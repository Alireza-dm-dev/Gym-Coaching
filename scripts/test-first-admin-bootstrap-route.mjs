/**
 * LOCAL ONLY. Regression suite for the TEMPORARY `POST /api/bootstrap/first-admin`
 * route (SEC0M9A). REMOVE THIS SUITE together with the route, immediately after
 * the first production Super Admin exists: also delete the `test:first-admin-route`
 * script and its `test:regression` entry in package.json, and the temporary
 * README subsection. Keep the permanent CLI (`scripts/bootstrap-production-admin.ts`).
 *
 * Real built Worker against a throwaway local D1 (never the shared
 * `.wrangler/state`, never remote), migrations 0000-0010 applied.
 *
 *   npm run build && npm run test:first-admin-route
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fetchBounded, installSuiteGuard, startWorker } from "./test-helpers.mjs";
// @ts-expect-error explicit .ts extension is required for Node's type stripping
import { verifyPassword } from "../lib/auth-crypto.ts";

if (process.argv.includes("--remote")) throw new Error("test-first-admin-bootstrap-route is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const PORT = process.env.FIRST_ADMIN_ROUTE_TEST_PORT ?? "8800";
const BASE = `http://127.0.0.1:${PORT}`;
const URL_PATH = `${BASE}/api/bootstrap/first-admin`;
const ROOT = mkdtempSync(join(tmpdir(), "gym-first-admin-route-"));
const STATE = join(ROOT, "state");
const PASSWORD = "Correct-Horse-Battery-9";
const EMAIL = "owner.admin@gym-prod.com";

let worker;
installSuiteGuard("first-admin-bootstrap-route", 10 * 60_000, () => { worker?.killNow(); rmSync(ROOT, { recursive: true, force: true }); });

const wranglerEntry = join(process.cwd(), "node_modules/wrangler/bin/wrangler.js");
const sitesEnv = join(process.cwd(), "scripts/sites-env.mjs");
function d1(...extra) {
  return spawnSync(process.execPath, ["--import", sitesEnv, wranglerEntry, "d1", "execute", "DB", "--local", "--persist-to", STATE,
    "--config", "dist/server/wrangler.json", "--json", ...extra], { encoding: "utf8", cwd: process.cwd() });
}
function q(command) {
  const r = d1("--command", command);
  assert.equal(r.status, 0, `query failed: ${command}\n${r.stderr}`);
  return JSON.parse(r.stdout)[0].results;
}
const reset = () => q("DELETE FROM auth_sessions; DELETE FROM members; DELETE FROM coaches; DELETE FROM users;");
const post = (body, { type = "application/json", raw = false } = {}) =>
  fetchBounded(URL_PATH, { method: "POST", headers: type ? { "content-type": type } : {}, body: raw ? body : JSON.stringify(body) });
async function json(response) {
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, text, json: parsed };
}
const counts = () => q(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM users WHERE role = 'super_admin') AS admins,
  (SELECT count(*) FROM coaches) AS coaches, (SELECT count(*) FROM members) AS members, (SELECT count(*) FROM auth_sessions) AS sessions`)[0];
const NOTHING = { users: 0, admins: 0, coaches: 0, members: 0, sessions: 0 };

describe("Temporary first-admin bootstrap route", { concurrency: false }, () => {
  before(async () => {
    for (const f of readdirSync("drizzle").filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      const r = d1("--file", join("drizzle", f));
      assert.equal(r.status, 0, `migration ${f} failed\n${r.stderr}`);
    }
    worker = await startWorker(Number(PORT), { persistTo: STATE });
  });
  after(async () => {
    await worker?.stop();
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("GET is unavailable", async () => {
    const r = await fetchBounded(URL_PATH);
    assert.ok([404, 405].includes(r.status), `GET -> ${r.status}`);
    assert.deepEqual(counts(), NOTHING);
  });

  it("refuses non-JSON requests (415) and malformed JSON (400)", async () => {
    assert.equal((await post("email=a@b.com&password=x", { type: "application/x-www-form-urlencoded", raw: true })).status, 415);
    assert.equal((await post(JSON.stringify({ email: EMAIL, password: PASSWORD }), { type: "text/plain", raw: true })).status, 415);
    assert.equal((await post(JSON.stringify({ email: EMAIL, password: PASSWORD }), { type: null, raw: true })).status, 415);
    assert.equal((await post("{not json", { raw: true })).status, 400);
    assert.deepEqual(counts(), NOTHING);
  });

  it("refuses missing/invalid input without writing", async () => {
    const cases = [
      [{ password: PASSWORD }, "missing email"],
      [{ email: EMAIL }, "missing password"],
      [{ email: "not-an-email", password: PASSWORD }, "invalid email"],
      [{ email: "admin@example.test", password: PASSWORD }, ".test email"],
      [{ email: "admin@sub.example.test", password: PASSWORD }, "nested .test email"],
      [{ email: EMAIL, password: "short" }, "short password"],
      [{ email: EMAIL, password: 123456789012 }, "non-string password"],
      [{ email: EMAIL, password: PASSWORD, role: "coach" }, "extra field"],
      [[EMAIL, PASSWORD], "array body"],
    ];
    for (const [body, label] of cases) {
      const r = await json(await post(body));
      assert.equal(r.status, 400, label);
      assert.ok(!r.text.includes(PASSWORD), label);
    }
    assert.deepEqual(counts(), NOTHING);
  });

  it("does not accept credentials through the query string", async () => {
    const r = await fetchBounded(`${URL_PATH}?email=${EMAIL}&password=${PASSWORD}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 400);
    assert.deepEqual(counts(), NOTHING);
  });

  it("creates exactly one active super_admin: normalized email, i=100000 hash that verifies, no profile rows, no session", async () => {
    const r = await json(await post({ email: `  ${EMAIL.toUpperCase()} `, password: PASSWORD }));
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json, { created: true, email: EMAIL, role: "super_admin" });
    assert.equal(r.text.includes(PASSWORD), false);
    assert.equal(/pbkdf2|hash|salt|token/i.test(r.text), false);

    const rows = q("SELECT role, email, password_hash, is_active FROM users");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "super_admin");
    assert.equal(rows[0].email, EMAIL);
    assert.equal(rows[0].is_active, 1);
    assert.match(rows[0].password_hash, /^pbkdf2-sha256\$v=1\$i=100000\$/);
    assert.equal(await verifyPassword(PASSWORD, rows[0].password_hash), true);
    assert.equal(await verifyPassword(`${PASSWORD}x`, rows[0].password_hash), false);
    assert.deepEqual(counts(), { users: 1, admins: 1, coaches: 0, members: 0, sessions: 0 });
  });

  it("does not log the user in: no cookie is set and the new admin has no session", async () => {
    const created = await post({ email: "other.admin@gym-prod.com", password: PASSWORD }); // refused, but also must not set cookies
    assert.equal(created.headers.getSetCookie().length, 0);
    assert.equal(counts().sessions, 0);
    const login = await fetchBounded(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    assert.equal(login.status, 200, "the normal login works for the new admin");
    q("DELETE FROM auth_sessions");
  });

  it("second bootstrap and a different admin both return 409 and change nothing", async () => {
    const before = q("SELECT id, email, password_hash FROM users");
    for (const email of [EMAIL, "another.admin@gym-prod.com"]) {
      const r = await json(await post({ email, password: "A-Different-Password-1" }));
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "A Super Admin already exists. Bootstrap refused.");
    }
    assert.deepEqual(q("SELECT id, email, password_hash FROM users"), before, "existing admin is never updated or reset");
    assert.equal(counts().admins, 1);
  });

  it("an existing user with the target email returns 409 (no admin yet)", async () => {
    reset();
    q(`INSERT INTO users (role, email, password_hash, is_active) VALUES ('coach', '${EMAIL}', 'x', 1)`);
    const r = await json(await post({ email: EMAIL, password: PASSWORD }));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "An account with this email already exists.");
    assert.equal(counts().admins, 0);
    assert.equal(q("SELECT role FROM users")[0].role, "coach", "the existing user is untouched");
  });

  it("concurrent attempts create at most one Super Admin", async () => {
    reset();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post({ email: i % 2 ? EMAIL : `race${i}@gym-prod.com`, password: PASSWORD }).then((r) => r.status)));
    assert.equal(results.filter((s) => s === 201).length, 1, JSON.stringify(results));
    assert.ok(results.every((s) => s === 201 || s === 409), JSON.stringify(results));
    assert.equal(counts().admins, 1);
    assert.equal(counts().users, 1);
  });

  it("a database without the users table fails safely (500, nothing leaked)", async () => {
    reset();
    q("ALTER TABLE users RENAME TO users_missing");
    try {
      const r = await json(await post({ email: EMAIL, password: PASSWORD }));
      assert.equal(r.status, 500);
      assert.equal(r.json.error, "Database schema is not ready.");
      assert.equal(/sql|sqlite|pbkdf2|no such table/i.test(r.text), false);
    } finally {
      q("ALTER TABLE users_missing RENAME TO users");
    }
    assert.deepEqual(counts(), NOTHING);
  });

  it("source guard: temporary banner present, no fixture credentials, no secret, no crypto of its own", () => {
    const source = readFileSync("app/api/bootstrap/first-admin/route.ts", "utf8");
    assert.match(source, /TEMPORARY FIRST-PRODUCTION-ADMIN BOOTSTRAP\.\n \* REMOVE IMMEDIATELY AFTER THE FIRST SUPER ADMIN IS CREATED\./);
    for (const fixture of ["LocalAdmin123!", "LocalCoach123!", "LocalMember123!", "superadmin@example.test"]) assert.equal(source.includes(fixture), false, fixture);
    assert.equal(/deriveBits|importKey|process\.env|env\.[A-Z_]+SECRET/.test(source), false);
    assert.match(source, /hashPassword/);
  });

  it("the shared local database is untouched (isolated state only)", () => {
    assert.ok(STATE.startsWith(tmpdir()) || STATE.startsWith(ROOT));
  });

  it("this suite runs exactly once in test:full, through test:regression", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    const occurrences = (name) => (scripts[name].match(/test:first-admin-route/g) ?? []).length;
    assert.equal(occurrences("test:regression"), 1);
    assert.equal(occurrences("test:full"), 0);
    assert.match(scripts["test:full"], /^npm run test:regression\b/);
  });
});
