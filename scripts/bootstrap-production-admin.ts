/**
 * PRODUCTION OPERATOR UTILITY. Creates the FIRST production Super Admin and
 * nothing else. This is not registration: it is run once, by hand, by the
 * owner, against an explicitly named remote D1 database.
 *
 *   GYM_BOOTSTRAP_ADMIN_EMAIL=...        \
 *   GYM_BOOTSTRAP_ADMIN_PASSWORD=...     \
 *   GYM_BOOTSTRAP_D1_DATABASE=<real D1 database name> \
 *   npm run bootstrap:production-admin -- --dry-run
 *
 *   ... same environment ...
 *   npm run bootstrap:production-admin -- --confirm-production
 *
 * Deliberately NOT supported: local/preview targets, defaults for any input,
 * updating or resetting an existing user, creating a second Super Admin,
 * creating Coach/Member rows, running migrations. `scripts/seed-local-auth.ts`
 * is the separate, local-only fixture seeder and is never used here.
 *
 * Secrets: the password is read only from the environment (never argv), is not
 * passed on to Wrangler, and is never printed. The hash is written to a 0600
 * temp file (not argv, so it is not in the process list), the file is removed
 * afterwards, and every message that could echo wrangler output is redacted.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Node's type stripping needs the explicit .ts extension; tsconfig forbids it.
// @ts-expect-error TS5097
import { hashPassword, verifyPassword } from "../lib/auth-crypto.ts";

/** Same rule as the Admin UI/API (`MIN_PASSWORD_LENGTH` in app/api/admin/*). */
const MIN_PASSWORD_LENGTH = 10;
const WRANGLER_TIMEOUT_MS = 120_000;
const FLAGS = new Set(["--dry-run", "--confirm-production"]);
// Binding/mode words that are never a real database name. Refuse rather than guess.
const NOT_A_DATABASE_NAME = new Set(["db", "local", "preview"]);

class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message);
};

type Inputs = { email: string; password: string; database: string; dryRun: boolean };

/** Sensitive strings of this run, scrubbed from anything that could be printed. */
const secrets: string[] = [];
function redact(text: string): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/pbkdf2-sha256\$[^\s'"]*/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
}

function parseArgs(argv: string[]): { dryRun: boolean; confirmed: boolean } {
  for (const arg of argv) {
    // Never echo an unknown argument: a password given positionally would be printed.
    if (!FLAGS.has(arg)) refuse("Unsupported argument. Only --dry-run and --confirm-production are accepted; the password is read from the environment, never from arguments.");
  }
  return { dryRun: argv.includes("--dry-run"), confirmed: argv.includes("--confirm-production") };
}

/** Same normalization as login and account creation: trim + lowercase. */
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function validateEmail(email: string): void {
  if (!email) refuse("GYM_BOOTSTRAP_ADMIN_EMAIL is required.");
  // Stricter than the app's `includes("@")`, and keeps the value safe to place in SQL.
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) refuse("GYM_BOOTSTRAP_ADMIN_EMAIL is not a valid email address.");
  const domain = email.split("@")[1];
  // `.test` is a reserved TLD (never a real mailbox) and covers every local fixture domain.
  if (domain === "test" || domain.endsWith(".test")) refuse("Fixture/test email domains (*.test, including example.test) are refused for the production admin.");
}

