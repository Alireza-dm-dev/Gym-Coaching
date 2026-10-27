import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { authSessions } from "../../../../db/schema";
import { hashSessionToken } from "../../../../lib/auth-crypto";
import {
  buildClearedSessionCookie, readSessionToken,
} from "../../../../lib/auth-session";

export const dynamic = "force-dynamic";

/** Idempotent: deletes only the presented session and always clears the cookie. */
export async function POST(request: Request) {
  try {
    const token = readSessionToken(request);
    if (token) {
      await getDb()
        .delete(authSessions)
        .where(eq(authSessions.tokenHash, await hashSessionToken(token)));
    }
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": buildClearedSessionCookie(request) } }
    );
  } catch (error) {
    console.error("POST /api/auth/logout failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Unable to sign out." }, { status: 500 });
  }
}
