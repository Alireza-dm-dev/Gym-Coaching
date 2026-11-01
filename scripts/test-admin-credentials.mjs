/**
 * LOCAL ONLY. Super Admin credential-update regression suite (SEC0H2.5): real
 * built Worker + real local D1 (`.wrangler/state`), no mocks, Node's built-in
 * test runner.
 *
 *   npm run build && npm run test:admin-credentials
 *
 * Covers PATCH /api/admin/users/:id/credentials: email correction, password
 * reset, atomicity, session purge, no-ops, duplicate/invalid input, target-role
 * rules and access control. Requires the clean local baseline (6 users all
 * active, 1 coach, 4 members, no sessions, cycles or auth sessions) and refuses
 * to run otherwise. Fixture credentials are snapshotted up front and restored
 * by cleanup, pass or fail; temporary rows use the `@admincreds.example.test`
 * domain or the `AdminCredsTest` name prefix.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, one, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.ADMIN_CREDENTIALS_TEST_PORT ?? "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "@admincreds.example.test";
const PREFIX = "AdminCredsTest";
const SA_EMAIL = "superadmin@example.test";
const COACH1 = "coach1@example.test";
const MEMBER1 = "member1@example.test";
const MEMBER1_PASSWORD = "LocalMember123!";
const FIXTURES = { [COACH1]: "LocalCoach123!", [MEMBER1]: MEMBER1_PASSWORD, [SA_EMAIL]: "LocalAdmin123!" };
const NEW_MEMBER_PASSWORD = "NewMemberPass456!";
const CORRECTED_MEMBER = `corrected.member${DOMAIN}`;
const COACH_T_EMAIL = `coach.temp${DOMAIN}`;
const COACH_T_PASSWORD = "TempCoachPass123!";
const COACH_T_NEW_EMAIL = `coach.fixed${DOMAIN}`;
const COACH_T_NEW_PASSWORD = "TempCoachFixed456!";

if (process.argv.includes("--remote")) throw new Error("test-admin-credentials is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const baselineCounts = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
  auth_sessions: count("auth_sessions") });
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0 };

let fixtureSnapshot = null; // original users rows, restored verbatim by cleanup
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function cleanup() {
  sql(
    `DELETE FROM auth_sessions; DELETE FROM members WHERE name LIKE '${PREFIX}%'; ` +
      `DELETE FROM coaches WHERE name LIKE '${PREFIX}%' OR user_id IN (SELECT id FROM users WHERE email LIKE '%${DOMAIN}'); ` +
      `DELETE FROM users WHERE email LIKE '%${DOMAIN}';`
  );
  for (const u of fixtureSnapshot ?? []) {
    sql(`UPDATE users SET email = ${q(u.email)}, password_hash = ${q(u.password_hash)}, is_active = ${q(u.is_active)}, updated_at = ${q(u.updated_at)} WHERE id = ${u.id}`);
  }
}

async function rawLogin(email, password) {
  return fetchBounded(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}
async function login(email, password) {
  const response = await rawLogin(email, password);
  assert.equal(response.status, 200, `login ${email}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function call(cookie, method, path, body) {
  const response = await fetchBounded(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}

let server;
let baselineVerified = false;
installSuiteGuard("test-admin-credentials", 300_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};

describe("Admin credential-update regression", () => {
  before(async () => {
    assert.deepEqual(baselineCounts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(baselineCounts())}`);
    baselineVerified = true;
    fixtureSnapshot = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");

    server = await startWorker(PORT);
    for (const email of Object.keys(FIXTURES)) jars[email] = await login(email, FIXTURES[email]);
  });

  after(async () => {
    try {
      if (baselineVerified) {
        cleanup();
        // Fixture credentials still work after cleanup.
        for (const email of Object.keys(FIXTURES)) {
          assert.equal((await rawLogin(email, FIXTURES[email])).status, 200, `post-cleanup login ${email}`);
        }
        sql("DELETE FROM auth_sessions");
      }
    } finally {
      await server?.stop();
    }
    if (!baselineVerified) return;
    const final = baselineCounts();
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, BASELINE);
    assert.deepEqual(sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id"), fixtureSnapshot);
  });

  const SA = () => jars[SA_EMAIL];
  const creds = (cookie, id, body) => call(cookie, "PATCH", `/api/admin/users/${id}/credentials`, body);
  const userRow = (id) => one(`SELECT id, role, email, password_hash, is_active FROM users WHERE id = ${id}`);
  const sessionsOf = (id) => count("auth_sessions", `user_id = ${id}`);
  const responses = [];

  let m1UserId, saUserId, coach1UserId, tUserId, tCoachId, tCoachCookie;

  it("setup: resolve fixture ids and create a temporary Coach through the admin API", async () => {
    m1UserId = one(`SELECT id FROM users WHERE email = '${MEMBER1}'`).id;
    saUserId = one(`SELECT id FROM users WHERE email = '${SA_EMAIL}'`).id;
    coach1UserId = one(`SELECT id FROM users WHERE email = '${COACH1}'`).id;
    const created = await call(SA(), "POST", "/api/admin/coaches", { name: `${PREFIX} Temp`, email: COACH_T_EMAIL, password: COACH_T_PASSWORD });
    assert.equal(created.status, 201);
    tUserId = created.json.coach.userId;
    tCoachId = created.json.coach.id;
    assert.ok(one(`SELECT password_hash FROM users WHERE id = ${tUserId}`).password_hash.startsWith("pbkdf2-sha256$v=1$i=100000$")); // new Coach credential
  });

  it("unauthenticated 401, Coach 403, Member 403; no mutation", async () => {
    const before = sql("SELECT id, email, password_hash FROM users ORDER BY id");
    const sessionsBefore = count("auth_sessions");
    for (const [cookie, expected] of [[null, 401], [jars[COACH1], 403], [jars[MEMBER1], 403]]) {
      assert.equal((await creds(cookie, m1UserId, { password: "AnotherLongPass1" })).status, expected);
      assert.equal((await creds(cookie, m1UserId, { email: `x${DOMAIN}` })).status, expected);
    }
    assert.deepEqual(sql("SELECT id, email, password_hash FROM users ORDER BY id"), before);
    assert.equal(count("auth_sessions"), sessionsBefore);
  });

  it("body validation: {}, unknown fields, non-object, bad email, bad password -> 400; missing user -> 404; zero mutation", async () => {
    const before = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");
    const sessionsBefore = count("auth_sessions");
    for (const body of [{}, { email: `a${DOMAIN}`, role: "coach" }, { isActive: false }, { password: "LongEnough123", userId: 1 }, [], "x", 5,
      { email: "no-at-sign" }, { email: "" }, { email: 5 }, { email: null }, { password: "short" }, { password: 1234567890123 }, { password: null }]) {
      assert.equal((await creds(SA(), m1UserId, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${m1UserId}/credentials`, undefined)).status, 400);
    assert.equal((await creds(SA(), 999999, { password: "LongEnough123" })).status, 404);
    assert.equal((await creds(SA(), "abc", { password: "LongEnough123" })).status, 404);
    assert.equal((await creds(SA(), 0, { password: "LongEnough123" })).status, 404);
    assert.deepEqual(sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id"), before);
    assert.equal(count("auth_sessions"), sessionsBefore);
  });

  it("Super Admin target -> 409: no email/password change and no session deletion", async () => {
    const before = userRow(saUserId);
    const sessionsBefore = sessionsOf(saUserId);
    assert.ok(sessionsBefore >= 1);
    for (const body of [{ email: `sa${DOMAIN}` }, { password: "LongEnough123" }, { email: `sa${DOMAIN}`, password: "LongEnough123" }]) {
      assert.equal((await creds(SA(), saUserId, body)).status, 409);
    }
    assert.deepEqual(userRow(saUserId), before);
    assert.equal(sessionsOf(saUserId), sessionsBefore);
    assert.equal((await call(SA(), "GET", "/api/admin/members")).status, 200); // own cookie still valid
  });

  it("Member password reset: sessions purged, old cookie 401, old password 401, new password works, safe response", async () => {
    const cookie = await login(MEMBER1, MEMBER1_PASSWORD);
    assert.equal((await call(cookie, "GET", "/api/members/me")).status, 200);
    const profileId = (await call(cookie, "GET", "/api/members/me")).json.member.id;
    assert.ok(sessionsOf(m1UserId) >= 1);
    const before = userRow(m1UserId);
    const linkBefore = sql("SELECT id, user_id, coach_id FROM members ORDER BY id");

    const res = await creds(SA(), m1UserId, { password: NEW_MEMBER_PASSWORD });
    assert.equal(res.status, 200);
    responses.push(res.text);
    assert.deepEqual(res.json, { user: { id: m1UserId, role: "member", email: MEMBER1, isActive: true } });
    assert.equal(sessionsOf(m1UserId), 0);
    assert.equal((await call(cookie, "GET", "/api/members/me")).status, 401);
    assert.equal((await rawLogin(MEMBER1, MEMBER1_PASSWORD)).status, 401);
    const fresh = await login(MEMBER1, NEW_MEMBER_PASSWORD);
    assert.equal((await call(fresh, "GET", "/api/members/me")).json.member.id, profileId);

    const after = userRow(m1UserId);
    assert.notEqual(after.password_hash, before.password_hash);
    assert.ok(after.password_hash.startsWith("pbkdf2-sha256$v=1$i=100000$") && !after.password_hash.includes(NEW_MEMBER_PASSWORD));
    assert.equal(after.email, before.email);
    assert.equal(after.is_active, 1);
    assert.deepEqual(sql("SELECT id, user_id, coach_id FROM members ORDER BY id"), linkBefore);

    // Restore the original password through the same endpoint.
    assert.equal((await creds(SA(), m1UserId, { password: MEMBER1_PASSWORD })).status, 200);
    assert.equal(sessionsOf(m1UserId), 0);
    assert.equal((await rawLogin(MEMBER1, NEW_MEMBER_PASSWORD)).status, 401);
    await login(MEMBER1, MEMBER1_PASSWORD);
  });

  it("Member email correction (padded, mixed case): old email 401, new email works with the same password, same profile", async () => {
    const cookie = await login(MEMBER1, MEMBER1_PASSWORD);
    const profileId = (await call(cookie, "GET", "/api/members/me")).json.member.id;
    const hashBefore = userRow(m1UserId).password_hash;
    const membersBefore = count("members");

    const res = await creds(SA(), m1UserId, { email: `  Corrected.Member${DOMAIN.toUpperCase()} ` });
    assert.equal(res.status, 200);
    responses.push(res.text);
    assert.deepEqual(res.json, { user: { id: m1UserId, role: "member", email: CORRECTED_MEMBER, isActive: true } });
    assert.equal(userRow(m1UserId).email, CORRECTED_MEMBER);
    assert.equal(userRow(m1UserId).password_hash, hashBefore); // email-only change keeps the hash
    assert.equal(sessionsOf(m1UserId), 0);
    assert.equal((await call(cookie, "GET", "/api/members/me")).status, 401); // even an email-only change kills old cookies
    assert.equal((await rawLogin(MEMBER1, MEMBER1_PASSWORD)).status, 401);
    const fresh = await login(CORRECTED_MEMBER, MEMBER1_PASSWORD);
    assert.equal((await call(fresh, "GET", "/api/members/me")).json.member.id, profileId);
    assert.equal(count("members"), membersBefore);
    assert.equal(count("members", `id = ${profileId} AND user_id = ${m1UserId}`), 1);
  });

  it("admin lists show the corrected email", async () => {
    const members = (await call(SA(), "GET", "/api/admin/members")).json.members;
    assert.equal(members.find((m) => m.userId === m1UserId).email, CORRECTED_MEMBER);
    assert.equal(members.filter((m) => m.email === MEMBER1).length, 0);
  });

  it("duplicate email (any case, Coach or Member owner) -> 409 with zero mutation", async () => {
    const memberCookie = await login(CORRECTED_MEMBER, MEMBER1_PASSWORD);
    const before = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");
    const sessionsBefore = sql("SELECT id, user_id FROM auth_sessions ORDER BY id");
    for (const email of [COACH1, "COACH1@example.test", `  ${COACH1.toUpperCase()}`, COACH_T_EMAIL]) {
      assert.equal((await creds(SA(), m1UserId, { email })).status, 409, email);
      assert.equal((await creds(SA(), m1UserId, { email, password: "WouldBeNewPass1" })).status, 409, `${email} + password`);
    }
    assert.equal((await creds(SA(), tUserId, { email: CORRECTED_MEMBER })).status, 409);
    assert.deepEqual(sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id"), before);
    assert.deepEqual(sql("SELECT id, user_id FROM auth_sessions ORDER BY id"), sessionsBefore);
    assert.equal((await call(memberCookie, "GET", "/api/members/me")).status, 200); // session survived
    assert.equal((await rawLogin(CORRECTED_MEMBER, MEMBER1_PASSWORD)).status, 200);
  });

  it("short password -> 400 with no mutation and no session purge (also combined with a valid email)", async () => {
    const before = userRow(m1UserId);
    const sessionsBefore = sessionsOf(m1UserId);
    assert.ok(sessionsBefore >= 1);
    assert.equal((await creds(SA(), m1UserId, { password: "123456789" })).status, 400);
    assert.equal((await creds(SA(), m1UserId, { email: `ok${DOMAIN}`, password: "123456789" })).status, 400);
    assert.deepEqual(userRow(m1UserId), before);
    assert.equal(sessionsOf(m1UserId), sessionsBefore);
    assert.equal((await creds(SA(), m1UserId, { password: "1234567890" })).status, 200); // exactly 10 is accepted
    assert.equal((await creds(SA(), m1UserId, { password: MEMBER1_PASSWORD })).status, 200);
  });

  it("no-op: same email (any case/padding) returns 200 with no purge and no write", async () => {
    const cookie = await login(CORRECTED_MEMBER, MEMBER1_PASSWORD);
    const before = userRow(m1UserId);
    const updatedBefore = one(`SELECT updated_at FROM users WHERE id = ${m1UserId}`).updated_at;
    const sessionsBefore = sessionsOf(m1UserId);
    const res = await creds(SA(), m1UserId, { email: `  ${CORRECTED_MEMBER.toUpperCase()} ` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { user: { id: m1UserId, role: "member", email: CORRECTED_MEMBER, isActive: true } });
    assert.deepEqual(userRow(m1UserId), before);
    assert.equal(one(`SELECT updated_at FROM users WHERE id = ${m1UserId}`).updated_at, updatedBefore);
    assert.equal(sessionsOf(m1UserId), sessionsBefore);
    assert.equal((await call(cookie, "GET", "/api/members/me")).status, 200);
  });

  it("Coach credentials: email+password in one request; sessions purged, profile and user ids unchanged, role unchanged", async () => {
    tCoachCookie = await login(COACH_T_EMAIL, COACH_T_PASSWORD);
    assert.equal((await call(tCoachCookie, "GET", "/api/members")).status, 200);
    const hashBefore = userRow(tUserId).password_hash;
    const profilesBefore = sql("SELECT id, user_id, name FROM coaches ORDER BY id");
    const membersBefore = sql("SELECT id, user_id, coach_id FROM members ORDER BY id");

    const res = await creds(SA(), tUserId, { email: ` ${COACH_T_NEW_EMAIL.toUpperCase()}`, password: COACH_T_NEW_PASSWORD });
    assert.equal(res.status, 200);
    responses.push(res.text);
    assert.deepEqual(res.json, { user: { id: tUserId, role: "coach", email: COACH_T_NEW_EMAIL, isActive: true } });
    assert.equal(sessionsOf(tUserId), 0);
    assert.equal((await call(tCoachCookie, "GET", "/api/members")).status, 401);
    assert.equal((await rawLogin(COACH_T_EMAIL, COACH_T_PASSWORD)).status, 401);
    assert.equal((await rawLogin(COACH_T_EMAIL, COACH_T_NEW_PASSWORD)).status, 401);
    assert.equal((await rawLogin(COACH_T_NEW_EMAIL, COACH_T_PASSWORD)).status, 401);
    tCoachCookie = await login(COACH_T_NEW_EMAIL, COACH_T_NEW_PASSWORD);
    assert.equal((await call(tCoachCookie, "GET", "/api/members")).status, 200);
    assert.equal((await call(tCoachCookie, "GET", "/api/admin/members")).status, 403); // still a Coach

    const after = userRow(tUserId);
    assert.equal(after.role, "coach");
    assert.notEqual(after.password_hash, hashBefore);
    assert.ok(after.password_hash.startsWith("pbkdf2-sha256$v=1$i=100000$"));
    assert.deepEqual(sql("SELECT id, user_id, name FROM coaches ORDER BY id"), profilesBefore);
    assert.deepEqual(sql("SELECT id, user_id, coach_id FROM members ORDER BY id"), membersBefore);
    const listed = (await call(SA(), "GET", "/api/admin/coaches")).json.coaches.find((c) => c.id === tCoachId);
    assert.deepEqual({ userId: listed.userId, email: listed.email }, { userId: tUserId, email: COACH_T_NEW_EMAIL });
  });

  it("combined Member change: both fields applied together, sessions purged, old pair fails, new pair works", async () => {
    const cookie = await login(CORRECTED_MEMBER, MEMBER1_PASSWORD);
    const res = await creds(SA(), m1UserId, { email: MEMBER1, password: NEW_MEMBER_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, MEMBER1);
    assert.equal(sessionsOf(m1UserId), 0);
    assert.equal((await call(cookie, "GET", "/api/members/me")).status, 401);
    assert.equal((await rawLogin(CORRECTED_MEMBER, MEMBER1_PASSWORD)).status, 401);
    assert.equal((await rawLogin(CORRECTED_MEMBER, NEW_MEMBER_PASSWORD)).status, 401);
    assert.equal((await rawLogin(MEMBER1, MEMBER1_PASSWORD)).status, 401);
    await login(MEMBER1, NEW_MEMBER_PASSWORD);
    // A combined request that conflicts on email must not apply the password either.
    const hash = userRow(m1UserId).password_hash;
    assert.equal((await creds(SA(), m1UserId, { email: COACH1, password: MEMBER1_PASSWORD })).status, 409);
    assert.equal(userRow(m1UserId).password_hash, hash);
    // Restore.
    assert.equal((await creds(SA(), m1UserId, { password: MEMBER1_PASSWORD })).status, 200);
    await login(MEMBER1, MEMBER1_PASSWORD);
  });

  it("inactive user: credentials update allowed, stays inactive, login fails until status reactivates", async () => {
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${tUserId}/status`, { isActive: false })).status, 200);
    const res = await creds(SA(), tUserId, { password: "InactiveReset789!" });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.isActive, false);
    assert.equal(userRow(tUserId).is_active, 0);
    assert.notEqual((await rawLogin(COACH_T_NEW_EMAIL, "InactiveReset789!")).status, 200);
    assert.equal((await call(SA(), "PATCH", `/api/admin/users/${tUserId}/status`, { isActive: true })).status, 200);
    assert.equal((await rawLogin(COACH_T_NEW_EMAIL, "InactiveReset789!")).status, 200);
    assert.equal(sql(`SELECT is_active FROM users WHERE id = ${coach1UserId}`)[0].is_active, 1);
  });

  it("responses never expose credentials or tokens", () => {
    assert.ok(responses.length >= 3);
    for (const text of responses) {
      for (const needle of ["password", "passwordHash", "password_hash", "pbkdf2", "token", NEW_MEMBER_PASSWORD, COACH_T_NEW_PASSWORD]) {
        assert.equal(text.toLowerCase().includes(needle.toLowerCase()), false, `response leaked "${needle}"`);
      }
    }
  });
});
