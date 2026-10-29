/**
 * LOCAL ONLY. Real-browser regression for the Member Meal Log (SEC0K3):
 * headless Chromium against the real built Worker + real local D1, no mocks. The
 * browser runs in Los Angeles to prove week/day grouping, future validation and
 * the displayed times all follow Asia/Tehran.
 *
 *   npm run build && npm run test:member-meals-ui
 *
 * Requires the clean local baseline and refuses to run otherwise. All meal rows
 * are removed and the original users rows restored, pass or fail.
 * Meals created through the UI use "today 00:00/00:01 Tehran" so they are never
 * in the future; the suite waits out Tehran 00:00-00:01 for that reason.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright-core";
import { count, fetchBounded, installSuiteGuard, resolveChromium, sleep, sql, startWorker } from "./test-helpers.mjs";
import { addDaysToDateKey, formatAppTime, getAppDateKey, getAppWeek, localDateTimeToUtcIso } from "../lib/date-time.ts";

const PORT = process.env.MEMBER_MEALS_UI_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const M1 = "member1@example.test";
const M2 = "member2@example.test";
const PASSWORDS = { [M1]: "LocalMember123!", [M2]: "LocalMember123!" };
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0 };

if (process.argv.includes("--remote")) throw new Error("test-member-meals-ui is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");
const CHROMIUM = resolveChromium(chromium);

const baselineCounts = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_meals: count("member_meals"), member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"),
  session_muscles: count("session_muscles"), auth_sessions: count("auth_sessions") });
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

let server, browser, page, snapshot = null, baselineVerified = false;
installSuiteGuard("test-member-meals-ui", 600_000, () => {
  try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
  server?.killNow();
  if (baselineVerified) cleanup();
});

function cleanup() {
  sql(`DELETE FROM member_meals; DELETE FROM auth_sessions; UPDATE members SET coach_id = 1;`);
  for (const u of snapshot ?? []) {
    sql(`UPDATE users SET email = ${q(u.email)}, password_hash = ${q(u.password_hash)}, is_active = ${q(u.is_active)}, updated_at = ${q(u.updated_at)} WHERE id = ${u.id}`);
  }
}

// ---- Dates, all from the real Tehran "today" -------------------------------------------------
const TODAY = getAppDateKey();
const weekOf = (offsetWeeks) => getAppWeek(new Date(localDateTimeToUtcIso(addDaysToDateKey(TODAY, offsetWeeks * 7), "12:00")));
const CUR = weekOf(0);
const PREV = weekOf(-1);
const OLD = weekOf(-2);
const at = (dateKey, time) => localDateTimeToUtcIso(dateKey, time);
const memberId = (email) => sql(`SELECT m.id FROM members m JOIN users u ON u.id = m.user_id WHERE u.email = '${email}'`)[0].id;
const seed = (id, dateKey, time, type, text) =>
  sql(`INSERT INTO member_meals (member_id, logged_at, meal_type, description) VALUES (${id}, '${at(dateKey, time)}', '${type}', ${q(text)});`);

describe("Member Meal Log UI (real browser)", () => {
  before(async () => {
    assert.deepEqual(baselineCounts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(baselineCounts())}`);
    baselineVerified = true;
    snapshot = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");
    // UI-created meals sit at today 00:00/00:01 Tehran: wait out the first two minutes of the Tehran day.
    const tehran = formatAppTime(new Date());
    if (tehran < "00:02") await sleep(125_000);
    server = await startWorker(PORT);
    browser = await chromium.launch({ executablePath: CHROMIUM, timeout: 30_000 });
  });

  after(async () => {
    try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch { /* ignore */ }
    try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
    try {
      if (baselineVerified) {
        cleanup();
        for (const [email, password] of Object.entries(PASSWORDS)) {
          const r = await fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
          assert.equal(r.status, 200, `post-cleanup login ${email}`);
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
    assert.equal(count("members", "coach_id = 1"), 4);
    assert.deepEqual(sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id"), snapshot);
  });

  // ---- UI helpers ------------------------------------------------------------------------------
  const net = [];
  const mealBodies = [];
  const mealCalls = (method) => net.filter((r) => r.path.startsWith("/api/members/me/meals") && r.method === method);
  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const p = await context.newPage();
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) net.push({ method: r.method(), path: u.pathname, search: u.search, body: r.postData() });
    });
    p.on("response", async (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/members/me/meals")) mealBodies.push(await r.text().catch(() => ""));
    });
    return p;
  };
  const login = async (email) => {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORDS[email]);
    await page.getByRole("button", { name: /sign in|log in|login/i }).click();
  };
  const nav = () => page.locator("aside.sidebar nav");
  const loaded = () => page.waitForFunction(() => !/Loading meals/.test(document.body.innerText));
  const openMeals = async () => {
    await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === "/api/members/me/meals"), nav().getByRole("button", { name: "Meal Log" }).click()]);
    await loaded();
  };
  /** Runs `action`, which must trigger exactly one week GET for `week`, then waits for it to render. */
  const viaWeek = async (week, action) => {
    await Promise.all([page.waitForResponse((r) => r.url().includes(`from=${week[0].dateKey}&to=${week[6].dateKey}`)), action()]);
    await loaded();
  };
  const gotoPrevWeek = (week) => viaWeek(week, () => page.getByRole("button", { name: "Previous week" }).click());
  const gotoNextWeek = (week) => viaWeek(week, () => page.getByRole("button", { name: "Next week" }).click());
  const gotoCurrentWeek = () => viaWeek(CUR, () => page.getByRole("button", { name: "Current week" }).click());
  const form = (name) => page.locator(`form[aria-label="${name}"]`);
  const fillForm = async (f, { mealType, dateKey, time, description }) => {
    if (mealType !== undefined) await f.locator("select").selectOption(mealType);
    if (dateKey !== undefined) await f.locator('input[type="date"]').fill(dateKey);
    if (time !== undefined) await f.locator('input[type="time"]').fill(time);
    if (description !== undefined) await f.locator("textarea").fill(description);
  };
  const dayMeals = (dateKey) => page.locator(`[data-day="${dateKey}"] [data-meal]`)
    .evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  const create = async (values, week = CUR) => {
    await page.getByRole("button", { name: "Log meal" }).click();
    const f = form("Log meal");
    await fillForm(f, values);
    const mark = net.length;
    await Promise.all([page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/members/me/meals"), f.getByRole("button", { name: "Save" }).click()]);
    await page.getByRole("status").filter({ hasText: "Meal logged." }).waitFor();
    await loaded();
    return net.slice(mark);
  };

  it("Member login -> Meal Log nav is visible alongside Today / Sessions / Cycle / Profile", async () => {
    page = await newPage();
    await login(M1);
    await nav().getByRole("button", { name: "Today" }).waitFor();
    assert.deepEqual(await nav().getByRole("button").evaluateAll((els) => els.map((e) => e.innerText.trim())), ["Today", "Sessions", "Cycle", "Meal Log", "Profile"]);
    assert.equal(await page.locator(".mobile-nav button").count(), 5);
  });

  it("opening Meal Log makes ONE week request for the Tehran Saturday-Friday week and shows the empty state", async () => {
    const mark = net.length;
    await openMeals();
    const gets = net.slice(mark).filter((r) => r.path === "/api/members/me/meals");
    assert.equal(gets.length, 1);
    assert.equal(gets[0].search, `?from=${CUR[0].dateKey}&to=${CUR[6].dateKey}`);
    assert.equal(CUR[0].weekday, "Sat");
    assert.equal(CUR[6].weekday, "Fri");
    await page.getByText("No meals logged this week.").waitFor();
    assert.deepEqual(await page.locator("[data-day]").evaluateAll((els) => els.map((e) => e.dataset.day)), CUR.map((d) => d.dateKey));
  });

  it("create form: meal type is not pre-selected; date and time default to Tehran now", async () => {
    await page.getByRole("button", { name: "Log meal" }).click();
    const f = form("Log meal");
    assert.equal(await f.locator("select").inputValue(), "");
    assert.equal(await f.locator('input[type="date"]').inputValue(), TODAY);
    assert.match(await f.locator('input[type="time"]').inputValue(), /^\d\d:\d\d$/);
    await f.getByRole("button", { name: "Cancel" }).click();
    await form("Log meal").waitFor({ state: "detached" });
  });

  it("client validation blocks bad input with no request: type, empty/whitespace/501-char description, future date, later-today time", async () => {
    await page.getByRole("button", { name: "Log meal" }).click();
    const f = form("Log meal");
    const mark = net.length;
    const expectError = async (text) => {
      await f.getByRole("button", { name: "Save" }).click();
      await f.getByRole("alert").filter({ hasText: text }).waitFor();
    };
    await fillForm(f, { dateKey: TODAY, time: "00:00", description: "x" });
    await expectError("Choose a meal type.");
    await fillForm(f, { mealType: "lunch", description: "   " });
    await expectError("Describe what you ate.");
    await fillForm(f, { description: "x".repeat(501) });
    await expectError("Keep the description under 500 characters.");
    await fillForm(f, { description: "ok", dateKey: addDaysToDateKey(TODAY, 1), time: "00:00" });
    await expectError("can't be logged in the future");
    const now = formatAppTime(new Date());
    if (now < "23:58") {
      const [h, m] = now.split(":").map(Number);
      const later = h * 60 + m + 2;
      await fillForm(f, { dateKey: TODAY, time: `${String(Math.floor(later / 60)).padStart(2, "0")}:${String(later % 60).padStart(2, "0")}` });
      await expectError("can't be logged in the future");
    }
    assert.equal(net.slice(mark).filter((r) => r.method === "POST").length, 0, "no POST was sent");
    await f.getByRole("button", { name: "Cancel" }).click();
  });

  it("creates Breakfast, Lunch, Dinner and Snack: one POST + one week refetch each, persisted and shown with Tehran time", async () => {
    for (const [type, label, text] of [["breakfast", "Breakfast", "Oats and fruit"], ["lunch", "Lunch", "Chicken bowl"], ["dinner", "Dinner", "Salmon and rice"], ["snack", "Snack", "Yogurt"]]) {
      const calls = await create({ mealType: type, dateKey: TODAY, time: "00:00", description: `  ${text}  ` });
      assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/members/me/meals", "GET /api/members/me/meals"], `${label}: one mutation + one refetch`);
      assert.deepEqual(JSON.parse(calls[0].body), { mealType: type, dateKey: TODAY, time: "00:00", description: text }, "trimmed body, no extra fields");
    }
    const shown = await dayMeals(TODAY);
    assert.deepEqual(shown, ["Breakfast · 00:00 Oats and fruit Edit Delete", "Lunch · 00:00 Chicken bowl Edit Delete", "Dinner · 00:00 Salmon and rice Edit Delete", "Snack · 00:00 Yogurt Edit Delete"]);
    assert.equal(await page.getByText("No meals logged this week.").count(), 0);
    assert.equal(count("member_meals", `member_id = ${memberId(M1)}`), 4);
  });

  it("reload persistence: the four meals are still there", async () => {
    await page.reload();
    await nav().getByRole("button", { name: "Meal Log" }).waitFor();
    await openMeals();
    assert.equal((await dayMeals(TODAY)).length, 4);
  });

  it("historical meal: a date in an earlier week saves and the view moves to that week", async () => {
    const day = OLD[3].dateKey;
    const calls = await create({ mealType: "dinner", dateKey: day, time: "19:45", description: "Old week dinner" });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}${c.search}`),
      ["POST /api/members/me/meals", `GET /api/members/me/meals?from=${OLD[0].dateKey}&to=${OLD[6].dateKey}`]);
    assert.deepEqual(await dayMeals(day), ["Dinner · 19:45 Old week dinner Edit Delete"]);
    await page.getByRole("button", { name: "Current week" }).waitFor();
    await gotoCurrentWeek();
    assert.equal((await dayMeals(TODAY)).length, 4);
  });

  it("week navigation: previous / next / current each issue exactly one range request; future week is empty", async () => {
    const mark = net.length;
    await gotoPrevWeek(PREV);
    await page.getByText("No meals logged this week.").waitFor();
    await gotoPrevWeek(OLD);
    assert.equal((await dayMeals(OLD[3].dateKey)).length, 1);
    await gotoNextWeek(PREV);
    await gotoNextWeek(CUR);
    await gotoNextWeek(weekOf(1));
    await page.getByText("No meals logged this week.").waitFor();
    assert.equal(await page.locator("[data-meal]").count(), 0);
    // Future weeks can be viewed but a future instant still cannot be saved.
    await page.getByRole("button", { name: "Log meal" }).click();
    const f = form("Log meal");
    await fillForm(f, { mealType: "lunch", dateKey: weekOf(1)[2].dateKey, time: "12:00", description: "future" });
    await f.getByRole("button", { name: "Save" }).click();
    await f.getByRole("alert").filter({ hasText: "can't be logged in the future" }).waitFor();
    await f.getByRole("button", { name: "Cancel" }).click();
    await gotoCurrentWeek();
    const weekGets = net.slice(mark).filter((r) => r.path === "/api/members/me/meals" && r.method === "GET");
    assert.equal(weekGets.length, 6, "prev, prev, next, next, next, current: one request per move");
    assert.ok(weekGets.every((r) => /^\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/.test(r.search)), "always a range, never per day");
    assert.equal(net.slice(mark).filter((r) => r.method !== "GET").length, 0);
  });

  it("Tehran grouping in a Los Angeles browser: 23:30 Friday and 00:30 Saturday land on their own Tehran days, times are Tehran times, rows sorted by time", async () => {
    const id = memberId(M1);
    seed(id, OLD[6].dateKey, "23:30", "dinner", "late friday");
    seed(id, PREV[0].dateKey, "00:30", "snack", "early saturday");
    seed(id, PREV[2].dateKey, "20:00", "dinner", "evening first inserted");
    seed(id, PREV[2].dateKey, "08:00", "breakfast", "morning second inserted");
    await gotoPrevWeek(PREV);
    assert.deepEqual(await dayMeals(PREV[0].dateKey), ["Snack · 00:30 early saturday Edit Delete"]);
    assert.deepEqual(await dayMeals(PREV[2].dateKey), ["Breakfast · 08:00 morning second inserted Edit Delete", "Dinner · 20:00 evening first inserted Edit Delete"]);
    await gotoPrevWeek(OLD);
    assert.deepEqual(await dayMeals(OLD[6].dateKey), ["Dinner · 23:30 late friday Edit Delete"]);
    await gotoCurrentWeek();
  });

  it("edit: type, time and description change via one PATCH + one refetch; persisted after reload", async () => {
    const row = page.locator(`[data-day="${TODAY}"] [data-meal]`).filter({ hasText: /Dinner · 00:00\s*Salmon and rice/ });
    await row.getByRole("button", { name: "Edit" }).click();
    const f = form("Edit meal");
    assert.equal(await f.locator("select").inputValue(), "dinner");
    assert.equal(await f.locator('input[type="time"]').inputValue(), "00:00");
    assert.equal(await f.locator("textarea").inputValue(), "Salmon and rice");
    await fillForm(f, { mealType: "snack", time: "00:01", description: "Edited late snack" });
    const mark = net.length;
    await Promise.all([page.waitForResponse((r) => r.request().method() === "PATCH"), f.getByRole("button", { name: "Save changes" }).click()]);
    await page.getByRole("status").filter({ hasText: "Changes saved." }).waitFor();
    await loaded();
    assert.deepEqual(net.slice(mark).map((c) => `${c.method} ${c.path.replace(/\d+$/, ":id")}`), ["PATCH /api/members/me/meals/:id", "GET /api/members/me/meals"]);
    assert.deepEqual(JSON.parse(net[mark].body), { mealType: "snack", dateKey: TODAY, time: "00:01", description: "Edited late snack" });
    await page.reload();
    await openMeals();
    const shown = await dayMeals(TODAY);
    assert.ok(shown.includes("Snack · 00:01 Edited late snack Edit Delete"), JSON.stringify(shown));
    assert.equal(shown.some((t) => t.includes("Salmon and rice")), false);
  });

  it("delete: Cancel sends no request; Confirm sends exactly one DELETE + one refetch; stays deleted after reload", async () => {
    const target = () => page.locator(`[data-day="${TODAY}"] [data-meal]`).filter({ hasText: "Yogurt" });
    let mark = net.length;
    await target().getByRole("button", { name: "Delete" }).click();
    await page.getByText("Delete this meal entry?").waitFor();
    await page.getByText("This cannot be undone.").waitFor();
    await target().getByRole("button", { name: "Cancel" }).click();
    await target().getByRole("button", { name: "Edit" }).waitFor();
    assert.equal(net.slice(mark).length, 0, "cancel sent no request");
    assert.equal(count("member_meals", "description = 'Yogurt'"), 1);

    mark = net.length;
    await target().getByRole("button", { name: "Delete" }).click();
    await Promise.all([page.waitForResponse((r) => r.request().method() === "DELETE"), target().getByRole("button", { name: "Delete" }).last().click()]);
    await page.getByRole("status").filter({ hasText: "Meal deleted." }).waitFor();
    await loaded();
    assert.deepEqual(net.slice(mark).map((c) => `${c.method} ${c.path.replace(/\d+$/, ":id")}`), ["DELETE /api/members/me/meals/:id", "GET /api/members/me/meals"]);
    assert.equal(await target().count(), 0);
    await page.reload();
    await openMeals();
    assert.equal((await dayMeals(TODAY)).some((t) => t.includes("Yogurt")), false);
    assert.equal(count("member_meals", "description = 'Yogurt'"), 0);
  });

  it("isolation: another Member's meals never appear, and responses carry no memberId", async () => {
    seed(memberId(M2), TODAY, "00:00", "lunch", "OTHER MEMBER SECRET");
    await page.reload();
    await openMeals();
    assert.equal(await page.getByText("OTHER MEMBER SECRET").count(), 0);
    assert.equal(mealBodies.some((b) => b.includes("OTHER MEMBER SECRET") || /memberId|coachId|userId/.test(b)), false);
    sql(`DELETE FROM member_meals WHERE description = 'OTHER MEMBER SECRET'`);
  });

  it("404 on edit and on delete: 'no longer available', list refetched, page intact", async () => {
    const mine = () => page.locator(`[data-day="${TODAY}"] [data-meal]`).filter({ hasText: "Oats and fruit" });
    await mine().getByRole("button", { name: "Edit" }).click();
    sql(`DELETE FROM member_meals WHERE description = 'Oats and fruit'`);
    await Promise.all([page.waitForResponse((r) => r.request().method() === "PATCH"), form("Edit meal").getByRole("button", { name: "Save changes" }).click()]);
    await page.getByRole("alert").filter({ hasText: "This meal entry is no longer available." }).waitFor();
    await loaded();
    assert.equal(await mine().count(), 0);

    const lunch = () => page.locator(`[data-day="${TODAY}"] [data-meal]`).filter({ hasText: "Chicken bowl" });
    await lunch().getByRole("button", { name: "Delete" }).click();
    sql(`DELETE FROM member_meals WHERE description = 'Chicken bowl'`);
    await Promise.all([page.waitForResponse((r) => r.request().method() === "DELETE"), lunch().getByRole("button", { name: "Delete" }).last().click()]);
    await page.getByRole("alert").filter({ hasText: "This meal entry is no longer available." }).waitFor();
    await loaded();
    assert.equal(await lunch().count(), 0);
    await nav().getByRole("button", { name: "Meal Log" }).waitFor();
  });

  it("existing Member views still render: Cycle and Sessions", async () => {
    await nav().getByRole("button", { name: "Cycle" }).click();
    await page.getByRole("heading", { name: /Period & PMS/ }).waitFor();
    await page.getByRole("button", { name: "Add dates" }).waitFor();
    await nav().getByRole("button", { name: "Sessions" }).click();
    await page.getByRole("heading", { name: /Your sessions/ }).waitFor();
    await nav().getByRole("button", { name: "Meal Log" }).click();
    await page.getByRole("heading", { name: /Your meals/ }).waitFor();
  });

  it("server 500s keep the Member signed in: failed load shows Retry, failed save keeps the form", async () => {
    const failing = "**/api/members/me/meals**";
    await page.route(failing, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await page.getByRole("button", { name: "Previous week" }).click();
    await page.getByRole("alert").filter({ hasText: "Could not load your meals." }).waitFor();
    await nav().getByRole("button", { name: "Meal Log" }).waitFor();
    await page.unroute(failing);
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/members/me/meals")), page.getByRole("button", { name: "Retry" }).click()]);
    await loaded();
    await gotoNextWeek(CUR);

    await page.getByRole("button", { name: "Log meal" }).click();
    const f = form("Log meal");
    await fillForm(f, { mealType: "lunch", dateKey: TODAY, time: "00:00", description: "will fail" });
    await page.route(failing, (route) => (route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue()));
    await f.getByRole("button", { name: "Save" }).click();
    await f.getByRole("alert").filter({ hasText: "Could not save meal. Try again." }).waitFor();
    assert.equal(await f.locator("textarea").inputValue(), "will fail", "form content is kept");
    await page.unroute(failing);
    assert.equal(count("member_meals", "description = 'will fail'"), 0);
    await f.getByRole("button", { name: "Cancel" }).click();
    await nav().getByRole("button", { name: "Meal Log" }).waitFor();
    assert.equal((await fetchBounded(`${BASE}/api/auth/me`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).status, 200, "still signed in");
  });

  it("401 from the meals API returns to the sign-in screen", async () => {
    await page.route("**/api/members/me/meals**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Not authenticated."}' }));
    await page.getByRole("button", { name: "Previous week" }).click();
    await page.getByLabel("Email").waitFor();
    await page.unroute("**/api/members/me/meals**");
  });
});
