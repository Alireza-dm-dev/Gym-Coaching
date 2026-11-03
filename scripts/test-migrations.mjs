/**
 * LOCAL ONLY. Migration regression suite (SEC0M8B): applies the real Drizzle
 * SQL files in `drizzle/` to throwaway local D1 databases (never the shared
 * `.wrangler/state`, never remote).
 *
 * The 0001 SQL defaults `goal ''` and `preferred_days '[]'` are migration-safety
 * placeholders only: they exist so 0001 can add required columns when legacy
 * Member rows are present. They are NOT product defaults; runtime Member
 * creation must keep requiring explicit, validated values (`10:00` and `60`
 * mirror the Add Client form's prefill).
 *
 * Proves 0000-0010 apply on a fresh database, and that 0001 also applies when `members` already holds rows, because a
 * required column added without a default fails on a populated table.
 *
 *   npm run build && npm run test:migrations
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { installSuiteGuard } from "./test-helpers.mjs";

if (process.argv.includes("--remote")) throw new Error("test-migrations is local-only.");
if (!existsSync("dist/server/wrangler.json")) throw new Error("Run the build first (dist/server is missing).");

const ROOT = mkdtempSync(join(tmpdir(), "gym-migrations-"));
const wranglerReal = join(process.cwd(), "node_modules/wrangler/bin/wrangler.js");
const sitesEnv = join(process.cwd(), "scripts/sites-env.mjs");
const FILES = readdirSync("drizzle").filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
let dirCounter = 0;

installSuiteGuard("migrations", 10 * 60_000, () => rmSync(ROOT, { recursive: true, force: true }));

const d1 = (state, ...extra) =>
  spawnSync(process.execPath, ["--import", sitesEnv, wranglerReal, "d1", "execute", "DB", "--local", "--persist-to", state,
    "--config", "dist/server/wrangler.json", "--json", ...extra], { encoding: "utf8", cwd: process.cwd() });
function query(state, command) {
  const r = d1(state, "--command", command);
  assert.equal(r.status, 0, `query failed: ${command}\n${r.stderr}`);
  return JSON.parse(r.stdout)[0].results;
}
function migrate(state, files) {
  for (const f of files) {
    const r = d1(state, "--file", join("drizzle", f));
    assert.equal(r.status, 0, `migration ${f} failed\n${r.stdout}${r.stderr}`);
  }
}
const newState = () => join(ROOT, `state-${dirCounter++}`);
const columns = (state, table) => query(state, `PRAGMA table_info(${table})`);

describe("Migrations 0000-0010", { concurrency: false }, () => {
  it("expects exactly migrations 0000-0010, in order", () => {
    assert.deepEqual(FILES.map((f) => f.slice(0, 4)), Array.from({ length: 11 }, (_, i) => String(i).padStart(4, "0")));
  });

  it("applies cleanly, once each, to a brand-new database with the expected final schema", () => {
    const state = newState();
    migrate(state, FILES);
    const tables = query(state, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    for (const t of ["coaches", "members", "sessions", "session_notes", "session_muscles", "users", "auth_sessions", "member_cycles", "member_meals"]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    assert.ok(columns(state, "coaches").some((c) => c.name === "photo_url"), "coaches.photo_url");
    assert.ok(columns(state, "members").some((c) => c.name === "photo_url"), "members.photo_url");
  });

  it("0001 keeps the four required Member columns NOT NULL, with constant fallback defaults", () => {
    const state = newState();
    migrate(state, FILES);
    const byName = Object.fromEntries(columns(state, "members").map((c) => [c.name, c]));
    const expected = { goal: ["text", "''"], default_start_time: ["text", "'10:00'"], default_duration_minutes: ["integer", "60"], preferred_days: ["text", "'[]'"] };
    for (const [name, [type, dflt]] of Object.entries(expected)) {
      assert.equal(byName[name].notnull, 1, `${name} stays NOT NULL`);
      assert.equal(byName[name].type.toLowerCase(), type, `${name} type`);
      assert.equal(byName[name].dflt_value, dflt, `${name} default`);
    }
    assert.equal(byName.photo_url.notnull, 0);
  });

  it("applies 0001 to a database whose members table already has rows, filling the defaults without data loss", () => {
    const state = newState();
    migrate(state, FILES.slice(0, 1)); // 0000 only
    query(state, "INSERT INTO coaches (name) VALUES ('Existing Coach')");
    query(state, "INSERT INTO members (coach_id, name) VALUES (1, 'Existing Member One'), (1, 'Existing Member Two')");
    const before = query(state, "SELECT id, coach_id, name, created_at FROM members ORDER BY id");
    assert.equal(before.length, 2);

    migrate(state, FILES.slice(1, 2)); // 0001 on a populated table
    const rows = query(state, "SELECT id, coach_id, name, created_at, goal, default_start_time, default_duration_minutes, preferred_days, photo_url FROM members ORDER BY id");
    assert.equal(rows.length, 2, "no rows lost");
    rows.forEach((row, i) => {
      assert.deepEqual({ id: row.id, coach_id: row.coach_id, name: row.name, created_at: row.created_at }, before[i]);
      assert.equal(row.goal, "");
      assert.equal(row.default_start_time, "10:00");
      assert.equal(row.default_duration_minutes, 60);
      assert.equal(row.preferred_days, "[]");
      assert.deepEqual(JSON.parse(row.preferred_days), []); // the shape the app's parsePreferredDays accepts
      assert.equal(row.photo_url, null);
    });

    migrate(state, FILES.slice(2)); // the rest still applies on top of that data
    assert.equal(query(state, "SELECT count(*) AS n FROM members")[0].n, 2);
    assert.equal(query(state, "SELECT count(*) AS n FROM coaches")[0].n, 1);
  });

  it("source guard: no required column is added without a default in any migration", () => {
    for (const f of FILES) {
      for (const line of readFileSync(join("drizzle", f), "utf8").split("\n")) {
        if (/ALTER TABLE .* ADD /i.test(line) && /NOT NULL/i.test(line)) {
          assert.match(line, /DEFAULT/i, `${f}: ${line.trim()}`);
        }
      }
    }
  });
});
