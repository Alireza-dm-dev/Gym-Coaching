/**
 * LOCAL ONLY. Period/PMS regression suite: real built Worker + real local D1
 * (`.wrangler/state`), no mocks. Uses Node's built-in test runner.
 *
 *   npm run build && npm run test:cycles
 *
 * Requires the local fixtures (6 users, 1 coach, 4 members, passwords from
 * scripts/seed-local-auth.ts) and a clean baseline; it refuses to run
 * otherwise rather than touching unknown data. All temporary rows are removed
 * and all Members are restored to coach 1 afterwards, pass or fail.
 * Dates are fixed past dates, so results don't depend on today's date.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.CYCLE_TEST_PORT ?? "8798";
const BASE = `http://127.0.0.1:${PORT}`;
const COACH2_EMAIL = "coach2.cycletest@example.test";

if (process.argv.includes("--remote")) throw new Error("test-cycles is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");



function cleanup() {
  sql(
    `UPDATE members SET coach_id = 1; DELETE FROM member_cycles; DELETE FROM auth_sessions; ` +
      `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email = '${COACH2_EMAIL}'); ` +
      `DELETE FROM users WHERE email = '${COACH2_EMAIL}';`
  );
}

const passwords = {
  "coach1@example.test": "LocalCoach123!",
  "coach2.cycletest@example.test": "LocalCoach123!",
  "member1@example.test": "LocalMember123!",
  "member2@example.test": "LocalMember123!",
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
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 or non-JSON */ }
  return { status: response.status, json };
}

const ME = "/api/members/me/cycles";
let server;
let baselineVerified = false; // cleanup only ever runs after the baseline was proven, never on unknown data
installSuiteGuard("test-cycles", 240_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};