function readInputs(env: NodeJS.ProcessEnv, dryRun: boolean): Inputs {
  const email = normalizeEmail(env.GYM_BOOTSTRAP_ADMIN_EMAIL ?? "");
  validateEmail(email);

  const password = env.GYM_BOOTSTRAP_ADMIN_PASSWORD ?? "";
  if (!password) refuse("GYM_BOOTSTRAP_ADMIN_PASSWORD is required.");
  secrets.push(password);
  if (password.length < MIN_PASSWORD_LENGTH) refuse(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  const database = (env.GYM_BOOTSTRAP_D1_DATABASE ?? "").trim();
  if (!database) refuse("GYM_BOOTSTRAP_D1_DATABASE is required: name the real production D1 database explicitly. There is no default.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(database)) refuse("GYM_BOOTSTRAP_D1_DATABASE is not a valid D1 database name.");
  if (NOT_A_DATABASE_NAME.has(database.toLowerCase())) refuse("GYM_BOOTSTRAP_D1_DATABASE must be the real remote database name, not a binding or mode word.");

  return { email, password, database, dryRun };
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// GYM_BOOTSTRAP_WRANGLER_ENTRY exists only so the local test suite can interpose a shim.
const wranglerEntry = process.env.GYM_BOOTSTRAP_WRANGLER_ENTRY ?? fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

/** Argument-array spawn (no shell). The password is stripped from the child's environment. */
function wrangler(args: string[]): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" };
  delete env.GYM_BOOTSTRAP_ADMIN_PASSWORD;
  const result = spawnSync(process.execPath, [wranglerEntry, ...args], {
    cwd: repoRoot, env, encoding: "utf8", timeout: WRANGLER_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ensureAuthenticated(): void {
  const result = wrangler(["whoami", "--json"]);
  let loggedIn = false;
  try { loggedIn = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))).loggedIn === true; } catch { /* not JSON */ }
  if (result.status !== 0 || !loggedIn) refuse("Wrangler is not authenticated. Run `wrangler login` (or set CLOUDFLARE_API_TOKEN) for the production account, then retry.");
}

type Row = Record<string, unknown>;

function d1Rows(database: string, mode: { command: string } | { file: string }): Row[] {
  const target = "command" in mode ? ["--command", mode.command] : ["--file", mode.file, "--yes"];
  const result = wrangler(["d1", "execute", database, "--remote", "--json", ...target]);
  if (result.status !== 0) refuse(`Wrangler D1 command failed (exit ${result.status}): ${redact(result.stderr || result.stdout) || "no output"}`);
  try {
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("[")));
    return (parsed[parsed.length - 1]?.results ?? []) as Row[];
  } catch {
    return refuse("Could not read Wrangler's D1 output.");
  }
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Read-only inspection. Returns the refusal reason, or null when the database is ready. */
function inspect(database: string, email: string): string | null {
  const columns = d1Rows(database, { command: "PRAGMA table_info(users)" }).map((row) => String(row.name));
  if (columns.length === 0) return "Production schema is not ready. Apply migrations before bootstrapping the admin.";
  for (const needed of ["role", "email", "password_hash", "is_active"]) {
    if (!columns.includes(needed)) return "Production schema is not ready. Apply migrations before bootstrapping the admin.";
  }
  const [counts] = d1Rows(database, {
    command: `SELECT (SELECT COUNT(*) FROM users WHERE role = 'super_admin') AS admins, (SELECT COUNT(*) FROM users WHERE email = ${sqlText(email)}) AS same_email`,
  });
  if (Number(counts?.admins) > 0) return "A Super Admin already exists. Bootstrap refused.";
  if (Number(counts?.same_email) > 0) return "A user with this email already exists. Bootstrap refused.";
  return null;
}

async function main(): Promise<void> {
  const { dryRun, confirmed } = parseArgs(process.argv.slice(2));
  const inputs = readInputs(process.env, dryRun);
  if (!dryRun && !confirmed) refuse("Refusing to modify production without --confirm-production. Use --dry-run to preview.");

  console.log(`Target D1 database : ${inputs.database} (remote)`);
  console.log(`Admin email        : ${inputs.email}`);
  console.log(`Action             : create first Super Admin${dryRun ? " (DRY RUN, nothing will be written)" : ""}`);

  ensureAuthenticated();
  const blocker = inspect(inputs.database, inputs.email);
  if (blocker) refuse(blocker);

  const passwordHash: string = await hashPassword(inputs.password);
  secrets.push(passwordHash);
  if (!(await verifyPassword(inputs.password, passwordHash))) refuse("Internal error: the generated password hash did not verify.");

  if (dryRun) {
    console.log("READY: the schema is present, no Super Admin exists, and the email is free.");
    console.log("Dry run: no changes were made.");
    return;
  }

  // One atomic statement. The guards repeat the pre-checks so a concurrent insert cannot slip a second admin in.
  const insert =
    `INSERT INTO users (role, email, password_hash, is_active) ` +
    `SELECT 'super_admin', ${sqlText(inputs.email)}, ${sqlText(passwordHash)}, 1 ` +
    `WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'super_admin') ` +
    `AND NOT EXISTS (SELECT 1 FROM users WHERE email = ${sqlText(inputs.email)});\n`;
  const dir = mkdtempSync(join(tmpdir(), "gym-bootstrap-"));
  const file = join(dir, "insert.sql");
  try {
    writeFileSync(file, insert, { mode: 0o600 });
    chmodSync(file, 0o600);
    d1Rows(inputs.database, { file }); // a failed insert is reported, never retried
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const admins = d1Rows(inputs.database, {
    command: `SELECT email, role, is_active AS active, (password_hash LIKE 'pbkdf2-sha256$%') AS hashed FROM users WHERE role = 'super_admin'`,
  });
  const [admin] = admins;
  if (admins.length !== 1 || admin.email !== inputs.email || Number(admin.active) !== 1 || Number(admin.hashed) !== 1) {
    refuse("The Super Admin was not created as expected (another admin or email may have been inserted concurrently). Inspect the users table; nothing was retried.");
  }

  console.log("First production Super Admin created.");
  console.log(`Email: ${inputs.email}`);
  console.log("Role: super_admin");
  console.log("Active: true");
}

main().catch((error: unknown) => {
  if (error instanceof Refusal) console.error(`Bootstrap refused: ${redact(error.message)}`);
  else console.error(`Bootstrap failed (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(1);
});
