import { getDb } from "../../../../../db";
import { memberMeals } from "../../../../../db/schema";
import { authErrorResponse, requireMember } from "../../../../../lib/authorization";
import { badRequest, serverError } from "../../shared";
import { listMealsForMember, mealColumns, parseMealRange, validateMealBody } from "../../nutrition-shared";

// Meal logs are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

async function resolveMemberId(request: Request, context: string): Promise<number | Response> {
  try {
    const { member } = await requireMember(request);
    return member.id;
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError(context, error, "Unable to process the request.");
  }
}

/** The caller's own meals in an inclusive Tehran date range, newest first. */
export async function GET(request: Request) {
  const ctx = "GET /api/members/me/meals failed";
  const memberId = await resolveMemberId(request, ctx);
  if (memberId instanceof Response) return memberId;

  const range = parseMealRange(request.url);
  if ("error" in range) return badRequest(range.error);

  try {
    return Response.json({ meals: await listMealsForMember(memberId, range.value.startIso, range.value.endIso) });
  } catch (error) {
    return serverError(ctx, error, "Unable to load your meals.");
  }
}

export async function POST(request: Request) {
  const ctx = "POST /api/members/me/meals failed";
  const memberId = await resolveMemberId(request, ctx);
  if (memberId instanceof Response) return memberId;

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
      .insert(memberMeals)
      .values({ memberId, ...validated.value })
      .returning(mealColumns);
    return Response.json({ meal: row }, { status: 201 });
  } catch (error) {
    return serverError(ctx, error, "Unable to save the meal.");
  }
}
