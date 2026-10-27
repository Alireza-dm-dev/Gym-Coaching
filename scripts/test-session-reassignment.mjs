/**
 * LOCAL ONLY. Session authorization across Member reassignment (SEC0H1.6):
 * real built Worker + real local D1 (`.wrangler/state`), no mocks, Node's
 * built-in test runner.
 *
 *   npm run build && npm run test:session-reassignment
 *
 * Coach A is fixture coach 1; Coach B is a temporary Coach. There is no
 * reassignment API yet, so the test moves Member 1 by updating
 * `members.coach_id` directly, exactly what the future endpoint will do.
 * Requires the clean local baseline (6 users, 1 coach, 4 members, no
 * sessions/cycles/auth sessions) and refuses to run otherwise. Cleanup always
 * restores all Members to coach 1 and removes every temporary row.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, one, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.SESSION_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const COACH_B_EMAIL = "coach.b.sessiontest@example.test";

if (process.argv.includes("--remote")) throw new Error("test-session-reassignment is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");


function cleanup() {
  sql(
    `DELETE FROM auth_sessions; DELETE FROM session_notes; DELETE FROM session_muscles; ` +
      `DELETE FROM sessions WHERE replacement_for_id IS NOT NULL; DELETE FROM sessions; ` +
      `UPDATE members SET coach_id = 1; ` +
      `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email = '${COACH_B_EMAIL}'); ` +
      `DELETE FROM users WHERE email = '${COACH_B_EMAIL}'; UPDATE users SET is_active = 1;`
  );
}

const passwords = {
  "coach1@example.test": "LocalCoach123!",
  [COACH_B_EMAIL]: "LocalCoach123!",
  "member1@example.test": "LocalMember123!",
  "superadmin@example.test": "LocalAdmin123!",
};
async function login(email) {
  const response = await fetchBounded(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: passwords[email] }),
  });
  assert.equal(response.status, 200, `login ${email}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function call(cookie, method, path, body) {
  const response = await fetchBounded(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* empty body */ }
  return { status: response.status, json };
}

