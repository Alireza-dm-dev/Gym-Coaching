/**
 * LOCAL ONLY. Real-browser regression for the Member profile photo and for how
 * Coaches see it (SEC0L3): headless Chromium against the real built Worker +
 * real local D1 + real local R2. A few responses are stubbed with page.route
 * only to force storage errors and image-load failures.
 *
 *   npm run build && npm run test:member-profile-ui
 *
 * Covers the Member Profile view, upload/replace/remove with persistence, the
 * Coach's view-only preview of the same photo, reassignment, and the logo
 * preview in the Member and Admin shells. Requires the clean local baseline and
 * refuses to run otherwise. Temporary rows use the `@memberprofileui.example.test`
 * domain or the `MemberProfileUITest` prefix; cleanup restores everything
 * (including Member 1's phone/weight/height) and removes every profile R2 object.
 */
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright-core";
import { count, deleteR2Object, fetchBounded, installSuiteGuard, one, r2Keys, resolveChromium, sleep, sql, startWorker } from "./test-helpers.mjs";
import { getInitials } from "../lib/initials.ts";

const PORT = process.env.MEMBER_PROFILE_UI_TEST_PORT ?? "8795";
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "@memberprofileui.example.test";
const PREFIX = "MemberProfileUITest";
const M1 = "member1@example.test";
const COACH_A = "coach1@example.test";
const SA = "superadmin@example.test";
const COACH_B = `coach.b${DOMAIN}`;
const PASSWORDS = { [M1]: "LocalMember123!", [COACH_A]: "LocalCoach123!", [SA]: "LocalAdmin123!", [COACH_B]: "ProfileCoachB123!" };
const BASELINE = { users: 6, activeUsers: 6, coaches: 1, members: 4, member_meals: 0, member_cycles: 0, sessions: 0, session_notes: 0, session_muscles: 0, auth_sessions: 0, coachPhotos: 0, memberPhotos: 0, onCoach1: 4, r2Objects: 0 };

if (process.argv.includes("--remote")) throw new Error("test-member-profile-ui is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");
const CHROMIUM = resolveChromium(chromium);

const snapshot = () => ({ users: count("users"), activeUsers: count("users", "is_active = 1"), coaches: count("coaches"), members: count("members"),
  member_meals: count("member_meals"), member_cycles: count("member_cycles"), sessions: count("sessions"), session_notes: count("session_notes"), session_muscles: count("session_muscles"),
  auth_sessions: count("auth_sessions"), coachPhotos: count("coaches", "photo_url IS NOT NULL"), memberPhotos: count("members", "photo_url IS NOT NULL"), onCoach1: count("members", "coach_id = 1"), r2Objects: r2Keys().length });
const lit = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

let server, browser, page, original = null, baselineVerified = false;
installSuiteGuard("test-member-profile-ui", 600_000, () => {
  try { browser?.process()?.kill("SIGKILL"); } catch { /* gone */ }
  server?.killNow();
  if (baselineVerified) cleanup();
});

