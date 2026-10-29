/**
 * LOCAL ONLY. Real-browser regression for the Coach Nutrition page (SEC0K4):
 * headless Chromium against the real built Worker + real local D1, no mocks. The
 * browser runs in Los Angeles to prove every day, week and time follows Asia/Tehran.
 *
 *   npm run build && npm run test:coach-nutrition-ui
 *
 * Meals are seeded straight into D1 in two PAST Tehran weeks (7 elapsed days, so
 * the expected percentages never depend on today's weekday); current-week and
 * 50% rules are covered by the pure `test:nutrition-rules` suite. Requires the
 * clean local baseline and refuses to run otherwise; every temporary row is
 * removed and the original users rows restored, pass or fail.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright-core";
import { count, fetchBounded, installSuiteGuard, resolveChromium, sql, startWorker } from "./test-helpers.mjs";
import { addDaysToDateKey, getAppDateKey, getAppWeek, localDateTimeToUtcIso } from "../lib/date-time.ts";

const PORT = process.env.COACH_NUTRITION_UI_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const COACH1 = "coach1@example.test";
const COACH_B = "coach.b@nutui.example.test";
const PASSWORD = "LocalCoach123!";
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0 };

if (process.argv.includes("--remote")) throw new Error("test-coach-nutrition-ui is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");
const CHROMIUM = resolveChromium(chromium);

const baselineCounts = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_meals: count("member_meals"), member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"),
  session_muscles: count("session_muscles"), auth_sessions: count("auth_sessions") });
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

let server, browser, page, snapshot = null, baselineVerified = false;
installSuiteGuard("test-coach-nutrition-ui", 600_000, () => {
  try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
  server?.killNow();
  if (baselineVerified) cleanup();
});

function cleanup() {
  sql(`DELETE FROM member_meals; DELETE FROM auth_sessions; UPDATE members SET coach_id = 1; ` +
    `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email = '${COACH_B}'); DELETE FROM users WHERE email = '${COACH_B}';`);
  for (const u of snapshot ?? []) {
    sql(`UPDATE users SET email = ${q(u.email)}, password_hash = ${q(u.password_hash)}, is_active = ${q(u.is_active)}, updated_at = ${q(u.updated_at)} WHERE id = ${u.id}`);
  }
}

// ---- Weeks, all derived from the real Tehran "today" -----------------------------------------
const TODAY = getAppDateKey();
const weekOf = (offset) => getAppWeek(new Date(localDateTimeToUtcIso(addDaysToDateKey(TODAY, offset * 7), "12:00")));
const CUR = weekOf(0), PREV = weekOf(-1), OLD = weekOf(-2), NEXT = weekOf(1);
const key = (week) => `${week[0].dateKey}|${week[6].dateKey}`;
const at = (dateKey, time) => localDateTimeToUtcIso(dateKey, time);
const rangeSearch = (week) => `?from=${week[0].dateKey}&to=${week[6].dateKey}`;
const NO_MOCK = /Protein coverage|Produce variety|Hydration|REPETITIVE CONSUMPTION|glasses/i;

describe("Coach Nutrition UI (real browser)", () => {
  let M; // fixture Members, by index: [{ id, name }]
  const seed = (member, dateKey, time, type) =>
    sql(`INSERT INTO member_meals (member_id, logged_at, meal_type, description) VALUES (${member.id}, '${at(dateKey, time)}', '${type}', '${type} ${dateKey}');`);

  before(async () => {
    assert.deepEqual(baselineCounts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(baselineCounts())}`);
    baselineVerified = true;
    snapshot = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");
    M = sql("SELECT id, name, user_id FROM members ORDER BY id");
    assert.equal(M.length, 4);

    const P = PREV.map((d) => d.dateKey), O = OLD.map((d) => d.dateKey);
    // PREV week. M0: every day (two meals on day 0; a 00:30 snack on day 1) -> 100%, steady.
    seed(M[0], P[0], "08:15", "breakfast"); seed(M[0], P[0], "12:30", "lunch");
    seed(M[0], P[1], "12:00", "lunch"); seed(M[0], P[1], "00:30", "snack");
    for (const d of P.slice(2)) seed(M[0], d, "13:00", "lunch");
    // M1: days 0, 1, 4 -> 3/7 = 43%, last three days include day 4 -> low consistency.
    for (const i of [0, 1, 4]) seed(M[1], P[i], "12:00", "lunch");
    // M2: snacks on days 0-4 -> 5/7 = 71%, snacks on most days. M3: nothing -> 0%.
    for (const i of [0, 1, 2, 3, 4]) seed(M[2], P[i], "16:00", "snack");
    // OLD week. M0: days 0-3 -> 4/7 = 57% with nothing on the last three days -> three-day gap. M1: days 1, 3, 5, 6 -> 57%, steady.
    for (const i of [0, 1, 2, 3]) seed(M[0], O[i], "12:00", "lunch");
    for (const i of [1, 3, 5, 6]) seed(M[1], O[i], "12:00", "dinner");

    server = await startWorker(PORT);
    browser = await chromium.launch({ executablePath: CHROMIUM, timeout: 30_000 });
    sql(`INSERT INTO users (role, email, password_hash) SELECT 'coach', '${COACH_B}', password_hash FROM users WHERE email = '${COACH1}'; ` +
      `INSERT INTO coaches (user_id, name) SELECT id, 'Nutrition UI Coach B' FROM users WHERE email = '${COACH_B}';`);
  });

  after(async () => {
    try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch { /* ignore */ }
    try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
    try {
      if (baselineVerified) {
        cleanup();
        const r = await fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: COACH1, password: PASSWORD }) });
        assert.equal(r.status, 200, "post-cleanup login");
        sql("DELETE FROM auth_sessions");
      }
    } finally {
      await server?.stop();
    }
    if (!baselineVerified) return;
    const final = baselineCounts();
    console.log("Final DB:", JSON.stringify(final));
    assert.deepEqual(final, BASELINE);
    assert.equal(count("members", "coach_id = 1"), 4);
    assert.deepEqual(sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id"), snapshot);
  });

  // ---- UI helpers ------------------------------------------------------------------------------
  let net = [];
  const nutritionGets = () => net.filter((r) => r.path === "/api/nutrition");
  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const p = await context.newPage();
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) net.push({ method: r.method(), path: u.pathname, search: u.search });
    });
    return p;
  };
  const login = async (email) => {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in|log in|login/i }).click();
    await page.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
  };
  const loaded = () => page.waitForFunction(() => !/Loading nutrition activity/.test(document.body.innerText));
  const openNutrition = async () => {
    await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === "/api/nutrition"), page.locator("aside.sidebar nav").getByRole("button", { name: "Nutrition" }).click()]);
    await loaded();
  };
  /** The week label text: changes whenever the visible week does. */
  const weekLabel = () => page.getByTestId("nutrition-week").innerText();
  /** Clicks a week control; when `week` is given it must produce exactly one GET for that range. */
  const goWeek = async (name, week) => {
    const was = await weekLabel();
    if (week) await Promise.all([page.waitForResponse((r) => r.url().includes(`from=${week[0].dateKey}&to=${week[6].dateKey}`)), page.getByRole("button", { name }).click()]);
    else await page.getByRole("button", { name }).click();
    await page.waitForFunction((old) => document.querySelector('[data-testid="nutrition-week"]')?.textContent !== old, was);
    await loaded();
  };
  const metric = (name) => page.locator(`[data-metric="${name}"] strong`).innerText();
  const rowOf = (member) => page.locator(`.nutrition-client[data-member-id="${member.id}"]`).evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());
  const select = (member) => page.locator(`.nutrition-client[data-member-id="${member.id}"]`).click();
  const detailMeals = (dateKey) => page.locator(`[data-detail] [data-day="${dateKey}"] [data-meal]`).evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));

  it("Coach login -> Nutrition: ALL-CLIENT OVERVIEW comes first, nothing selected, every assigned Member listed, ONE range request", async () => {
    page = await newPage();
    await login(COACH1);
    await openNutrition();
    assert.deepEqual(nutritionGets().map((r) => r.search), [rangeSearch(CUR)], "exactly one GET for the current Saturday-Friday week");
    const order = await page.locator(".content").evaluate((el) => [...el.children].map((e) => e.className));
    assert.deepEqual(order.slice(0, 3), ["page-heading", "nutrition-week-nav", "surface nutrition-overview"], "heading, week bar, then the overview before anything else");
    await page.getByText("ALL-CLIENT OVERVIEW").waitFor();
    await page.getByText("Select a client to view weekly nutrition activity.").waitFor();
    assert.equal(await page.locator("[data-detail]").count(), 0, "no Member selected initially, even though Clients has its own selection");
    assert.deepEqual(await page.locator(".nutrition-client").evaluateAll((els) => els.map((e) => Number(e.dataset.memberId))), M.map((m) => m.id));
    assert.equal(CUR[0].weekday, "Sat");
  });

  it("current week with no meals: real zero metrics (0 of 4, 0 · 0, 0%, 4 need follow-up); no mock copy", async () => {
    assert.equal(await metric("logged"), "0 of 4");
    assert.equal(await metric("entries"), "0 · 0");
    assert.equal(await metric("average"), "0%");
    assert.equal(await metric("followup"), "4");
    assert.ok(/No food activity logged this week/.test(await rowOf(M[0])));
    assert.equal(NO_MOCK.test(await page.locator("body").innerText()), false);
  });

  it("previous week: one GET for the right range; real metrics and per-Member consistency + primary insight", async () => {
    const before = nutritionGets().length;
    await goWeek("Previous week", PREV);
    assert.equal(nutritionGets().length, before + 1);
    assert.equal(nutritionGets().at(-1).search, rangeSearch(PREV));
    assert.equal(await metric("logged"), "3 of 4");
    assert.equal(await metric("entries"), "11 · 6", "11 breakfast/lunch/dinner entries, 6 snacks");
    assert.equal(await metric("average"), "54%", "mean of 7/7, 3/7, 5/7 and 0/7");
    assert.equal(await metric("followup"), "2", "low consistency + no activity; snacks-most-days and steady do not count");
    assert.match(await rowOf(M[0]), /100%.*Steady logging|Steady logging.*100%/);
    assert.match(await rowOf(M[1]), /Logging on fewer than half of the days/);
    assert.match(await rowOf(M[1]), /43%/);
    assert.match(await rowOf(M[2]), /Snacks logged on most days/);
    assert.match(await rowOf(M[2]), /71%/);
    assert.match(await rowOf(M[3]), /No food activity logged this week/);
    assert.match(await rowOf(M[3]), /0%/);
  });

  it("selecting a Member adds ONLY that Member's detail with no extra request; the overview stays; switching replaces it", async () => {
    const before = net.length;
    await select(M[0]);
    await page.locator(`[data-detail="${M[0].id}"]`).waitFor();
    assert.equal(await page.locator("[data-detail]").count(), 1);
    assert.equal(net.length, before, "selection makes no request at all");
    await page.getByText("ALL-CLIENT OVERVIEW").waitFor();
    assert.equal(await page.locator("[data-no-selection]").count(), 0);
    assert.equal((await page.locator("[data-consistency] strong").innerText()).replace(/\s+/g, ""), "100%");
    assert.match(await page.locator("[data-consistency] small").innerText(), /7 of 7 days logged/);
    assert.equal(await page.locator('[data-insight="steady"] h2').innerText(), "Steady logging");

    await select(M[1]);
    await page.locator(`[data-detail="${M[1].id}"]`).waitFor();
    assert.equal(await page.locator("[data-detail]").count(), 1);
    assert.equal(await page.locator(`[data-detail="${M[0].id}"]`).count(), 0);
    assert.match(await page.locator("[data-consistency] small").innerText(), /3 of 7 days logged/);
    assert.equal((await page.locator("[data-consistency] strong").innerText()).replace(/\s+/g, ""), "43%");
    assert.equal(await page.locator('[data-insight="low-consistency"] h2').innerText(), "Logging on fewer than half of the days");
    assert.equal(net.length, before);
  });

  it("each rule shows its insight: snacks-most-days, no-activity (with empty activity), and no protein/produce/hydration UI", async () => {
    await select(M[2]);
    await page.locator('[data-insight="snacks-most-days"]').waitFor();
    assert.equal(await page.locator('[data-insight] h2').innerText(), "Snacks logged on most days");
    assert.equal((await page.locator("[data-consistency] strong").innerText()).replace(/\s+/g, ""), "71%");

    await select(M[3]);
    await page.locator('[data-insight="no-activity"]').waitFor();
    assert.equal(await page.locator('[data-insight] h2').innerText(), "No food activity logged this week");
    assert.equal((await page.locator("[data-consistency] strong").innerText()).replace(/\s+/g, ""), "0%");
    await page.getByText("No food activity logged this week.").waitFor();
    assert.equal(await page.locator("[data-detail] [data-meal]").count(), 0, "nothing fabricated");
    assert.equal(NO_MOCK.test(await page.locator("body").innerText()), false);
  });

  it("client food activity: 7 Saturday-Friday Tehran days, Tehran times, labels, descriptions, chronological, read-only", async () => {
    await select(M[0]);
    await page.locator(`[data-detail="${M[0].id}"]`).waitFor();
    assert.deepEqual(await page.locator("[data-detail] [data-day]").evaluateAll((els) => els.map((e) => e.dataset.day)), PREV.map((d) => d.dateKey));
    assert.deepEqual(await detailMeals(PREV[0].dateKey), [`Breakfast · 08:15 breakfast ${PREV[0].dateKey}`, `Lunch · 12:30 lunch ${PREV[0].dateKey}`]);
    // 00:30 Tehran is the previous UTC (and previous Los Angeles) day: it must sit on day 1, before the 12:00 lunch.
    assert.deepEqual(await detailMeals(PREV[1].dateKey), [`Snack · 00:30 snack ${PREV[1].dateKey}`, `Lunch · 12:00 lunch ${PREV[1].dateKey}`]);
    assert.deepEqual(await detailMeals(PREV[6].dateKey), [`Lunch · 13:00 lunch ${PREV[6].dateKey}`]);
    assert.equal(await page.locator("[data-detail]").getByRole("button").count(), 0, "no Edit/Delete or any control in the detail");
    await select(M[2]);
    await page.locator(`[data-detail="${M[2].id}"]`).waitFor();
    assert.deepEqual(await detailMeals(PREV[2].dateKey), [`Snack · 16:00 snack ${PREV[2].dateKey}`]);
    assert.deepEqual(await detailMeals(PREV[6].dateKey), []);
  });

  it("older week: three-day gap and steady are computed from that week's own data", async () => {
    await goWeek("Previous week", OLD);
    assert.match(await rowOf(M[0]), /No meals logged for 3 days/);
    assert.match(await rowOf(M[0]), /57%/);
    assert.match(await rowOf(M[1]), /Steady logging/);
    assert.match(await rowOf(M[1]), /57%/);
    assert.equal(await metric("logged"), "2 of 4");
    assert.equal(await metric("entries"), "8 · 0");
    await select(M[0]);
    await page.locator('[data-insight="three-day-gap"]').waitFor();
    assert.equal(await page.locator("[data-insight] h2").innerText(), "No meals logged for 3 days");
    assert.deepEqual(await detailMeals(OLD[4].dateKey), []);
  });

  it("week navigation + cache: visited weeks are not requested again; each new week is exactly one range GET", async () => {
    const start = nutritionGets().length; // CUR, PREV, OLD so far
    const mark = net.length;
    assert.deepEqual(nutritionGets().map((r) => r.search), [rangeSearch(CUR), rangeSearch(PREV), rangeSearch(OLD)]);
    await goWeek("Next week");            // PREV: cached
    await goWeek("Next week");            // CUR: cached
    await goWeek("Previous week");        // PREV: cached
    await goWeek("Current week");         // CUR: cached
    assert.equal(nutritionGets().length, start, "no duplicate GET for visited weeks");
    await goWeek("Next week", NEXT);      // future week: one new GET
    assert.equal(nutritionGets().length, start + 1);
    assert.equal(nutritionGets().at(-1).search, rangeSearch(NEXT));
    assert.equal(await page.getByRole("button", { name: "Current week" }).isDisabled(), false);
    await goWeek("Current week");
    assert.equal(await page.getByRole("button", { name: "Current week" }).isDisabled(), true);
    assert.equal(nutritionGets().length, start + 1);
    assert.deepEqual([...new Set(net.slice(mark).map((r) => r.path))], ["/api/nutrition"], "week navigation makes no per-Member or per-day requests");
  });

  it("future week is neutral: no average, no follow-up, '—', 'Week has not started', no fabricated meals", async () => {
    await goWeek("Next week");            // cached since the previous test
    assert.equal(await metric("logged"), "0 of 4");
    assert.equal(await metric("entries"), "0 · 0");
    assert.equal(await metric("average"), "—");
    assert.equal(await metric("followup"), "0");
    assert.match(await rowOf(M[3]), /—/);
    assert.equal(/No food activity logged/.test(await rowOf(M[3])), false, "no negative insight for a week that has not happened");
    await select(M[3]);
    await page.locator('[data-insight="not-started"]').waitFor();
    assert.equal(await page.locator("[data-insight] h2").innerText(), "Week has not started yet.");
    assert.equal((await page.locator("[data-consistency] strong").innerText()).trim(), "—");
    assert.match(await page.locator("[data-consistency] small").innerText(), /Week has not started/);
    assert.equal(await page.locator("[data-detail] [data-meal]").count(), 0);
    await goWeek("Current week");
  });

  it("search filters the client list without hiding the overview totals", async () => {
    await page.getByLabel("Search clients").fill(M[1].name.slice(0, 4).toLowerCase());
    const shown = await page.locator(".nutrition-client").count();
    assert.ok(shown >= 1 && shown <= 4);
    assert.equal(await page.locator(`.nutrition-client[data-member-id="${M[1].id}"]`).count(), 1);
    await page.getByLabel("Search clients").fill("zzzz-no-such-client");
    assert.equal(await page.locator(".nutrition-client").count(), 0);
    assert.equal(await metric("followup"), "4", "metrics still cover the whole roster");
    await page.getByLabel("Search clients").fill("");
    assert.equal(await page.locator(".nutrition-client").count(), 4);
  });

  it("local errors keep the shell and roster: 500 -> Retry recovers; 403 -> permission message; no stale or mock numbers", async () => {
    await page.reload();
    await page.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
    const failing = "**/api/nutrition**";
    await page.route(failing, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await page.locator("aside.sidebar nav").getByRole("button", { name: "Nutrition" }).click();
    await page.getByRole("alert").filter({ hasText: "Could not load nutrition activity." }).waitFor();
    assert.equal(await page.locator(".nutrition-client").count(), 4, "the roster stays");
    assert.equal(await metric("average"), "—");
    assert.equal(await page.locator("aside.sidebar nav").getByRole("button", { name: "Calendar" }).isVisible(), true);
    await page.unroute(failing);
    await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === "/api/nutrition"), page.getByRole("button", { name: "Retry" }).click()]);
    await loaded();
    assert.equal(await metric("logged"), "0 of 4");

    await page.route(failing, (route) => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Forbidden."}' }));
    await goWeek("Previous week");
    await page.getByRole("alert").filter({ hasText: "You don’t have access to Nutrition." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry" }).count(), 0);
    await page.unroute(failing);
    await goWeek("Current week");
  });

  it("inactive Member login does not remove the Member or their meals from the assigned Coach", async () => {
    sql(`UPDATE users SET is_active = 0 WHERE id = ${M[2].user_id};`);
    await page.reload();
    await page.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
    await openNutrition();
    await goWeek("Previous week", PREV);
    assert.match(await rowOf(M[2]), /Snacks logged on most days/);
    assert.equal(await metric("logged"), "3 of 4");
    sql(`UPDATE users SET is_active = 1 WHERE id = ${M[2].user_id};`);
  });

  it("zero-Member Coach: Nutrition renders the overview empty state, no detail, navigation intact", async () => {
    const coachB = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const bPage = await coachB.newPage();
    await bPage.goto(BASE);
    await bPage.getByLabel("Email").fill(COACH_B);
    await bPage.getByLabel("Password").fill(PASSWORD);
    await bPage.getByRole("button", { name: /sign in|log in|login/i }).click();
    await bPage.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
    await bPage.locator("aside.sidebar nav").getByRole("button", { name: "Nutrition" }).click();
    await bPage.getByText("ALL-CLIENT OVERVIEW").waitFor();
    await bPage.getByText("No members yet.").first().waitFor();
    assert.equal(await bPage.locator("[data-detail], .nutrition-client").count(), 0);
    assert.equal(await bPage.getByRole("button", { name: "Previous week" }).isVisible(), true);
    assert.equal(await bPage.locator("aside.sidebar nav").getByRole("button", { name: "Calendar" }).isVisible(), true);
    await coachB.close();
  });

  it("reassignment: Coach A loses the Member and meals; Coach B sees the Member with the full history; rows untouched", async () => {
    const rowsBefore = JSON.stringify(sql("SELECT * FROM member_meals ORDER BY id"));
    sql(`UPDATE members SET coach_id = (SELECT c.id FROM coaches c JOIN users u ON u.id = c.user_id WHERE u.email = '${COACH_B}') WHERE id = ${M[1].id};`);

    await page.reload();
    await page.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
    await openNutrition();
    await goWeek("Previous week", PREV);
    assert.equal(await page.locator(`.nutrition-client[data-member-id="${M[1].id}"]`).count(), 0, "Coach A no longer lists the Member");
    assert.equal(await page.locator(".nutrition-client").count(), 3);
    assert.equal(await metric("logged"), "2 of 3");
    assert.equal(await metric("entries"), "8 · 6", "M1's three lunches are gone from Coach A's totals (11 - 3)");

    const coachB = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const bPage = await coachB.newPage();
    await bPage.goto(BASE);
    await bPage.getByLabel("Email").fill(COACH_B);
    await bPage.getByLabel("Password").fill(PASSWORD);
    await bPage.getByRole("button", { name: /sign in|log in|login/i }).click();
    await bPage.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
    await bPage.locator("aside.sidebar nav").getByRole("button", { name: "Nutrition" }).click();
    await bPage.locator(`.nutrition-client[data-member-id="${M[1].id}"]`).waitFor();
    assert.equal(await bPage.locator(".nutrition-client").count(), 1);
    await Promise.all([bPage.waitForResponse((r) => r.url().includes(`from=${PREV[0].dateKey}`)), bPage.getByRole("button", { name: "Previous week" }).click()]);
    await bPage.waitForFunction(() => !/Loading nutrition activity/.test(document.body.innerText));
    await bPage.locator(`.nutrition-client[data-member-id="${M[1].id}"]`).click();
    await bPage.locator(`[data-detail="${M[1].id}"] [data-meal]`).first().waitFor();
    assert.equal(await bPage.locator("[data-detail] [data-meal]").count(), 3, "full retained history");
    assert.match(await bPage.locator("[data-consistency] small").innerText(), /3 of 7 days logged/);
    await coachB.close();

    assert.equal(JSON.stringify(sql("SELECT * FROM member_meals ORDER BY id")), rowsBefore, "no meal row was rewritten");
    sql("UPDATE members SET coach_id = 1;");
  });

  it("401 from the Nutrition API returns to the sign-in screen", async () => {
    await page.reload();
    await page.locator("aside.sidebar").getByText("Coach", { exact: true }).waitFor();
    await page.route("**/api/nutrition**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Not authenticated."}' }));
    await page.locator("aside.sidebar nav").getByRole("button", { name: "Nutrition" }).click();
    await page.getByLabel("Email").waitFor();
    await page.unroute("**/api/nutrition**");
  });
});
