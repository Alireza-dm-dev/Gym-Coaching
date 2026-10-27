import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { members, sessions } from "../../../../db/schema";
import { localDateTimeToUtcIso } from "../../../../lib/date-time";
import { badRequest, notFound, serverError } from "../../members/shared";
import { isValidDateKey, nextDateKey, resolveSessionActor, sessionColumns, TIME_PATTERN } from "../shared";

// Session records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

type AbsenceInput = {
  memberId: number;
  dateKey: string;
  replacementDateKey: string;
  replacementTime: string;
};
const ABSENCE_FIELDS = ["memberId", "dateKey", "replacementDateKey", "replacementTime"] as const;

function conflict(message: string) {
  return Response.json({ error: message }, { status: 409 });
}

/** Only these four fields are accepted; everything else is server-decided. */
function validateAbsenceInput(body: unknown): { error: string } | { value: AbsenceInput } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  const allowed = new Set<string>(ABSENCE_FIELDS);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { error: `Unsupported field(s): ${unknown.join(", ")}.` };
  }

  for (const field of ABSENCE_FIELDS) {
    if (input[field] === undefined) return { error: `${field} is required.` };
  }

  const { memberId, dateKey, replacementDateKey, replacementTime } = input;
  if (typeof memberId !== "number" || !Number.isInteger(memberId) || memberId <= 0) {
    return { error: "memberId must be a positive whole number." };
  }
  if (typeof dateKey !== "string" || !isValidDateKey(dateKey)) {
    return { error: "dateKey must be a real Gregorian date in YYYY-MM-DD format." };
  }
  if (typeof replacementDateKey !== "string" || !isValidDateKey(replacementDateKey)) {
    return { error: "replacementDateKey must be a real Gregorian date in YYYY-MM-DD format." };
  }
  if (typeof replacementTime !== "string" || !TIME_PATTERN.test(replacementTime)) {
    return { error: "replacementTime must be a 24-hour HH:MM value." };
  }
  // YYYY-MM-DD keys compare correctly as plain strings.
  if (replacementDateKey < dateKey) {
    return { error: "replacementDateKey cannot be before dateKey." };
  }

  return { value: { memberId, dateKey, replacementDateKey, replacementTime } };
}

export async function POST(request: Request) {
  const actor = await resolveSessionActor(request);
  if (actor instanceof Response) return actor;
  if (actor.kind === "member") {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const validated = validateAbsenceInput(body);
  if ("error" in validated) return badRequest(validated.error);
  const { memberId, dateKey, replacementDateKey, replacementTime } = validated.value;

  try {
    const db = getDb();

    // Source of truth for the original time/duration is the persisted
    // member, never the request.
    const [member] = await db
      .select({
        id: members.id,
        coachId: members.coachId,
        defaultStartTime: members.defaultStartTime,
        defaultDurationMinutes: members.defaultDurationMinutes,
      })
      .from(members)
      // Coach: ownership is in the WHERE, so a foreign Member is just "not found".
      // Super Admin: any Member; new rows belong to that Member's current Coach.
      .where(
        actor.kind === "coach"
          ? and(eq(members.id, memberId), eq(members.coachId, actor.coachId))
          : eq(members.id, memberId)
      )
      .limit(1);

    if (!member) return notFound("Member not found.");

    const originalScheduledAt = localDateTimeToUtcIso(dateKey, member.defaultStartTime);
    const replacementScheduledAt = localDateTimeToUtcIso(replacementDateKey, replacementTime);

    const originalDayStart = localDateTimeToUtcIso(dateKey, "00:00");
    const originalDayEnd = localDateTimeToUtcIso(nextDateKey(dateKey), "00:00");

    // One non-cancelled submission per member per Tehran calendar day, same
    // rule the completed-session route already enforces for its own date.
    const [originalConflict] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          // Member-wide: Sessions created by a previous Coach still conflict.
          eq(sessions.memberId, member.id),
          gte(sessions.scheduledAt, originalDayStart),
          lt(sessions.scheduledAt, originalDayEnd),
          ne(sessions.status, "cancelled")
        )
      )
      .limit(1);

    if (originalConflict) {
      return conflict("A session already exists for this member on the original date.");
    }

    const [replacementConflict] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.memberId, member.id),
          eq(sessions.scheduledAt, replacementScheduledAt),
          ne(sessions.status, "cancelled")
        )
      )
      .limit(1);

    if (replacementConflict) {
      return conflict("A session already exists for this member at the replacement time.");
    }

    // The absent row and its replacement are one logical write. D1's `batch`
    // is the smallest mechanism this driver exposes for a multi-statement
    // atomic write: both inserts run inside one implicit transaction, so a
    // failure on either statement rolls back the whole pair (see report).
    // The replacement's `replacementForId` is resolved with a same-transaction
    // subquery rather than a value read back from the first insert, since a
    // batch's statements are all built before any of them execute.
    const absentIdForReplacement = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.memberId, member.id),
          eq(sessions.status, "absent"),
          eq(sessions.scheduledAt, originalScheduledAt)
        )
      )
      .orderBy(desc(sessions.id))
      .limit(1);

    const [[absentSession], [replacementSession]] = await db.batch([
      db
        .insert(sessions)
        .values({
          memberId: member.id,
          coachId: member.coachId,
          scheduledAt: originalScheduledAt,
          status: "absent",
          durationMinutes: member.defaultDurationMinutes,
          replacementForId: null,
        })
        .returning(sessionColumns),
      db
        .insert(sessions)
        .values({
          memberId: member.id,
          coachId: member.coachId,
          scheduledAt: replacementScheduledAt,
          status: "replacement",
          durationMinutes: member.defaultDurationMinutes,
          replacementForId: sql`(${absentIdForReplacement})`,
        })
        .returning(sessionColumns),
    ]);

    return Response.json({ absentSession, replacementSession }, { status: 201 });
  } catch (error) {
    return serverError(
      "POST /api/sessions/absence failed",
      error,
      "Unable to record the absence and replacement."
    );
  }
}
