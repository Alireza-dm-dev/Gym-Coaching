import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { members } from "../../../../../db/schema";
import { authErrorResponse, requireCoach, requireUser } from "../../../../../lib/authorization";
import { badRequest, notFound, serverError } from "../../shared";
import { listCyclesForMember } from "../../cycle-shared";

export const dynamic = "force-dynamic";

/**
 * Coach read-only view of a CURRENTLY assigned Member's cycle history.
 * Super Admin and Members are refused outright (no "see all" bypass); a
 * Member must use /api/members/me/cycles. Visibility is derived from the live
 * `members.coachId`, so it moves with reassignment.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let coachId: number;
  try {
    const user = await requireUser(request);
    if (user.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403 });
    ({ coach: { id: coachId } } = await requireCoach(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError("GET /api/members/[id]/cycles failed", error, "Unable to load cycle records.");
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return badRequest("Member id must be a positive whole number.");
  }

  try {
    const [member] = await getDb()
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, id), eq(members.coachId, coachId)))
      .limit(1);
    if (!member) return notFound("Member not found.");

    return Response.json({ cycles: await listCyclesForMember(member.id) });
  } catch (error) {
    return serverError("GET /api/members/[id]/cycles failed", error, "Unable to load cycle records.");
  }
}
