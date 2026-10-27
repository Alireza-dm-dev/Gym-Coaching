/**
 * LOCAL ONLY. Real-browser regression for the Super Admin UI (SEC0H3): headless
 * Chromium against the real built Worker + real local D1, no mocks.
 *
 *   npm run build && npm run test:admin-ui
 *
 * `playwright-core` (a devDependency) ships no browser. Set CHROMIUM_PATH to a
 * Chromium/Chrome executable, or have Chrome/Chromium installed in a standard
 * location; the suite fails clearly if none is found and never skips silently.
 *
 * Requires the clean local baseline (6 users all active, 1 coach, 4 members, no
 * sessions, cycles or auth sessions) and refuses to run otherwise. Temporary rows
 * use the `@adminui.example.test` domain or the `AdminUiTest` name prefix; the
 * original users rows are snapshotted and restored, pass or fail.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { count, fetchBounded, installSuiteGuard, sql, startWorker } from "./test-helpers.mjs";

const PORT = process.env.ADMIN_UI_TEST_PORT ?? "8797";
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "@adminui.example.test";
const PREFIX = "AdminUiTest";
const FIXTURES = { "superadmin@example.test": "LocalAdmin123!", "coach1@example.test": "LocalCoach123!", "member1@example.test": "LocalMember123!" };
const SA = "superadmin@example.test";
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0 };

if (process.argv.includes("--remote")) throw new Error("test-admin-ui is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
];
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) {
    if (!existsSync(process.env.CHROMIUM_PATH)) throw new Error(`CHROMIUM_PATH does not exist: ${process.env.CHROMIUM_PATH}`);
    return process.env.CHROMIUM_PATH;
  }
  const found = [...CHROMIUM_CANDIDATES, chromium.executablePath()].find((path) => path && existsSync(path));
  if (!found) throw new Error("No Chromium/Chrome found. Set CHROMIUM_PATH to a Chromium/Chrome executable.");
  return found;
}
const CHROMIUM = resolveChromium();

const baselineCounts = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"), auth_sessions: count("auth_sessions") });
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

let server, browser, page, snapshot = null, baselineVerified = false;
installSuiteGuard("test-admin-ui", 300_000, () => {
  try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
  server?.killNow();
  if (baselineVerified) cleanup();
});
const requests = [];
const consoleErrors = [];

function cleanup() {
  sql(`DELETE FROM auth_sessions; UPDATE members SET coach_id = 1; DELETE FROM members WHERE name LIKE '${PREFIX}%'; ` +
    `DELETE FROM coaches WHERE name LIKE '${PREFIX}%' OR user_id IN (SELECT id FROM users WHERE email LIKE '%${DOMAIN}'); DELETE FROM users WHERE email LIKE '%${DOMAIN}';`);
  for (const u of snapshot ?? []) {
    sql(`UPDATE users SET email = ${q(u.email)}, password_hash = ${q(u.password_hash)}, is_active = ${q(u.is_active)}, updated_at = ${q(u.updated_at)} WHERE id = ${u.id}`);
  }
}
async function apiLogin(email, password) {
  return fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
}

async function uiLogin(email, password) {
  await page.goto(BASE);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in|log in|login/i }).click();
}
const row = (name) => page.locator("article.admin-row", { hasText: name });
const dialog = () => page.getByRole("dialog");
const nav = (name) => page.locator("aside.sidebar nav").getByRole("button", { name });
const notice = () => page.locator(".admin-notice");

describe("Super Admin UI (real browser)", () => {
  before(async () => {
    assert.deepEqual(baselineCounts(), BASELINE, `Unexpected local D1 baseline: ${JSON.stringify(baselineCounts())}`);
    baselineVerified = true;
    snapshot = sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id");
    server = await startWorker(PORT);
    browser = await chromium.launch({ executablePath: CHROMIUM, timeout: 30_000 });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) requests.push(`${r.method()} ${u.pathname}`); });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  });

  after(async () => {
    // Close Chromium (bounded); if it will not close, kill it.
    try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch { /* ignore */ }
    try { browser?.process()?.kill("SIGKILL"); } catch { /* already gone */ }
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
    assert.deepEqual(sql("SELECT id, email, password_hash, is_active, updated_at FROM users ORDER BY id"), snapshot);
  });

  it("Super Admin login shows AdminApp; Overview counts and tabs work", async () => {
    await uiLogin(SA, FIXTURES[SA]);
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    const stat = (label) => page.locator(".admin-stat", { hasText: label }).locator("strong");
    await page.waitForFunction(() => document.querySelector(".admin-stat strong")?.textContent !== "–");
    assert.equal(await stat("Total Coaches").innerText(), "1");
    assert.equal(await stat("Active Coaches").innerText(), "1");
    assert.equal(await stat("Total Members").innerText(), "4");
    assert.equal(await stat("Members with login").innerText(), "4");
    assert.equal(await stat("Members without login").innerText(), "0");
    assert.equal(await stat("Inactive Members").innerText(), "0");
    await nav("Coaches").click();
    await page.getByRole("heading", { name: "Coaches" }).waitFor();
    await row("coach1@example.test").waitFor();
    await nav("Members").click();
    await page.getByRole("heading", { name: "Members" }).waitFor();
    await row("member1@example.test").waitFor();
    assert.equal(await page.locator("article.admin-row").count(), 4);
    const text = await page.locator("main").innerText();
    assert.ok(!/userId|password_hash/i.test(text));
  });

  it("Coach create: validation, duplicate 409 keeps the form open, success lists the Coach", async () => {
    await nav("Coaches").click();
    await page.getByRole("button", { name: "Create Coach" }).first().click();
    await dialog().getByLabel("Name").fill(`${PREFIX} Coach B`);
    await dialog().getByLabel("Email").fill("coach1@example.test"); // existing
    await dialog().getByLabel("Initial password").fill("short");
    await dialog().getByRole("button", { name: "Create Coach" }).click();
    await dialog().getByText(/at least 10 characters/).waitFor();
    await dialog().getByLabel("Initial password").fill("CoachBPassword123!");
    await dialog().getByRole("button", { name: "Create Coach" }).click();
    await dialog().getByText("An account already exists with this email.").waitFor();
    assert.equal(count("coaches"), 1);
    await dialog().getByLabel("Email").fill(`  Coach.B${DOMAIN.toUpperCase()}`);
    await dialog().getByRole("button", { name: "Create Coach" }).click();
    await notice().getByText("Coach created.").waitFor();
    await row(`${PREFIX} Coach B`).waitFor();
    assert.ok((await row(`${PREFIX} Coach B`).innerText()).includes(`coach.b${DOMAIN}`));
    assert.ok(!(await page.locator("body").innerText()).includes("CoachBPassword123!"));
  });

  it("Coach credentials: email correction, then password reset behind a confirmation; new login works", async () => {
    const r = () => row(`${PREFIX} Coach B`);
    await r().getByRole("button", { name: "Manage login" }).click();
    await dialog().getByLabel("Email").fill(`coach.b.fixed${DOMAIN}`);
    await dialog().getByRole("button", { name: "Save" }).click();
    await notice().getByText("Login email updated.").waitFor();
    await r().getByText(`coach.b.fixed${DOMAIN}`).waitFor();
    assert.equal((await apiLogin(`coach.b${DOMAIN}`, "CoachBPassword123!")).status, 401);
    assert.equal((await apiLogin(`coach.b.fixed${DOMAIN}`, "CoachBPassword123!")).status, 200);

    await r().getByRole("button", { name: "Manage login" }).click();
    await dialog().getByLabel("New password (optional)").fill("tooshort");
    await dialog().getByRole("button", { name: "Save" }).click();
    await dialog().getByText(/at least 10 characters/).waitFor();
    await dialog().getByLabel("New password (optional)").fill("CoachBNewPass456!");
    await dialog().getByRole("button", { name: "Save" }).click();
    await dialog().getByText("Their current login sessions will end immediately.").waitFor();
    assert.equal((await apiLogin(`coach.b.fixed${DOMAIN}`, "CoachBNewPass456!")).status, 401); // not sent before confirmation
    await dialog().getByRole("button", { name: "Reset password" }).click();
    await notice().getByText("Password updated.").waitFor();
    assert.equal((await apiLogin(`coach.b.fixed${DOMAIN}`, "CoachBPassword123!")).status, 401);
    assert.equal((await apiLogin(`coach.b.fixed${DOMAIN}`, "CoachBNewPass456!")).status, 200);
    assert.ok(!(await page.locator("body").innerText()).includes("CoachBNewPass456!"));
  });

  it("Coach deactivate (zero Members) needs confirmation; reactivate does not", async () => {
    const r = () => row(`${PREFIX} Coach B`);
    await r().getByRole("button", { name: "Deactivate" }).click();
    await dialog().getByText("They will be signed out immediately.").waitFor();
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await r().getByText("Active", { exact: true }).waitFor();
    await r().getByRole("button", { name: "Deactivate" }).click();
    await dialog().getByRole("button", { name: "Deactivate" }).click();
    await notice().getByText("Account deactivated.").waitFor();
    await r().getByText("Inactive").waitFor();
    assert.equal(count("users", `email = 'coach.b.fixed${DOMAIN}' AND is_active = 0`), 1);
    await r().getByRole("button", { name: "Reactivate" }).click();
    await notice().getByText("Account reactivated.").waitFor();
    await r().getByText("Active", { exact: true }).waitFor();
  });

  it("Coach with Members: deactivation is blocked with the member count; Admin stays signed in", async () => {
    const r = () => row("coach1@example.test");
    await r().getByRole("button", { name: "Deactivate" }).click();
    await dialog().getByRole("button", { name: "Deactivate" }).click();
    await dialog().getByText("This Coach still has 4 assigned members. Reassign them before deactivating the Coach.").waitFor();
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await r().waitFor();
    assert.equal(count("users", "email = 'coach1@example.test' AND is_active = 1"), 1);
    await page.getByRole("heading", { name: "Coaches" }).waitFor(); // still in AdminApp
  });

  it("Member create (existing POST /api/members) lists a profile-only Member with No login", async () => {
    await nav("Members").click();
    await page.getByRole("button", { name: "Create Member" }).first().click();
    const options = await dialog().locator("select[name=coachId] option").allInnerTexts();
    assert.equal(options.length, 2); // only active Coaches
    await dialog().getByLabel("Full name").fill(`${PREFIX} Member A`);
    await dialog().getByLabel("Phone number").fill("09120000000");
    await dialog().getByLabel("Weight (kg)").fill("60");
    await dialog().getByLabel("Height (cm)").fill("170");
    await dialog().getByLabel("Primary goal").fill("fitness");
    await dialog().getByRole("button", { name: "Create Member" }).click();
    await notice().getByText("Member created.").waitFor();
    const r = row(`${PREFIX} Member A`);
    await r.waitFor();
    assert.ok((await r.innerText()).includes("No login"));
    assert.equal(await r.getByRole("button", { name: "Deactivate" }).count(), 0);
    assert.equal(await r.getByRole("button", { name: "Add login" }).count(), 1);
    assert.equal(sql(`SELECT user_id FROM members WHERE name = '${PREFIX} Member A'`)[0].user_id, null);
  });

  it("Add login: duplicate email 409 stays open; success shows email + Active; Member can sign in", async () => {
    const r = () => row(`${PREFIX} Member A`);
    await r().getByRole("button", { name: "Add login" }).click();
    await dialog().getByLabel("Email").fill("member1@example.test");
    await dialog().getByLabel("Initial password").fill("MemberAPassword123!");
    await dialog().getByRole("button", { name: "Create login" }).click();
    await dialog().getByText(/already exists/i).waitFor();
    await dialog().getByLabel("Email").fill(`member.a${DOMAIN}`);
    await dialog().getByRole("button", { name: "Create login" }).click();
    await notice().getByText("Login created.").waitFor();
    await r().getByText(`member.a${DOMAIN}`).waitFor();
    await r().getByText("Active", { exact: true }).waitFor();
    assert.equal((await apiLogin(`member.a${DOMAIN}`, "MemberAPassword123!")).status, 200);
  });

  it("Member credentials: email correction and password reset (confirmed)", async () => {
    const r = () => row(`${PREFIX} Member A`);
    await r().getByRole("button", { name: "Manage login" }).click();
    await dialog().getByLabel("Email").fill(`member.a.fixed${DOMAIN}`);
    await dialog().getByLabel("New password (optional)").fill("MemberANewPass456!");
    await dialog().getByRole("button", { name: "Save" }).click();
    await dialog().getByRole("button", { name: "Reset password" }).click();
    await notice().getByText("Password updated.").waitFor();
    await r().getByText(`member.a.fixed${DOMAIN}`).waitFor();
    assert.equal((await apiLogin(`member.a${DOMAIN}`, "MemberAPassword123!")).status, 401);
    assert.equal((await apiLogin(`member.a.fixed${DOMAIN}`, "MemberANewPass456!")).status, 200);
  });

  it("Member reassignment: confirmation for a different Coach, row updates; only active Coaches offered", async () => {
    const r = () => row(`${PREFIX} Member A`);
    await r().getByRole("button", { name: "Reassign" }).click();
    await dialog().getByLabel("Coach").selectOption({ label: `${PREFIX} Coach B` });
    await dialog().getByRole("button", { name: "Continue" }).click();
    await dialog().getByText("The new Coach will gain access to the Member's training history. The previous Coach will lose access.").waitFor();
    await dialog().getByRole("button", { name: "Reassign" }).click();
    await notice().getByText("Assignment updated.").waitFor();
    await r().getByText(`Coach: ${PREFIX} Coach B`).waitFor();
    // Same Coach needs no confirmation or request.
    await r().getByRole("button", { name: "Reassign" }).click();
    await dialog().getByRole("button", { name: "Continue" }).click();
    await dialog().waitFor({ state: "detached" });
  });

  it("Member deactivate (confirmed) and reactivate; profile stays listed", async () => {
    const r = () => row(`${PREFIX} Member A`);
    await r().getByRole("button", { name: "Deactivate" }).click();
    await dialog().getByText("Their profile and training history will remain.").waitFor();
    await dialog().getByRole("button", { name: "Deactivate" }).click();
    await r().getByText("Inactive").waitFor();
    assert.equal((await apiLogin(`member.a.fixed${DOMAIN}`, "MemberANewPass456!")).status, 401);
    await r().getByRole("button", { name: "Reactivate" }).click();
    await r().getByText("Active", { exact: true }).waitFor();
    assert.equal((await apiLogin(`member.a.fixed${DOMAIN}`, "MemberANewPass456!")).status, 200);
  });

  it("Members search filters by name, email and Coach; Overview reflects latest state", async () => {
    await page.getByLabel("Search Members").fill(`${PREFIX} Coach B`);
    assert.equal(await page.locator("article.admin-row").count(), 1);
    await page.getByLabel("Search Members").fill("member1@");
    assert.equal(await page.locator("article.admin-row").count(), 1);
    await nav("Overview").click();
    const stat = (label) => page.locator(".admin-stat", { hasText: label }).locator("strong");
    assert.equal(await stat("Total Coaches").innerText(), "2");
    assert.equal(await stat("Total Members").innerText(), "5");
    assert.equal(await stat("Members with login").innerText(), "5");
  });

  it("mobile viewport has no horizontal overflow", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await nav("Members").or(page.locator("nav.mobile-nav").getByRole("button", { name: "Members" })).last().click();
    await page.locator("article.admin-row").first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  it("logout leaves no stale Admin state; Coach and Member logins never render AdminApp", async () => {
    await page.getByRole("button", { name: /sign out/i }).first().click();
    await page.getByLabel("Email").waitFor();
    assert.equal(await page.locator("article.admin-row").count(), 0);
    await uiLogin("coach1@example.test", FIXTURES["coach1@example.test"]);
    await page.locator("aside.sidebar").getByText("Independent coach").waitFor();
    assert.equal(await page.locator(".admin-stat, .admin-row").count(), 0);
    await page.getByRole("button", { name: /sign out/i }).first().click();
    await uiLogin("member1@example.test", FIXTURES["member1@example.test"]);
    await page.locator("aside.sidebar").getByText("Member", { exact: true }).waitFor();
    assert.equal(await page.locator(".admin-stat, .admin-row").count(), 0);
    await page.getByRole("button", { name: /sign out/i }).first().click();
    await uiLogin(SA, FIXTURES[SA]);
    await page.getByRole("heading", { name: "Overview" }).waitFor();
  });

  it("network audit: only account-management endpoints; no cycles, sessions, notes or muscles", () => {
    const allowed = [/^(GET|POST) \/api\/auth\/(me|login|logout)$/, /^(GET|POST) \/api\/admin\/(coaches|members)$/,
      /^POST \/api\/admin\/members\/\d+\/account$/, /^PATCH \/api\/admin\/members\/\d+\/assignment$/,
      /^PATCH \/api\/admin\/users\/\d+\/(status|credentials)$/, /^POST \/api\/members$/];
    const adminPhase = requests; // includes the brief Coach/Member logins, which are the only extra calls
    const offending = adminPhase.filter((r) => !allowed.some((re) => re.test(r)) && !/^GET \/api\/(members|sessions|members\/me)/.test(r));
    assert.deepEqual(offending, []);
    for (const r of requests.slice(0, requests.findIndex((x) => x === "POST /api/auth/logout"))) {
      assert.ok(!/cycles|sessions|note|muscle/.test(r), `Super Admin session made ${r}`);
    }
  });
});
