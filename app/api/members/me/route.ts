import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { members } from "../../../../db/schema";
import { authErrorResponse, requireMember } from "../../../../lib/authorization";
import { memberColumns, serverError, toApiMember } from "../shared";

// Member records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let memberId: number;
  try {
    ({ member: { id: memberId } } = await requireMember(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError("GET /api/members/me failed", error, "Unable to load your profile.");
  }

  try {
    const db = getDb();
    const [row] = await db
      .select(memberColumns)
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);

    if (!row) return serverError("GET /api/members/me failed", "no row for resolved member id", "Unable to load your profile.");

    return Response.json({ member: toApiMember(row) });
  } catch (error) {
    return serverError("GET /api/members/me failed", error, "Unable to load your profile.");
  }
}
