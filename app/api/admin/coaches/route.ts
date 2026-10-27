import { asc, count, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { coaches, members, users } from "../../../../db/schema";
import { hashPassword } from "../../../../lib/auth-crypto";
import { authErrorResponse, requireRole } from "../../../../lib/authorization";
import { badRequest, serverError } from "../../members/shared";

// Account data is persisted state, so never serve it from a cached render.
export const dynamic = "force-dynamic";

export const MIN_PASSWORD_LENGTH = 10;

/** Deliberately narrow management projection: no credentials, no Member data. */
const coachColumns = {
  id: coaches.id,
  userId: coaches.userId,
  name: coaches.name,
  email: users.email,
  isActive: users.isActive,
};

async function requireSuperAdmin(request: Request): Promise<Response | null> {
  try {
    await requireRole(request, "super_admin");
    return null;
  } catch (error) {
    return authErrorResponse(error) ?? serverError("Admin auth failed", error, "Unable to process the request.");
  }
}

export async function GET(request: Request) {
  const denied = await requireSuperAdmin(request);
  if (denied) return denied;

  try {
    // One query: the Member count comes from a grouped LEFT JOIN, not per-Coach lookups.
    const rows = await getDb()
      .select({ ...coachColumns, memberCount: count(members.id) })
      .from(coaches)
      .innerJoin(users, eq(users.id, coaches.userId))
      .leftJoin(members, eq(members.coachId, coaches.id))
      .groupBy(coaches.id)
      .orderBy(asc(coaches.id));
    return Response.json({ coaches: rows });
  } catch (error) {
    return serverError("GET /api/admin/coaches failed", error, "Unable to load coaches.");
  }
}

export async function POST(request: Request) {
  const denied = await requireSuperAdmin(request);
  if (denied) return denied;

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
  const unknown = Object.keys(input).filter((key) => !["name", "email", "password"].includes(key));
  if (unknown.length > 0) return badRequest(`Unsupported field(s): ${unknown.join(", ")}.`);

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return badRequest("name must be a non-empty string.");
  // Login lowercases its input, so only the normalized form is ever stored.
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return badRequest("email must be a valid email address.");
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const db = getDb();
  try {
    const passwordHash = await hashPassword(input.password);
    // One atomic D1 batch: if either insert fails, neither row remains. The
    // Coach row takes its user_id from the just-inserted User by email.
    const [[user], [coach]] = await db.batch([
      db.insert(users).values({ role: "coach", email, passwordHash, isActive: true })
        .returning({ id: users.id }),
      db.insert(coaches)
        .values({ userId: sql`(SELECT id FROM users WHERE email = ${email})`, name })
        .returning({ id: coaches.id }),
    ]);
    return Response.json(
      { coach: { id: coach.id, userId: user.id, name, email, isActive: true, memberCount: 0 } },
      { status: 201 }
    );
  } catch (error) {
    // The batch rolled back. If the email is already taken it was the unique
    // constraint (409); otherwise it is a genuine failure.
    const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (clash) return Response.json({ error: "An account with this email already exists." }, { status: 409 });
    return serverError("POST /api/admin/coaches failed", error, "Unable to create the coach.");
  }
}
