/**
 * LOCAL ONLY. Real-browser regression for the Session-backed Coach Calendar
 * (SEC0I2): headless Chromium against the real built Worker + real local D1, no
 * mocks. The browser runs in a deliberately different timezone (Los Angeles) to
 * prove every business date comes from the Tehran helpers.
 *
 *   npm run build && npm run test:coach-calendar-ui
 *
 * Seeds Sessions directly in D1 for the read model, then (SEC0I3) drives the real
 * attendance mutations from Today and the Calendar: Present/Absent, past backfill,
 * past pending-replacement completion, future read-only, zero-Member shell. Requires the clean local baseline and refuses to run otherwise.
 * Temporary rows use the `@calui.example.test` domain or the `CalTest` name
 * prefix; the original users rows are snapshotted and restored, pass or fail.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright-core";
import { count, fetchBounded, installSuiteGuard, resolveChromium, sql, startWorker } from "./test-helpers.mjs";
import { shortJalaliLabel } from "../lib/coach-calendar.ts";
import { getAppDateKey, getJalaliMonthGrid, localDateTimeToUtcIso, shiftJalaliMonth } from "../lib/date-time.ts";

const PORT = process.env.COACH_CALENDAR_UI_TEST_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "@calui.example.test";
const PREFIX = "CalTest";
const SA = "superadmin@example.test";
const COACH1 = "coach1@example.test";
const FIXTURES = { [SA]: "LocalAdmin123!", [COACH1]: "LocalCoach123!", "member1@example.test": "LocalMember123!" };
const COACH_B = `coach.b${DOMAIN}`;
const COACH_B_PASSWORD = "CalCoachB12345!";
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0 };

if (process.argv.includes("--remote")) throw new Error("test-coach-calendar-ui is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");
const CHROMIUM = resolveChromium(chromium);

const baselineCounts = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"), auth_sessions: count("auth_sessions") });
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

let server, browser, page, snapshot = null, baselineVerified = false;
installSuiteGuard("test-coach-calendar-ui", 300_000, () => {
  try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
  server?.killNow();
  if (baselineVerified) cleanup();
});

function cleanup() {
  sql(`DELETE FROM auth_sessions; DELETE FROM session_notes; DELETE FROM session_muscles; DELETE FROM sessions WHERE replacement_for_id IS NOT NULL; DELETE FROM sessions; ` +
    `DELETE FROM members WHERE name LIKE '${PREFIX}%'; UPDATE members SET coach_id = 1; ` +
    `DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%${DOMAIN}'); DELETE FROM users WHERE email LIKE '%${DOMAIN}';`);
  for (const u of snapshot ?? []) {
    sql(`UPDATE users SET email = ${q(u.email)}, password_hash = ${q(u.password_hash)}, is_active = ${q(u.is_active)}, updated_at = ${q(u.updated_at)} WHERE id = ${u.id}`);
  }
}

async function apiLogin(email, password) {
  return fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
}
async function apiCookie(email, password) {
  const response = await apiLogin(email, password);
  assert.equal(response.status, 200, `login ${email}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function api(cookie, method, path, body) {
  const response = await fetchBounded(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json().catch(() => null) };
}

// ---- Calendar fixtures, all derived from the real Tehran "today" -------------------------------
const TODAY = getAppDateKey();
const CUR = getJalaliMonthGrid(TODAY);
const PREV = getJalaliMonthGrid(shiftJalaliMonth(TODAY, -1));
const NEXT = getJalaliMonthGrid(shiftJalaliMonth(TODAY, 1));
const day = (grid, i) => grid.days[i].dateKey;
const satIndex = PREV.days.findIndex((d, i) => i >= 14 && d.weekday === "Sat");
const D = {
  unrecorded: day(PREV, 0), completed: day(PREV, 2), absent: day(PREV, 4), replacement: day(PREV, 6),
  beforeBeta: day(PREV, 7), betaStart: day(PREV, 10), afterBeta: day(PREV, 12),
  gammaSat: day(PREV, satIndex), gammaReplacement: day(PREV, satIndex + 2),
  crossAbsent: day(PREV, 20), crossReplacement: day(NEXT, 1), future: day(NEXT, 4),
};
const at = (dateKey, time) => localDateTimeToUtcIso(dateKey, time);
const ids = {};

describe("Coach Calendar UI (real browser)", () => {
  before(async () => {
    assert.deepEqual(baselineCounts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(baselineCounts())}`);
    baselineVerified = true;
    snapshot = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");
    server = await startWorker(PORT);
    browser = await chromium.launch({ executablePath: CHROMIUM, timeout: 30_000 });

    // Members through the real Coach API; createdAt and Sessions seeded in D1.
    const coach = await apiCookie(COACH1, FIXTURES[COACH1]);
    const make = async (name, days, time) => {
      const body = { name: `${PREFIX} ${name}`, phone: "09120000000", weightKg: 60, heightCm: 170, goal: "fitness", defaultStartTime: time, defaultDurationMinutes: 50, preferredDays: days };
      const created = await api(coach, "POST", "/api/members", body);
      assert.equal(created.status, 201);
      return created.json.member.id;
    };
    const everyDay = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
    ids.alpha = await make("Alpha", everyDay, "09:00");
    ids.beta = await make("Beta", everyDay, "10:00");
    ids.gamma = await make("Gamma", ["Sat"], "11:00");
    sql(`UPDATE members SET created_at = '2020-01-01 00:00:00' WHERE id IN (${ids.alpha}, ${ids.gamma}); ` +
      `UPDATE members SET created_at = '${D.betaStart} 06:00:00' WHERE id = ${ids.beta};`);

    const insert = (memberId, dateKey, time, status, forAbsentAt = null) =>
      `INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes, replacement_for_id) VALUES (${memberId}, 1, '${at(dateKey, time)}', '${status}', 50, ` +
      `${forAbsentAt ? `(SELECT id FROM sessions WHERE member_id = ${memberId} AND status = 'absent' AND scheduled_at = '${at(forAbsentAt, "09:00")}')` : "NULL"}); `;
    sql(
      insert(ids.alpha, D.completed, "09:00", "completed") +
      insert(ids.alpha, D.absent, "09:00", "absent") + insert(ids.alpha, D.replacement, "17:00", "replacement", D.absent) +
      insert(ids.alpha, D.crossAbsent, "09:00", "absent") + insert(ids.alpha, D.crossReplacement, "18:00", "replacement", D.crossAbsent) +
      `INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes) VALUES (${ids.gamma}, 1, '${at(D.gammaSat, "11:00")}', 'absent', 50); ` +
      `INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes, replacement_for_id) VALUES (${ids.gamma}, 1, '${at(D.gammaReplacement, "15:30")}', 'completed', 50, ` +
      `(SELECT id FROM sessions WHERE member_id = ${ids.gamma} AND status = 'absent' AND scheduled_at = '${at(D.gammaSat, "11:00")}'));`
    );
  });

  after(async () => {
    try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch { /* ignore */ }
    try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
    try {
      if (baselineVerified) {
        cleanup();
        for (const [email, password] of Object.entries(FIXTURES)) assert.equal((await apiLogin(email, password)).status, 200, `post-cleanup login ${email}`);
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
  const rangeRequests = [];
  const net = []; // every /api request of the current page: for the mutation + refetch audit
  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const p = await context.newPage();
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) net.push({ method: r.method(), path: u.pathname, search: u.search, body: r.postData() });
      if (u.pathname === "/api/sessions" && u.searchParams.has("from")) rangeRequests.push(`${u.searchParams.get("from")}|${u.searchParams.get("to")}`);
    });
    return p;
  };
  const login = async (email, password) => {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in|log in|login/i }).click();
  };
  const loaded = () => page.waitForFunction(() => !document.querySelector(".agenda .empty-agenda") || !/Loading sessions/.test(document.querySelector(".agenda").innerText));
  const openCalendar = async () => { await page.locator("aside.sidebar nav").getByRole("button", { name: "Calendar" }).click(); await loaded(); };
  const monthMode = () => page.locator(".view-toggle").getByRole("button", { name: "Month" }).click();
  const eyebrow = () => page.locator(".page-heading .eyebrow").innerText();
  const step = async (label) => {
    const was = await eyebrow();
    await page.getByRole("button", { name: label }).click();
    await page.waitForFunction((old) => document.querySelector(".page-heading .eyebrow")?.textContent !== old, was);
    await loaded();
  };
  const prev = () => step("Previous month");
  const next = () => step("Next month");
  const pick = async (dateKey) => {
    await page.locator(`.month-grid [data-date="${dateKey}"]`).click();
    await page.locator(`.month-grid .selected-day[data-date="${dateKey}"]`).waitFor();
    await loaded();
  };
  const goToday = async () => { await page.locator(".month-nav").getByRole("button", { name: "Today" }).click(); await loaded(); };
  const rowsOf = (name) => page.locator(`.agenda-row[data-member="${PREFIX} ${name}"]`)
    .evaluateAll((els) => els.map((e) => ({ state: e.dataset.state, text: e.innerText.replace(/\s+/g, " ").trim(), present: !!e.querySelector(".calendar-present"),
      actions: [...e.querySelectorAll(".att-btn")].map((b) => `${b.dataset.action}:${b.innerText.trim()}`) })));
  const rangeKey = (grid) => `${grid.startDateKey}|${grid.endDateKey}`;

  it("Coach login -> Calendar loads exactly the current Jalali month range, no per-day/per-Member fan-out", async () => {
    page = await newPage();
    await login(COACH1, FIXTURES[COACH1]);
    await page.locator("aside.sidebar").getByText("Independent coach").waitFor();
    await openCalendar();
    assert.ok(rangeRequests.includes(rangeKey(CUR)), `missing ${rangeKey(CUR)} in ${rangeRequests}`);
    assert.equal(new Set(rangeRequests).size, rangeRequests.length, "a range was requested twice");
    assert.ok(rangeRequests.length <= 2, `more than month + one neighbouring week month: ${rangeRequests}`);
  });

  it("Month view is the real Jalali month: true length, weekday offset, real Gregorian keys", async () => {
    await monthMode();
    assert.equal((await page.locator(".calendar").evaluate(() => document.querySelector(".page-heading .eyebrow").textContent)), `${CUR.monthName.toUpperCase()} ${CUR.year}`);
    const cells = await page.locator(".month-grid button").evaluateAll((els) => els.map((e) => e.dataset.date));
    assert.deepEqual(cells, CUR.days.map((d) => d.dateKey));
    assert.equal(await page.locator(".month-grid > i").count(), CUR.leadingBlanks);
    assert.equal(await page.locator(".month-grid .today-day").getAttribute("data-date"), TODAY);
  });

  it("previous month: one new request; completed / absent / replacement / Not recorded are the real persisted states", async () => {
    const before = rangeRequests.length;
    await prev();
    assert.equal(rangeRequests.length, before + 1);
    assert.equal(rangeRequests.at(-1), rangeKey(PREV));
    assert.equal(await page.locator(".month-grid button").count(), PREV.days.length);

    await pick(D.completed);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => [r.state, /09:00/.test(r.text)]), [["completed", true]]);
    assert.equal(await page.locator(`.month-grid [data-date="${D.completed}"]`).getAttribute("data-top"), "completed");

    await pick(D.absent);
    const absent = await rowsOf("Alpha");
    assert.deepEqual(absent.map((r) => r.state), ["absent"]);
    assert.ok(absent[0].text.includes(`Replaced on ${shortJalaliLabel(D.replacement)}`), absent[0].text);

    await pick(D.replacement);
    const replacement = await rowsOf("Alpha");
    assert.deepEqual(replacement.map((r) => r.state), ["replacement-pending"]);
    assert.ok(replacement[0].text.includes(`Replacement for ${shortJalaliLabel(D.absent)}`), replacement[0].text);
    assert.ok(/17:00/.test(replacement[0].text));

    await pick(D.unrecorded);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => r.state), ["not-recorded"]); // never inferred as Absent
    assert.equal(await page.locator(".agenda-row[data-state=absent]").count(), 0);
    assert.equal(await page.locator(".calendar-present").count(), 0); // no attendance writes on past days
  });

  it("replacement on a NON-preferred weekday is visible and distinguishable (completed replacement)", async () => {
    await pick(D.gammaReplacement);
    const rows = await rowsOf("Gamma");
    assert.deepEqual(rows.map((r) => r.state), ["replacement-completed"]);
    assert.ok(rows[0].text.includes(`Replacement for ${shortJalaliLabel(D.gammaSat)}`), rows[0].text);
    await pick(D.gammaSat);
    assert.deepEqual((await rowsOf("Gamma")).map((r) => r.state), ["absent"]);
  });

  it("no Not-recorded before a Member existed; Not recorded from their first day on", async () => {
    await pick(D.beforeBeta);
    assert.deepEqual(await rowsOf("Beta"), []);
    await pick(D.betaStart);
    assert.deepEqual((await rowsOf("Beta")).map((r) => r.state), ["not-recorded"]);
    await pick(D.afterBeta);
    assert.deepEqual((await rowsOf("Beta")).map((r) => r.state), ["not-recorded"]);
  });

  it("next month: future expectations render, cross-month replacement resolves its link from loaded data", async () => {
    await next(); // back to the current month: cached, no request
    assert.equal(new Set(rangeRequests).size, rangeRequests.length);
    const before = rangeRequests.length;
    await next();
    assert.equal(rangeRequests.length, before + 1);
    assert.equal(rangeRequests.at(-1), rangeKey(NEXT));
    await pick(D.future);
    const future = await rowsOf("Alpha");
    assert.deepEqual(future.map((r) => [r.state, r.present]), [["expected", false]]); // no future writes
    await pick(D.crossReplacement);
    const cross = await rowsOf("Alpha");
    assert.deepEqual(cross.map((r) => r.state), ["replacement-pending"]);
    assert.ok(cross[0].text.includes(`Replacement for ${shortJalaliLabel(D.crossAbsent)}`), cross[0].text);
  });

  it("navigating back to visited months uses the cache: zero new Session requests", async () => {
    const before = rangeRequests.length;
    await prev(); await prev(); await next();
    assert.equal(rangeRequests.length, before);
    assert.equal(new Set(rangeRequests).size, rangeRequests.length);
  });

  it("Today shows Expected with the existing Present action; week strip uses the same derivation", async () => {
    await goToday();
    assert.equal(await page.locator(".month-grid .selected-day").getAttribute("data-date"), TODAY);
    const today = await rowsOf("Alpha");
    assert.deepEqual(today.map((r) => [r.state, r.present]), [["expected", true]]);
    await page.locator(".view-toggle").getByRole("button", { name: "Week" }).click();
    assert.equal(await page.locator(".week button").count(), 7);
    assert.equal(await page.locator(`.week [data-date="${TODAY}"]`).getAttribute("data-top"), "expected");
    await monthMode();
  });

  it("a failing range request is local to the Calendar: roster intact, Retry recovers", async () => {
    const failing = (url) => url.pathname === "/api/sessions" && url.searchParams.has("from");
    await next(); // a cached month first
    await page.route(failing, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await page.getByRole("button", { name: "Next month" }).click(); // an uncached month
    await page.getByText("Could not load sessions").waitFor();
    assert.ok(await page.locator("aside.sidebar nav").isVisible()); // CoachApp is not blanked
    await page.unroute(failing);
    await page.locator(".agenda").getByRole("button", { name: "Retry" }).click();
    await page.locator(".agenda .empty-agenda strong", { hasText: "Could not load" }).waitFor({ state: "detached" });
    await loaded();
    await goToday();
  });

  it("reload preserves Session-derived statuses", async () => {
    await page.reload();
    await openCalendar();
    await monthMode();
    await prev();
    await pick(D.absent);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => r.state), ["absent"]);
    await pick(D.completed);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => r.state), ["completed"]);
  });

  // ---- SEC0I3: Today + attendance mutations ---------------------------------------------------------
  const sidebar = async (label) => { await page.locator("aside.sidebar nav").getByRole("button", { name: label }).click(); };
  const todayLoaded = () => page.waitForFunction(() => { const el = document.querySelector(".schedule"); return !!el && !/Loading sessions/.test(el.innerText); });
  const openToday = async () => { await sidebar("Today"); await todayLoaded(); };
  const todayRows = () => page.locator(".schedule-row").evaluateAll((els) => els.map((e) => [e.dataset.member, e.dataset.state]));
  const todayRow = (name) => page.locator(`.schedule-row[data-member="${PREFIX} ${name}"]`);
  const calendarTodayRows = () => page.locator(".agenda-row").evaluateAll((els) => els.map((e) => [e.dataset.member, e.dataset.state]));
  const apiSince = (mark) => net.slice(mark);
  const writes = (list) => list.filter((r) => r.method !== "GET");
  const confirmSession = async () => {
    await page.getByRole("button", { name: "Save & confirm attendance" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  };
  const metric = (cls) => page.locator(`.metric.${cls} > strong`).innerText();

  it("Today lists EVERY expected Member from the real model (not the first three) and agrees with the Calendar", async () => {
    await page.context().close();
    page = await newPage();
    await login(COACH1, FIXTURES[COACH1]);
    await page.locator("aside.sidebar").getByText("Independent coach").waitFor();
    await todayLoaded();
    const rows = await todayRows();
    const names = rows.map((r) => r[0]);
    // Alpha and Beta are the 5th/6th roster entries: a slice(0, 3) list could never show them.
    assert.ok(names.includes(`${PREFIX} Alpha`) && names.includes(`${PREFIX} Beta`), `Today rows: ${names}`);
    assert.deepEqual(rows.filter((r) => r[0].startsWith(PREFIX) && r[0] !== `${PREFIX} Gamma`).map((r) => r[1]), ["expected", "expected"]);
    assert.ok(await todayRow("Alpha").locator("time").innerText() === "09:00");
    assert.ok(/50 min/.test(await todayRow("Alpha").innerText()));
    assert.deepEqual(await todayRow("Alpha").locator(".att-btn").evaluateAll((els) => els.map((e) => e.innerText.trim())), ["Present", "Absent"]);
    assert.equal(await metric("green"), String(rows.length)); // real load, never the hardcoded 4
    assert.equal(await metric("gold"), "0");
    assert.equal(await page.getByText("CLIENT CONSISTENCY").count() + await page.getByText("PLANS ENDING SOON").count() + await page.getByText("Four sessions today").count(), 0);

    await sidebar("Calendar"); await loaded();
    assert.deepEqual(await calendarTodayRows(), rows); // same date, same derivation
  });

  it("Today Present: one POST for today's date, UI updates with no reload, only the month range is refetched, and it persists", async () => {
    await openToday();
    await todayRow("Alpha").getByRole("button", { name: "Present" }).click();
    await page.getByRole("dialog").waitFor();
    const mark = net.length;
    await confirmSession();
    await page.locator(`.schedule-row[data-member="${PREFIX} Alpha"][data-state="completed"]`).waitFor();
    assert.deepEqual(await todayRow("Alpha").locator(".att-btn").count(), 0); // no duplicate actions on a Completed row
    const calls = apiSince(mark);
    assert.deepEqual(writes(calls).map((r) => `${r.method} ${r.path}`), ["POST /api/sessions"]);
    assert.deepEqual(JSON.parse(writes(calls)[0].body), { memberId: ids.alpha, dateKey: TODAY });
    const reads = calls.filter((r) => r.method === "GET");
    assert.ok(reads.length >= 1 && reads.every((r) => r.path === "/api/sessions" && /from=/.test(r.search) && !/memberId=\d+&limit/.test(r.search)), JSON.stringify(reads));
    assert.ok(reads.length <= 2, `per-Member fan-out? ${JSON.stringify(reads)}`);
    assert.equal(await metric("gold"), "1");

    await page.reload(); await todayLoaded();
    assert.equal(await todayRow("Alpha").getAttribute("data-state"), "completed"); // persisted
    assert.equal(sql(`SELECT count(*) AS n FROM sessions WHERE member_id = ${ids.alpha} AND status = 'completed' AND scheduled_at = '${at(TODAY, "09:00")}'`)[0].n, 1);
  });

  it("Today Absent: one absence POST, Today updates in place, the replacement lands on the chosen (future) date as read-only Replacement pending", async () => {
    await openToday();
    await todayRow("Beta").getByRole("button", { name: "Absent" }).click();
    await page.getByRole("dialog").getByText("Reschedule before marking absent").waitFor();
    const choice = page.locator(".replacement-days button").first();
    const replacementKey = await page.locator('input[name="replacementDate"]').inputValue();
    await choice.click();
    const mark = net.length;
    await page.getByRole("button", { name: "Confirm absence & reschedule" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.locator(`.schedule-row[data-member="${PREFIX} Beta"][data-state="absent"]`).waitFor();
    assert.deepEqual(writes(apiSince(mark)).map((r) => `${r.method} ${r.path}`), ["POST /api/sessions/absence"]);
    const body = JSON.parse(writes(apiSince(mark))[0].body);
    assert.equal(body.dateKey, TODAY);
    assert.equal(body.replacementDateKey, replacementKey);
    assert.equal(await metric("slate"), "1");
    assert.ok(/replacement/.test(await page.locator(".metric.slate > small").innerText()));

    // Calendar agrees, and the replacement is on the chosen day, read-only because it is in the future.
    await sidebar("Calendar"); await loaded();
    assert.deepEqual((await rowsOf("Beta")).map((r) => [r.state, r.actions]), [["absent", []]]);
    await page.locator(".view-toggle").getByRole("button", { name: "Month" }).click();
    await pick(replacementKey);
    const replacement = await rowsOf("Beta");
    assert.deepEqual(replacement.map((r) => [r.state, r.actions]), [["replacement-pending", []]]); // future: no Complete
    assert.ok(replacement[0].text.includes("Replacement for"), replacement[0].text);
    await goToday();
  });

  it("past Not recorded: Mark completed POSTs the SELECTED date, flips to Completed in place and survives reload", async () => {
    await prev();
    const target = day(PREV, 1);
    await pick(target);
    const before = await rowsOf("Alpha");
    assert.deepEqual(before.map((r) => [r.state, r.actions]), [["not-recorded", ["complete:Mark completed", "absent:Mark absent"]]]);
    await page.locator(`.agenda-row[data-member="${PREFIX} Alpha"]`).getByRole("button", { name: "Mark completed" }).click();
    const mark = net.length;
    await confirmSession();
    await page.locator(`.agenda-row[data-member="${PREFIX} Alpha"][data-state="completed"]`).waitFor();
    const calls = apiSince(mark);
    assert.deepEqual(writes(calls).map((r) => `${r.method} ${r.path}`), ["POST /api/sessions"]);
    assert.deepEqual(JSON.parse(writes(calls)[0].body), { memberId: ids.alpha, dateKey: target }); // the row's date, not today
    assert.equal(await page.locator(`.month-grid [data-date="${target}"]`).getAttribute("data-top"), "completed");

    await page.reload(); await openCalendar(); await monthMode(); await prev(); await pick(target);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => [r.state, r.actions]), [["completed", []]]);
  });

  it("past Not recorded: Mark absent uses the historical date; a replacement before it is refused, one in the NEXT-month range is saved and that month is fresh", async () => {
    const target = day(PREV, 3);
    await pick(target);
    await page.locator(`.agenda-row[data-member="${PREFIX} Alpha"]`).getByRole("button", { name: "Mark absent" }).click();
    await page.getByRole("dialog").getByText("Reschedule before marking absent").waitFor();
    assert.equal(await page.locator('input[name="replacementDate"]').getAttribute("min"), target);

    await page.locator('input[name="replacementDate"]').fill(day(PREV, 2)); // before the absence
    await page.getByRole("button", { name: "Confirm absence & reschedule" }).click();
    await page.getByRole("dialog").getByText("cannot be before").waitFor();

    const replacementKey = day(CUR, 0); // another Jalali month, past or today
    await page.locator('input[name="replacementDate"]').fill(replacementKey);
    await page.locator('.app-dialog input[name="time"]').fill("17:00");
    const mark = net.length;
    await page.getByRole("button", { name: "Confirm absence & reschedule" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.locator(`.agenda-row[data-member="${PREFIX} Alpha"][data-state="absent"]`).waitFor();
    const calls = apiSince(mark);
    assert.deepEqual(writes(calls).map((r) => `${r.method} ${r.path}`), ["POST /api/sessions/absence"]);
    assert.deepEqual(JSON.parse(writes(calls)[0].body), { memberId: ids.alpha, dateKey: target, replacementDateKey: replacementKey, replacementTime: "17:00" });
    // The replacement's month is not loaded yet, so the label is not guessed (no extra request).
    assert.ok(!(await rowsOf("Alpha"))[0].text.includes("Replaced on"));

    await next(); // the CURRENT month: its cache was invalidated by the mutation, so it must show the new row
    await pick(replacementKey);
    const rows = await rowsOf("Alpha");
    assert.ok(rows.some((r) => r.state === "replacement-pending" && r.text.includes(`Replacement for ${shortJalaliLabel(target)}`)), JSON.stringify(rows));
    await prev(); await pick(target); // both months are now loaded, so the cross-month link resolves
    assert.ok((await rowsOf("Alpha"))[0].text.includes(`Replaced on ${shortJalaliLabel(replacementKey)}`));
    assert.equal(sql(`SELECT count(*) AS n FROM sessions WHERE member_id = ${ids.alpha} AND status = 'absent' AND scheduled_at = '${at(target, "09:00")}'`)[0].n, 1);
  });

  it("past pending Replacement: Complete replacement PATCHes that row (no new Session, link preserved)", async () => {
    await pick(D.replacement);
    const rows = await rowsOf("Alpha");
    assert.deepEqual(rows.map((r) => [r.state, r.actions]), [["replacement-pending", ["complete-replacement:Complete replacement"]]]);
    const rowId = sql(`SELECT id, replacement_for_id AS r FROM sessions WHERE member_id = ${ids.alpha} AND scheduled_at = '${at(D.replacement, "17:00")}'`)[0];
    const total = count("sessions");
    await page.locator(`.agenda-row[data-member="${PREFIX} Alpha"]`).getByRole("button", { name: "Complete replacement" }).click();
    const mark = net.length;
    await confirmSession();
    await page.locator(`.agenda-row[data-member="${PREFIX} Alpha"][data-state="replacement-completed"]`).waitFor();
    assert.deepEqual(writes(apiSince(mark)).map((r) => `${r.method} ${r.path}`), [`PATCH /api/sessions/${rowId.id}/complete`]);
    assert.equal(count("sessions"), total); // completed in place
    const after = sql(`SELECT status, replacement_for_id AS r, coach_id FROM sessions WHERE id = ${rowId.id}`)[0];
    assert.deepEqual([after.status, after.r, after.coach_id], ["completed", rowId.r, 1]);
    await pick(D.absent); // the original absence still links to it
    assert.ok((await rowsOf("Alpha"))[0].text.includes(`Replaced on ${shortJalaliLabel(D.replacement)}`));
  });

  it("future dates are read-only: Expected and Replacement pending offer no write action", async () => {
    await next(); await next();
    await pick(D.future);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => [r.state, r.actions]), [["expected", []]]);
    await pick(D.crossReplacement);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => [r.state, r.actions]), [["replacement-pending", []]]);
    assert.equal(await page.locator(".agenda .att-btn").count(), 0);
    await goToday();
  });

  it("same-day absence and replacement stay visible and each row targets its own Session id", async () => {
    // Seed a past day: absent + pending replacement the same date, then complete the replacement from the UI.
    const sameDay = day(PREV, 14);
    sql(`INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes) VALUES (${ids.alpha}, 1, '${at(sameDay, "09:00")}', 'absent', 50); ` +
      `INSERT INTO sessions (member_id, coach_id, scheduled_at, status, duration_minutes, replacement_for_id) VALUES (${ids.alpha}, 1, '${at(sameDay, "18:00")}', 'replacement', 50, ` +
      `(SELECT id FROM sessions WHERE member_id = ${ids.alpha} AND status = 'absent' AND scheduled_at = '${at(sameDay, "09:00")}'));`);
    const replacementId = sql(`SELECT id FROM sessions WHERE member_id = ${ids.alpha} AND scheduled_at = '${at(sameDay, "18:00")}'`)[0].id;
    await page.reload(); await openCalendar(); await monthMode(); await prev(); await pick(sameDay);
    const rows = await rowsOf("Alpha");
    assert.deepEqual(rows.map((r) => [r.state, r.actions]), [["absent", []], ["replacement-pending", ["complete-replacement:Complete replacement"]]]);
    const mark = net.length;
    await page.locator('.agenda-row[data-state="replacement-pending"]').getByRole("button", { name: "Complete replacement" }).click();
    await confirmSession();
    await page.locator('.agenda-row[data-state="replacement-completed"]').waitFor();
    assert.deepEqual(writes(apiSince(mark)).map((r) => `${r.method} ${r.path}`), [`PATCH /api/sessions/${replacementId}/complete`]);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => r.state), ["absent", "replacement-completed"]);
  });

  it("a Coach with ZERO Members keeps the full shell with proper empty states", async () => {
    const sa = await apiCookie(SA, FIXTURES[SA]);
    const created = await api(sa, "POST", "/api/admin/coaches", { name: `${PREFIX} Coach B`, email: COACH_B, password: COACH_B_PASSWORD });
    assert.equal(created.status, 201);
    ids.coachB = created.json.coach.id;

    await page.context().close();
    page = await newPage();
    await login(COACH_B, COACH_B_PASSWORD);
    await page.locator("aside.sidebar").getByText("Independent coach").waitFor();
    const navLabels = await page.locator("aside.sidebar nav button").evaluateAll((els) => els.map((e) => e.innerText.replace(/\d+$/, "").trim()));
    assert.deepEqual(navLabels, ["Today", "Clients", "Calendar", "Nutrition", "Settings"]);
    assert.ok(await page.locator("aside.sidebar").getByRole("button", { name: /sign out/i }).isVisible());
    await todayLoaded();
    await page.locator(".schedule .empty-agenda strong", { hasText: "No members scheduled." }).waitFor();
    assert.equal(await metric("green"), "0");

    await sidebar("Clients");
    await page.getByText("No members yet.").first().waitFor();
    assert.ok(await page.locator(".page-heading").getByRole("button", { name: /add client/i }).isVisible()); // create flow stays reachable
    await sidebar("Calendar"); await loaded();
    assert.ok(await page.locator(".calendar").isVisible());
    await page.locator(".agenda .empty-agenda strong", { hasText: "No sessions on this day" }).waitFor();
    await sidebar("Nutrition");
    await page.getByText("No members yet.").first().waitFor();
    await sidebar("Settings");
    await page.getByText("Absence handling").waitFor();
    assert.equal(await page.locator("aside.sidebar nav").isVisible(), true);
  });

  it("Member and a Coach never see another Coach's calendar", async () => {
    const sa = await apiCookie(SA, FIXTURES[SA]);
    // Coach B already exists (created by the zero-Member shell test, which ran with no Members).
    const delta = await api(sa, "POST", "/api/members", { name: `${PREFIX} Delta`, phone: "09120000000", weightKg: 60, heightCm: 170, goal: "fitness",
      defaultStartTime: "12:00", defaultDurationMinutes: 50, preferredDays: ["Sat"], coachId: ids.coachB });
    assert.equal(delta.status, 201);

    await page.context().close();
    page = await newPage();
    await login("member1@example.test", FIXTURES["member1@example.test"]);
    await page.locator("aside.sidebar").getByText("Member", { exact: true }).waitFor();
    assert.equal(await page.locator(".calendar, .agenda").count(), 0);

    await page.context().close();
    page = await newPage();
    await login(COACH_B, COACH_B_PASSWORD);
    await openCalendar(); await monthMode(); await prev();
    assert.equal(await page.locator(`.month-grid [data-date="${D.completed}"]`).getAttribute("data-top"), "");
    await pick(D.completed);
    assert.deepEqual(await rowsOf("Alpha"), []);
    assert.deepEqual(await rowsOf("Gamma"), []);
    assert.equal(await page.locator(`.agenda-row:not([data-member="${PREFIX} Delta"])`).count(), 0);
  });

  it("reassignment: Coach A loses the Member's calendar, Coach B gains schedule and history (no Session rewrite)", async () => {
    const before = sql("SELECT id, coach_id FROM sessions ORDER BY id");
    const sa = await apiCookie(SA, FIXTURES[SA]);
    assert.equal((await api(sa, "PATCH", `/api/admin/members/${ids.alpha}/assignment`, { coachId: ids.coachB })).status, 200);
    assert.deepEqual(sql("SELECT id, coach_id FROM sessions ORDER BY id"), before);

    await page.context().close();
    page = await newPage();
    await login(COACH_B, COACH_B_PASSWORD);
    await openCalendar(); await monthMode(); await prev(); await pick(D.completed);
    assert.deepEqual((await rowsOf("Alpha")).map((r) => r.state), ["completed"]); // history follows the current Coach
    await pick(D.betaStart);
    assert.deepEqual(await rowsOf("Beta"), []);

    await page.context().close();
    page = await newPage();
    await login(COACH1, FIXTURES[COACH1]);
    await openCalendar(); await monthMode(); await prev(); await pick(D.completed);
    assert.deepEqual(await rowsOf("Alpha"), []); // Coach A no longer sees the Member at all
    assert.deepEqual((await rowsOf("Gamma")).length, 0);
  });
});
