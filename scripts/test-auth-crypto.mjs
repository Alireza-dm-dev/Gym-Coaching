/**
 * LOCAL ONLY. Password-hash compatibility suite (SEC0M8A). Exercises the real
 * `lib/auth-crypto.ts` helpers on actually produced hashes; no database.
 *
 * Cloudflare Workers production currently rejects PBKDF2 above 100,000
 * iterations, so the default must never exceed that.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PBKDF2_ITERATIONS, base64UrlToBytes, bytesToBase64Url, hashPassword, verifyPassword } from "../lib/auth-crypto.ts";

const PLATFORM_MAX_ITERATIONS = 100_000;
const PASSWORD = "CorrectHorse-Battery9";
const iterationsOf = (hash) => Number(/\$i=(\d+)\$/.exec(hash)?.[1]);

/** Independent PBKDF2 (not via hashPassword) to build hashes with an arbitrary stored count. */
async function manualHash(password, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return `pbkdf2-sha256$v=1$i=${iterations}$salt=${bytesToBase64Url(salt)}$hash=${bytesToBase64Url(new Uint8Array(bits))}`;
}

describe("Auth crypto (production Workers compatibility)", () => {
  it("new hashes encode exactly 100000 iterations and never more than the platform limit", async () => {
    const hash = await hashPassword(PASSWORD);
    assert.match(hash, /^pbkdf2-sha256\$v=1\$i=100000\$salt=[A-Za-z0-9_-]+\$hash=[A-Za-z0-9_-]+$/);
    assert.equal(iterationsOf(hash), 100_000);
    assert.ok(iterationsOf(hash) <= PLATFORM_MAX_ITERATIONS);
    assert.ok(PBKDF2_ITERATIONS <= PLATFORM_MAX_ITERATIONS);
  });

  it("accepts the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword(PASSWORD);
    assert.equal(await verifyPassword(PASSWORD, hash), true);
    assert.equal(await verifyPassword(`${PASSWORD}x`, hash), false);
    assert.equal(await verifyPassword("", hash), false);
  });

  it("uses a random salt: two hashes of the same password differ, both verify", async () => {
    const [a, b] = [await hashPassword(PASSWORD), await hashPassword(PASSWORD)];
    assert.notEqual(a, b);
    assert.notEqual(a.split("$")[3], b.split("$")[3]);
    assert.equal(base64UrlToBytes(a.split("$")[3].slice(5)).length, 16);
    assert.equal(await verifyPassword(PASSWORD, a), true);
    assert.equal(await verifyPassword(PASSWORD, b), true);
  });

  it("verification uses the iteration count stored in the hash, not the default", async () => {
    for (const iterations of [1_000, 50_000, 100_000]) {
      const hash = await manualHash(PASSWORD, iterations);
      assert.equal(await verifyPassword(PASSWORD, hash), true, `i=${iterations}`);
      assert.equal(await verifyPassword("wrong-password-1", hash), false, `i=${iterations}`);
    }
    // Same salt/hash bytes with a tampered count must not verify.
    const hash = await manualHash(PASSWORD, 1_000);
    assert.equal(await verifyPassword(PASSWORD, hash.replace("i=1000$", "i=1001$")), false);
  });

  it("refuses malformed, unsupported and tampered hashes safely (false, never a throw)", async () => {
    const good = await hashPassword(PASSWORD);
    const parts = good.split("$");
    const bad = [
      "", "not-a-hash", "pbkdf2-sha256", parts.slice(0, 4).join("$"), `${good}$extra`,
      good.replace("pbkdf2-sha256", "pbkdf2-sha1"), good.replace("v=1", "v=2"),
      good.replace("i=100000", "i=0"), good.replace("i=100000", "i=abc"), good.replace("i=100000", "i=99999999999"),
      good.replace(/hash=.*/, "hash=AAAA"), good.replace(/salt=[^$]*/, "salt=AA"), good.replace(/hash=./, "hash=!"),
    ];
    for (const hash of bad) assert.equal(await verifyPassword(PASSWORD, hash), false, hash);
    assert.equal(await verifyPassword(PASSWORD, undefined), false);
  });

  it("rejects an empty password when hashing", async () => {
    await assert.rejects(() => hashPassword(""));
  });

  it("source guard: the default iteration constant is the single definition and stays <= 100000", () => {
    const source = readFileSync(new URL("../lib/auth-crypto.ts", import.meta.url), "utf8");
    const match = /export const PBKDF2_ITERATIONS = ([\d_]+);/.exec(source);
    assert.ok(match, "PBKDF2_ITERATIONS definition");
    assert.ok(Number(match[1].replaceAll("_", "")) <= PLATFORM_MAX_ITERATIONS);
    for (const file of ["app/api/auth/login/route.ts"]) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      for (const m of text.matchAll(/\$i=(\d+)\$/g)) assert.ok(Number(m[1]) <= PLATFORM_MAX_ITERATIONS, `${file}: stored hash literal`);
    }
  });
});
