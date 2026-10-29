import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { coaches } from "../../../../db/schema";
import { authErrorResponse, requireCoach } from "../../../../lib/authorization";
import { serverError } from "../../members/shared";

// Profile state is persisted, so never serve it from a cached render.
export const dynamic = "force-dynamic";

/** The signed-in Coach's own display profile. Name is read-only (Super Admin owns it). */
export async function GET(request: Request) {
  const ctx = "GET /api/coaches/me failed";
  let coachId: number;
  try {
    ({ coach: { id: coachId } } = await requireCoach(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError(ctx, error, "Unable to load your profile.");
  }

  try {
    const [row] = await getDb()
      .select({ id: coaches.id, name: coaches.name, photoUrl: coaches.photoUrl })
      .from(coaches)
      .where(eq(coaches.id, coachId))
      .limit(1);
    if (!row) return serverError(ctx, "no row for resolved coach id", "Unable to load your profile.");
    return Response.json({ coach: row });
  } catch (error) {
    return serverError(ctx, error, "Unable to load your profile.");
  }
}
