/**
 * LOCAL ONLY. Persisted Session muscle detail (SEC0J2): the `muscles` projection
 * on both `GET /api/sessions` modes, read-time retention, the muscle write rules,
 * and reassignment. Real built Worker + real local D1, no mocks.
 *
 *   npm run build && npm run test:session-muscles
 *
 * Coach A is fixture coach 1; Coach B is a temporary Coach. Requires the clean
 * local baseline and refuses to run otherwise; every temporary row is removed.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, one, sql, startWorker } from "./test-helpers.mjs";
import { addDaysToDateKey, getAppDateKey, localDateTimeToUtcIso } from "../lib/date-time.ts";

const PORT = process.env.SESSION_MUSCLES_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const COACH_B = "coach.b.muscles@example.test";
const BASELINE = { users: 6, coaches: 1, members: 4, sessions: 0, session_notes: 0, session_muscles: 0, member_cycles: 0, auth_sessions: 0, onCoach1: 4 };
const CANON = ["shoulders", "chest", "arms", "core", "back", "glutes", "quads", "hamstrings", "calves"];

if (process.argv.includes("--remote")) throw new Error("test-session-muscles is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const counts = () => ({ users: count("users"), coaches: count("coaches"), members: count("members"), sessions: count("sessions"),
  session_notes: count("session_notes"), session_muscles: count("session_muscles"), member_cycles: count("member_cycles"),
  auth_sessions: count("auth_sessions"), onCoach1: count("members", "coach_id = 1") });
function cleanup() {
  sql("DELETE FROM auth_sessions; DELETE FROM session_notes; DELETE FROM session_muscles; DELETE FROM sessions WHERE replacement_for_id IS NOT NULL; DELETE FROM sessions; UPDATE members SET coach_id = 1; " +
    `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email = '${COACH_B}'); DELETE FROM users WHERE email = '${COACH_B}';`);
}
const passwords = { "coach1@example.test": "LocalCoach123!", [COACH_B]: "LocalCoach123!", "member1@example.test": "LocalMember123!" };
async function login(email) {
  const response = await fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: passwords[email] }) });
  assert.equal(response.status, 200, `login ${email}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function call(cookie, method, path, body) {
  const response = await fetchBounded(`${BASE}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json(); } catch { /* empty body */ }
  return { status: response.status, json };
}
const TODAY = getAppDateKey();
const dateKey = (days) => addDaysToDateKey(TODAY, days);

let server, baselineVerified = false;
const jar = {};
installSuiteGuard("test-session-muscles", 240_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });

