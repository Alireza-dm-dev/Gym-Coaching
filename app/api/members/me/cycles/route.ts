import { getDb } from "../../../../../db";
import { memberCycles } from "../../../../../db/schema";
import { authErrorResponse, requireMember } from "../../../../../lib/authorization";
import { badRequest, serverError } from "../../shared";
import { cycleColumns, listCyclesForMember, validateCycleBody } from "../../cycle-shared";

// Cycle records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let memberId: number;
  try {
    ({ member: { id: memberId } } = await requireMember(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError("GET /api/members/me/cycles failed", error, "Unable to load your cycle records.");
  }

  try {
    return Response.json({ cycles: await listCyclesForMember(memberId) });
  } catch (error) {
    return serverError("GET /api/members/me/cycles failed", error, "Unable to load your cycle records.");
  }
}

export async function POST(request: Request) {
  let memberId: number;
  try {
    ({ member: { id: memberId } } = await requireMember(request));
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError("POST /api/members/me/cycles failed", error, "Unable to save the cycle record.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const validated = validateCycleBody(body);
  if ("error" in validated) return badRequest(validated.error);

  try {
    // Identity comes only from the session; one record per Member per periodStart.
    const [row] = await getDb()
      .insert(memberCycles)
      .values({ memberId, ...validated.value })
      .onConflictDoNothing()
      .returning(cycleColumns);

    if (!row) {
      return Response.json(
        { error: "A cycle record with this periodStart already exists." },
        { status: 409 }
      );
    }
    return Response.json({ cycle: row }, { status: 201 });
  } catch (error) {
    return serverError("POST /api/members/me/cycles failed", error, "Unable to save the cycle record.");
  }
}
