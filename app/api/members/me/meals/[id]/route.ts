import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { memberMeals } from "../../../../../../db/schema";
import { authErrorResponse, requireMember } from "../../../../../../lib/authorization";
import { badRequest, notFound, serverError } from "../../../shared";
import { mealColumns, validateMealBody } from "../../../nutrition-shared";

// Meal logs are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

/**
 * Member self-service correction/removal. Identity is the session's Member
 * only; every statement is scoped by BOTH the route id and that Member's id,
 * so a foreign id is indistinguishable from a missing one (404). Independent
 * of Coach assignment and of any retention policy.
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
  const rawId = (await params).id;
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isInteger(id) || id <= 0) {
    return badRequest("Meal id must be a positive whole number.");
  }
  return { memberId, id };
}

/** Complete replacement of the editable state (same body and rules as POST). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = "PATCH /api/members/me/meals/[id] failed";
  const resolved = await resolve(request, params, ctx);
  if (resolved instanceof Response) return resolved;
  const { memberId, id } = resolved;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  const validated = validateMealBody(body);
  if ("error" in validated) return badRequest(validated.error);

  try {
    const [row] = await getDb()
      .update(memberMeals)
      .set({ ...validated.value, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(memberMeals.id, id), eq(memberMeals.memberId, memberId)))
      .returning(mealColumns);
    if (!row) return notFound("Meal not found.");
    return Response.json({ meal: row });
  } catch (error) {
    return serverError(ctx, error, "Unable to update the meal.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = "DELETE /api/members/me/meals/[id] failed";
  const resolved = await resolve(request, params, ctx);
  if (resolved instanceof Response) return resolved;
  const { memberId, id } = resolved;

  try {
    const [row] = await getDb()
      .delete(memberMeals)
      .where(and(eq(memberMeals.id, id), eq(memberMeals.memberId, memberId)))
      .returning({ id: memberMeals.id });
    if (!row) return notFound("Meal not found.");
    return new Response(null, { status: 204 });
  } catch (error) {
    return serverError(ctx, error, "Unable to delete the meal.");
  }
}
