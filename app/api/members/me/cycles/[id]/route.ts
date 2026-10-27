import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { memberCycles } from "../../../../../../db/schema";
import { authErrorResponse, requireMember } from "../../../../../../lib/authorization";
import { badRequest, notFound, serverError } from "../../../shared";
import { cycleColumns, validateCyclePatch } from "../../../cycle-shared";

// Cycle records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

const DUPLICATE = "A cycle record with this periodStart already exists.";

/**
 * Member self-service correction/removal. Identity is the session's Member
 * only; every statement is scoped by BOTH the route id and that Member's id,
 * so a foreign id is indistinguishable from a missing one (404). Independent
 * of Coach assignment, and not subject to any retention policy.
 */
async function resolve(
  request: Request,
  params: Promise<{ id: string }>,
  context: string
): Promise<{ memberId: number; id: number } | Response> {
  let memberId: number;
  try {
    ({ member: { id: memberId } } = await requireMember(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError(context, error, "Unable to process the request.");
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("Cycle id must be a positive whole number.");
  return { memberId, id };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = "PATCH /api/members/me/cycles/[id] failed";
  const resolved = await resolve(request, params, ctx);
  if (resolved instanceof Response) return resolved;
  const { memberId, id } = resolved;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const owned = and(eq(memberCycles.id, id), eq(memberCycles.memberId, memberId));
  const db = getDb();
  try {
    const [existing] = await db
      .select({
        periodStart: memberCycles.periodStart, periodEnd: memberCycles.periodEnd,
        pmsStart: memberCycles.pmsStart, pmsEnd: memberCycles.pmsEnd,
      })
      .from(memberCycles)
      .where(owned)
      .limit(1);
    if (!existing) return notFound("Cycle record not found.");

    const validated = validateCyclePatch(body, existing);
    if ("error" in validated) return badRequest(validated.error);

    try {
      const [row] = await db
        .update(memberCycles)
        .set({ ...validated.value, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(owned)
        .returning(cycleColumns);
      if (!row) return notFound("Cycle record not found.");
      return Response.json({ cycle: row });
    } catch (error) {
      // A rejected UPDATE changed nothing. If another of this Member's records
      // already holds the target periodStart it is the unique constraint (409);
      // otherwise it is a genuine failure.
      const [clash] = await db
        .select({ id: memberCycles.id })
        .from(memberCycles)
        .where(and(
          eq(memberCycles.memberId, memberId),
          eq(memberCycles.periodStart, validated.value.periodStart),
          ne(memberCycles.id, id)
        ))
        .limit(1);
      if (clash) return Response.json({ error: DUPLICATE }, { status: 409 });
      throw error;
    }
  } catch (error) {
    return serverError(ctx, error, "Unable to update the cycle record.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = "DELETE /api/members/me/cycles/[id] failed";
  const resolved = await resolve(request, params, ctx);
  if (resolved instanceof Response) return resolved;
  const { memberId, id } = resolved;

  try {
    const [row] = await getDb()
      .delete(memberCycles)
      .where(and(eq(memberCycles.id, id), eq(memberCycles.memberId, memberId)))
      .returning({ id: memberCycles.id });
    if (!row) return notFound("Cycle record not found.");
    return new Response(null, { status: 204 });
  } catch (error) {
    return serverError(ctx, error, "Unable to delete the cycle record.");
  }
}
