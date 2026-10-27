/**
 * LOCAL DEVELOPMENT ONLY. Seeds test-only login credentials into the LOCAL
 * D1 (`.wrangler/state`) so authorization can be exercised through the real
 * login flow. Idempotent. Never targets remote D1: every Wrangler call is
 * hard-wired to `--local` and the script refuses `--remote`.
 *
 *   node --experimental-strip-types scripts/seed-local-auth.ts
 *
 * Public, intentionally non-secret local fixture credentials:
 *   coach1@example.test        LocalCoach123!
 *   member1..4@example.test    LocalMember123!
 *   superadmin@example.test    LocalAdmin123!   (super_admin, no profile)
 *
 * Hashes come from the real `hashPassword` and are never printed.
 */
import { spawnSync } from "node:child_process";
// Node's type stripping needs the explicit .ts extension; tsconfig forbids it.
// @ts-expect-error TS5097
import { hashPassword } from "../lib/auth-crypto.ts";

if (process.argv.includes("--remote")) {
  throw new Error("seed-local-auth is local-only; --remote is not supported.");
}

const COACH_PASSWORD = "LocalCoach123!";
const MEMBER_PASSWORD = "LocalMember123!";
const ADMIN_PASSWORD = "LocalAdmin123!";
const ADMIN_EMAIL = "superadmin@example.test";

const fixtures: Array<[email: string, password: string]> = [
  ["coach1@example.test", COACH_PASSWORD],
  ["member1@example.test", MEMBER_PASSWORD],
  ["member2@example.test", MEMBER_PASSWORD],
  ["member3@example.test", MEMBER_PASSWORD],
  ["member4@example.test", MEMBER_PASSWORD],
];

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const statements: string[] = [];
for (const [email, password] of fixtures) {
  // Only the hash changes; id, role, email, is_active and profile links stay.
  statements.push(
    `UPDATE users SET password_hash = ${sqlLiteral(await hashPassword(password))}, ` +
      `updated_at = CURRENT_TIMESTAMP WHERE email = ${sqlLiteral(email)};`
  );
}
// Insert only if missing; an existing row keeps its role and just gets the hash.
statements.push(
  `INSERT INTO users (role, email, password_hash) VALUES ('super_admin', ${sqlLiteral(ADMIN_EMAIL)}, ` +
    `${sqlLiteral(await hashPassword(ADMIN_PASSWORD))}) ` +
    `ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, updated_at = CURRENT_TIMESTAMP;`
);

const result = spawnSync(
  process.execPath,
  [
    "--import", "./scripts/sites-env.mjs",
    "./node_modules/wrangler/bin/wrangler.js",
    "d1", "execute", "DB",
    "--local",
    "--config", "dist/server/wrangler.json",
    "--persist-to", ".wrangler/state",
    "--json",
    "--command", statements.join(" "),
  ],
  { encoding: "utf8" }
);
if (result.status !== 0) {
  // Wrangler output can echo the SQL (and so the hashes); report only the status.
  throw new Error(`Local D1 seed failed (wrangler exit ${result.status}).`);
}

console.log("Seeded local Coach credentials (1)");
console.log("Seeded local Member credentials (4)");
console.log(`Seeded local Super Admin (${ADMIN_EMAIL})`);
