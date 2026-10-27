import { and, count, eq, exists, notExists, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { authSessions, coaches, members, users } from "../../../../../../db/schema";
import { authErrorResponse, requireRole } from "../../../../../../lib/authorization";
import { badRequest, notFound, serverError } from "../../../../members/shared";

export const dynamic = "force-dynamic";

const safeUser = { id: users.id, role: users.role, email: users.email, isActive: users.isActive };

/**
 * Activate/deactivate a linked Coach or Member login. No hard delete, and
 * Super Admin accounts are not manageable here. Deactivation purges every
 * auth session of the user in the same atomic batch, so a later reactivation
 * can never resurrect an old session.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(request, "super_admin");
  } catch (error) {
    return authErrorResponse(error) ?? serverError("Admin auth failed", error, "Unable to process the request.");
  }

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound("User not found.");

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
  if (Object.keys(input).some((key) => key !== "isActive") || typeof input.isActive !== "boolean") {
    return badRequest("Body must be exactly { isActive: boolean }.");
  }
  const target = input.isActive;

  const db = getDb();
  const ctx = "PATCH /api/admin/users/[id]/status failed";
  try {
    const [user] = await db.select(safeUser).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return notFound("User not found.");
    if (user.role === "super_admin") {
      return Response.json({ error: "Super Admin accounts cannot be changed here." }, { status: 409 });
    }
    // Idempotent: no change, no side effects.
    if (user.isActive === target) return Response.json({ user });

    const stillOwnsMembers = db
      .select({ one: sql`1` })
      .from(members)
      .innerJoin(coaches, eq(coaches.id, members.coachId))
      .where(eq(coaches.userId, id));
    const blockedCoach = !target && user.role === "coach";

    const [updated] = await db.batch([
      db.update(users)
        .set({ isActive: target, updatedAt: sql`CURRENT_TIMESTAMP` })
        // A Coach is only deactivated while it owns no Members; checked in the
        // statement itself, so it cannot race the count below.
        .where(and(eq(users.id, id), blockedCoach ? notExists(stillOwnsMembers) : undefined))
        .returning(safeUser),
      // Runs only if the update above actually deactivated the user.
      db.delete(authSessions).where(
        target
          ? sql`0`
          : and(
              eq(authSessions.userId, id),
              exists(db.select({ one: sql`1` }).from(users).where(and(eq(users.id, id), eq(users.isActive, false))))
            )
      ),
    ]);

    if (updated.length === 0) {
      const [{ memberCount }] = await db
        .select({ memberCount: count(members.id) })
        .from(coaches)
        .innerJoin(members, eq(members.coachId, coaches.id))
        .where(eq(coaches.userId, id));
      return Response.json({ error: "Coach still has assigned members.", memberCount }, { status: 409 });
    }
    return Response.json({ user: updated[0] });
  } catch (error) {
    return serverError(ctx, error, "Unable to update the account status.");
  }
}
