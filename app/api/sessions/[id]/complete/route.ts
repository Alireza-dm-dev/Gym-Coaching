import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { sessions } from "../../../../../db/schema";
import { getAppDateKey, localDateTimeToUtcIso } from "../../../../../lib/date-time";
import { badRequest, notFound, serverError } from "../../../members/shared";
import { currentCoachSessionScope, nextDateKey, resolveSessionActor, sessionColumns } from "../../shared";

// Session records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

function conflict(message: string) {
  return Response.json({ error: message }, { status: 409 });
}

/**
 * Marks an existing `replacement` session `completed`, in place — no new row
 * is created and `replacementForId` is left untouched, since that link is
 * the historical record that this completion started life as a replacement.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await resolveSessionActor(request);
  if (actor instanceof Response) return actor;
  if (actor.kind === "member") {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isInteger(id) || id <= 0) {
    return badRequest("Session id must be a positive whole number.");
  }

  // Coach authorization is the Member's CURRENT assignment, evaluated inside
  // the statements below; sessions.coachId (historical attribution) is never
  // consulted and never rewritten, so a carried-over replacement stays
  // attributed to its original Coach. Super Admin is unrestricted.
  const owner = actor.kind === "coach" ? currentCoachSessionScope(actor.coachId) : undefined;

  try {
    const db = getDb();
    // First instant of Tehran tomorrow: a replacement scheduled at or after it is
    // still in the future and cannot be completed yet.
    const tomorrowStart = localDateTimeToUtcIso(nextDateKey(getAppDateKey()), "00:00");

    // The write itself is the concurrency guard: only a row that is still
    // `replacement` (with an intact replacementForId) for this coach is
    // matched, so two concurrent completions of the same row can't both
    // succeed — a plain read-then-write would race here.
    const [row] = await db
      .update(sessions)
      .set({ status: "completed", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(sessions.id, id),
          owner,
          eq(sessions.status, "replacement"),
          isNotNull(sessions.replacementForId),
          lt(sessions.scheduledAt, tomorrowStart)
        )
      )
      .returning(sessionColumns);

    if (row) return Response.json({ session: row }, { status: 200 });

    // The guarded update matched nothing. Look the row up (without the
    // status condition) only to pick the right error, never to loosen the
    // write's own guard.
    const [existing] = await db
      .select({ id: sessions.id, status: sessions.status, scheduledAt: sessions.scheduledAt })
      .from(sessions)
      .where(and(eq(sessions.id, id), owner))
      .limit(1);

    if (!existing) return notFound("Session not found.");
    if (existing.status === "replacement" && existing.scheduledAt >= tomorrowStart) {
      return conflict("A future replacement session cannot be completed yet.");
    }
    return conflict("Only a replacement session can be completed through this endpoint.");
  } catch (error) {
    return serverError(
      "PATCH /api/sessions/[id]/complete failed",
      error,
      "Unable to complete the session."
    );
  }
}
