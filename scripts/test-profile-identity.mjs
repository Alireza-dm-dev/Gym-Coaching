/**
 * LOCAL ONLY. Profile identity / private profile-photo regression suite
 * (SEC0L2): real built Worker + real local D1 + real local R2 (Miniflare, via
 * the same `BUCKET` binding production uses), no mocks. Node's built-in runner.
 *
 *   npm run build && npm run test:profile-identity
 *
 * Also covers the pure `getInitials` helper. Requires the clean local baseline
 * (6 active users, 1 coach, 4 members on coach 1, no photos, no profile R2
 * objects, no sessions/cycles/meals/auth sessions) and refuses to run
 * otherwise. Temporary rows use the `@profileidentity.example.test` domain or
 * the `ProfileIdentityTest` prefix; cleanup (including every `profiles/` R2
 * object) always restores the baseline, pass or fail.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, deleteR2Object, fetchBounded, installSuiteGuard, one, r2Keys, sql, startWorker } from "./test-helpers.mjs";
import { getInitials } from "../lib/initials.ts";

const PORT = process.env.PROFILE_IDENTITY_TEST_PORT ?? "8799";
const NOBUCKET_PORT = String(Number(PORT) + 1);
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "@profileidentity.example.test";
const PREFIX = "ProfileIdentityTest";
const COACH_B_EMAIL = `coach.b${DOMAIN}`;
const COACH_B_PASSWORD = "CoachBPassword123!";
const NOBUCKET_CONFIG = "dist/server/wrangler-nobucket.json";

if (process.argv.includes("--remote")) throw new Error("test-profile-identity is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

// ---- bytes -----------------------------------------------------------------
const pad = (head, total = 64) => { const b = Buffer.alloc(total); Buffer.from(head).copy(b); return b; };
const JPEG = (n = 64) => pad([0xff, 0xd8, 0xff, 0xe0], n);
const PNG = (n = 64) => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], n);
const WEBP = (n = 64) => { const b = Buffer.alloc(n); b.write("RIFF", 0); b.writeUInt32LE(n - 8, 4); b.write("WEBPVP8 ", 8); return b; };
const GIF = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
const SVG = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const MAX = 2 * 1024 * 1024;

function cleanup() {
  sql(
    `DELETE FROM auth_sessions; ` +
      `UPDATE members SET photo_url = NULL; UPDATE coaches SET photo_url = NULL; ` +
      `DELETE FROM members WHERE name LIKE '${PREFIX}%'; ` +
      `DELETE FROM coaches WHERE name LIKE '${PREFIX}%' OR user_id IN (SELECT id FROM users WHERE email LIKE '%${DOMAIN}'); ` +
      `DELETE FROM users WHERE email LIKE '%${DOMAIN}'; UPDATE users SET is_active = 1; UPDATE members SET coach_id = 1;`
  );
  for (const key of r2Keys()) deleteR2Object(key);
  rmSync(NOBUCKET_CONFIG, { force: true });
}

const passwords = {
  "coach1@example.test": "LocalCoach123!",
  "member1@example.test": "LocalMember123!",
  "member2@example.test": "LocalMember123!",
  "member3@example.test": "LocalMember123!",
  "superadmin@example.test": "LocalAdmin123!",
  [COACH_B_EMAIL]: COACH_B_PASSWORD,
};
async function rawLogin(email) {
  return fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: passwords[email] }) });
}
async function login(email) {
  const response = await rawLogin(email);
  assert.equal(response.status, 200, `login ${email}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function call(cookie, method, path, body, base = BASE) {
  const response = await fetchBounded(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}
/** Raw-bytes upload. `type` undefined sends no Content-Type. */
async function put(cookie, bytes, type, query = "", base = BASE) {
  const response = await fetchBounded(`${base}/api/profile/photo${query}`, { method: "PUT", headers: { ...(cookie ? { cookie } : {}), ...(type ? { "content-type": type } : {}) }, body: bytes });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}
async function read(cookie, url, base = BASE) {
  const response = await fetchBounded(`${base}${url}`, { headers: cookie ? { cookie } : {} });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}

let server;
let noBucket;
let baselineVerified = false;
installSuiteGuard("test-profile-identity", 300_000, () => { server?.killNow(); noBucket?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, coachPhotos: 0, memberPhotos: 0, onCoach1: 4, r2Objects: 0 };
const snapshot = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_meals: count("member_meals"), member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
  auth_sessions: count("auth_sessions"), coachPhotos: count("coaches", "photo_url IS NOT NULL"), memberPhotos: count("members", "photo_url IS NOT NULL"), onCoach1: count("members", "coach_id = 1"), r2Objects: r2Keys().length });
