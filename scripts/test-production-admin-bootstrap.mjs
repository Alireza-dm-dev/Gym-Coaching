/**
 * LOCAL ONLY. Regression suite for scripts/bootstrap-production-admin.ts
 * (SEC0M7A). It never touches production and never touches the shared local
 * D1: every case runs against a throwaway Miniflare D1 under the OS temp dir.
 *
 *   npm run build && npm run test:production-admin-bootstrap
 *
 * The script under test always asks Wrangler for `--remote`. Its test hook
 * (GYM_BOOTSTRAP_WRANGLER_ENTRY) points it at a shim that records the argv,
 * asserts `--remote` was requested, and re-targets the call at the temp local
 * D1. So the real script, real hashing and real SQL run end to end.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installSuiteGuard } from "./test-helpers.mjs";
// Needs `node --experimental-strip-types` (see the npm script).
import { verifyPassword } from "../lib/auth-crypto.ts";

if (process.argv.includes("--remote")) throw new Error("test-production-admin-bootstrap is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const SCRIPT = "scripts/bootstrap-production-admin.ts";
const ROOT = mkdtempSync(join(tmpdir(), "gymbs-test-"));
const SHIM = join(ROOT, "wrangler-shim.mjs");
const LOG = join(ROOT, "shim.log");
const PASSWORD = "Correct-Horse-Battery-9";
const EMAIL_RAW = "  Owner.Admin@Gym-Prod.COM ";
const EMAIL = "owner.admin@gym-prod.com";
const DB_NAME = "gym-prod-d1-test";
const outputs = []; // every stdout/stderr produced by any run, for the leak check
let template; // migrated local D1 state (0000-0010)
let dirCounter = 0;

installSuiteGuard("production-admin-bootstrap", 15 * 60_000, () => rmSync(ROOT, { recursive: true, force: true }));

const wranglerReal = join(process.cwd(), "node_modules/wrangler/bin/wrangler.js");
const sitesEnv = join(process.cwd(), "scripts/sites-env.mjs");
writeFileSync(SHIM, `
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "whoami") {
  if (process.env.SHIM_AUTH === "none") { console.log('{"loggedIn":false}'); process.exit(1); }
  console.log('{"loggedIn":true}'); process.exit(0);
}
if (args[0] !== "d1" || args[1] !== "execute") { console.error("shim: unexpected wrangler command"); process.exit(98); }
if (!args.includes("--remote") || args.includes("--local")) { console.error("shim: script must request --remote only"); process.exit(99); }
const fileIndex = args.indexOf("--file");
if (fileIndex >= 0 && process.env.SHIM_FAIL_INSERT === "1") {
  // Simulate wrangler echoing the failing SQL (which contains the hash).
  console.error("D1_ERROR: boom while running: " + readFileSync(args[fileIndex + 1], "utf8"));
  process.exit(1);
}
const rest = args.slice(3).filter((a) => a !== "--remote");
const out = ["--import", ${JSON.stringify(sitesEnv)}, ${JSON.stringify(wranglerReal)}, "d1", "execute", "DB", "--local",
  "--persist-to", process.env.SHIM_STATE, "--config", "dist/server/wrangler.json", ...rest];
const r = spawnSync(process.execPath, out, { stdio: "inherit", cwd: ${JSON.stringify(process.cwd())} });
process.exit(r.status ?? 1);
`);

function localD1(state, ...extra) {
  return spawnSync(process.execPath, ["--import", sitesEnv, wranglerReal, "d1", "execute", "DB", "--local", "--persist-to", state,
    "--config", "dist/server/wrangler.json", "--json", ...extra], { encoding: "utf8", cwd: process.cwd() });
}
function q(state, command) {
  const r = localD1(state, "--command", command);
  assert.equal(r.status, 0, `local query failed: ${command}\n${r.stderr}`);
  return JSON.parse(r.stdout)[0].results;
}
const newState = () => join(ROOT, `state-${dirCounter++}`);
function freshState(kind) {
  const state = newState();
  if (kind === "migrated") cpSync(template, state, { recursive: true });
  return state; // "empty": a missing dir becomes an empty D1 on first use
}

const BASE_ENV = () => ({
  GYM_BOOTSTRAP_ADMIN_EMAIL: EMAIL_RAW,
  GYM_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
  GYM_BOOTSTRAP_D1_DATABASE: DB_NAME,
});
function run({ args = [], env = BASE_ENV(), state, extra = {} } = {}) {
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GYM_BOOTSTRAP_WRANGLER_ENTRY: SHIM, SHIM_LOG: LOG, SHIM_STATE: state ?? freshState("migrated"), ...extra, ...env };
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args], { encoding: "utf8", env: childEnv, cwd: process.cwd(), timeout: 180_000 });
  outputs.push(r.stdout, r.stderr);
  return { status: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}`, state: childEnv.SHIM_STATE };
}
const shimCalls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const without = (key) => { const e = BASE_ENV(); delete e[key]; return e; };
const refused = (r, pattern) => { assert.notEqual(r.status, 0, r.all); assert.match(r.all, pattern); };
const leftoverTemp = () => readdirSync(tmpdir()).filter((f) => f.startsWith("gym-bootstrap-"));

describe("bootstrap-production-admin", { concurrency: false }, () => {
  before(() => {
    template = newState();
    const files = readdirSync("drizzle").filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    assert.equal(files.length, 11, "expected migrations 0000-0010");
    for (const f of files) {
      const r = localD1(template, "--file", join("drizzle", f));
      assert.equal(r.status, 0, `migration ${f} failed\n${r.stderr}`);
    }
    assert.equal(q(template, "SELECT count(*) AS n FROM users")[0].n, 0, "template must start with no users");
  });
  after(() => rmSync(ROOT, { recursive: true, force: true }));

  describe("input refusals (before any Wrangler call)", () => {
    it("missing email", () => {
      const n = shimCalls().length;
      refused(run({ env: without("GYM_BOOTSTRAP_ADMIN_EMAIL"), args: ["--confirm-production"] }), /GYM_BOOTSTRAP_ADMIN_EMAIL is required/);
      assert.equal(shimCalls().length, n, "must not reach Wrangler");
    });
    it("invalid email", () => refused(run({ env: { ...BASE_ENV(), GYM_BOOTSTRAP_ADMIN_EMAIL: "not-an-email" }, args: ["--confirm-production"] }), /not a valid email/));
    it("missing password", () => refused(run({ env: without("GYM_BOOTSTRAP_ADMIN_PASSWORD"), args: ["--confirm-production"] }), /GYM_BOOTSTRAP_ADMIN_PASSWORD is required/));
    it("fixture/test email domains", () => {
      for (const email of ["superadmin@example.test", "someone@admincreds.example.test", "a@b.test", "SuperAdmin@Example.Test"]) {
        refused(run({ env: { ...BASE_ENV(), GYM_BOOTSTRAP_ADMIN_EMAIL: email }, args: ["--confirm-production"] }), /Fixture\/test email domains/);
      }
    });
    it("short password (9 chars)", () => {
      refused(run({ env: { ...BASE_ENV(), GYM_BOOTSTRAP_ADMIN_PASSWORD: "123456789" }, args: ["--confirm-production"] }), /at least 10 characters/);
    });
    it("missing / placeholder target database", () => {
      refused(run({ env: without("GYM_BOOTSTRAP_D1_DATABASE"), args: ["--confirm-production"] }), /GYM_BOOTSTRAP_D1_DATABASE is required/);
      for (const name of ["DB", "local", "preview", "bad name;rm"]) {
        refused(run({ env: { ...BASE_ENV(), GYM_BOOTSTRAP_D1_DATABASE: name }, args: ["--confirm-production"] }), /GYM_BOOTSTRAP_D1_DATABASE/);
      }
    });
    it("no --confirm-production on a real run", () => {
      const n = shimCalls().length;
      refused(run(), /--confirm-production/);
      assert.equal(shimCalls().length, n, "must not reach Wrangler");
    });
    it("positional/unknown arguments are refused and never echoed", () => {
      const r = run({ args: ["--confirm-production", "SuperSecretPositional1"] });
      refused(r, /Unsupported argument/);
      assert.ok(!r.all.includes("SuperSecretPositional1"));
    });
    it("password policy matches the app's MIN_PASSWORD_LENGTH", () => {
      const appRule = readFileSync("app/api/admin/members/shared.ts", "utf8").match(/MIN_PASSWORD_LENGTH\s*=\s*(\d+)/)?.[1];
      const scriptRule = readFileSync(SCRIPT, "utf8").match(/MIN_PASSWORD_LENGTH\s*=\s*(\d+)/)?.[1];
      assert.ok(appRule);
      assert.equal(scriptRule, appRule);
    });
  });

  describe("Wrangler/auth and schema pre-checks", () => {
    it("unauthenticated Wrangler stops before touching D1", () => {
      const state = freshState("migrated");
      const n = shimCalls().length;
      refused(run({ state, args: ["--confirm-production"], extra: { SHIM_AUTH: "none" } }), /not authenticated/);
      assert.ok(shimCalls().slice(n).every((c) => c[0] === "whoami"), "only whoami may run");
      assert.equal(q(state, "SELECT count(*) AS n FROM users")[0].n, 0);
    });
    it("missing users table → schema-not-ready, nothing written", () => {
      const state = freshState("empty");
      refused(run({ state, args: ["--confirm-production"] }), /Production schema is not ready\. Apply migrations before bootstrapping the admin\./);
      assert.deepEqual(q(state, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"), []);
    });
  });

  describe("dry run", () => {
    it("reports READY and mutates nothing (no confirmation flag needed)", () => {
      const state = freshState("migrated");
      const n = shimCalls().length;
      const r = run({ state, args: ["--dry-run"] });
      assert.equal(r.status, 0, r.all);
      assert.match(r.out, /READY/);
      assert.match(r.out, /Dry run: no changes were made/);
      assert.equal(q(state, "SELECT count(*) AS n FROM users")[0].n, 0);
      assert.ok(!shimCalls().slice(n).some((c) => c.includes("--file")), "dry run must not execute any file/insert");
    });
    it("surfaces the existing-admin blocker too", () => {
      const state = freshState("migrated");
      q(state, "INSERT INTO users (role,email,password_hash) VALUES ('super_admin','other.admin@gym-prod.com','x')");
      refused(run({ state, args: ["--dry-run"] }), /A Super Admin already exists\. Bootstrap refused\./);
    });
  });

  describe("real bootstrap", () => {
    let state;
    let first;
    before(() => { state = freshState("migrated"); first = run({ state, args: ["--confirm-production"] }); });

    it("succeeds with only safe output", () => {
      assert.equal(first.status, 0, first.all);
      assert.match(first.out, /First production Super Admin created\./);
      assert.ok(first.out.includes(`Email: ${EMAIL}`));
      assert.match(first.out, /Role: super_admin/);
      assert.match(first.out, /Active: true/);
    });
    it("creates exactly one active super_admin with the normalized email", () => {
      const rows = q(state, "SELECT role, email, is_active FROM users");
      assert.deepEqual(rows, [{ role: "super_admin", email: EMAIL, is_active: 1 }]);
    });
    it("stores a hash the app's own verifyPassword accepts (and rejects a wrong password)", async () => {
      const [{ password_hash: hash }] = q(state, "SELECT password_hash FROM users");
      assert.match(hash, /^pbkdf2-sha256\$v=1\$i=100000\$/);
      assert.equal(await verifyPassword(PASSWORD, hash), true);
      assert.equal(await verifyPassword(`${PASSWORD}x`, hash), false);
    });
    it("creates no Coach, Member, session or auth-session rows", () => {
      for (const table of ["coaches", "members", "sessions", "auth_sessions", "member_cycles", "member_meals"]) {
        assert.equal(q(state, `SELECT count(*) AS n FROM ${table}`)[0].n, 0, table);
      }
    });
    it("a second real run refuses and changes nothing", () => {
      const [{ password_hash: before }] = q(state, "SELECT password_hash FROM users");
      const second = run({ state, args: ["--confirm-production"] });
      refused(second, /A Super Admin already exists\. Bootstrap refused\./);
      assert.ok(!/created/i.test(second.out));
      const rows = q(state, "SELECT password_hash FROM users");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].password_hash, before);
    });
  });

  describe("existing data refusals", () => {
    it("a different existing Super Admin → refuse, no second admin", () => {
      const state = freshState("migrated");
      q(state, "INSERT INTO users (role,email,password_hash) VALUES ('super_admin','other.admin@gym-prod.com','x')");
      refused(run({ state, args: ["--confirm-production"] }), /A Super Admin already exists/);
      assert.equal(q(state, "SELECT count(*) AS n FROM users")[0].n, 1);
    });
    it("target email already used by another role → refuse, row untouched", () => {
      const state = freshState("migrated");
      q(state, `INSERT INTO users (role,email,password_hash) VALUES ('coach','${EMAIL}','keep-me')`);
      refused(run({ state, args: ["--confirm-production"] }), /A user with this email already exists/);
      assert.deepEqual(q(state, "SELECT role, password_hash FROM users"), [{ role: "coach", password_hash: "keep-me" }]);
    });
  });

  describe("execution safety and secrecy", () => {
    it("a failing insert is reported once, not retried, leaves nothing and does not echo SQL/hash", () => {
      const state = freshState("migrated");
      const tempBefore = leftoverTemp();
      const n = shimCalls().length;
      refused(run({ state, args: ["--confirm-production"], extra: { SHIM_FAIL_INSERT: "1" } }), /Wrangler D1 command failed/);
      assert.equal(shimCalls().slice(n).filter((c) => c.includes("--file")).length, 1, "insert must not be retried");
      assert.equal(q(state, "SELECT count(*) AS n FROM users")[0].n, 0);
      assert.deepEqual(leftoverTemp(), tempBefore, "temp SQL file must be removed");
    });
    it("every Wrangler call is --remote against the named database; password/hash never in argv", () => {
      const calls = shimCalls().filter((c) => c[0] === "d1");
      assert.ok(calls.length > 0);
      for (const c of calls) {
        assert.ok(c.includes("--remote") && !c.includes("--local"));
        assert.equal(c[2], DB_NAME);
        assert.ok(!c.join(" ").includes(PASSWORD));
        assert.ok(!c.join(" ").includes("pbkdf2-sha256$v="), "hash must travel by 0600 file, not argv");
      }
    });
    it("no run ever printed the password or a hash (stdout + stderr of all runs)", () => {
      const all = outputs.join("\n");
      assert.ok(all.length > 0);
      assert.ok(!all.includes(PASSWORD), "password leaked");
      assert.ok(!/pbkdf2-sha256\$/.test(all), "hash leaked");
      assert.ok(!all.includes("SuperSecretPositional1"));
    });
  });

  describe("no automatic execution and no HTTP surface", () => {
    it("is only reachable through its own explicit npm script", () => {
      const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
      const hits = Object.entries(scripts).filter(([, v]) => v.includes("bootstrap-production-admin"));
      assert.deepEqual(hits.map(([k]) => k), ["bootstrap:production-admin"]);
      // The operator script itself is never invoked by any lifecycle/test script (the *test suite* is chained, see below).
      for (const hook of ["build", "start", "dev", "postinstall", "prepare", "install:ci", "test:regression", "test:full"]) {
        assert.ok(!/bootstrap[:-]production-admin(?!-)/.test((scripts[hook] ?? "").replace("test:production-admin-bootstrap", "")), hook);
      }
      for (const f of ["vite.config.ts", "worker/index.ts", "next.config.ts", ".openai/hosting.json", "scripts/run-framework.mjs", "scripts/build-verified.sh"]) {
        assert.ok(!readFileSync(f, "utf8").includes("bootstrap-production-admin"), f);
      }
    });
    it("this suite runs exactly once in test:full, through test:regression", () => {
      const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
      const occurrences = (text) => text.split("npm run test:production-admin-bootstrap").length - 1;
      assert.equal(occurrences(scripts["test:regression"]), 1);
      assert.equal(occurrences(scripts["test:full"]), 0);
      assert.ok(scripts["test:full"].startsWith("npm run test:regression"));
    });
    it("adds no bootstrap route under app/api other than the one temporary first-admin route (SEC0M9A)", () => {
      const TEMPORARY = "app/api/bootstrap/first-admin/route.ts"; // remove it, and this exception, after the first production admin exists
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      const routes = walk("app/api");
      assert.ok(routes.length > 0);
      assert.deepEqual(routes.filter((f) => f !== TEMPORARY && (/bootstrap/i.test(f) || /bootstrap/i.test(readFileSync(f, "utf8")))), []);
      // The temporary route never invokes or imports the operator CLI.
      if (routes.includes(TEMPORARY)) assert.ok(!/^\s*import .*(bootstrap-production-admin|child_process)/m.test(readFileSync(TEMPORARY, "utf8")));
    });
    it("seed-local-auth.ts stays local-only and separate", () => {
      const source = readFileSync(SCRIPT, "utf8");
      assert.ok(!/^import .*seed-local/m.test(source) && !/db\/seed-local/.test(source) && !source.includes('"--local"'));
      assert.match(readFileSync("scripts/seed-local-auth.ts", "utf8"), /--remote is not supported/);
    });
  });
});