// Tehran "today" and day arithmetic, so recent Sessions stay inside the 30-day detail window.
function dateKeyDaysAgo(days) {
  const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(new Date());
  const [y, m, d] = now.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

let server;
let baselineVerified = false; // cleanup only ever runs after the baseline was proven
installSuiteGuard("test-session-reassignment", 240_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};

describe("Session reassignment regression", () => {
  before(async () => {
    const baseline = { users: count("users"), coaches: count("coaches"), members: count("members"), sessions: count("sessions"),
      member_cycles: count("member_cycles"), auth_sessions: count("auth_sessions"), activeUsers: count("users", "is_active = 1"),
      onCoach1: count("members", "coach_id = 1") };
    assert.deepEqual(baseline, { users: 6, coaches: 1, members: 4, sessions: 0, member_cycles: 0, auth_sessions: 0, activeUsers: 6, onCoach1: 4 },
      `Unexpected local D1 baseline: ${JSON.stringify(baseline)}`);
    baselineVerified = true;

    server = await startWorker(PORT);
    sql(`INSERT INTO users (role, email, password_hash) SELECT 'coach', '${COACH_B_EMAIL}', password_hash FROM users WHERE email = 'coach1@example.test'; ` +
      `INSERT INTO coaches (user_id, name) SELECT id, 'Session Test Coach B' FROM users WHERE email = '${COACH_B_EMAIL}';`);
    for (const email of Object.keys(passwords)) jars[email] = await login(email);
  });

  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    const final = { users: count("users"), coaches: count("coaches"), members: count("members"), member_cycles: count("member_cycles"),
      sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
      auth_sessions: count("auth_sessions"), onCoach1: count("members", "coach_id = 1") };
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, { users: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, onCoach1: 4 });
  });

  const A = () => jars["coach1@example.test"];
  const B = () => jars[COACH_B_EMAIL];
  const M = () => jars["member1@example.test"];
  const SA = () => jars["superadmin@example.test"];
  const history = async (cookie) => (await call(cookie, "GET", "/api/sessions?memberId=1&limit=50")).json?.sessions ?? null;
  const ids = (list) => (list ?? []).map((s) => s.id).sort((a, b) => a - b);

  let coachAId, coachBId, s1, r1, absent1, oldPlain, oldReplacement;
  const dayS1 = dateKeyDaysAgo(3);

  it("setup: Coach A creates S1 (+note, muscles) and absence/pending replacement R1, plus old rows beyond retention", async () => {
    coachAId = one("SELECT id FROM coaches WHERE name <> 'Session Test Coach B' LIMIT 1").id;
    coachBId = one("SELECT id FROM coaches WHERE name = 'Session Test Coach B'").id;

    const created = await call(A(), "POST", "/api/sessions", { memberId: 1, dateKey: dayS1 });
    assert.equal(created.status, 201);
    s1 = created.json.session.id;
    assert.equal(created.json.session.coachId, coachAId);
    assert.equal((await call(A(), "PUT", `/api/sessions/${s1}/note`, { note: "S1 original note" })).status, 200);
    assert.equal((await call(A(), "PUT", `/api/sessions/${s1}/muscles`, { muscles: ["chest", "arms"] })).status, 200);

    const absence = await call(A(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKeyDaysAgo(6), replacementDateKey: dateKeyDaysAgo(2), replacementTime: "09:00" });
    assert.equal(absence.status, 201);
    absent1 = absence.json.absentSession.id;
    r1 = absence.json.replacementSession.id;
    assert.equal(absence.json.replacementSession.status, "replacement");

    // Old rows (outside the 30-day detail window), inserted directly for the retention/precedence cases.
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const older = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
    sql(`INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes) VALUES (1, ${coachAId}, '${old}', 'completed', 50), (1, ${coachAId}, '${older}', 'absent', 50);`);
    oldPlain = one(`SELECT id FROM sessions WHERE scheduled_at = '${old}'`).id;
    const oldAbsent = one(`SELECT id FROM sessions WHERE scheduled_at = '${older}'`).id;
    const oldRepl = new Date(Date.now() - 59 * 24 * 3600 * 1000).toISOString();
    sql(`INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes, replacement_for_id) VALUES (1, ${coachAId}, '${oldRepl}', 'completed', 50, ${oldAbsent});`);
    oldReplacement = one(`SELECT id FROM sessions WHERE scheduled_at = '${oldRepl}'`).id;
  });

  it("before reassignment: A sees everything; B sees nothing for the Member", async () => {
    assert.ok(ids(await history(A())).includes(s1) && ids(await history(A())).includes(r1));
    assert.equal((await call(A(), "GET", `/api/sessions/${s1}/note`)).status, 200);
    assert.equal((await call(A(), "GET", `/api/sessions/${s1}/muscles`)).status, 200);
    assert.deepEqual(await history(B()), []);
    assert.equal((await call(B(), "GET", `/api/sessions/${s1}/note`)).status, 404);
    assert.equal((await call(B(), "GET", `/api/sessions/${s1}/muscles`)).status, 404);
    assert.equal((await call(B(), "PATCH", `/api/sessions/${r1}/complete`)).status, 404);
  });

  it("reassign Member 1 A -> B by changing members.coach_id only (no session rewrite)", () => {
    const before = sql("SELECT id, coach_id FROM sessions ORDER BY id");
    sql(`UPDATE members SET coach_id = ${coachBId} WHERE id = 1;`);
    assert.deepEqual(sql("SELECT id, coach_id FROM sessions ORDER BY id"), before);
  });

  it("after reassignment, former Coach A has no access at all", async () => {
    assert.deepEqual(await history(A()), []);
    const from = dateKeyDaysAgo(10), to = dateKeyDaysAgo(0);
    assert.equal(ids((await call(A(), "GET", `/api/sessions?from=${from}&to=${to}`)).json.sessions).length, 0);
    for (const id of [s1, r1]) {
      assert.equal((await call(A(), "GET", `/api/sessions/${id}/note`)).status, 404);
      assert.equal((await call(A(), "GET", `/api/sessions/${id}/muscles`)).status, 404);
      assert.equal((await call(A(), "PUT", `/api/sessions/${id}/note`, { note: "nope" })).status, 404);
      assert.equal((await call(A(), "PUT", `/api/sessions/${id}/muscles`, { muscles: ["core"] })).status, 404);
    }
    assert.equal((await call(A(), "PATCH", `/api/sessions/${r1}/complete`)).status, 404);
    assert.equal((await call(A(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKeyDaysAgo(20) })).status, 404);
    assert.equal((await call(A(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKeyDaysAgo(21), replacementDateKey: dateKeyDaysAgo(20), replacementTime: "09:00" })).status, 404);
  });

  it("after reassignment, current Coach B reads full history, notes and muscles", async () => {
    const list = ids(await history(B()));
    for (const id of [s1, r1, absent1]) assert.ok(list.includes(id), `history missing ${id}`);
    const from = dateKeyDaysAgo(10), to = dateKeyDaysAgo(0);
    assert.ok(ids((await call(B(), "GET", `/api/sessions?from=${from}&to=${to}`)).json.sessions).includes(s1));
    const note = await call(B(), "GET", `/api/sessions/${s1}/note`);
    assert.equal(note.status, 200);
    assert.equal(note.json.note.note, "S1 original note");
    assert.deepEqual((await call(B(), "GET", `/api/sessions/${s1}/muscles`)).json.muscles, ["chest", "arms"]);
  });

  it("historical writes: B is 403 on A's ordinary completed Session (unchanged data); precedence 404 > 403 > 409", async () => {
    assert.equal((await call(B(), "PUT", `/api/sessions/${s1}/note`, { note: "B edit" })).status, 403);
    assert.equal((await call(B(), "PUT", `/api/sessions/${s1}/muscles`, { muscles: ["core"] })).status, 403);
    assert.equal((await call(B(), "GET", `/api/sessions/${s1}/note`)).json.note.note, "S1 original note");
    assert.deepEqual((await call(B(), "GET", `/api/sessions/${s1}/muscles`)).json.muscles, ["chest", "arms"]);
    // Old (beyond retention) ordinary Session: authorization is decided before retention.
    assert.equal((await call(B(), "PUT", `/api/sessions/${oldPlain}/note`, { note: "x" })).status, 403);
    assert.equal((await call(A(), "PUT", `/api/sessions/${oldPlain}/note`, { note: "x" })).status, 404);
  });

  it("pending replacement: B cannot write detail yet (lifecycle 409), then completes it; coachId and link are untouched", async () => {
    assert.equal((await call(B(), "PUT", `/api/sessions/${r1}/note`, { note: "too early" })).status, 409);
    assert.equal((await call(M(), "PATCH", `/api/sessions/${r1}/complete`)).status, 403);
    const done = await call(B(), "PATCH", `/api/sessions/${r1}/complete`);
    assert.equal(done.status, 200);
    assert.equal(done.json.session.status, "completed");
    const row = one(`SELECT coach_id, replacement_for_id, status FROM sessions WHERE id = ${r1}`);
    assert.deepEqual(row, { coach_id: coachAId, replacement_for_id: absent1, status: "completed" });
    assert.equal((await call(B(), "PATCH", `/api/sessions/${r1}/complete`)).status, 409); // already completed
  });

  it("completed former replacement: B may write Note/Muscles, A stays 404, retention still applies", async () => {
    assert.equal((await call(B(), "PUT", `/api/sessions/${r1}/note`, { note: "completed by B" })).status, 200);
    assert.equal((await call(B(), "PUT", `/api/sessions/${r1}/muscles`, { muscles: ["glutes"] })).status, 200);
    assert.equal(one(`SELECT note FROM session_notes WHERE session_id = ${r1}`).note, "completed by B");
    assert.equal(one(`SELECT muscle FROM session_muscles WHERE session_id = ${r1}`).muscle, "glutes");
    assert.equal(one(`SELECT coach_id FROM sessions WHERE id = ${r1}`).coach_id, coachAId);
    assert.equal((await call(A(), "PUT", `/api/sessions/${r1}/note`, { note: "A edit" })).status, 404);
    // Outside the 30-day window the exception does not bypass retention.
    assert.equal((await call(B(), "PUT", `/api/sessions/${oldReplacement}/note`, { note: "late" })).status, 409);
    assert.equal((await call(B(), "PUT", `/api/sessions/${oldReplacement}/muscles`, { muscles: ["core"] })).status, 409);
  });

  it("duplicate checks are Member-wide across Coaches", async () => {
    assert.equal((await call(B(), "POST", "/api/sessions", { memberId: 1, dateKey: dayS1 })).status, 409);
    assert.equal((await call(B(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dayS1, replacementDateKey: dateKeyDaysAgo(1), replacementTime: "09:00" })).status, 409);
    // Replacement time already used by A's R1 (same member, same instant).
    assert.equal((await call(B(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKeyDaysAgo(8), replacementDateKey: dateKeyDaysAgo(2), replacementTime: "09:00" })).status, 409);
  });

  it("new Session and new absence/replacement pair after reassignment belong to B", async () => {
    const created = await call(B(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKeyDaysAgo(10) });
    assert.equal(created.status, 201);
    assert.equal(created.json.session.coachId, coachBId);
    const absence = await call(B(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKeyDaysAgo(13), replacementDateKey: dateKeyDaysAgo(12), replacementTime: "09:00" });
    assert.equal(absence.status, 201);
    assert.equal(absence.json.absentSession.coachId, coachBId);
    assert.equal(absence.json.replacementSession.coachId, coachBId);
    assert.equal(count("sessions", `coach_id = ${coachBId}`), 3);
  });

  it("Member keeps full own history; Super Admin behaviour is unchanged", async () => {
    const mine = ids(await history(M()));
    for (const id of [s1, r1, absent1, oldPlain, oldReplacement]) assert.ok(mine.includes(id), `member history missing ${id}`);
    assert.equal((await call(M(), "PUT", `/api/sessions/${s1}/note`, { note: "m" })).status, 403);
    const adminList = ids(await history(SA()));
    assert.ok(adminList.includes(s1) && adminList.includes(r1));
    assert.equal((await call(SA(), "GET", `/api/sessions/${s1}/note`)).status, 200);
    assert.equal((await call(SA(), "PUT", `/api/sessions/${s1}/note`, { note: "admin edit" })).status, 200);
    assert.equal((await call(SA(), "GET", "/api/members/1/cycles")).status, 403); // Cycle/PMS still denied
  });

  it("historical sessions.coach_id was never rewritten", () => {
    assert.equal(count("sessions", `id IN (${s1}, ${r1}, ${absent1}, ${oldPlain}, ${oldReplacement}) AND coach_id <> ${coachAId}`), 0);
  });
});