const dbPhoto = (table, id) => one(`SELECT photo_url FROM ${table} WHERE id = ${id}`).photo_url;
const keyOf = (url) => url.replace("/api/photos/", "");

describe("getInitials (pure)", () => {
  it("derives initials from a display name", () => {
    assert.equal(getInitials("Jordan Lee"), "JL");
    assert.equal(getInitials("Alireza"), "A");
    assert.equal(getInitials("Mary Jane Watson"), "MW");
    assert.equal(getInitials("  Jordan    Lee  "), "JL");
    assert.equal(getInitials("\tjordan\n lee "), "JL");
    assert.equal(getInitials("alireza"), "A");
  });
  it("falls back to ? for empty or missing names", () => {
    for (const value of ["", "   ", "\n\t", null, undefined]) assert.equal(getInitials(value), "?");
  });
  it("is Unicode-safe", () => {
    assert.equal(getInitials("مهدی خوش‌پوش"), "مخ");
    assert.equal(getInitials("علیرضا"), "ع");
    assert.equal(getInitials("李 小龍"), "李小");
    assert.equal(getInitials("𠮷野 家"), "𠮷家"); // astral first character kept whole
    assert.equal(getInitials("élodie"), "É");
  });
});

describe("Profile identity and private photo regression", () => {
  before(async () => {
    assert.deepEqual(snapshot(), BASELINE, "Unexpected local baseline (D1 or R2)");
    baselineVerified = true;

    server = await startWorker(PORT);
    for (const email of ["coach1@example.test", "member1@example.test", "member2@example.test", "member3@example.test", "superadmin@example.test"]) jars[email] = await login(email);
  });

  after(async () => {
    await server?.stop();
    await noBucket?.stop();
    if (!baselineVerified) return;
    cleanup();
    const final = snapshot();
    console.log("Final DB/R2:", JSON.stringify(final));
    assert.deepEqual(final, BASELINE);
  });

  const SA = () => jars["superadmin@example.test"];
  const A = () => jars["coach1@example.test"];
  const B = () => jars[COACH_B_EMAIL];
  const M1 = () => jars["member1@example.test"];
  const M2 = () => jars["member2@example.test"];
  const M3 = () => jars["member3@example.test"];

  let coachBId, coachBUserId, m1Url1, m1Url2, m2Url, coachUrl;

  // ---- Coach self-profile ----------------------------------------------------
  it("Coach reads own profile with the real DB name and no photo", async () => {
    const response = await call(A(), "GET", "/api/coaches/me");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { coach: { id: 1, name: one("SELECT name FROM coaches WHERE id = 1").name, photoUrl: null } });
    assert.deepEqual(Object.keys(response.json.coach).sort(), ["id", "name", "photoUrl"]);
  });
  it("Member, Super Admin and unauthenticated callers cannot read the Coach profile", async () => {
    assert.equal((await call(M1(), "GET", "/api/coaches/me")).status, 403);
    assert.equal((await call(SA(), "GET", "/api/coaches/me")).status, 403);
    assert.equal((await call(null, "GET", "/api/coaches/me")).status, 401);
  });
  it("Coach name stays read-only: there is no PATCH, and /api/auth/me is unchanged", async () => {
    const patch = await call(A(), "PATCH", "/api/coaches/me", { name: "Hacked" });
    assert.ok([404, 405].includes(patch.status), `PATCH status ${patch.status}`);
    assert.equal(one("SELECT name FROM coaches WHERE id = 1").name, "Jordan Lee");
    const me = await call(A(), "GET", "/api/auth/me");
    assert.deepEqual(Object.keys(me.json).sort(), ["user"]);
    assert.deepEqual(Object.keys(me.json.user).sort(), ["email", "id", "role"]);
  });

  // ---- Auth on the shared endpoints ---------------------------------------------
  it("unauthenticated and Super Admin cannot upload or remove, and nothing changes", async () => {
    assert.equal((await put(null, JPEG(), "image/jpeg")).status, 401);
    assert.equal((await put(SA(), JPEG(), "image/jpeg")).status, 403);
    assert.equal((await call(null, "DELETE", "/api/profile/photo")).status, 401);
    assert.equal((await call(SA(), "DELETE", "/api/profile/photo")).status, 403);
    assert.equal(r2Keys().length, 0);
    assert.equal(count("coaches", "photo_url IS NOT NULL") + count("members", "photo_url IS NOT NULL"), 0);
  });

  // ---- Validation (no mutation) -----------------------------------------------
  it("rejects SVG, GIF, unknown and missing types with 415", async () => {
    assert.equal((await put(M1(), SVG(), "image/svg+xml")).status, 415);
    assert.equal((await put(M1(), GIF(), "image/gif")).status, 415);
    assert.equal((await put(M1(), JPEG(), "application/octet-stream")).status, 415);
    assert.equal((await put(M1(), JPEG(), undefined)).status, 415);
    assert.equal((await put(M1(), SVG(), "image/png")).status, 415, "SVG bytes under an allowed type");
  });
  it("rejects spoofed MIME (bytes do not match the declared type) with 415", async () => {
    assert.equal((await put(M1(), JPEG(), "image/png")).status, 415);
    assert.equal((await put(M1(), PNG(), "image/webp")).status, 415);
    assert.equal((await put(M1(), WEBP(), "image/jpeg")).status, 415);
    assert.equal((await put(M1(), Buffer.from("not an image at all"), "image/jpeg")).status, 415);
  });
  it("rejects an empty body with 400 and an oversize body with 413", async () => {
    assert.equal((await put(M1(), Buffer.alloc(0), "image/jpeg")).status, 400);
    const big = await put(M1(), JPEG(MAX + 1), "image/jpeg");
    assert.equal(big.status, 413);
    assert.equal(big.json.error, "Image must be 2 MB or smaller.");
  });
  it("failed validation changed neither the DB nor R2", () => {
    assert.equal(dbPhoto("members", 1), null);
    assert.equal(r2Keys().length, 0);
  });

  // ---- Upload: Coach (JPEG), Member (PNG, WebP) --------------------------------
  it("Coach uploads a JPEG; the URL is app-relative and persists", async () => {
    const response = await put(A(), JPEG(), "image/jpeg; charset=binary");
    assert.equal(response.status, 200);
    coachUrl = response.json.photoUrl;
    assert.deepEqual(Object.keys(response.json), ["photoUrl"]);
    assert.match(coachUrl, /^\/api\/photos\/profiles\/coach\/1\/[0-9a-f]{32}\.jpg$/);
    assert.equal(dbPhoto("coaches", 1), coachUrl);
    assert.equal((await call(A(), "GET", "/api/coaches/me")).json.coach.photoUrl, coachUrl);
    assert.deepEqual(r2Keys(), [keyOf(coachUrl)]);
    assert.equal(one("SELECT name FROM coaches WHERE id = 1").name, "Jordan Lee", "name untouched");
  });
  it("Member uploads a PNG; only members.photo_url changes", async () => {
    const before = { ...one("SELECT id, user_id, coach_id, name, phone, weight_kg, height_cm, goal, default_start_time, default_duration_minutes, preferred_days FROM members WHERE id = 1") };
    const response = await put(M1(), PNG(), "image/png", "?memberId=2&photoUrl=/api/photos/x&key=profiles/member/2/x.png");
    assert.equal(response.status, 200);
    m1Url1 = response.json.photoUrl;
    assert.match(m1Url1, /^\/api\/photos\/profiles\/member\/1\/[0-9a-f]{32}\.png$/);
    assert.equal(dbPhoto("members", 1), m1Url1);
    assert.equal(dbPhoto("members", 2), null, "request parameters cannot aim at another profile");
    assert.deepEqual({ ...one("SELECT id, user_id, coach_id, name, phone, weight_kg, height_cm, goal, default_start_time, default_duration_minutes, preferred_days FROM members WHERE id = 1") }, before);
    assert.equal((await call(M1(), "GET", "/api/members/me")).json.member.photoUrl, m1Url1);
  });
  it("another Member uploads a WebP", async () => {
    const response = await put(M2(), WEBP(), "image/webp");
    assert.equal(response.status, 200);
    m2Url = response.json.photoUrl;
    assert.match(m2Url, /^\/api\/photos\/profiles\/member\/2\/[0-9a-f]{32}\.webp$/);
    assert.equal(dbPhoto("members", 2), m2Url);
  });
  it("the assigned Coach's roster already carries the Member photoUrl", async () => {
    const roster = (await call(A(), "GET", "/api/members")).json.members;
    assert.equal(roster.find((m) => m.id === 1).photoUrl, m1Url1);
    assert.equal(roster.find((m) => m.id === 3).photoUrl, null);
  });

  // ---- Private reads ---------------------------------------------------------------
  it("Member photo: self, current Coach and Super Admin read it with the right headers", async () => {
    for (const cookie of [M1(), A(), SA()]) {
      const r = await read(cookie, m1Url1);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/png");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.ok(r.body.equals(PNG()), "bytes round-trip");
    }
  });
  it("Member photo: other Member, unrelated Coach and unauthenticated are refused", async () => {
    coachBId = undefined;
    const created = await call(SA(), "POST", "/api/admin/coaches", { name: `${PREFIX} Coach B`, email: COACH_B_EMAIL, password: COACH_B_PASSWORD });
    assert.equal(created.status, 201);
    coachBId = created.json.coach.id;
    coachBUserId = created.json.coach.userId;
    jars[COACH_B_EMAIL] = await login(COACH_B_EMAIL);
    assert.equal((await read(M2(), m1Url1)).status, 404);
    assert.equal((await read(B(), m1Url1)).status, 404);
    assert.equal((await read(null, m1Url1)).status, 401);
  });
  it("Coach photo: self and Super Admin read it; other Coach, Member and unauthenticated are refused", async () => {
    for (const cookie of [A(), SA()]) {
      const r = await read(cookie, coachUrl);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/jpeg");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.ok(r.body.equals(JPEG()));
    }
    assert.equal((await read(B(), coachUrl)).status, 404);
    assert.equal((await read(M1(), coachUrl)).status, 404);
    assert.equal((await read(null, coachUrl)).status, 401);
  });
  it("malformed or unknown keys are 404 for an authenticated caller", async () => {
    for (const bad of ["/api/photos/profiles/member/1/zzz.png", "/api/photos/etc/passwd", "/api/photos/profiles/member/1/00000000000000000000000000000000.png", "/api/photos/profiles/member/999/00000000000000000000000000000000.png", "/api/photos/profiles/member/1/00000000000000000000000000000000.svg"]) {
      assert.equal((await read(SA(), bad)).status, 404, bad);
    }
    // A well-formed key that is not the profile's current photoUrl is not served.
    assert.equal((await read(SA(), "/api/photos/profiles/member/1/00000000000000000000000000000000.png")).status, 404);
  });

  // ---- Replace -----------------------------------------------------------------------
  it("replacing a photo changes the URL, serves the new object and retires the old one", async () => {
    const response = await put(M1(), PNG(MAX), "image/png"); // exactly 2 MB is allowed
    assert.equal(response.status, 200);
    m1Url2 = response.json.photoUrl;
    assert.notEqual(m1Url2, m1Url1);
    assert.equal(dbPhoto("members", 1), m1Url2);
    const fresh = await read(M1(), m1Url2);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.length, MAX);
    for (const cookie of [M1(), A(), SA()]) assert.equal((await read(cookie, m1Url1)).status, 404, "old URL no longer authorized");
    assert.ok(!r2Keys().includes(keyOf(m1Url1)), "old object was deleted");
    assert.ok(r2Keys().includes(keyOf(m1Url2)));
  });

  // ---- Remove ----------------------------------------------------------------------------
  it("remove clears the photo, deletes the object and is idempotent", async () => {
    const removed = await call(M2(), "DELETE", "/api/profile/photo");
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json, { photoUrl: null });
    assert.equal(dbPhoto("members", 2), null);
    assert.equal((await call(M2(), "GET", "/api/members/me")).json.member.photoUrl, null);
    assert.equal((await read(M2(), m2Url)).status, 404);
    assert.equal((await read(SA(), m2Url)).status, 404);
    assert.ok(!r2Keys().includes(keyOf(m2Url)));
    const again = await call(M2(), "DELETE", "/api/profile/photo");
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { photoUrl: null });
  });

  // ---- Reassignment ----------------------------------------------------------------------
  it("read authorization follows the Member's CURRENT Coach; the photo is untouched", async () => {
    const keysBefore = r2Keys();
    assert.equal((await read(A(), m1Url2)).status, 200);
    assert.equal((await read(B(), m1Url2)).status, 404);
    const moved = await call(SA(), "PATCH", "/api/admin/members/1/assignment", { coachId: coachBId });
    assert.equal(moved.status, 200);
    assert.equal((await read(A(), m1Url2)).status, 404, "old Coach");
    const asB = await read(B(), m1Url2);
    assert.equal(asB.status, 200, "new Coach");
    assert.equal(asB.body.length, MAX);
    assert.equal((await read(M1(), m1Url2)).status, 200, "Member");
    assert.equal(dbPhoto("members", 1), m1Url2, "photo_url unchanged");
    assert.deepEqual(r2Keys(), keysBefore, "no object rewrite");
    assert.equal((await call(B(), "GET", "/api/members")).json.members.find((m) => m.id === 1).photoUrl, m1Url2);
    assert.equal((await call(SA(), "PATCH", "/api/admin/members/1/assignment", { coachId: 1 })).status, 200);
    assert.equal((await read(A(), m1Url2)).status, 200);
    assert.equal((await read(B(), m1Url2)).status, 404);
  });

  // ---- Inactive accounts ------------------------------------------------------------------
  it("deactivating a Member login keeps the photo; reactivation restores the same URL", async () => {
    const userId = one("SELECT user_id FROM members WHERE id = 1").user_id;
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${userId}/status`, { isActive: false })).status, 200);
    assert.equal(dbPhoto("members", 1), m1Url2);
    assert.equal((await read(M1(), m1Url2)).status, 401, "inactive self access is gone");
    assert.equal((await put(M1(), PNG(), "image/png")).status, 401);
    assert.equal((await read(A(), m1Url2)).status, 200, "current Coach is unchanged");
    assert.equal((await read(SA(), m1Url2)).status, 200);
    assert.ok(r2Keys().includes(keyOf(m1Url2)), "object not deleted on deactivation");
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${userId}/status`, { isActive: true })).status, 200);
    jars["member1@example.test"] = await login("member1@example.test");
    assert.equal((await call(M1(), "GET", "/api/members/me")).json.member.photoUrl, m1Url2);
    assert.equal((await read(M1(), m1Url2)).status, 200);
  });
  it("deactivating a Coach login keeps the photo; reactivation restores the same URL", async () => {
    // Coach 1 still has Members (the product refuses to deactivate such a Coach), so use Coach B.
    const upload = await put(B(), JPEG(), "image/jpeg");
    assert.equal(upload.status, 200);
    const url = upload.json.photoUrl;
    assert.match(url, new RegExp(`^/api/photos/profiles/coach/${coachBId}/[0-9a-f]{32}\\.jpg$`));
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${coachBUserId}/status`, { isActive: false })).status, 200);
    assert.equal(dbPhoto("coaches", coachBId), url);
    assert.equal((await call(B(), "GET", "/api/coaches/me")).status, 401);
    assert.equal((await read(SA(), url)).status, 200);
    assert.ok(r2Keys().includes(keyOf(url)), "object not deleted on deactivation");
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${coachBUserId}/status`, { isActive: true })).status, 200);
    jars[COACH_B_EMAIL] = await login(COACH_B_EMAIL);
    assert.equal((await call(B(), "GET", "/api/coaches/me")).json.coach.photoUrl, url);
    assert.equal((await read(B(), url)).status, 200);
  });

  // ---- Coach replace + remove ----------------------------------------------------------------
  it("Coach can replace and then remove the photo; the name never changes", async () => {
    const replaced = await put(A(), PNG(), "image/png");
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.json.photoUrl, coachUrl);
    assert.equal((await read(A(), coachUrl)).status, 404);
    assert.ok(!r2Keys().includes(keyOf(coachUrl)));
    assert.equal((await read(A(), replaced.json.photoUrl)).status, 200);
    const removed = await call(A(), "DELETE", "/api/profile/photo");
    assert.deepEqual(removed.json, { photoUrl: null });
    assert.equal(dbPhoto("coaches", 1), null);
    assert.equal((await read(A(), replaced.json.photoUrl)).status, 404);
    assert.equal((await call(A(), "GET", "/api/coaches/me")).json.coach.name, "Jordan Lee");
  });

  // ---- Missing bucket binding ----------------------------------------------------------------
  it("a Worker without the BUCKET binding answers 503 and mutates nothing", async () => {
    const config = JSON.parse(readFileSync("dist/server/wrangler.json", "utf8"));
    config.r2_buckets = [];
    writeFileSync(NOBUCKET_CONFIG, JSON.stringify(config));
    noBucket = await startWorker(NOBUCKET_PORT, { config: NOBUCKET_CONFIG });
    const nb = `http://127.0.0.1:${NOBUCKET_PORT}`;
    const keysBefore = r2Keys();
    const upload = await put(M3(), PNG(), "image/png", "", nb);
    assert.equal(upload.status, 503);
    assert.equal(dbPhoto("members", 3), null, "no DB mutation");
    const readback = await read(M1(), m1Url2, nb);
    assert.equal(readback.status, 503);
    assert.equal(dbPhoto("members", 1), m1Url2);
    assert.deepEqual(r2Keys(), keysBefore);
    await noBucket.stop();
    noBucket = undefined;
  });
});
