/**
 * LOCAL ONLY. Super Admin Member-management regression suite (SEC0H2): real
 * built Worker + real local D1 (`.wrangler/state`), no mocks, Node's built-in
 * test runner.
 *
 *   npm run build && npm run test:admin-members
 *
 * Covers the Member list, login provisioning for profile-only Members and
 * assignment/reassignment, including how Session and Cycle access follow a
 * reassignment made through the real endpoint. Requires the clean local
 * baseline (6 users all active, 1 coach, 4 members on coach 1, no sessions,
 * cycles or auth sessions) and refuses to run otherwise. Temporary rows use
 * the `@adminmembers.example.test` domain or the `AdminMembersTest` name
 * prefix; cleanup always restores the baseline, pass or fail.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, one, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.ADMIN_MEMBERS_TEST_PORT ?? "8798";
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "@adminmembers.example.test";
const PREFIX = "AdminMembersTest";
const COACH_B_EMAIL = `coach.b${DOMAIN}`;
const COACH_B_PASSWORD = "CoachBPassword123!";
const P_EMAIL_INPUT = `  Provisioned.Member${DOMAIN.toUpperCase()} `; // padded + mixed case on purpose
const P_EMAIL = `provisioned.member${DOMAIN}`;
const P_PASSWORD = "ProvisionedPass123!";
const Q_EMAIL = `coach.created${DOMAIN}`;
const Q_PASSWORD = "CoachCreatedPass123!";

if (process.argv.includes("--remote")) throw new Error("test-admin-members is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");


function cleanup() {
  sql(
    `DELETE FROM auth_sessions; DELETE FROM session_notes; DELETE FROM session_muscles; ` +
      `DELETE FROM sessions WHERE replacement_for_id IS NOT NULL; DELETE FROM sessions; DELETE FROM member_cycles; ` +
      `UPDATE members SET coach_id = 1 WHERE user_id IS NOT NULL AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%${DOMAIN}'); ` +
      `DELETE FROM members WHERE name LIKE '${PREFIX}%'; ` +
      `DELETE FROM coaches WHERE name LIKE '${PREFIX}%' OR user_id IN (SELECT id FROM users WHERE email LIKE '%${DOMAIN}'); ` +
      `DELETE FROM users WHERE email LIKE '%${DOMAIN}'; UPDATE users SET is_active = 1; UPDATE members SET coach_id = 1;`
  );
}

const passwords = {
  "coach1@example.test": "LocalCoach123!",
  "member1@example.test": "LocalMember123!",
  "superadmin@example.test": "LocalAdmin123!",
  [COACH_B_EMAIL]: COACH_B_PASSWORD,
  [P_EMAIL]: P_PASSWORD,
  [Q_EMAIL]: Q_PASSWORD,
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

// Tehran "today" and day arithmetic, so recent Sessions stay inside the 30-day detail window.
function dateKeyDaysAgo(days) {
  const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(new Date());
  const [y, m, d] = now.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

const newMember = (name) => ({ name, phone: "09120000000", weightKg: 60, heightCm: 170, goal: "fitness", defaultStartTime: "09:00", defaultDurationMinutes: 50, preferredDays: ["Sat"] });

let server;
let baselineVerified = false; // cleanup only ever runs after the baseline was proven
installSuiteGuard("test-admin-members", 300_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};

describe("Admin Member management regression", () => {
  before(async () => {
    const baseline = { users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
      member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
      auth_sessions: count("auth_sessions"), onCoach1: count("members", "coach_id = 1") };
    assert.deepEqual(baseline, { users: 6, activeUsers: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, onCoach1: 4 },
      `Unexpected local D1 baseline: ${JSON.stringify(baseline)}`);
    baselineVerified = true;

    server = await startWorker(PORT);
    for (const email of ["coach1@example.test", "member1@example.test", "superadmin@example.test"]) jars[email] = await login(email);
  });

  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    const final = { users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
      member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
      auth_sessions: count("auth_sessions"), onCoach1: count("members", "coach_id = 1") };
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, { users: 6, activeUsers: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, onCoach1: 4 });
  });

  const SA = () => jars["superadmin@example.test"];
  const A = () => jars["coach1@example.test"];
  const B = () => jars[COACH_B_EMAIL];
  const M1 = () => jars["member1@example.test"];
  const list = async () => (await call(SA(), "GET", "/api/admin/members")).json.members;
  const byId = async (id) => (await list()).find((m) => m.id === id);
  const account = (cookie, id, body) => call(cookie, "POST", `/api/admin/members/${id}/account`, body);
  const assign = (cookie, id, body) => call(cookie, "PATCH", `/api/admin/members/${id}/assignment`, body);
  const status = (id, isActive) => call(SA(), "PATCH", `/api/admin/users/${id}/status`, { isActive });
  const history = async (cookie) => (await call(cookie, "GET", "/api/sessions?memberId=1&limit=50")).json?.sessions ?? null;
  const ids = (rows) => (rows ?? []).map((s) => s.id).sort((a, b) => a - b);
  const responses = [];

  let coachAId, coachBId, coachBUserId, pId, qId, pUserId, s1, r1, absent1, cycleId, sessionsSnapshot, cycleSnapshot;

  it("unauthenticated, Coach and Member are denied on every Member admin route, with no mutation", async () => {
    const before = { users: count("users"), members: count("members"), onCoach1: count("members", "coach_id = 1"), linked: count("members", "user_id IS NOT NULL") };
    for (const [cookie, expected] of [[null, 401], [A(), 403], [M1(), 403]]) {
      assert.equal((await call(cookie, "GET", "/api/admin/members")).status, expected);
      assert.equal((await account(cookie, 2, { email: `x${DOMAIN}`, password: "longenough123" })).status, expected);
      assert.equal((await assign(cookie, 2, { coachId: 1 })).status, expected);
    }
    assert.deepEqual({ users: count("users"), members: count("members"), onCoach1: count("members", "coach_id = 1"), linked: count("members", "user_id IS NOT NULL") }, before);
  });

  it("list: narrow projection, ordered by id, linked fixtures show account values", async () => {
    const res = await call(SA(), "GET", "/api/admin/members");
    assert.equal(res.status, 200);
    responses.push(res.text);
    assert.equal(res.json.members.length, 4);
    assert.deepEqual(res.json.members.map((m) => m.id), [...res.json.members.map((m) => m.id)].sort((a, b) => a - b));
    for (const m of res.json.members) assert.deepEqual(Object.keys(m).sort(), ["coach", "email", "id", "isActive", "name", "userId"]);
    for (const m of res.json.members) assert.deepEqual(Object.keys(m.coach).sort(), ["id", "name"]);
    const m1 = res.json.members.find((m) => m.id === 1);
    assert.equal(m1.email, "member1@example.test");
    assert.equal(m1.isActive, true);
    assert.equal(typeof m1.userId, "number");
    assert.equal(m1.coach.id, 1);
    coachAId = 1;
  });

  it("setup: Coach B is created through the admin API", async () => {
    const created = await call(SA(), "POST", "/api/admin/coaches", { name: `${PREFIX} Coach B`, email: COACH_B_EMAIL, password: COACH_B_PASSWORD });
    assert.equal(created.status, 201);
    coachBId = created.json.coach.id;
    coachBUserId = created.json.coach.userId;
    jars[COACH_B_EMAIL] = await login(COACH_B_EMAIL);
  });

  it("Super Admin POST /api/members still requires coachId and creates a profile-only Member", async () => {
    assert.equal((await call(SA(), "POST", "/api/members", newMember(`${PREFIX} NoCoach`))).status, 400);
    assert.equal(count("members", `name = '${PREFIX} NoCoach'`), 0);
    const created = await call(SA(), "POST", "/api/members", { ...newMember(`${PREFIX} Profile Only`), coachId: coachAId });
    assert.equal(created.status, 201);
    pId = created.json.member.id;
    assert.equal(one(`SELECT user_id FROM members WHERE id = ${pId}`).user_id, null);
  });

  it("Coach-created Member stays profile-only and is assigned to the Coach; no admin create route exists", async () => {
    const created = await call(A(), "POST", "/api/members", newMember(`${PREFIX} Coach Created`));
    assert.equal(created.status, 201);
    qId = created.json.member.id;
    assert.deepEqual(one(`SELECT coach_id, user_id FROM members WHERE id = ${qId}`), { coach_id: coachAId, user_id: null });
    assert.equal((await call(SA(), "POST", "/api/admin/members", { name: "x", coachId: 1 })).status, 405);
  });

  it("list shows profile-only Members with null account values", async () => {
    for (const id of [pId, qId]) {
      const row = await byId(id);
      assert.equal(row.userId, null);
      assert.equal(row.email, null);
      assert.equal(row.isActive, null);
      assert.equal(row.coach.id, coachAId);
    }
  });

  it("provision validation: bad bodies, missing Member, already-linked Member; no writes", async () => {
    const before = { users: count("users"), members: count("members"), linked: count("members", "user_id IS NOT NULL") };
    const good = { email: P_EMAIL, password: P_PASSWORD };
    for (const body of [
      { ...good, role: "coach" }, { ...good, isActive: false }, { ...good, userId: 1 }, { ...good, email: "no-at-sign" }, { ...good, email: 5 },
      { ...good, password: "short" }, { ...good, password: 1234567890123 }, { email: P_EMAIL }, [], "x",
    ]) assert.equal((await account(SA(), pId, body)).status, 400);
    assert.equal((await account(SA(), 999999, good)).status, 404);
    assert.equal((await account(SA(), "abc", good)).status, 404);
    assert.equal((await account(SA(), 1, { email: `other${DOMAIN}`, password: P_PASSWORD })).status, 409); // Member 1 already has a login
    assert.deepEqual({ users: count("users"), members: count("members"), linked: count("members", "user_id IS NOT NULL") }, before);
    assert.equal(one("SELECT email FROM users WHERE id = (SELECT user_id FROM members WHERE id = 1)").email, "member1@example.test");
  });

  it("provision: normalized email, hashed password, links the existing profile, no duplicate Member row", async () => {
    const membersBefore = count("members");
    const created = await account(SA(), pId, { email: P_EMAIL_INPUT, password: P_PASSWORD });
    assert.equal(created.status, 201);
    responses.push(created.text);
    const { member } = created.json;
    assert.deepEqual(Object.keys(member).sort(), ["coach", "email", "id", "isActive", "name", "userId"]);
    assert.equal(member.id, pId);
    assert.equal(member.email, P_EMAIL);
    assert.equal(member.isActive, true);
    assert.deepEqual(member.coach, { id: coachAId, name: member.coach.name });
    pUserId = member.userId;

    const user = one(`SELECT id, role, email, password_hash, is_active FROM users WHERE email = '${P_EMAIL}'`);
    assert.deepEqual({ id: user.id, role: user.role, is_active: user.is_active }, { id: pUserId, role: "member", is_active: 1 });
    assert.ok(user.password_hash.startsWith("pbkdf2-sha256$v=1$i=100000$") && !user.password_hash.includes(P_PASSWORD));
    assert.equal(count("members"), membersBefore);
    assert.equal(count("members", `id = ${pId} AND user_id = ${pUserId}`), 1);
    const row = await byId(pId);
    assert.deepEqual({ userId: row.userId, email: row.email, isActive: row.isActive, id: row.id }, { userId: pUserId, email: P_EMAIL, isActive: true, id: pId });
  });

  it("provisioned Member can log in as a member and /api/members/me resolves the pre-existing profile", async () => {
    const response = await rawLogin(P_EMAIL_INPUT);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user?.role ?? "member", "member");
    jars[P_EMAIL] = await login(P_EMAIL);
    const me = await call(jars[P_EMAIL], "GET", "/api/members/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.member.id, pId);
    assert.equal(me.json.member.name, `${PREFIX} Profile Only`);
    assert.equal(count("members"), 6);
  });

  it("second provision attempt is 409 with no second User and unchanged linkage", async () => {
    const users = count("users");
    assert.equal((await account(SA(), pId, { email: `second${DOMAIN}`, password: P_PASSWORD })).status, 409);
    assert.equal((await account(SA(), pId, { email: P_EMAIL, password: P_PASSWORD })).status, 409);
    assert.equal(count("users"), users);
    assert.equal(count("members", `id = ${pId} AND user_id = ${pUserId}`), 1);
  });

  it("duplicate email (any case) is 409; Member stays unlinked; no new User", async () => {
    const users = count("users");
    for (const email of [P_EMAIL, P_EMAIL.toUpperCase(), "COACH1@example.test"]) {
      assert.equal((await account(SA(), qId, { email, password: Q_PASSWORD })).status, 409);
    }
    assert.equal(count("users"), users);
    assert.equal(one(`SELECT user_id FROM members WHERE id = ${qId}`).user_id, null);
    assert.equal((await byId(qId)).isActive, null);
  });

  it("Coach-created Member can then be provisioned by Super Admin, keeping its Coach", async () => {
    const created = await account(SA(), qId, { email: Q_EMAIL, password: Q_PASSWORD });
    assert.equal(created.status, 201);
    responses.push(created.text);
    assert.equal(created.json.member.id, qId);
    assert.equal(created.json.member.coach.id, coachAId);
    jars[Q_EMAIL] = await login(Q_EMAIL);
    assert.equal((await call(jars[Q_EMAIL], "GET", "/api/members/me")).json.member.id, qId);
  });

  it("linked Member deactivation shows in the list, keeping Member row, Coach and email", async () => {
    const off = await status(pUserId, false);
    assert.equal(off.status, 200);
    const row = await byId(pId);
    assert.deepEqual({ isActive: row.isActive, email: row.email, coachId: row.coach.id, userId: row.userId }, { isActive: false, email: P_EMAIL, coachId: coachAId, userId: pUserId });
    assert.equal((await byId(qId)).isActive, true);
    assert.equal((await status(pUserId, true)).status, 200);
    assert.equal((await byId(pId)).isActive, true);
  });

  it("assignment validation: bad bodies 400, missing Member 404, missing Coach 404, unlinked Coach 409", async () => {
    for (const body of [{}, { coachId: "2" }, { coachId: 0 }, { coachId: 1.5 }, { coachId: coachBId, name: "x" }, { coachId: null }, [], "x"]) {
      assert.equal((await assign(SA(), pId, body)).status, 400);
    }
    assert.equal((await assign(SA(), 999999, { coachId: coachBId })).status, 404);
    assert.equal((await assign(SA(), "abc", { coachId: coachBId })).status, 404);
    assert.equal((await assign(SA(), pId, { coachId: 999999 })).status, 404);
    sql(`INSERT INTO coaches (user_id, name) VALUES (NULL, '${PREFIX} Legacy');`);
    const legacyId = one(`SELECT id FROM coaches WHERE name = '${PREFIX} Legacy'`).id;
    assert.equal((await assign(SA(), pId, { coachId: legacyId })).status, 409);
    sql(`DELETE FROM coaches WHERE id = ${legacyId};`);
    assert.equal(one(`SELECT coach_id FROM members WHERE id = ${pId}`).coach_id, coachAId);
  });

  it("assignment to an inactive Coach is 409 with no mutation; reactivated Coach works", async () => {
    assert.equal((await status(coachBUserId, false)).status, 200);
    const before = sql("SELECT id, coach_id FROM members ORDER BY id");
    const denied = await assign(SA(), pId, { coachId: coachBId });
    assert.equal(denied.status, 409);
    assert.deepEqual(sql("SELECT id, coach_id FROM members ORDER BY id"), before);
    assert.equal((await status(coachBUserId, true)).status, 200);
    jars[COACH_B_EMAIL] = await login(COACH_B_EMAIL); // deactivation purged the old session
  });

  it("setup: Coach A history for Member 1 (Session, note, muscles, pending replacement) and a Member Cycle", async () => {
    const created = await call(A(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKeyDaysAgo(3) });
    assert.equal(created.status, 201);
    s1 = created.json.session.id;
    assert.equal(created.json.session.coachId, coachAId);
    assert.equal((await call(A(), "PUT", `/api/sessions/${s1}/note`, { note: "S1 note" })).status, 200);
    assert.equal((await call(A(), "PUT", `/api/sessions/${s1}/muscles`, { muscles: ["chest"] })).status, 200);
    const absence = await call(A(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKeyDaysAgo(6), replacementDateKey: dateKeyDaysAgo(2), replacementTime: "09:00" });
    assert.equal(absence.status, 201);
    absent1 = absence.json.absentSession.id;
    r1 = absence.json.replacementSession.id;
    const cycle = await call(M1(), "POST", "/api/members/me/cycles", { periodStart: "2025-01-10", periodEnd: "2025-01-14", pmsStart: "2025-01-01", pmsEnd: "2025-01-08" });
    assert.equal(cycle.status, 201);
    cycleId = cycle.json.cycle.id;

    assert.equal((await call(A(), "GET", "/api/members/1/cycles")).status, 200);
    assert.equal((await call(B(), "GET", "/api/members/1/cycles")).status, 404);
    assert.deepEqual(ids(await history(B())), []);
    assert.equal((await call(SA(), "GET", "/api/members/1/cycles")).status, 403);
  });

  it("reassign A -> B through the endpoint: only members.coach_id changes", async () => {
    sessionsSnapshot = sql("SELECT * FROM sessions ORDER BY id");
    cycleSnapshot = sql("SELECT * FROM member_cycles ORDER BY id");
    const usersSnapshot = sql("SELECT * FROM users ORDER BY id");
    const noteSnapshot = sql("SELECT * FROM session_notes ORDER BY id");
    const muscleSnapshot = sql("SELECT * FROM session_muscles ORDER BY id");
    const memberBefore = one("SELECT * FROM members WHERE id = 1");

    const moved = await assign(SA(), 1, { coachId: coachBId });
    assert.equal(moved.status, 200);
    responses.push(moved.text);
    assert.deepEqual(Object.keys(moved.json.member).sort(), ["coach", "email", "id", "isActive", "name", "userId"]);
    assert.equal(moved.json.member.coach.id, coachBId);
    assert.equal(moved.json.member.email, "member1@example.test");

    assert.deepEqual({ ...one("SELECT * FROM members WHERE id = 1") }, { ...memberBefore, coach_id: coachBId });
    assert.deepEqual(sql("SELECT * FROM sessions ORDER BY id"), sessionsSnapshot);
    assert.deepEqual(sql("SELECT * FROM member_cycles ORDER BY id"), cycleSnapshot);
    assert.deepEqual(sql("SELECT * FROM users ORDER BY id"), usersSnapshot);
    assert.deepEqual(sql("SELECT * FROM session_notes ORDER BY id"), noteSnapshot);
    assert.deepEqual(sql("SELECT * FROM session_muscles ORDER BY id"), muscleSnapshot);
    assert.equal(count("sessions", `id IN (${s1}, ${r1}, ${absent1}) AND coach_id <> ${coachAId}`), 0);
  });

  it("no-op assignment returns 200 with the current representation and mutates nothing", async () => {
    const before = sql("SELECT * FROM members ORDER BY id");
    const again = await assign(SA(), 1, { coachId: coachBId });
    assert.equal(again.status, 200);
    assert.equal(again.json.member.coach.id, coachBId);
    assert.deepEqual(sql("SELECT * FROM members ORDER BY id"), before);
  });

  it("Session visibility follows the new Coach; attribution stays with A", async () => {
    assert.deepEqual(await history(A()), []);
    for (const id of [s1, r1]) {
      assert.equal((await call(A(), "GET", `/api/sessions/${id}/note`)).status, 404);
      assert.equal((await call(A(), "GET", `/api/sessions/${id}/muscles`)).status, 404);
    }
    const mine = ids(await history(B()));
    for (const id of [s1, r1, absent1]) assert.ok(mine.includes(id), `B history missing ${id}`);
    assert.equal((await call(B(), "GET", `/api/sessions/${s1}/note`)).json.note.note, "S1 note");
    assert.deepEqual(sql("SELECT * FROM sessions ORDER BY id"), sessionsSnapshot);
  });

  it("pending replacement: A -> 404, B completes it, coach_id and link stay on A", async () => {
    assert.equal((await call(A(), "PATCH", `/api/sessions/${r1}/complete`)).status, 404);
    assert.equal((await call(B(), "PATCH", `/api/sessions/${r1}/complete`)).status, 200);
    assert.deepEqual(one(`SELECT coach_id, replacement_for_id, status FROM sessions WHERE id = ${r1}`), { coach_id: coachAId, replacement_for_id: absent1, status: "completed" });
  });

  it("Cycle/PMS visibility follows the new Coach; rows unchanged; Super Admin still denied", async () => {
    assert.equal((await call(A(), "GET", "/api/members/1/cycles")).status, 404);
    const read = await call(B(), "GET", "/api/members/1/cycles");
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.cycles.map((c) => c.id), [cycleId]);
    assert.deepEqual(sql("SELECT * FROM member_cycles ORDER BY id"), cycleSnapshot);
    assert.equal((await call(SA(), "GET", "/api/members/1/cycles")).status, 403);
  });

  it("new Session after reassignment belongs to B; A gets 404", async () => {
    assert.equal((await call(A(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKeyDaysAgo(10) })).status, 404);
    const created = await call(B(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKeyDaysAgo(10) });
    assert.equal(created.status, 201);
    assert.equal(created.json.session.coachId, coachBId);
  });

  it("new absence pair after reassignment belongs to B; old rows keep A", async () => {
    const absence = await call(B(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKeyDaysAgo(13), replacementDateKey: dateKeyDaysAgo(12), replacementTime: "09:00" });
    assert.equal(absence.status, 201);
    assert.equal(absence.json.absentSession.coachId, coachBId);
    assert.equal(absence.json.replacementSession.coachId, coachBId);
    assert.equal(count("sessions", `coach_id = ${coachAId}`), 3);
    assert.equal(count("sessions", `coach_id = ${coachBId}`), 3);
  });

  it("list reflects the reassignment; non-admins remain denied after it", async () => {
    assert.equal((await byId(1)).coach.id, coachBId);
    assert.equal((await call(A(), "GET", "/api/admin/members")).status, 403);
    assert.equal((await assign(B(), 1, { coachId: coachAId })).status, 403);
    assert.equal((await account(M1(), qId, { email: `z${DOMAIN}`, password: P_PASSWORD })).status, 403);
    assert.equal(one("SELECT coach_id FROM members WHERE id = 1").coach_id, coachBId);
  });

  it("admin Member responses never expose credentials, tokens, notes, cycles or body data", () => {
    assert.ok(responses.length >= 4);
    for (const text of responses) {
      for (const needle of ["passwordHash", "password_hash", "pbkdf2", "tokenHash", "token", "note", "muscle", "cycle", "pms", "weightKg", "heightCm", "phone", "goal", "preferredDays", "photoUrl", P_PASSWORD]) {
        assert.equal(text.toLowerCase().includes(needle.toLowerCase()), false, `response leaked "${needle}"`);
      }
    }
  });
});
