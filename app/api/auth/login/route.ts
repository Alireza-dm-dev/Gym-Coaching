import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { authSessions, users } from "../../../../db/schema";
import {
  generateSessionToken, hashSessionToken, verifyPassword,
} from "../../../../lib/auth-crypto";
import {
  SESSION_LIFETIME_SECONDS, buildSessionCookie,
} from "../../../../lib/auth-session";

export const dynamic = "force-dynamic";

// Valid PBKDF2 hash of a random throwaway value; belongs to no account. Used
// so unknown/passwordless/inactive logins still pay for a PBKDF2 verify.
const DUMMY_PASSWORD_HASH =
  "pbkdf2-sha256$v=1$i=600000$salt=4AjYJwuQNMx9j3ktUUSW_w$hash=zXOpV4swH8iWg8uqcfiCIP7EewGlg8C4zq7xoYBh1n0";

const badRequest = (error: string) => Response.json({ error }, { status: 400 });
const invalidCredentials = () =>
  Response.json({ error: "Invalid email or password." }, { status: 401 });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("Request body must be an object.");
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "email" && key !== "password")) {
    return badRequest("Only email and password are accepted.");
  }
  if (typeof input.email !== "string" || typeof input.password !== "string") {
    return badRequest("email and password must be strings.");
  }
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  if (!email || !password) return badRequest("email and password are required.");

  try {
    const db = getDb();
    const [user] = await db
      .select({
        id: users.id,
        role: users.role,
        email: users.email,
        passwordHash: users.passwordHash,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const usable = user && user.isActive && user.passwordHash !== null;
    const passwordOk = await verifyPassword(
      password,
      usable ? user.passwordHash! : DUMMY_PASSWORD_HASH
    );
    if (!usable || !passwordOk) return invalidCredentials();

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000);
    await db.insert(authSessions).values({
      userId: user.id,
      tokenHash: await hashSessionToken(token),
      expiresAt: expiresAt.toISOString(),
    });

    return Response.json(
      { user: { id: user.id, role: user.role, email: user.email } },
      { headers: { "Set-Cookie": buildSessionCookie(request, token, expiresAt) } }
    );
  } catch (error) {
    console.error("POST /api/auth/login failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Unable to sign in." }, { status: 500 });
  }
}
