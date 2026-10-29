/**
 * LOCAL ONLY. Nutrition (member_meals) backend regression suite: real built
 * Worker + real local D1 (`.wrangler/state`), no mocks. Node's built-in runner.
 *
 *   npm run build && npm run test:nutrition
 *
 * Requires the local fixtures and a clean baseline (it refuses to run
 * otherwise). All temporary rows are removed, Members are restored to coach 1
 * and every login re-activated afterwards, pass or fail. Fixed historical dates
 * make results independent of today's date; "today"/"tomorrow" are derived from
 * Asia/Tehran, never from the host timezone.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.NUTRITION_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const COACH2_EMAIL = "coach2.nutritiontest@example.test";

if (process.argv.includes("--remote")) throw new Error("test-nutrition is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

function cleanup() {
  sql(
    `UPDATE members SET coach_id = 1; UPDATE users SET is_active = 1; DELETE FROM member_meals; DELETE FROM auth_sessions; ` +
      `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email = '${COACH2_EMAIL}'); ` +
      `DELETE FROM users WHERE email = '${COACH2_EMAIL}';`
  );
}

const passwords = {
  "coach1@example.test": "LocalCoach123!",
  [COACH2_EMAIL]: "LocalCoach123!",
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

/** Tehran wall-clock "now" from the clock, independent of the host timezone. */
function tehranNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
const addDays = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const ME = "/api/members/me/meals";
const rng = (from, to) => `?from=${from}&to=${to}`;
let server;
let baselineVerified = false; // cleanup only ever runs after the baseline was proven
installSuiteGuard("test-nutrition", 240_000, () => { server?.killNow(); if (baselineVerified) cleanup(); });
const jars = {};

