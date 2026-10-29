import { authErrorResponse, requireCoach } from "../../../lib/authorization";
import { badRequest, serverError } from "../members/shared";
import { listMealsForCoach, parseMealRange } from "../members/nutrition-shared";

// Meal logs are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

/**
 * Coach read-only aggregate: meals in an inclusive Tehran date range for every
 * Member CURRENTLY assigned to the calling Coach, in one query. Super Admin and
 * Members are refused (no "see all" bypass). There is no write endpoint.
 */
export async function GET(request: Request) {
  const ctx = "GET /api/nutrition failed";
  let coachId: number;
  try {
    ({ coach: { id: coachId } } = await requireCoach(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError(ctx, error, "Unable to load nutrition.");
  }

  const range = parseMealRange(request.url);
  if ("error" in range) return badRequest(range.error);

  try {
    return Response.json({ meals: await listMealsForCoach(coachId, range.value.startIso, range.value.endIso) });
  } catch (error) {
    return serverError(ctx, error, "Unable to load nutrition.");
  }
}
