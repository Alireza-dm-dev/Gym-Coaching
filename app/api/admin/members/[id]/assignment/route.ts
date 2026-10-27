import { and, eq, exists, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { coaches, members, users } from "../../../../../../db/schema";
import { badRequest, notFound, serverError } from "../../../../members/shared";
import { loadAdminMember, parseId, readExactBody, requireSuperAdmin } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Reassign a Member to another active Coach. Changes only `members.coachId`:
 * Session rows keep their historical attribution and Cycles follow the Member.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSuperAdmin(request);
  if (denied) return denied;

  const id = parseId((await params).id);
  if (id === null) return notFound("Member not found.");

  const input = await readExactBody(request, ["coachId"]);
  if (typeof input === "string") return badRequest(input);
  const target = input.coachId;
  if (typeof target !== "number" || !Number.isInteger(target) || target <= 0) {
    return badRequest("coachId must be a positive whole number.");
  }

  const db = getDb();
  try {
    const current = await loadAdminMember(id);
    if (!current) return notFound("Member not found.");

    const [coach] = await db
      .select({ id: coaches.id, role: users.role, isActive: users.isActive })
      .from(coaches)
      .leftJoin(users, eq(users.id, coaches.userId))
      .where(eq(coaches.id, target))
      .limit(1);
    if (!coach) return notFound("Coach not found.");
    // Exists but is not an operational Coach account (legacy unlinked, or inactive).
    if (coach.role !== "coach" || !coach.isActive) {
      return Response.json({ error: "Coach is not an active coach account." }, { status: 409 });
    }

    if (current.coach.id !== target) {
      // The active-Coach condition is part of the statement, so a concurrent
      // deactivation cannot slip between the check above and the write.
      const updated = await db
        .update(members)
        .set({ coachId: target })
        .where(
          and(
            eq(members.id, id),
            exists(
              db.select({ one: sql`1` }).from(coaches)
                .innerJoin(users, eq(users.id, coaches.userId))
                .where(and(eq(coaches.id, target), eq(users.role, "coach"), eq(users.isActive, true)))
            )
          )
        )
        .returning({ id: members.id });
      if (updated.length === 0) {
        return Response.json({ error: "Coach is not an active coach account." }, { status: 409 });
      }
    }

    return Response.json({ member: await loadAdminMember(id) });
  } catch (error) {
    return serverError("PATCH /api/admin/members/[id]/assignment failed", error, "Unable to reassign the member.");
  }
}