describe("Nutrition regression", () => {
  before(async () => {
    const baseline = { users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
      member_meals: count("member_meals"), auth_sessions: count("auth_sessions") };
    assert.deepEqual(baseline, { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, auth_sessions: 0 },
      `Unexpected local D1 baseline: ${JSON.stringify(baseline)}`);
    baselineVerified = true;

    server = await startWorker(PORT);

    sql(`INSERT INTO users (role, email, password_hash) SELECT 'coach', '${COACH2_EMAIL}', password_hash FROM users WHERE email = 'coach1@example.test'; ` +
      `INSERT INTO coaches (user_id, name) SELECT id, 'Nutrition Test Coach 2' FROM users WHERE email = '${COACH2_EMAIL}';`);

    for (const email of Object.keys(passwords)) jars[email] = await login(email);
  });

  after(async () => {
    await server?.stop();
    if (!baselineVerified) return;
    cleanup();
    const final = { users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
      member_meals: count("member_meals"), member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"),
      session_muscles: count("session_muscles"), auth_sessions: count("auth_sessions"), onCoach1: count("members", "coach_id = 1") };
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, member_cycles: 0, sessions: 0,
      session_notes: 0, session_muscles: 0, auth_sessions: 0, onCoach1: 4 });
  });

  const m1 = () => jars["member1@example.test"];
  const m2 = () => jars["member2@example.test"];
  const c1 = () => jars["coach1@example.test"];
  const c2 = () => jars[COACH2_EMAIL];
  const sa = () => jars["superadmin@example.test"];
  const memberId = (email) => sql(`SELECT m.id FROM members m JOIN users u ON u.id = m.user_id WHERE u.email = '${email}'`)[0].id;
  const list = async (cookie, from = "2025-01-01", to = "2025-01-31") => (await call(cookie, "GET", ME + rng(from, to))).json.meals;
  const coachList = async (cookie, from = "2025-01-01", to = "2025-01-31") => (await call(cookie, "GET", "/api/nutrition" + rng(from, to))).json.meals;
  const body = (over = {}) => ({ mealType: "breakfast", dateKey: "2025-01-10", time: "08:00", description: "Oats and fruit", ...over });
  const create = async (cookie, over) => {
    const r = await call(cookie, "POST", ME, body(over));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.meal;
  };
  const rowCount = () => count("member_meals");

  it("schema: index exists and the canonical-type CHECK rejects bad values at the DB", () => {
    const idx = sql("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'member_meals_member_id_logged_at_idx'");
    assert.equal(idx.length, 1);
    assert.throws(() => sql(`INSERT INTO member_meals (member_id, logged_at, meal_type, description) VALUES (1, '2025-01-01T00:00:00.000Z', 'brunch', 'x')`));
    assert.equal(rowCount(), 0);
  });

  it("query plan: member and coach range reads use the (member_id, logged_at) index", () => {
    const member = sql("EXPLAIN QUERY PLAN SELECT id FROM member_meals WHERE member_id = 1 AND logged_at >= 'a' AND logged_at < 'b' ORDER BY logged_at DESC, id DESC")
      .map((r) => r.detail).join(" | ");
    assert.match(member, /member_meals_member_id_logged_at_idx \(member_id=\? AND logged_at>\? AND logged_at<\?\)/);
    const coach = sql("EXPLAIN QUERY PLAN SELECT mm.id FROM member_meals mm INNER JOIN members m ON m.id = mm.member_id WHERE m.coach_id = 1 AND mm.logged_at >= 'a' AND mm.logged_at < 'b'")
      .map((r) => r.detail).join(" | ");
    assert.match(coach, /member_meals_member_id_logged_at_idx/);
    assert.doesNotMatch(coach, /SCAN mm|SCAN member_meals/);
  });

  it("unauthenticated requests get 401 on every endpoint", async () => {
    assert.equal((await call(null, "GET", ME + rng("2025-01-01", "2025-01-02"))).status, 401);
    assert.equal((await call(null, "POST", ME, body())).status, 401);
    assert.equal((await call(null, "PATCH", `${ME}/1`, body())).status, 401);
    assert.equal((await call(null, "DELETE", `${ME}/1`)).status, 401);
    assert.equal((await call(null, "GET", "/api/nutrition" + rng("2025-01-01", "2025-01-02"))).status, 401);
  });

  it("member creates breakfast, lunch, dinner and snack; values persist and the shape hides ownership", async () => {
    const made = [];
    for (const [i, mealType] of ["breakfast", "lunch", "dinner", "snack"].entries()) {
      made.push(await create(m1(), { mealType, time: `${String(8 + i).padStart(2, "0")}:30`, description: `${mealType} entry` }));
    }
    for (const meal of made) {
      assert.deepEqual(Object.keys(meal).sort(), ["createdAt", "description", "id", "loggedAt", "mealType", "updatedAt"]);
    }
    const meals = await list(m1());
    assert.deepEqual(meals.map((m) => m.mealType), ["snack", "dinner", "lunch", "breakfast"], "loggedAt descending");
    assert.deepEqual(meals.map((m) => m.description), ["snack entry", "dinner entry", "lunch entry", "breakfast entry"]);
    assert.equal(meals[3].loggedAt, "2025-01-10T05:00:00.000Z", "08:30 Tehran (+03:30) stored as UTC ISO");
  });

  it("description is trimmed before saving, and not otherwise rewritten", async () => {
    const meal = await create(m1(), { dateKey: "2025-01-11", description: "  Rice  and   beans \n" });
    assert.equal(meal.description, "Rice  and   beans");
    assert.equal(sql(`SELECT description FROM member_meals WHERE id = ${meal.id}`)[0].description, "Rice  and   beans");
    assert.equal((await call(m1(), "DELETE", `${ME}/${meal.id}`)).status, 204);
  });

  it("PATCH replaces type/date/time/description and bumps updatedAt", async () => {
    const meal = await create(m1(), { dateKey: "2025-01-12", description: "to edit" });
    sql(`UPDATE member_meals SET updated_at = '2000-01-01 00:00:00', created_at = '2000-01-01 00:00:00' WHERE id = ${meal.id}`);
    const patched = await call(m1(), "PATCH", `${ME}/${meal.id}`, body({ mealType: "dinner", dateKey: "2025-01-13", time: "21:15", description: " edited " }));
    assert.equal(patched.status, 200);
    assert.equal(patched.json.meal.mealType, "dinner");
    assert.equal(patched.json.meal.description, "edited");
    assert.equal(patched.json.meal.loggedAt, "2025-01-13T17:45:00.000Z");
    assert.equal(patched.json.meal.createdAt, "2000-01-01 00:00:00", "createdAt untouched");
    assert.notEqual(patched.json.meal.updatedAt, "2000-01-01 00:00:00", "updatedAt changed");
    const [row] = (await list(m1())).filter((m) => m.id === meal.id);
    assert.equal(row.mealType, "dinner");
  });

  it("another Member never sees, edits or deletes the meal (404, nothing changes)", async () => {
    const before = await list(m1());
    assert.deepEqual(await list(m2()), []);
    const id = before[0].id;
    assert.equal((await call(m2(), "PATCH", `${ME}/${id}`, body({ description: "hijack" }))).status, 404);
    assert.equal((await call(m2(), "DELETE", `${ME}/${id}`)).status, 404);
    assert.deepEqual(await list(m1()), before);
  });

  it("DELETE removes the row (hard delete); repeat and unknown ids are 404", async () => {
    const meal = await create(m1(), { dateKey: "2025-01-14", description: "temp" });
    assert.equal((await call(m1(), "DELETE", `${ME}/${meal.id}`)).status, 204);
    assert.equal(sql(`SELECT id FROM member_meals WHERE id = ${meal.id}`).length, 0);
    assert.equal((await call(m1(), "DELETE", `${ME}/${meal.id}`)).status, 404);
    assert.equal((await call(m1(), "PATCH", `${ME}/${meal.id}`, body())).status, 404);
    assert.equal((await call(m1(), "DELETE", `${ME}/999999`)).status, 404);
  });

  it("validation: every invalid input is a deterministic 400 and writes nothing", async () => {
    const before = rowCount();
    const bad = [
      body({ mealType: "brunch" }), body({ mealType: 5 }), body({ mealType: undefined }),
      body({ extra: 1 }), body({ calories: 300 }),
      body({ description: "" }), body({ description: "   \n\t " }), body({ description: "x".repeat(501) }), body({ description: 42 }), body({ description: undefined }),
      body({ dateKey: "2025-02-31" }), body({ dateKey: "10-01-2025" }), body({ dateKey: undefined }),
      body({ time: "24:00" }), body({ time: "8:00" }), body({ time: "08:60" }), body({ time: undefined }),
      [], null, "text",
    ];
    for (const payload of bad) {
      assert.equal((await call(m1(), "POST", ME, payload)).status, 400, JSON.stringify(payload));
    }
    const ok = await call(m1(), "POST", ME, body({ dateKey: "2025-01-15", description: "x".repeat(500) }));
    assert.equal(ok.status, 201, "500 characters is allowed");
    const id = ok.json.meal.id;
    for (const payload of [body({ mealType: "brunch" }), body({ extra: 1 }), body({ description: " " }), body({ time: "99:99" })]) {
      assert.equal((await call(m1(), "PATCH", `${ME}/${id}`, payload)).status, 400);
    }
    assert.equal((await call(m1(), "PATCH", `${ME}/abc`, body())).status, 400);
    assert.equal((await call(m1(), "DELETE", `${ME}/0`)).status, 400);
    assert.equal(rowCount(), before + 1, "only the valid 500-character row was written");
    assert.equal((await call(m1(), "DELETE", `${ME}/${id}`)).status, 204);
  });

  it("range validation: bad dates, from > to, missing params and >31 days are 400; 31 days is allowed", async () => {
    const paths = [
      ME, ME + "?from=2025-01-01", ME + "?to=2025-01-01", ME + rng("2025-02-31", "2025-03-01"), ME + rng("2025-01-01", "bad"),
      ME + rng("2025-01-10", "2025-01-09"), ME + rng("2025-03-01", "2025-04-01"),
    ];
    for (const path of paths) {
      assert.equal((await call(m1(), "GET", path)).status, 400, path);
      assert.equal((await call(c1(), "GET", path.replace(ME, "/api/nutrition"))).status, 400, path);
    }
    assert.equal((await call(m1(), "GET", ME + rng("2025-03-01", "2025-03-31"))).status, 200, "31 calendar days");
    assert.equal((await call(m1(), "GET", ME + rng("2025-01-10", "2025-01-10"))).status, 200, "single day");
  });

  it("future rule uses Tehran time: past and earlier-today allowed; later-today and future dates are 400", async (t) => {
    const now = tehranNow();
    const before = rowCount();
    assert.equal((await call(m1(), "POST", ME, body({ dateKey: addDays(now.dateKey, -1), time: "23:59", description: "yesterday" }))).status, 201);
    assert.equal((await call(m1(), "POST", ME, body({ dateKey: now.dateKey, time: "00:00", description: "today earlier" }))).status, 201);
    assert.equal((await call(m1(), "POST", ME, body({ dateKey: addDays(now.dateKey, 1), time: "00:00" }))).status, 400, "tomorrow");
    assert.equal((await call(m1(), "POST", ME, body({ dateKey: addDays(now.dateKey, 400), time: "12:00" }))).status, 400, "far future");
    if (now.hour === 23 && now.minute === 59) {
      t.diagnostic("Tehran clock is at 23:59: later-today assertion skipped");
    } else {
      const laterMinutes = Math.min(now.hour * 60 + now.minute + 2, 23 * 60 + 59);
      const later = `${String(Math.floor(laterMinutes / 60)).padStart(2, "0")}:${String(laterMinutes % 60).padStart(2, "0")}`;
      assert.equal((await call(m1(), "POST", ME, body({ dateKey: now.dateKey, time: later }))).status, 400, `today ${later}`);
    }
    assert.equal(rowCount(), before + 2);

    // PATCH enforces the same rule against the final state.
    const [mine] = (await list(m1(), addDays(now.dateKey, -1), now.dateKey)).filter((m) => m.description === "today earlier");
    assert.equal((await call(m1(), "PATCH", `${ME}/${mine.id}`, body({ dateKey: addDays(now.dateKey, 1), time: "09:00" }))).status, 400);
    assert.equal((await list(m1(), addDays(now.dateKey, -1), now.dateKey)).filter((m) => m.id === mine.id).length, 1);
    sql(`DELETE FROM member_meals WHERE logged_at >= '${addDays(now.dateKey, -2)}'`);
  });

  it("Tehran day boundaries: 23:30 and 00:30 land on their own Tehran dates and `to` is inclusive", async () => {
    sql("DELETE FROM member_meals");
    const late = await create(m1(), { dateKey: "2025-03-15", time: "23:30", description: "late" });
    const early = await create(m1(), { dateKey: "2025-03-16", time: "00:30", description: "early" });
    const justBefore = await create(m1(), { dateKey: "2025-03-14", time: "23:59", description: "prev" });
    assert.equal(early.loggedAt, "2025-03-15T21:00:00.000Z", "00:30 Tehran is the previous UTC day");
    const ids = async (from, to) => (await list(m1(), from, to)).map((m) => m.id);
    assert.deepEqual(await ids("2025-03-15", "2025-03-15"), [late.id]);
    assert.deepEqual(await ids("2025-03-16", "2025-03-16"), [early.id]);
    assert.deepEqual(await ids("2025-03-14", "2025-03-14"), [justBefore.id]);
    assert.deepEqual(await ids("2025-03-15", "2025-03-16"), [early.id, late.id]);
    assert.deepEqual((await coachList(c1(), "2025-03-16", "2025-03-16")).map((m) => m.id), [early.id]);
    assert.deepEqual((await coachList(c1(), "2025-03-14", "2025-03-16")).map((m) => m.id), [early.id, late.id, justBefore.id]);
  });

  it("Saturday-Friday weeks work as plain 7-day ranges (Sat 2025-03-15 .. Fri 2025-03-21)", async () => {
    sql("DELETE FROM member_meals");
    const sat = await create(m1(), { dateKey: "2025-03-15", time: "08:00", description: "sat" });
    const fri = await create(m1(), { dateKey: "2025-03-21", time: "23:50", description: "fri" });
    await create(m1(), { dateKey: "2025-03-22", time: "00:10", description: "next sat" });
    assert.deepEqual((await list(m1(), "2025-03-15", "2025-03-21")).map((m) => m.id), [fri.id, sat.id]);
  });

  it("Coach reads currently assigned Members (with memberId); other Coach, Member and Super Admin get nothing", async () => {
    sql("DELETE FROM member_meals");
    const a = await create(m1(), { description: "member one" });
    const b = await create(m2(), { mealType: "lunch", description: "member two" });
    const rows = await coachList(c1());
    assert.deepEqual(rows.map((m) => [m.id, m.memberId]).sort(), [[a.id, memberId("member1@example.test")], [b.id, memberId("member2@example.test")]].sort());
    assert.deepEqual(Object.keys(rows[0]).sort(), ["createdAt", "description", "id", "loggedAt", "mealType", "memberId", "updatedAt"]);
    assert.deepEqual(await coachList(c2()), [], "unrelated Coach sees nothing and no per-Member error");
    assert.equal((await call(m1(), "GET", "/api/nutrition" + rng("2025-01-01", "2025-01-31"))).status, 403);
    assert.equal((await call(sa(), "GET", "/api/nutrition" + rng("2025-01-01", "2025-01-31"))).status, 403);
  });

  it("Coach and Super Admin cannot use the Member routes; Coach has no write endpoint", async () => {
    const before = await coachList(c1());
    const id = before[0].id;
    for (const jar of [c1(), sa()]) {
      assert.equal((await call(jar, "GET", ME + rng("2025-01-01", "2025-01-31"))).status, 403);
      assert.equal((await call(jar, "POST", ME, body())).status, 403);
      assert.equal((await call(jar, "PATCH", `${ME}/${id}`, body())).status, 403);
      assert.equal((await call(jar, "DELETE", `${ME}/${id}`)).status, 403);
    }
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
      assert.equal((await call(c1(), method, "/api/nutrition", body())).status, 405, method);
    }
    assert.deepEqual(await coachList(c1()), before);
  });

  it("reassignment A -> B switches Coach visibility without rewriting the meal rows", async () => {
    const snapshot = JSON.stringify(sql("SELECT * FROM member_meals ORDER BY id"));
    const m1Id = memberId("member1@example.test");
    assert.ok((await coachList(c1())).some((m) => m.memberId === m1Id));
    assert.deepEqual(await coachList(c2()), []);
    sql(`UPDATE members SET coach_id = (SELECT c.id FROM coaches c JOIN users u ON u.id = c.user_id WHERE u.email = '${COACH2_EMAIL}') WHERE id = ${m1Id};`);
    assert.equal((await coachList(c1())).some((m) => m.memberId === m1Id), false, "old Coach loses access");
    const moved = await coachList(c2());
    assert.deepEqual(moved.map((m) => m.memberId), [m1Id], "new Coach sees the full history");
    assert.equal(JSON.stringify(sql("SELECT * FROM member_meals ORDER BY id")), snapshot, "meal rows unchanged");
    assert.equal(sql("SELECT name FROM pragma_table_info('member_meals') WHERE name LIKE '%coach%'").length, 0, "no stored coach column");
    // The Member keeps full access to their own meals throughout.
    assert.ok((await list(m1())).length > 0);
    sql("UPDATE members SET coach_id = 1;");
    assert.ok((await coachList(c1())).some((m) => m.memberId === m1Id));
    assert.deepEqual(await coachList(c2()), []);
  });

  it("inactive Member login keeps the history visible to the currently assigned Coach", async () => {
    const m1Id = memberId("member1@example.test");
    sql(`UPDATE users SET is_active = 0 WHERE email = 'member1@example.test';`);
    const rows = await coachList(c1());
    assert.ok(rows.some((m) => m.memberId === m1Id), "Coach still sees the inactive Member's meals");
    assert.ok(rowCount() > 0, "rows are not deleted");
    sql(`UPDATE users SET is_active = 1 WHERE email = 'member1@example.test';`);
  });

  it("no retention: very old meals remain readable and are not removed", async () => {
    const old = await create(m1(), { dateKey: "2020-06-01", time: "12:00", description: "ancient" });
    assert.deepEqual((await list(m1(), "2020-06-01", "2020-06-01")).map((m) => m.id), [old.id]);
    assert.equal(sql(`SELECT id FROM member_meals WHERE id = ${old.id}`).length, 1);
  });
});