function cleanup() {
  sql(`DELETE FROM auth_sessions; UPDATE members SET photo_url = NULL, coach_id = 1; UPDATE coaches SET photo_url = NULL; ` +
    `DELETE FROM coaches WHERE name LIKE '${PREFIX}%' OR user_id IN (SELECT id FROM users WHERE email LIKE '%${DOMAIN}'); DELETE FROM users WHERE email LIKE '%${DOMAIN}'; UPDATE users SET is_active = 1;` +
    (original ? ` UPDATE members SET phone = ${lit(original.phone)}, weight_kg = ${lit(original.weight_kg)}, height_cm = ${lit(original.height_cm)} WHERE id = 1;` : ""));
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
async function apiCall(cookie, method, path, body) {
  const response = await fetchBounded(`${BASE}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, response };
}
async function apiLogin(email) {
  const r = await fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORDS[email] }) });
  assert.equal(r.status, 200, `login ${email}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

describe("Member profile photo and Coach visibility (real browser)", () => {
  let helperPage, memberName, memberInitials, url1, url2, url3;
  const net = [];

  before(async () => {
    assert.deepEqual(snapshot(), BASELINE, "Unexpected local baseline (D1 or R2)");
    baselineVerified = true;
    original = one("SELECT phone, weight_kg, height_cm FROM members WHERE id = 1");
    memberName = one("SELECT name FROM members WHERE id = 1").name;
    memberInitials = getInitials(memberName);
    sql("UPDATE members SET phone = '09120001111', weight_kg = 72.5, height_cm = 178 WHERE id = 1");
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
    assert.deepEqual({ ...one("SELECT phone, weight_kg, height_cm FROM members WHERE id = 1") }, { ...original });
  });

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
  const login = async (email) => {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORDS[email]);
    await page.getByRole("button", { name: /sign in|log in|login/i }).click();
    await page.locator("aside.sidebar:visible, .mobile-nav:visible").first().waitFor();
  };
  const logout = async () => {
    await page.locator("aside.sidebar").getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Email").waitFor();
  };
  const readAvatar = (locator) => locator.evaluate((el) => {
    const img = el.querySelector("img");
    return { text: img ? "" : el.innerText.trim(), src: img?.getAttribute("src") ?? null, decoded: img ? img.complete && img.naturalWidth > 0 : null };
  });
  const expectPhoto = async (locator, url) => {
    await until(async () => { const s = await readAvatar(locator); return s.src === url && s.decoded; }, `avatar shows ${url}`);
  };
  const expectInitials = (locator, initials) =>
    until(async () => (await readAvatar(locator)).text === initials, `initials ${initials}`);
  const sidebarAvatar = () => page.locator("aside.sidebar .workspace .coach-avatar");
  const profileAvatar = () => page.locator("main.content .profile-card .person .avatar");
  const dialog = () => page.getByRole("dialog");
  const memberNav = (name) => page.locator("aside.sidebar nav").getByRole("button", { name, exact: true }).click();
  const photoCalls = (method) => net.filter((r) => r.path === "/api/profile/photo" && r.method === method);
  const dbPhoto = () => one("SELECT photo_url FROM members WHERE id = 1").photo_url;
  const upload = async (input, f) => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/profile/photo" && r.request().method() === "PUT"),
      input.setInputFiles(f),
    ]);
    return response;
  };

  it("Member login shows the real name and derived initials", async () => {
    page = await newPage();
    await login(M1);
    await page.locator("aside.sidebar .workspace").getByText(memberName, { exact: true }).waitFor();
    assert.equal((await page.locator("aside.sidebar .workspace small").innerText()).trim(), "Member");
    await expectInitials(sidebarAvatar(), memberInitials);
  });

  it("Profile keeps the real read-only fields and offers no edit controls", async () => {
    await memberNav("Profile");
    await page.locator("main.content .profile-card").waitFor();
    assert.equal((await page.locator("main.content h2").first().innerText()).trim(), memberName);
    const stats = (await page.locator("main.content .profile-stats").first().innerText()).replace(/\s+/g, " ");
    assert.match(stats, /09120001111/);
    assert.match(stats, /72\.5 kg/);
    assert.match(stats, /178 cm/);
    await expectInitials(profileAvatar(), memberInitials);
    assert.equal(await page.locator("main.content input:not([type=file]), main.content textarea, main.content select").count(), 0);
    const names = await page.locator("main.content button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.innerText.trim()));
    assert.ok(!names.some((n) => /edit|save|update/i.test(n)), `unexpected controls: ${names}`);
  });

  it("the Member logo opens an enlarged preview without navigating", async () => {
    const before = page.url();
    await page.locator("aside.sidebar").getByRole("button", { name: "Open Fit & Mischief logo" }).click();
    await dialog().waitFor();
    assert.equal(await dialog().locator("img").getAttribute("src"), "/app-logo.png");
    await dialog().getByRole("button", { name: "Close" }).click();
    await dialog().waitFor({ state: "hidden" });
    assert.equal(page.url(), before);
  });

  it("avatar click previews initials with Change photo and no Remove", async () => {
    await profileAvatar().click();
    await dialog().waitFor();
    assert.equal((await dialog().locator(".photo-preview").innerText()).trim(), memberInitials);
    assert.equal(await dialog().getByRole("button", { name: "Change photo" }).isVisible(), true);
    assert.equal(await dialog().getByRole("button", { name: "Remove photo" }).count(), 0);
  });

  it("uploads a PNG: Profile avatar, sidebar and preview update at once; the DB holds the URL", async () => {
    const response = await upload(dialog().locator("input[type=file]"), file("me.png", "image/png", await makeImage("image/png", 30)));
    assert.equal(response.status(), 200);
    url1 = (await response.json()).photoUrl;
    assert.match(url1, /^\/api\/photos\/profiles\/member\/1\/[0-9a-f]{32}\.png$/);
    await expectPhoto(dialog().locator(".photo-preview"), url1);
    await expectPhoto(profileAvatar(), url1);
    await expectPhoto(sidebarAvatar(), url1);
    assert.equal(dbPhoto(), url1);
    assert.deepEqual(r2Keys(), [url1.replace("/api/photos/", "")]);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
  });

  it("the photo survives a reload and the Member's other fields are untouched", async () => {
    await page.reload();
    await expectPhoto(sidebarAvatar(), url1);
    await memberNav("Profile");
    await expectPhoto(profileAvatar(), url1);
    assert.match((await page.locator("main.content .profile-stats").first().innerText()).replace(/\s+/g, " "), /09120001111/);
  });

  it("replacing with a JPEG sends one PUT and no DELETE, and retires the old URL", async () => {
    const deletes = photoCalls("DELETE").length;
    await profileAvatar().click();
    const response = await upload(dialog().locator("input[type=file]"), file("me.jpg", "image/jpeg", await makeImage("image/jpeg", 200)));
    assert.equal(response.status(), 200);
    url2 = (await response.json()).photoUrl;
    assert.notEqual(url2, url1);
    await expectPhoto(sidebarAvatar(), url2);
    assert.equal(photoCalls("DELETE").length, deletes);
    assert.equal((await page.context().request.get(BASE + url1)).status(), 404);
    assert.equal((await page.context().request.get(BASE + url2)).status(), 200);
  });

  it("invalid, oversize, spoofed and storage-error uploads keep the current photo", async () => {
    const input = dialog().locator("input[type=file]");
    const puts = photoCalls("PUT").length;
    await input.setInputFiles(file("a.gif", "image/gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)])));
    await dialog().getByRole("alert").filter({ hasText: "Choose a JPEG, PNG or WebP image." }).waitFor();
    await input.setInputFiles(file("big.png", "image/png", Buffer.alloc(2 * 1024 * 1024 + 1)));
    await dialog().getByRole("alert").filter({ hasText: "Image must be 2 MB or smaller." }).waitFor();
    assert.equal(photoCalls("PUT").length, puts);
    const spoof = await upload(input, file("fake.png", "image/png", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)])));
    assert.equal(spoof.status(), 415);
    await page.route("**/api/profile/photo", (route) => (route.request().method() === "PUT"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"stub"}' }) : route.continue()));
    await input.setInputFiles(file("ok.jpg", "image/jpeg", await makeImage("image/jpeg", 10)));
    await dialog().getByRole("alert").filter({ hasText: "Profile photo storage is unavailable." }).waitFor();
    await page.unroute("**/api/profile/photo");
    await expectPhoto(sidebarAvatar(), url2);
    assert.equal(dbPhoto(), url2);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
  });

  it("a photo that fails to load falls back to initials with no request loop", async () => {
    await page.route("**/api/photos/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    const before = net.filter((r) => r.path.startsWith("/api/photos/")).length;
    await page.reload();
    await expectInitials(sidebarAvatar(), memberInitials);
    await memberNav("Profile");
    await expectInitials(profileAvatar(), memberInitials);
    assert.equal(await page.locator("main.content .profile-card img, aside.sidebar .workspace img").count(), 0);
    await sleep(1_500);
    const first = net.filter((r) => r.path.startsWith("/api/photos/")).length - before;
    await sleep(1_500);
    assert.equal(net.filter((r) => r.path.startsWith("/api/photos/")).length - before, first);
    assert.ok(first <= 4, `bounded image requests (${first})`);
    assert.equal(dbPhoto(), url2);
    await page.unroute("**/api/photos/**");
    await page.reload();
    await expectPhoto(sidebarAvatar(), url2);
  });

  it("Today, Sessions, Cycle and Meal Log still render", async () => {
    for (const [name, text] of [["Today", /Hi,/], ["Sessions", /Your sessions/], ["Cycle", /Period & PMS/], ["Meal Log", /Your meals/]]) {
      await memberNav(name);
      await page.locator("main.content h1").filter({ hasText: text }).waitFor();
    }
  });

  it("removing the photo returns the Profile avatar and sidebar to initials", async () => {
    await memberNav("Profile");
    await profileAvatar().click();
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/profile/photo" && r.request().method() === "DELETE"),
      dialog().getByRole("button", { name: "Remove photo" }).click(),
    ]);
    assert.equal(response.status(), 200);
    await expectInitials(sidebarAvatar(), memberInitials);
    await expectInitials(profileAvatar(), memberInitials);
    assert.equal(dbPhoto(), null);
    assert.deepEqual(r2Keys(), []);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
  });

  it("mobile: Profile exposes the avatar, Change photo and Remove photo", async () => {
    await page.context().close();
    page = await newPage({ width: 390, height: 800 });
    await login(M1);
    assert.equal(await page.locator("aside.sidebar").isVisible(), false);
    await page.locator(".mobile-nav").getByRole("button", { name: "Profile" }).click();
    await profileAvatar().click();
    await dialog().waitFor();
    const response = await upload(dialog().locator("input[type=file]"), file("m.webp", "image/webp", await makeImage("image/webp", 90)));
    assert.equal(response.status(), 200);
    const url = (await response.json()).photoUrl;
    await expectPhoto(profileAvatar(), url);
    await dialog().getByRole("button", { name: "Remove photo" }).click();
    await expectInitials(profileAvatar(), memberInitials);
    assert.equal(dbPhoto(), null);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
  });

  it("the Coach sees the same photo, and clicking it opens a view-only preview", async () => {
    page = await newPage();
    await login(M1);
    await memberNav("Profile");
    await profileAvatar().click();
    const response = await upload(dialog().locator("input[type=file]"), file("c.png", "image/png", await makeImage("image/png", 320)));
    url3 = (await response.json()).photoUrl;
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await logout();

    await login(COACH_A);
    await page.locator("aside.sidebar nav").getByRole("button", { name: "Clients" }).click();
    const row = page.locator(".directory button").filter({ hasText: memberName });
    await row.waitFor();
    await expectPhoto(row.locator(".avatar"), url3);
    await row.click();
    const detail = page.locator(".client-detail .person .avatar-lg");
    await expectPhoto(detail, url3);
    await detail.click();
    await dialog().waitFor();
    await expectPhoto(dialog().locator(".photo-preview"), url3);
    assert.equal(await dialog().getByRole("button", { name: "Change photo" }).count(), 0, "view-only");
    assert.equal(await dialog().getByRole("button", { name: "Remove photo" }).count(), 0, "view-only");
    assert.equal(await dialog().locator("input[type=file]").count(), 0);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await dialog().waitFor({ state: "hidden" });
    assert.equal(dbPhoto(), url3);
  });

  it("after reassignment the old Coach loses the Member and the new Coach sees the same photo", async () => {
    const sa = await apiLogin(SA);
    const created = await apiCall(sa, "POST", "/api/admin/coaches", { name: `${PREFIX} Coach B`, email: COACH_B, password: PASSWORDS[COACH_B] });
    assert.equal(created.status, 201);
    const coachBId = created.json.coach.id;
    const moved = await apiCall(sa, "PATCH", "/api/admin/members/1/assignment", { coachId: coachBId });
    assert.equal(moved.status, 200);

    await page.reload();
    await page.locator("aside.sidebar nav").getByRole("button", { name: "Clients" }).click();
    await page.locator(".directory").waitFor();
    assert.equal(await page.locator(".directory button").filter({ hasText: memberName }).count(), 0, "old Coach no longer lists the Member");
    assert.equal((await page.context().request.get(BASE + url3)).status(), 404, "old Coach cannot read the photo");

    await logout();
    await login(COACH_B);
    await page.locator("aside.sidebar nav").getByRole("button", { name: "Clients" }).click();
    const row = page.locator(".directory button").filter({ hasText: memberName });
    await row.waitFor();
    await expectPhoto(row.locator(".avatar"), url3);
    assert.equal(dbPhoto(), url3, "photo URL not rewritten");
    await logout();

    assert.equal((await apiCall(sa, "PATCH", "/api/admin/members/1/assignment", { coachId: 1 })).status, 200);
  });

  it("the Admin logo opens the same enlarged preview", async () => {
    await login(SA);
    await page.locator("aside.sidebar").getByRole("button", { name: "Open Fit & Mischief logo" }).click();
    await dialog().waitFor();
    assert.equal(await dialog().locator("img").getAttribute("src"), "/app-logo.png");
    await dialog().getByRole("button", { name: "Close" }).click();
    await dialog().waitFor({ state: "hidden" });
  });
});
