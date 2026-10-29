/**
 * LOCAL ONLY. Real-browser regression for the Coach identity and profile photo
 * (SEC0L3): headless Chromium against the real built Worker + real local D1 +
 * real local R2, no mocks (a few responses are stubbed with page.route only to
 * force storage errors and image-load failures).
 *
 *   npm run build && npm run test:coach-profile-ui
 *
 * Requires the clean local baseline (no photos, no profile R2 objects) and
 * refuses to run otherwise. The Coach's name is changed temporarily to prove the
 * shell shows the database value; cleanup restores it, removes every profile R2
 * object and clears photo URLs, pass or fail.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright-core";
import { count, deleteR2Object, installSuiteGuard, one, r2Keys, resolveChromium, sleep, sql, startWorker } from "./test-helpers.mjs";
import { getInitials } from "../lib/initials.ts";

const PORT = process.env.COACH_PROFILE_UI_TEST_PORT ?? "8797";
const BASE = `http://127.0.0.1:${PORT}`;
const COACH1 = "coach1@example.test";
const PASSWORD = "LocalCoach123!";
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, coachPhotos: 0, memberPhotos: 0, onCoach1: 4, r2Objects: 0 };

if (process.argv.includes("--remote")) throw new Error("test-coach-profile-ui is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");
const CHROMIUM = resolveChromium(chromium);

const snapshot = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_meals: count("member_meals"), member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
  auth_sessions: count("auth_sessions"), coachPhotos: count("coaches", "photo_url IS NOT NULL"), memberPhotos: count("members", "photo_url IS NOT NULL"), onCoach1: count("members", "coach_id = 1"), r2Objects: r2Keys().length });
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

let server, browser, page, originalName = null, baselineVerified = false;
installSuiteGuard("test-coach-profile-ui", 600_000, () => {
  try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
  server?.killNow();
  if (baselineVerified) cleanup();
});

function cleanup() {
  sql(`DELETE FROM auth_sessions; UPDATE coaches SET photo_url = NULL${originalName ? `, name = ${q(originalName)}` : ""}; UPDATE members SET photo_url = NULL;`);
  for (const key of r2Keys()) deleteR2Object(key);
}

async function until(fn, message, ms = 10_000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for: ${message}`);
    await sleep(100);
  }
}

describe("Coach identity and profile photo (real browser)", () => {
  let helperPage;
  const net = [];

  before(async () => {
    assert.deepEqual(snapshot(), BASELINE, "Unexpected local baseline (D1 or R2)");
    baselineVerified = true;
    originalName = one("SELECT name FROM coaches WHERE id = 1").name;
    server = await startWorker(PORT);
    browser = await chromium.launch({ executablePath: CHROMIUM, timeout: 30_000 });
    helperPage = await (await browser.newContext()).newPage();
  });

  after(async () => {
    try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch { /* ignore */ }
    try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
    try { if (baselineVerified) cleanup(); } finally { await server?.stop(); }
    if (!baselineVerified) return;
    const final = snapshot();
    console.log("Final DB/R2:", JSON.stringify(final));
    assert.deepEqual(final, BASELINE);
    assert.equal(one("SELECT name FROM coaches WHERE id = 1").name, originalName);
  });

  /** A real, decodable image of the given type, produced by the browser itself. */
  async function makeImage(mime, hue) {
    const b64 = await helperPage.evaluate(async ({ mime, hue }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32 + (hue % 7);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = `hsl(${hue},80%,50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.9));
      if (blob.type !== mime) throw new Error(`browser cannot encode ${mime}`);
      let out = "";
      for (const b of new Uint8Array(await blob.arrayBuffer())) out += String.fromCharCode(b);
      return btoa(out);
    }, { mime, hue });
    return Buffer.from(b64, "base64");
  }
  const file = (name, mimeType, buffer) => ({ name, mimeType, buffer });

  const newPage = async (viewport = { width: 1280, height: 900 }) => {
    const context = await browser.newContext({ viewport });
    const p = await context.newPage();
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) net.push({ method: r.method(), path: u.pathname });
    });
    return p;
  };
  const login = async () => {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(COACH1);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in|log in|login/i }).click();
    await page.locator("aside.sidebar:visible, .mobile-nav:visible").first().waitFor();
  };
  const sidebarAvatar = () => page.locator("aside.sidebar .workspace .coach-avatar");
  const topbarAvatar = () => page.locator("header.topbar .top-actions .coach-avatar");
  const settingsCard = () => page.locator('article[aria-label="Your profile"]');
  const dialog = () => page.getByRole("dialog");
  const openSettings = () => page.locator("aside.sidebar nav").getByRole("button", { name: "Settings" }).click();
  const readAvatar = (locator) => locator.evaluate((el) => {
    const img = el.querySelector("img");
    return { text: img ? "" : el.innerText.trim(), src: img?.getAttribute("src") ?? null, decoded: img ? img.complete && img.naturalWidth > 0 : null };
  });
  const photoCalls = (method) => net.filter((r) => r.path === "/api/profile/photo" && (!method || r.method === method));
  const dbPhoto = () => one("SELECT photo_url FROM coaches WHERE id = 1").photo_url;
  const upload = async (input, f) => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/profile/photo" && r.request().method() === "PUT"),
      input.setInputFiles(f),
    ]);
    return response;
  };
  const expectPhoto = async (locator, url) => {
    const state = await until(async () => { const s = await readAvatar(locator); return s.src === url && s.decoded ? s : null; }, `avatar shows ${url}`);
    assert.equal(state.src, url);
  };

  it("shows the real DB Coach name and derived initials (nothing hardcoded)", async () => {
    sql("UPDATE coaches SET name = 'Mary Jane Watson' WHERE id = 1");
    page = await newPage();
    await login();
    const sidebar = page.locator("aside.sidebar .workspace");
    await sidebar.getByText("Mary Jane Watson", { exact: true }).waitFor();
    assert.equal((await sidebar.locator("small").innerText()).trim(), "Coach");
    assert.equal((await readAvatar(sidebarAvatar())).text, getInitials("Mary Jane Watson"));
    assert.equal((await readAvatar(sidebarAvatar())).text, "MW");
    assert.equal((await readAvatar(topbarAvatar())).text, "MW");
    const body = await page.locator("body").innerText();
    assert.ok(!body.includes("Jordan Lee") && !body.includes("Independent coach"), "no hardcoded identity in the page");
    assert.equal(net.filter((r) => r.path === "/api/coaches/me").length >= 1, true);

    sql(`UPDATE coaches SET name = ${q(originalName)} WHERE id = 1`);
    await page.reload();
    await page.locator("aside.sidebar .workspace").getByText(originalName, { exact: true }).waitFor();
    assert.equal((await readAvatar(sidebarAvatar())).text, getInitials(originalName));
  });

  it("Settings shows a read-only Profile card", async () => {
    await openSettings();
    const card = settingsCard();
    await card.waitFor();
    assert.equal((await card.locator("h2").innerText()).trim(), originalName);
    assert.equal((await card.locator("small").first().innerText()).trim(), "Coach");
    assert.equal((await readAvatar(card.locator(".coach-avatar"))).text, getInitials(originalName));
    assert.equal(await card.getByRole("button", { name: "Change photo" }).isVisible(), true);
    assert.equal(await card.getByRole("button", { name: "Remove photo" }).count(), 0, "no Remove without a photo");
    assert.equal(await card.locator("input:not([type=file])").count(), 0, "name is not editable");
  });

  it("avatar click opens a preview with initials, Change photo and no Remove", async () => {
    await sidebarAvatar().click();
    const d = dialog();
    await d.waitFor();
    assert.equal((await d.getByRole("heading").innerText()).trim(), originalName);
    assert.equal((await d.locator(".photo-preview").innerText()).trim(), getInitials(originalName));
    assert.equal(await d.getByRole("button", { name: "Change photo" }).isVisible(), true);
    assert.equal(await d.getByRole("button", { name: "Remove photo" }).count(), 0);
    await d.getByRole("button", { name: "Close", exact: true }).click();
    await d.waitFor({ state: "hidden" });
  });

  let url1, url2, url3;
  it("uploads a JPEG: every avatar updates at once and the DB holds the returned URL", async () => {
    const response = await upload(settingsCard().locator("input[type=file]"), file("me.jpg", "image/jpeg", await makeImage("image/jpeg", 20)));
    assert.equal(response.status(), 200);
    url1 = (await response.json()).photoUrl;
    assert.match(url1, /^\/api\/photos\/profiles\/coach\/1\/[0-9a-f]{32}\.jpg$/);
    for (const avatar of [sidebarAvatar(), topbarAvatar(), settingsCard().locator(".coach-avatar")]) await expectPhoto(avatar, url1);
    assert.equal(dbPhoto(), url1);
    assert.equal(await settingsCard().getByRole("button", { name: "Remove photo" }).isVisible(), true);
    assert.deepEqual(r2Keys(), [url1.replace("/api/photos/", "")]);
  });

  it("the photo survives a reload", async () => {
    await page.reload();
    await expectPhoto(sidebarAvatar(), url1);
    await expectPhoto(topbarAvatar(), url1);
  });

  it("replacing with a PNG sends one PUT (no DELETE), changes the URL and retires the old one", async () => {
    const deletesBefore = photoCalls("DELETE").length;
    const putsBefore = photoCalls("PUT").length;
    await openSettings();
    const response = await upload(settingsCard().locator("input[type=file]"), file("me.png", "image/png", await makeImage("image/png", 140)));
    assert.equal(response.status(), 200);
    url2 = (await response.json()).photoUrl;
    assert.notEqual(url2, url1);
    assert.match(url2, /\.png$/);
    await expectPhoto(sidebarAvatar(), url2);
    assert.equal(photoCalls("PUT").length - putsBefore, 1);
    assert.equal(photoCalls("DELETE").length, deletesBefore, "the client never sends a DELETE to replace");
    assert.equal((await page.context().request.get(BASE + url1)).status(), 404, "old URL retired");
    assert.equal((await page.context().request.get(BASE + url2)).status(), 200);
    assert.equal(dbPhoto(), url2);
  });

  it("uploads a WebP from the avatar preview", async () => {
    await topbarAvatar().click();
    const d = dialog();
    await d.waitFor();
    const response = await upload(d.locator("input[type=file]"), file("me.webp", "image/webp", await makeImage("image/webp", 260)));
    assert.equal(response.status(), 200);
    url3 = (await response.json()).photoUrl;
    assert.match(url3, /\.webp$/);
    await expectPhoto(d.locator(".photo-preview"), url3);
    await expectPhoto(sidebarAvatar(), url3);
    await d.getByRole("button", { name: "Close", exact: true }).click();
    await d.waitFor({ state: "hidden" });
  });

  it("rejects the wrong type, an oversize file and a spoofed file without touching the avatar", async () => {
    const input = settingsCard().locator("input[type=file]");
    const putsBefore = photoCalls("PUT").length;
    await input.setInputFiles(file("a.gif", "image/gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)])));
    await settingsCard().getByRole("alert").filter({ hasText: "Choose a JPEG, PNG or WebP image." }).waitFor();
    await input.setInputFiles(file("big.png", "image/png", Buffer.alloc(2 * 1024 * 1024 + 1)));
    await settingsCard().getByRole("alert").filter({ hasText: "Image must be 2 MB or smaller." }).waitFor();
    assert.equal(photoCalls("PUT").length, putsBefore, "client pre-checks send nothing");
    // Allowed type, wrong bytes: only the server can tell.
    const spoof = await upload(input, file("fake.png", "image/png", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)])));
    assert.equal(spoof.status(), 415);
    await settingsCard().getByRole("alert").filter({ hasText: "Choose a JPEG, PNG or WebP image." }).waitFor();
    await expectPhoto(sidebarAvatar(), url3);
    assert.equal(dbPhoto(), url3);
  });

  it("a 503 or 500 from the server shows a message and keeps the current avatar", async () => {
    const input = settingsCard().locator("input[type=file]");
    for (const [status, message] of [[503, "Profile photo storage is unavailable."], [500, "Could not update profile photo. Try again."], [413, "Image must be 2 MB or smaller."]]) {
      await page.route("**/api/profile/photo", (route) => (route.request().method() === "PUT"
        ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "stub" }) }) : route.continue()));
      await input.setInputFiles(file("ok.jpg", "image/jpeg", await makeImage("image/jpeg", 300)));
      await settingsCard().getByRole("alert").filter({ hasText: message }).waitFor();
      await page.unroute("**/api/profile/photo");
      await expectPhoto(sidebarAvatar(), url3);
      assert.equal(dbPhoto(), url3);
    }
  });

  it("a photo that fails to load falls back to initials without a request loop", async () => {
    await page.route("**/api/photos/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    const before = net.filter((r) => r.path.startsWith("/api/photos/")).length;
    await page.reload();
    await page.locator("aside.sidebar .workspace").getByText(originalName, { exact: true }).waitFor();
    await until(async () => (await readAvatar(sidebarAvatar())).text === getInitials(originalName), "initials fallback");
    assert.equal((await readAvatar(topbarAvatar())).text, getInitials(originalName));
    assert.equal(await page.locator("aside.sidebar .workspace img").count(), 0, "no broken <img> left");
    await sleep(1_500);
    const first = net.filter((r) => r.path.startsWith("/api/photos/")).length - before;
    await sleep(1_500);
    const second = net.filter((r) => r.path.startsWith("/api/photos/")).length - before;
    assert.equal(first, second, "no retry loop");
    assert.ok(first <= 3, `bounded image requests (${first})`);
    assert.equal(dbPhoto(), url3, "a failed image load never mutates the DB");
    await page.unroute("**/api/photos/**");
    await page.reload();
    await expectPhoto(sidebarAvatar(), url3);
  });

  it("removing the photo returns every avatar to initials; removing again is not offered", async () => {
    await sidebarAvatar().click();
    const d = dialog();
    await d.waitFor();
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/profile/photo" && r.request().method() === "DELETE"),
      d.getByRole("button", { name: "Remove photo" }).click(),
    ]);
    assert.equal(response.status(), 200);
    await until(async () => (await readAvatar(d.locator(".photo-preview"))).text === getInitials(originalName), "preview initials");
    assert.equal(await d.getByRole("button", { name: "Remove photo" }).count(), 0);
    await d.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal((await readAvatar(sidebarAvatar())).text, getInitials(originalName));
    assert.equal((await readAvatar(topbarAvatar())).text, getInitials(originalName));
    assert.equal(dbPhoto(), null);
    assert.deepEqual(r2Keys(), []);
    await page.reload();
    await page.locator("aside.sidebar .workspace").getByText(originalName, { exact: true }).waitFor();
    assert.equal((await readAvatar(sidebarAvatar())).text, getInitials(originalName));
  });

  it("the logo opens an enlarged preview and never navigates", async () => {
    const before = page.url();
    await page.locator("aside.sidebar").getByRole("button", { name: "Open Fit & Mischief logo" }).click();
    const d = dialog();
    await d.waitFor();
    assert.equal(await d.locator("img").getAttribute("src"), "/app-logo.png");
    await d.getByRole("button", { name: "Close" }).click();
    await d.waitFor({ state: "hidden" });
    assert.equal(page.url(), before);
  });

  it("existing Coach navigation still works", async () => {
    const nav = page.locator("aside.sidebar nav");
    await nav.getByRole("button", { name: "Clients" }).click();
    await page.locator(".directory").waitFor();
    await nav.getByRole("button", { name: "Calendar" }).click();
    await page.locator(".calendar, .agenda").first().waitFor();
    await nav.getByRole("button", { name: "Nutrition" }).click();
    await page.locator("main.content").getByText("Nutrition", { exact: false }).first().waitFor();
    await nav.getByRole("button", { name: "Today" }).click();
    await page.locator("main.content").waitFor();
  });

  it("mobile: the Settings Profile card is the way to change and remove the photo", async () => {
    await page.context().close();
    page = await newPage({ width: 390, height: 800 });
    await login();
    assert.equal(await page.locator("aside.sidebar").isVisible(), false);
    assert.equal(await topbarAvatar().isVisible(), false, "topbar avatar stays hidden on mobile");
    await page.locator(".mobile-nav").getByRole("button", { name: "Settings" }).click();
    const card = settingsCard();
    await card.waitFor();
    const response = await upload(card.locator("input[type=file]"), file("m.png", "image/png", await makeImage("image/png", 60)));
    assert.equal(response.status(), 200);
    const url = (await response.json()).photoUrl;
    await expectPhoto(card.locator(".coach-avatar"), url);
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === "/api/profile/photo"),
      card.getByRole("button", { name: "Remove photo" }).click(),
    ]);
    await until(async () => (await readAvatar(card.locator(".coach-avatar"))).text === getInitials(originalName), "mobile initials");
    assert.equal(dbPhoto(), null);
  });
});
