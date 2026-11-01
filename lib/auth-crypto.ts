/**
 * Password hashing and session-token primitives (SEC0C1), built only on Web
 * Crypto so they run identically in Cloudflare Workers and Node. This file is
 * cryptographic only: no password policy lives here. Never log anything
 * derived from these functions' inputs or outputs.
 */

const PBKDF2_ALGORITHM_TAG = "pbkdf2-sha256";
const PBKDF2_VERSION = 1;
// Cloudflare Workers production currently limits PBKDF2 to 100,000 iterations; do not raise this
// above that. Each stored hash records its own count, so verification never depends on this value.
export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;
const MAX_ITERATIONS = 10_000_000;
const SESSION_TOKEN_BYTES = 32;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_LOOKUP = new Map(
  Array.from(BASE64URL_ALPHABET, (char, index) => [char, index] as const)
);

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) {
      out += BASE64URL_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    }
    if (b2 !== undefined) out += BASE64URL_ALPHABET[b2 & 63];
  }
  return out;
}

/** Strict unpadded base64url decode; returns null on any invalid input. */
export function base64UrlToBytes(value: string): Uint8Array | null {
  if (value.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let pos = 0;
  for (const char of value) {
    const v = BASE64URL_LOOKUP.get(char);
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  // Leftover bits must be zero padding, otherwise the encoding is non-canonical.
  if (buffer !== 0) return null;
  return out;
}

/** Compares all bytes without early exit on the first mismatch. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derivePbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  lengthBytes: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

/** Format: pbkdf2-sha256$v=1$i=<iterations>$salt=<b64url>$hash=<b64url> */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await derivePbkdf2(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_HASH_BYTES
  );
  return [
    PBKDF2_ALGORITHM_TAG,
    `v=${PBKDF2_VERSION}`,
    `i=${PBKDF2_ITERATIONS}`,
    `salt=${bytesToBase64Url(salt)}`,
    `hash=${bytesToBase64Url(hash)}`,
  ].join("$");
}

type ParsedPasswordHash = {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
};

function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  if (typeof encoded !== "string") return null;
  const parts = encoded.split("$");
  if (parts.length !== 5) return null;
  const [tag, version, iter, saltPart, hashPart] = parts;
  if (tag !== PBKDF2_ALGORITHM_TAG) return null;
  if (version !== `v=${PBKDF2_VERSION}`) return null;
  if (!iter.startsWith("i=") || !saltPart.startsWith("salt=")) return null;
  if (!hashPart.startsWith("hash=")) return null;

  const iterText = iter.slice(2);
  if (!/^[1-9][0-9]{0,8}$/.test(iterText)) return null;
  const iterations = Number(iterText);
  if (iterations > MAX_ITERATIONS) return null;

  const salt = base64UrlToBytes(saltPart.slice(5));
  const hash = base64UrlToBytes(hashPart.slice(5));
  if (!salt || !hash || salt.length < PBKDF2_SALT_BYTES) return null;
  if (hash.length !== PBKDF2_HASH_BYTES) return null;
  return { iterations, salt, hash };
}

/**
 * Returns false (never throws) for malformed/unknown hashes and empty
 * passwords. Uses the iteration count stored in the hash, not the current
 * constant, so older hashes keep verifying after a future parameter bump.
 */
export async function verifyPassword(
  password: string,
  encodedHash: string
): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) return false;
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;
  try {
    const candidate = await derivePbkdf2(
      password,
      parsed.salt,
      parsed.iterations,
      parsed.hash.length
    );
    return constantTimeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/** 32 random bytes (256 bits), base64url. Goes in the cookie, never the DB. */
export function generateSessionToken(): string {
  return bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES))
  );
}

/** SHA-256 of the token as lowercase hex; this is what `auth_sessions.token_hash` stores. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