describe("Cycle regression", () => {
  before(async () => {
    // Fixture safety: known baseline only.
    const baseline = { users: count("users"), coaches: count("coaches"), members: count("members"),
      member_cycles: count("member_cycles"), auth_sessions: count("auth_sessions") };
    assert.deepEqual(baseline, { users: 6, coaches: 1, members: 4, member_cycles: 0, auth_sessions: 0 },
      `Unexpected local D1 baseline: ${JSON.stringify(baseline)}`);
    baselineVerified = true;

    server = await startWorker(PORT);

    sql(`INSERT INTO users (role, email, password_hash) SELECT 'coach', '${COACH2_EMAIL}', password_hash FROM users WHERE email = 'coach1@example.test'; ` +
      `INSERT INTO coaches (user_id, name) SELECT id, 'Cycle Test Coach 2' FROM users WHERE email = '${COACH2_EMAIL}';`);

    for (const email of Object.keys(passwords)) jars[email] = await login(email);
  });

  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    const final = { users: count("users"), coaches: count("coaches"), members: count("members"), member_cycles: count("member_cycles"),
      sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"), auth_sessions: count("auth_sessions") };
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, { users: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0 });
  });

  const m1 = () => jars["member1@example.test"];
  const m2 = () => jars["member2@example.test"];
  const c1 = () => jars["coach1@example.test"];
  const c2 = () => jars[COACH2_EMAIL];
  const sa = () => jars["superadmin@example.test"];
  const list = async (cookie) => (await call(cookie, "GET", ME)).json.cycles;
  let cycleId;

  it("unauthenticated requests get 401 (Member and Coach endpoints)", async () => {
    assert.equal((await call(null, "GET", ME)).status, 401);
    assert.equal((await call(null, "POST", ME, { periodStart: "2025-01-10" })).status, 401);
    assert.equal((await call(null, "GET", "/api/members/1/cycles")).status, 401);
    assert.equal((await call(null, "PATCH", `${ME}/1`, { periodEnd: "2025-01-12" })).status, 401);
    assert.equal((await call(null, "DELETE", `${ME}/1`)).status, 401);
  });

  it("member own create/read", async () => {
    const created = await call(m1(), "POST", ME, { periodStart: "2025-01-10", periodEnd: "2025-01-14", pmsStart: "2025-01-01", pmsEnd: "2025-01-08" });
    assert.equal(created.status, 201);
    cycleId = created.json.cycle.id;
    assert.equal("memberId" in created.json.cycle, false);
    const cycles = await list(m1());
    assert.deepEqual(cycles.map((c) => c.id), [cycleId]);
  });

  it("member isolation", async () => {
    assert.deepEqual(await list(m2()), []);
  });

  it("member edit own (partial) reflects in GET", async () => {
    const patched = await call(m1(), "PATCH", `${ME}/${cycleId}`, { periodEnd: "2025-01-15" });
    assert.equal(patched.status, 200);
    const [row] = await list(m1());
    assert.equal(row.periodEnd, "2025-01-15");
    assert.equal(row.periodStart, "2025-01-10");
    assert.equal(row.pmsStart, "2025-01-01");
  });

  it("foreign member mutation hidden (404) and changes nothing", async () => {
    const before = await list(m1());
    assert.equal((await call(m2(), "PATCH", `${ME}/${cycleId}`, { periodEnd: "2025-01-12" })).status, 404);
    assert.equal((await call(m2(), "DELETE", `${ME}/${cycleId}`)).status, 404);
    assert.deepEqual(await list(m1()), before);
  });

  it("coach reads currently assigned member; coach and super admin cannot mutate or read via Member routes", async () => {
    const read = await call(c1(), "GET", "/api/members/1/cycles");
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.cycles.map((c) => c.id), [cycleId]);
    const before = await list(m1());
    for (const jar of [c1(), sa()]) {
      assert.equal((await call(jar, "PATCH", `${ME}/${cycleId}`, { periodEnd: "2025-01-12" })).status, 403);
      assert.equal((await call(jar, "DELETE", `${ME}/${cycleId}`)).status, 403);
    }
    assert.deepEqual(await list(m1()), before);
  });

  it("super admin denied on the Coach read route", async () => {
    assert.equal((await call(sa(), "GET", "/api/members/1/cycles")).status, 403);
  });

  it("member cannot use the Coach read route", async () => {
    assert.equal((await call(m1(), "GET", "/api/members/1/cycles")).status, 403);
  });

  it("duplicate periodStart returns 409 and writes nothing", async () => {
    assert.equal((await call(m1(), "POST", ME, { periodStart: "2025-01-10" })).status, 409);
    assert.equal((await list(m1())).length, 1);
    assert.equal((await call(m2(), "POST", ME, { periodStart: "2025-01-10" })).status, 201); // other Member may reuse it
    const [other] = await list(m2());
    assert.equal((await call(m2(), "DELETE", `${ME}/${other.id}`)).status, 204);
  });

  it("invalid PMS final state is rejected (POST and PATCH) without mutation", async () => {
    assert.equal((await call(m1(), "POST", ME, { periodStart: "2025-03-01", pmsStart: "2025-02-20" })).status, 400);
    assert.equal((await list(m1())).length, 1);
    const before = await list(m1());
    assert.equal((await call(m1(), "PATCH", `${ME}/${cycleId}`, { pmsEnd: null })).status, 400);
    assert.deepEqual(await list(m1()), before);
  });

  it("reassignment moves Coach visibility to the current Coach", async () => {
    assert.equal((await call(c1(), "GET", "/api/members/1/cycles")).status, 200);
    assert.equal((await call(c2(), "GET", "/api/members/1/cycles")).status, 404);
    sql(`UPDATE members SET coach_id = (SELECT c.id FROM coaches c JOIN users u ON u.id = c.user_id WHERE u.email = '${COACH2_EMAIL}') WHERE id = 1;`);
    assert.equal((await call(c1(), "GET", "/api/members/1/cycles")).status, 404);
    const moved = await call(c2(), "GET", "/api/members/1/cycles");
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.json.cycles.map((c) => c.id), [cycleId]);
    sql("UPDATE members SET coach_id = 1 WHERE id = 1;");
    assert.equal((await call(c1(), "GET", "/api/members/1/cycles")).status, 200);
  });

  it("member delete own, then double delete is 404", async () => {
    assert.equal((await call(m1(), "DELETE", `${ME}/${cycleId}`)).status, 204);
    assert.deepEqual(await list(m1()), []);
    assert.equal((await call(m1(), "DELETE", `${ME}/${cycleId}`)).status, 404);
  });
});
