import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { authSessions, users, type UserRole } from "../db/schema";
import { hashSessionToken } from "./auth-crypto";

/** Fixed absolute session lifetime (no sliding expiry, no refresh). */
export const SESSION_LIFETIME_SECONDS = 14 * 24 * 60 * 60;

export type { UserRole };

/** Safe caller identity: no credentials, session ids or token material. */
export type AuthenticatedUser = {
  id: number;
  role: UserRole;
  email: string;
};

/**
 * `__Host-` requires Secure, so it is used only on HTTPS requests; plain-HTTP
 * local dev uses `session`. Name and Secure both derive from the request
 * protocol so issue, read and clear always agree.
 */
function cookiePolicy(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return { secure, name: secure ? "__Host-session" : "session" };
}

function cookieAttributes(request: Request, extra: string) {
  const { secure } = cookiePolicy(request);
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; ${extra}`;
}

export function buildSessionCookie(request: Request, token: string, expiresAt: Date) {
  const { name } = cookiePolicy(request);
  return `${name}=${token}; ${cookieAttributes(
    request,
    `Max-Age=${SESSION_LIFETIME_SECONDS}; Expires=${expiresAt.toUTCString()}`
  )}`;
}

export function buildClearedSessionCookie(request: Request) {
  const { name } = cookiePolicy(request);
  return `${name}=; ${cookieAttributes(
    request,
    "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  )}`;
}

export function readSessionToken(request: Request): string | null {
  const { name } = cookiePolicy(request);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const sep = part.indexOf("=");
    if (sep > 0 && part.slice(0, sep).trim() === name) {
      const value = part.slice(sep + 1).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Resolves the session cookie to a live User in one join. Role and
 * `isActive` come from `users` on every call. Expired sessions and sessions
 * of deactivated Users are deleted opportunistically. Returns null for any
 * unauthenticated state without revealing why.
 */
export async function resolveSessionUser(token: string): Promise<AuthenticatedUser | null> {
  const db = getDb();
  const tokenHash = await hashSessionToken(token);
  const [row] = await db
    .select({
      sessionId: authSessions.id,
      expiresAt: authSessions.expiresAt,
      userId: users.id,
      role: users.role,
      email: users.email,
      isActive: users.isActive,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;

  const expiresMs = Date.parse(row.expiresAt);
  if (!row.isActive || !(expiresMs > Date.now())) {
    await db.delete(authSessions).where(eq(authSessions.id, row.sessionId));
    return null;
  }
  return { id: row.userId, role: row.role, email: row.email };
}

/**
 * Canonical "who is the caller?" lookup for server code: cookie → live User,
 * or null for any unauthenticated state. It cannot touch the Response, so
 * routes that want to clear a dead cookie do that themselves (see
 * `/api/auth/me`, which calls `resolveSessionUser` directly for that reason).
 */
export async function getCurrentUser(request: Request): Promise<AuthenticatedUser | null> {
  const token = readSessionToken(request);
  return token ? resolveSessionUser(token) : null;
}