describe("Session muscles (SEC0J2)", () => {
  before(async () => {
    assert.deepEqual(counts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(counts())}`);
    baselineVerified = true;
    server = await startWorker(PORT);
    sql(`INSERT INTO users (role, email, password_hash) SELECT 'coach', '${COACH_B}', password_hash FROM users WHERE email = 'coach1@example.test'; ` +
      `INSERT INTO coaches (user_id, name) SELECT id, 'Muscle Test Coach B' FROM users WHERE email = '${COACH_B}';`);
    for (const email of Object.keys(passwords)) jar[email] = await login(email);
  });
  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    console.log("Final DB:", JSON.stringify(counts()));
    assert.deepEqual(counts(), BASELINE);
  });

  const A = () => jar["coach1@example.test"], B = () => jar[COACH_B], M = () => jar["member1@example.test"];
  const put = (cookie, id, muscles) => call(cookie, "PUT", `/api/sessions/${id}/muscles`, { muscles });
  const history = async (cookie, memberId) => (await call(cookie, "GET", `/api/sessions?memberId=${memberId}&limit=50`)).json.sessions;
  const range = async (cookie, from, to) => (await call(cookie, "GET", `/api/sessions?from=${from}&to=${to}`)).json.sessions;
  const musclesOf = (list, id) => list.find((s) => s.id === id)?.muscles;

  let s1, s2, absentId, replacementId;

  it("completed Session: PUT saves, GET-by-id returns canonical order, whole-set replacement, empty clears", async () => {
    const created = await call(A(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKey(-3) });
    assert.equal(created.status, 201);
    s1 = created.json.session.id;
    const saved = await put(A(), s1, ["calves", "chest", "shoulders"]); // deliberately not canonical
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.muscles, ["shoulders", "chest", "calves"]);
    assert.deepEqual((await call(A(), "GET", `/api/sessions/${s1}/muscles`)).json.muscles, ["shoulders", "chest", "calves"]);
    assert.deepEqual((await put(A(), s1, ["glutes", "arms"])).json.muscles, ["arms", "glutes"]); // replaced, not appended
    assert.equal(count("session_muscles", `session_id = ${s1}`), 2);
    assert.deepEqual((await put(A(), s1, [])).json.muscles, []);
    assert.equal(count("session_muscles", `session_id = ${s1}`), 0);
    assert.deepEqual((await put(A(), s1, ["back", "core", "quads", "hamstrings"])).json.muscles, ["core", "back", "quads", "hamstrings"]);
  });

  it("invalid sets are rejected 400 and never change the stored set", async () => {
    for (const body of [["pecs"], ["chest", "chest"], [1], "chest", undefined]) {
      const response = body === undefined ? await call(A(), "PUT", `/api/sessions/${s1}/muscles`, {}) : await put(A(), s1, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await call(A(), "GET", `/api/sessions/${s1}/muscles`)).json.muscles, ["core", "back", "quads", "hamstrings"]);
  });

  it("both Session GET modes carry muscles[] in canonical order, [] when none, without multiplying rows or losing the note", async () => {
    const second = await call(A(), "POST", "/api/sessions", { memberId: 1, dateKey: dateKey(-2) });
    s2 = second.json.session.id; // no muscles
    assert.equal((await call(A(), "PUT", `/api/sessions/${s1}/note`, { note: "kept" })).status, 200);
    const other = await call(A(), "POST", "/api/sessions", { memberId: 2, dateKey: dateKey(-2) });
    assert.equal((await put(A(), other.json.session.id, ["calves", "shoulders"])).status, 200);

    const rows = await history(A(), 1);
    assert.equal(rows.length, 2);
    assert.deepEqual(musclesOf(rows, s1), ["core", "back", "quads", "hamstrings"]);
    assert.deepEqual(musclesOf(rows, s2), []);
    assert.equal(rows.find((r) => r.id === s1).note.note, "kept");
    const all = await range(A(), dateKey(-5), dateKey(0));
    assert.equal(all.length, 3); // one row per Session, however many muscles
    assert.deepEqual(musclesOf(all, s1), ["core", "back", "quads", "hamstrings"]);
    assert.deepEqual(musclesOf(all, other.json.session.id), ["shoulders", "calves"]); // grouped per Session, no cross-talk
    assert.deepEqual(musclesOf(all, s2), []);
    assert.deepEqual(musclesOf(await range(A(), dateKey(-5), dateKey(0)).then((l) => l.filter((r) => r.memberId === 2)), other.json.session.id), ["shoulders", "calves"]);
    const own = await history(M(), 1);
    assert.deepEqual(musclesOf(own, s1), ["core", "back", "quads", "hamstrings"]); // Member reads their own detail
    for (const row of [...rows, ...all]) assert.ok(row.muscles.every((m) => CANON.includes(m)));
  });

  it("lifecycle: pending replacement and absent rows are 409; the completed replacement is writable and keeps its link", async () => {
    const absence = await call(A(), "POST", "/api/sessions/absence", { memberId: 3, dateKey: dateKey(-9), replacementDateKey: dateKey(-8), replacementTime: "09:00" });
    assert.equal(absence.status, 201);
    absentId = absence.json.absentSession.id; replacementId = absence.json.replacementSession.id;
    assert.equal((await put(A(), replacementId, ["chest"])).status, 409);
    assert.equal((await put(A(), absentId, ["chest"])).status, 409);
    assert.equal((await call(A(), "PATCH", `/api/sessions/${replacementId}/complete`)).status, 200);
    assert.deepEqual((await put(A(), replacementId, ["chest", "arms"])).json.muscles, ["chest", "arms"]);
    const row = (await history(A(), 3)).find((r) => r.id === replacementId);
    assert.deepEqual([row.status, row.replacementForId, row.muscles], ["completed", absentId, ["chest", "arms"]]);
  });

  it("authorization: Member write 403, no cookie 401, unrelated Coach 404 for read and write", async () => {
    assert.equal((await put(M(), s1, ["chest"])).status, 403);
    assert.equal((await put(undefined, s1, ["chest"])).status, 401);
    assert.equal((await call(B(), "GET", `/api/sessions/${s1}/muscles`)).status, 404);
    assert.equal((await put(B(), s1, ["chest"])).status, 404);
    assert.deepEqual(await history(B(), 1), []); // and the projection never leaks another Coach's detail
  });

  it("exact Tehran retention boundary: through D+30 readable/writable; from midnight D+31 hidden and write-blocked (rows not deleted by GET)", async () => {
    const insert = (iso) => { sql(`INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes) VALUES (4, 1, '${iso}', 'completed', 50)`); return one(`SELECT id FROM sessions WHERE scheduled_at = '${iso}'`).id; };
    const lastDay = insert(localDateTimeToUtcIso(dateKey(-30), "00:00")); // Tehran midnight of D = today-30, kept through today
    const expired = insert(localDateTimeToUtcIso(dateKey(-31), "23:59")); // one minute before the cutoff
    assert.equal((await put(A(), lastDay, ["glutes"])).status, 200);
    sql(`INSERT INTO session_muscles (session_id, muscle) VALUES (${expired}, 'chest'), (${expired}, 'back')`);

    assert.deepEqual((await call(A(), "GET", `/api/sessions/${lastDay}/muscles`)).json.muscles, ["glutes"]);
    assert.deepEqual(musclesOf(await history(A(), 4), lastDay), ["glutes"]);

    const byId = await call(A(), "GET", `/api/sessions/${expired}/muscles`);
    assert.deepEqual([byId.status, byId.json.muscles], [200, []]); // never a 409 on read
    assert.deepEqual(musclesOf(await history(A(), 4), expired), []);
    assert.deepEqual(musclesOf(await range(A(), dateKey(-31), dateKey(-31)), expired), []);
    // Notes follow the same read-time rule: hidden on every read surface, rows kept until cron.
    sql(`INSERT INTO session_notes (session_id, note) VALUES (${expired}, 'expired note'), (${lastDay}, 'kept note')`);
    const hist = await history(A(), 4);
    assert.equal(hist.find((r) => r.id === expired).note, null);
    assert.equal(hist.find((r) => r.id === lastDay).note.note, "kept note");
    assert.equal((await range(A(), dateKey(-31), dateKey(-31))).find((r) => r.id === expired).note, null);
    assert.equal((await range(A(), dateKey(-30), dateKey(-30))).find((r) => r.id === lastDay).note.note, "kept note");
    assert.equal((await call(A(), "GET", `/api/sessions/${expired}/note`)).json.note, null);
    assert.equal((await call(A(), "GET", `/api/sessions/${lastDay}/note`)).json.note.note, "kept note");
    assert.equal(count("session_notes", `session_id = ${expired}`), 1); // hidden, not deleted
    assert.equal((await put(A(), expired, ["calves"])).status, 409);
    assert.equal(count("session_muscles", `session_id = ${expired}`), 2); // hidden, not deleted
    assert.equal((await history(A(), 4)).length, 2); // the Session rows themselves remain
  });

  it("reassignment: old Coach 404; new Coach reads retained muscles, ordinary old-Coach Session write 403, completed replacement write allowed; coachId unchanged", async () => {
    const pending = await call(A(), "POST", "/api/sessions/absence", { memberId: 1, dateKey: dateKey(-7), replacementDateKey: dateKey(-6), replacementTime: "09:00" });
    assert.equal(pending.status, 201);
    const pendingId = pending.json.replacementSession.id;
    const before = sql("SELECT id, coach_id FROM sessions ORDER BY id");
    const coachBId = one(`SELECT c.id AS id FROM coaches c JOIN users u ON u.id = c.user_id WHERE u.email = '${COACH_B}'`).id;
    sql(`UPDATE members SET coach_id = ${coachBId} WHERE id = 1`);

    assert.equal((await call(A(), "GET", `/api/sessions/${s1}/muscles`)).status, 404);
    assert.equal((await put(A(), s1, ["chest"])).status, 404);
    assert.deepEqual(await history(A(), 1), []);

    assert.deepEqual((await call(B(), "GET", `/api/sessions/${s1}/muscles`)).json.muscles, ["core", "back", "quads", "hamstrings"]);
    assert.deepEqual(musclesOf(await history(B(), 1), s1), ["core", "back", "quads", "hamstrings"]);
    assert.equal((await put(B(), s1, ["chest"])).status, 403); // ordinary Session of the previous Coach
    assert.equal((await call(B(), "PATCH", `/api/sessions/${pendingId}/complete`)).status, 200);
    assert.deepEqual((await put(B(), pendingId, ["quads"])).json.muscles, ["quads"]); // replacement exception
    assert.deepEqual(sql("SELECT id, coach_id FROM sessions WHERE id IN (SELECT id FROM sessions) ORDER BY id").filter((r) => before.some((b) => b.id === r.id)), before);
  });
});
