/**
 * LOCAL ONLY. Super Admin account-management regression suite (SEC0H1): real
 * built Worker + real local D1 (`.wrangler/state`), no mocks, Node's built-in
 * test runner.
 *
 *   npm run build && npm run test:admin
 *
 * Requires the local fixtures (6 users all active, 1 coach, 4 members, passwords
 * from scripts/seed-local-auth.ts) and a clean baseline; it refuses to run
 * otherwise rather than touching unknown data. Temporary Coach accounts use
 * the `@admintest.example.test` domain and are removed afterwards; fixture
 * users are re-activated, Members restored to coach 1 and auth sessions
 * cleared, pass or fail.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, sleep, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.ADMIN_TEST_PORT ?? "8797";
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DOMAIN = "@admintest.example.test";
const NEW_EMAIL_INPUT = `  Temp.Coach${TEST_DOMAIN.toUpperCase()} `; // padded + mixed case on purpose
const NEW_EMAIL = `temp.coach${TEST_DOMAIN}`;
const NEW_PASSWORD = "TempCoachPass123!";

if (process.argv.includes("--remote")) throw new Error("test-admin is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const userRow = (email) => sql(`SELECT id, role, email, password_hash, is_active, updated_at FROM users WHERE email = '${email}'`)[0];

function cleanup() {
  sql(
    `DELETE FROM auth_sessions; UPDATE members SET coach_id = 1; ` +
      `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%${TEST_DOMAIN}'); ` +
      `DELETE FROM users WHERE email LIKE '%${TEST_DOMAIN}'; UPDATE users SET is_active = 1;`
  );
}

const passwords = {
  "coach1@example.test": "LocalCoach123!",
  "member1@example.test": "LocalMember123!",
  "superadmin@example.test": "LocalAdmin123!",
  [NEW_EMAIL]: NEW_PASSWORD,
};

async function rawLogin(email) {
  return fetchBounded(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: passwords[email.trim().toLowerCase()] }),
  });
}
async function login(email) {
  const response = await rawLogin(email);
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
let baselineVerified = false; // cleanup only ever runs after the baseline was proven
installSuiteGuard("test-admin", 240_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};

describe("Admin regression", () => {
  before(async () => {
    const baseline = { users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"),
      members: count("members"), member_cycles: count("member_cycles"), auth_sessions: count("auth_sessions") };
    assert.deepEqual(baseline, { users: 6, activeUsers: 6, coaches: 1, members: 4, member_cycles: 0, auth_sessions: 0 },
      `Unexpected local D1 baseline: ${JSON.stringify(baseline)}`);
    baselineVerified = true;

    server = await startWorker(PORT);
    for (const email of ["coach1@example.test", "member1@example.test", "superadmin@example.test"]) jars[email] = await login(email);
  });

  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    const final = { users: count("users"), coaches: count("coaches"), members: count("members"), member_cycles: count("member_cycles"),
      sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
      auth_sessions: count("auth_sessions"), activeUsers: count("users", "is_active = 1") };
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, { users: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, activeUsers: 6 });
  });

  const sa = () => jars["superadmin@example.test"];
  const c1 = () => jars["coach1@example.test"];
  const m1 = () => jars["member1@example.test"];
  const status = (cookie, id, body) => call(cookie, "PATCH", `/api/admin/users/${id}/status`, body);
  let newUserId;
  let coach1UserId;
  let member1UserId;
  let saUserId;
  const responses = [];

  it("unauthenticated, Coach and Member are denied on every admin route, with no mutation", async () => {
    const before = count("users") + count("coaches");
    for (const [cookie, expected] of [[null, 401], [c1(), 403], [m1(), 403]]) {
      assert.equal((await call(cookie, "GET", "/api/admin/coaches")).status, expected);
      assert.equal((await call(cookie, "POST", "/api/admin/coaches", { name: "X", email: `x${TEST_DOMAIN}`, password: "longenough123" })).status, expected);
      assert.equal((await status(cookie, 1, { isActive: false })).status, expected);
    }
    assert.equal(count("users") + count("coaches"), before);
    assert.equal(count("users", "is_active = 1"), 6);
  });

  it("coach list: narrow projection with a member count", async () => {
    const list = await call(sa(), "GET", "/api/admin/coaches");
    assert.equal(list.status, 200);
    responses.push(list.text);
    assert.equal(list.json.coaches.length, 1);
    const [coach] = list.json.coaches;
    assert.deepEqual(Object.keys(coach).sort(), ["email", "id", "isActive", "memberCount", "name", "userId"]);
    assert.equal(coach.email, "coach1@example.test");
    assert.equal(coach.isActive, true);
    assert.equal(coach.memberCount, 4);
    coach1UserId = coach.userId;
    member1UserId = userRow("member1@example.test").id;
    saUserId = userRow("superadmin@example.test").id;
  });

  it("coach create validation rejects bad bodies without writing", async () => {
    const before = count("users") + count("coaches");
    const good = { name: "Temp Coach", email: NEW_EMAIL, password: NEW_PASSWORD };
    for (const body of [
      { ...good, role: "super_admin" }, { ...good, isActive: false }, { ...good, name: "  " }, { ...good, email: "no-at-sign" },
      { ...good, password: "short" }, { ...good, password: 1234567890123 }, { name: "n", email: NEW_EMAIL }, [], "x",
    ]) assert.equal((await call(sa(), "POST", "/api/admin/coaches", body)).status, 400);
    assert.equal(count("users") + count("coaches"), before);
  });

  it("coach create: normalized email, hashed password, atomic user + coach, can log in", async () => {
    const created = await call(sa(), "POST", "/api/admin/coaches", { name: "  Temp Coach  ", email: NEW_EMAIL_INPUT, password: NEW_PASSWORD });
    assert.equal(created.status, 201);
    responses.push(created.text);
    assert.deepEqual(Object.keys(created.json.coach).sort(), ["email", "id", "isActive", "memberCount", "name", "userId"]);
    assert.equal(created.json.coach.email, NEW_EMAIL);
    assert.equal(created.json.coach.name, "Temp Coach");
    assert.equal(created.json.coach.memberCount, 0);
    newUserId = created.json.coach.userId;

    const user = userRow(NEW_EMAIL);
    assert.equal(user.id, newUserId);
    assert.equal(user.role, "coach");
    assert.equal(user.is_active, 1);
    assert.ok(user.password_hash.startsWith("pbkdf2-sha256$") && !user.password_hash.includes(NEW_PASSWORD));
    assert.equal(count("coaches", `user_id = ${newUserId} AND id = ${created.json.coach.id}`), 1);
    assert.equal((await rawLogin(NEW_EMAIL_INPUT)).status, 200); // login normalizes too
    jars[NEW_EMAIL] = await login(NEW_EMAIL);
    assert.equal((await call(jars[NEW_EMAIL], "GET", "/api/members")).status, 200);
  });

  it("duplicate email (any case) returns 409 and leaves no partial rows", async () => {
    const before = { users: count("users"), coaches: count("coaches") };
    for (const email of [NEW_EMAIL, NEW_EMAIL.toUpperCase(), "COACH1@example.test"]) {
      assert.equal((await call(sa(), "POST", "/api/admin/coaches", { name: "Dup", email, password: NEW_PASSWORD })).status, 409);
    }
    assert.deepEqual({ users: count("users"), coaches: count("coaches") }, before);
  });

  it("list shows the new coach after the fixture coach, ordered by id", async () => {
    const list = await call(sa(), "GET", "/api/admin/coaches");
    assert.deepEqual(list.json.coaches.map((c) => c.email), ["coach1@example.test", NEW_EMAIL]);
    assert.equal(list.json.coaches[1].memberCount, 0);
  });

  it("status route validates input and target", async () => {
    for (const body of [{}, { isActive: "no" }, { isActive: false, role: "coach" }, [], null]) {
      assert.equal((await status(sa(), newUserId, body)).status, 400);
    }
    assert.equal((await status(sa(), 999999, { isActive: false })).status, 404);
    assert.equal((await status(sa(), "abc", { isActive: false })).status, 404);
    assert.equal(userRow(NEW_EMAIL).is_active, 1);
  });

  it("a Coach that still owns Members cannot be deactivated (zero mutation)", async () => {
    const sessionsBefore = count("auth_sessions", `user_id = ${coach1UserId}`);
    assert.ok(sessionsBefore > 0);
    const blocked = await status(sa(), coach1UserId, { isActive: false });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.memberCount, 4);
    assert.equal(userRow("coach1@example.test").is_active, 1);
    assert.equal(count("auth_sessions", `user_id = ${coach1UserId}`), sessionsBefore);
    assert.equal(count("members", "coach_id = 1"), 4);
    assert.equal((await call(c1(), "GET", "/api/members")).status, 200);
  });

  it("super admin accounts cannot be changed through the status route", async () => {
    const sessionsBefore = count("auth_sessions", `user_id = ${saUserId}`);
    for (const isActive of [false, true]) assert.equal((await status(sa(), saUserId, { isActive })).status, 409);
    assert.equal(userRow("superadmin@example.test").is_active, 1);
    assert.equal(count("auth_sessions", `user_id = ${saUserId}`), sessionsBefore);
  });

  it("zero-Member Coach: deactivation purges sessions, blocks login, old token stays dead after reactivation", async () => {
    const oldCookie = jars[NEW_EMAIL];
    assert.ok(count("auth_sessions", `user_id = ${newUserId}`) > 0);
    const beforeRow = userRow(NEW_EMAIL);
    await sleep(1100); // updated_at has second resolution

    const off = await status(sa(), newUserId, { isActive: false });
    assert.equal(off.status, 200);
    responses.push(off.text);
    assert.deepEqual(off.json.user, { id: newUserId, role: "coach", email: NEW_EMAIL, isActive: false });
    const afterRow = userRow(NEW_EMAIL);
    assert.equal(afterRow.is_active, 0);
    assert.notEqual(afterRow.updated_at, beforeRow.updated_at);
    assert.equal(count("auth_sessions", `user_id = ${newUserId}`), 0);
    assert.equal((await call(oldCookie, "GET", "/api/auth/me")).status, 401);
    assert.equal((await rawLogin(NEW_EMAIL)).status, 401);

    // Idempotent: same status again is a 200 with no side effects.
    await sleep(1100);
    const again = await status(sa(), newUserId, { isActive: false });
    assert.equal(again.status, 200);
    assert.equal(userRow(NEW_EMAIL).updated_at, afterRow.updated_at);

    const on = await status(sa(), newUserId, { isActive: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.user.isActive, true);
    assert.equal(count("auth_sessions", `user_id = ${newUserId}`), 0); // reactivation creates no sessions
    assert.equal((await call(oldCookie, "GET", "/api/auth/me")).status, 401);
    assert.equal((await rawLogin(NEW_EMAIL)).status, 200);
  });

  it("Member: deactivation purges sessions and blocks login, profile and Coach access retained, reactivation needs fresh login", async () => {
    const oldCookie = m1();
    assert.ok(count("auth_sessions", `user_id = ${member1UserId}`) > 0);
    const off = await status(sa(), member1UserId, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.user.isActive, false);
    responses.push(off.text);
    assert.equal(count("auth_sessions", `user_id = ${member1UserId}`), 0);
    assert.equal((await call(oldCookie, "GET", "/api/auth/me")).status, 401);
    assert.equal((await rawLogin("member1@example.test")).status, 401);

    assert.equal(count("members", `id = 1 AND user_id = ${member1UserId} AND coach_id = 1`), 1); // profile retained
    const roster = await call(c1(), "GET", "/api/members");
    assert.equal(roster.status, 200);
    assert.ok(roster.json.members.some((m) => m.id === 1));
    assert.equal((await call(c1(), "GET", "/api/sessions?memberId=1&limit=5")).status, 200);

    assert.equal((await status(sa(), member1UserId, { isActive: true })).status, 200);
    assert.equal((await call(oldCookie, "GET", "/api/auth/me")).status, 401);
    assert.equal((await rawLogin("member1@example.test")).status, 200);
  });

  it("responses never expose credentials, tokens, notes, cycles or body measurements", () => {
    assert.ok(responses.length >= 4);
    for (const text of responses) {
      for (const needle of ["passwordHash", "password_hash", "pbkdf2", "tokenHash", "token", "note", "muscle", "cycle", "pms", "weightKg", "heightCm", "phone"]) {
        assert.equal(text.toLowerCase().includes(needle.toLowerCase()), false, `response leaked "${needle}"`);
      }
    }
  });
});
