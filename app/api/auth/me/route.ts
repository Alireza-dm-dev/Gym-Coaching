import {
  buildClearedSessionCookie, readSessionToken, resolveSessionUser,
} from "../../../../lib/auth-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthenticated = (clear: boolean) =>
    Response.json(
      { error: "Not authenticated." },
      {
        status: 401,
        headers: clear ? { "Set-Cookie": buildClearedSessionCookie(request) } : {},
      }
    );

  const token = readSessionToken(request);
  if (!token) return unauthenticated(false);

  try {
    const user = await resolveSessionUser(token);
    return user ? Response.json({ user }) : unauthenticated(true);
  } catch (error) {
    console.error("GET /api/auth/me failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Unable to load session." }, { status: 500 });
  }
}
