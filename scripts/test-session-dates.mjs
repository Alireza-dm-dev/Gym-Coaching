/**
 * LOCAL ONLY. Future-date protection for Session attendance writes (SEC0I3):
 * real built Worker + real local D1, no mocks, Node's built-in test runner.
 *
 *   npm run build && npm run test:session-dates
 *
 * Attendance (normal completion, the ORIGINAL absence, completing a replacement)
 * can only happen for the Tehran business date or earlier; a replacement may
 * still be SCHEDULED in the future. Requires the clean local baseline and
 * refuses to run otherwise; every Session row is removed afterwards.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, one, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.SESSION_DATES_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const BASELINE = { users: 6, coaches: 1, members: 4, sessions: 0, session_notes: 0, session_muscles: 0, member_cycles: 0, auth_sessions: 0, onCoach1: 4 };

if (process.argv.includes("--remote")) throw new Error("test-session-dates is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const counts = () => ({ users: count("users"), coaches: count("coaches"), members: count("members"), sessions: count("sessions"),
  session_notes: count("session_notes"), session_muscles: count("session_muscles"), member_cycles: count("member_cycles"),
  auth_sessions: count("auth_sessions"), onCoach1: count("members", "coach_id = 1") });
function cleanup() {
  sql("DELETE FROM auth_sessions; DELETE FROM session_notes; DELETE FROM session_muscles; DELETE FROM sessions WHERE replacement_for_id IS NOT NULL; DELETE FROM sessions;");
}

const passwords = { "coach1@example.test": "LocalCoach123!", "member1@example.test": "LocalMember123!" };
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
/** Tehran business date shifted by `days` (negative = past, positive = future). */
function dateKey(days) {
  const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(new Date());
  const [y, m, d] = now.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

let server, baselineVerified = false, coach, member;
installSuiteGuard("test-session-dates", 180_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });

describe("Session future-date guards", () => {
  before(async () => {
    assert.deepEqual(counts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(counts())}`);
    baselineVerified = true;
    server = await startWorker(PORT);
    coach = await login("coach1@example.test");
    member = await login("member1@example.test");
  });
  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    console.log("Final DB:", JSON.stringify(counts()));
    assert.deepEqual(counts(), BASELINE);
  });

  const absence = (memberId, original, replacement, time = "09:00") =>
    call(coach, "POST", "/api/sessions/absence", { memberId, dateKey: original, replacementDateKey: replacement, replacementTime: time });

  it("POST /api/sessions: today and past are allowed, future is 400 and writes nothing", async () => {
    assert.equal((await call(coach, "POST", "/api/sessions", { memberId: 1, dateKey: dateKey(0) })).status, 201);
    assert.equal((await call(coach, "POST", "/api/sessions", { memberId: 2, dateKey: dateKey(-3) })).status, 201);
    const before = count("sessions");
    for (const days of [1, 30]) {
      const response = await call(coach, "POST", "/api/sessions", { memberId: 3, dateKey: dateKey(days) });
      assert.equal(response.status, 400, `+${days}d`);
      assert.match(response.json.error, /future/i);
    }
    assert.equal(count("sessions"), before);
  });

  it("authorization still comes first: no cookie 401, Member 403, even for a future date", async () => {
    assert.equal((await call(undefined, "POST", "/api/sessions", { memberId: 3, dateKey: dateKey(2) })).status, 401);
    assert.equal((await call(member, "POST", "/api/sessions", { memberId: 3, dateKey: dateKey(2) })).status, 403);
    assert.equal((await call(undefined, "POST", "/api/sessions/absence", { memberId: 3, dateKey: dateKey(2), replacementDateKey: dateKey(3), replacementTime: "09:00" })).status, 401);
    assert.equal((await call(member, "PATCH", "/api/sessions/1/complete")).status, 403);
  });

  it("body validation precedes lookup: a future date for an unknown Member is still 400, not 404", async () => {
    assert.equal((await call(coach, "POST", "/api/sessions", { memberId: 9999, dateKey: dateKey(2) })).status, 400);
    assert.equal((await call(coach, "POST", "/api/sessions", { memberId: 9999, dateKey: dateKey(-2) })).status, 404);
  });

  it("POST /api/sessions/absence: past and today originals allowed (replacement may be future); future original is 400", async () => {
    const pastWithFuture = await absence(3, dateKey(-2), dateKey(3));
    assert.equal(pastWithFuture.status, 201);
    assert.equal(pastWithFuture.json.replacementSession.status, "replacement");
    assert.equal((await absence(4, dateKey(0), dateKey(1))).status, 201);
    const before = count("sessions");
    const future = await absence(2, dateKey(1), dateKey(2));
    assert.equal(future.status, 400);
    assert.match(future.json.error, /future/i);
    assert.equal((await absence(2, dateKey(-1), dateKey(-2))).status, 400); // replacement before the absence: unchanged rule
    assert.equal(count("sessions"), before);
  });

  it("PATCH /api/sessions/:id/complete: past and today replacements complete (409 after); a future one is 409 and stays pending", async () => {
    const past = await absence(1, dateKey(-10), dateKey(-5), "10:00");
    const today = await absence(2, dateKey(-9), dateKey(0), "10:00");
    assert.equal(past.status, 201); assert.equal(today.status, 201);
    const pastId = past.json.replacementSession.id, todayId = today.json.replacementSession.id;
    const futureId = one("SELECT id FROM sessions WHERE status = 'replacement' AND member_id = 3").id;

    const done = await call(coach, "PATCH", `/api/sessions/${pastId}/complete`);
    assert.equal(done.status, 200);
    assert.equal(done.json.session.status, "completed");
    assert.notEqual(done.json.session.replacementForId, null);
    assert.equal((await call(coach, "PATCH", `/api/sessions/${todayId}/complete`)).status, 200);
    assert.equal((await call(coach, "PATCH", `/api/sessions/${pastId}/complete`)).status, 409); // already completed

    const future = await call(coach, "PATCH", `/api/sessions/${futureId}/complete`);
    assert.equal(future.status, 409);
    assert.match(future.json.error, /future/i);
    assert.equal(one(`SELECT status FROM sessions WHERE id = ${futureId}`).status, "replacement");
    assert.equal((await call(coach, "PATCH", "/api/sessions/999999/complete")).status, 404);
  });
});
