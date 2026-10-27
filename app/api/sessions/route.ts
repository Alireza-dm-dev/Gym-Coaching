import { and, asc, desc, eq, gte, lt, ne, type SQL } from "drizzle-orm";
import { getDb } from "../../../db";
import { members, sessionNotes, sessions } from "../../../db/schema";
import { localDateTimeToUtcIso } from "../../../lib/date-time";
import { badRequest, notFound, serverError } from "../members/shared";
import { currentCoachSessionScope, resolveSessionActor } from "./shared";

// Session records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

type SessionInput = { memberId: number; dateKey: string };
const SESSION_FIELDS = ["memberId", "dateKey"] as const;

/** Rejects impossible dates such as 2026-02-31, which `Date.UTC` would roll over. */
function isValidDateKey(dateKey: string): boolean {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * The next Gregorian calendar date, as a `YYYY-MM-DD` key. `dateKey` must
 * already be a valid calendar date (see `isValidDateKey`).
 *
 * Advances via `Date.UTC`, which normalizes month/year overflow on its own,
 * so no fixed millisecond offset is added to an instant.
 */
function nextDateKey(dateKey: string): string {
  const [, yearText, monthText, dayText] = DATE_KEY_PATTERN.exec(dateKey)!;
  const next = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + 1));
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/** Only `memberId` and `dateKey` are accepted; everything else is server-decided. */
function validateNewSession(body: unknown): { error: string } | { value: SessionInput } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  const allowed = new Set<string>(SESSION_FIELDS);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { error: `Unsupported field(s): ${unknown.join(", ")}.` };
  }

  for (const field of SESSION_FIELDS) {
    if (input[field] === undefined) return { error: `${field} is required.` };
  }

  const { memberId, dateKey } = input;
  if (typeof memberId !== "number" || !Number.isInteger(memberId) || memberId <= 0) {
    return { error: "memberId must be a positive whole number." };
  }
  if (typeof dateKey !== "string" || !isValidDateKey(dateKey)) {
    return { error: "dateKey must be a real Gregorian date in YYYY-MM-DD format." };
  }

  return { value: { memberId, dateKey } };
}

const sessionColumns = {
  id: sessions.id,
  memberId: sessions.memberId,
  coachId: sessions.coachId,
  scheduledAt: sessions.scheduledAt,
  status: sessions.status,
  durationMinutes: sessions.durationMinutes,
  replacementForId: sessions.replacementForId,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
};

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

  const validated = validateNewSession(body);
  if ("error" in validated) return badRequest(validated.error);
  const { memberId, dateKey } = validated.value;

  try {
    const db = getDb();

    // Source of truth for time/duration is the persisted member, never the request.
    const [member] = await db
      .select({
        id: members.id,
        coachId: members.coachId,
        defaultStartTime: members.defaultStartTime,
        defaultDurationMinutes: members.defaultDurationMinutes,
      })
      .from(members)
      // Coach: ownership is in the WHERE, so a foreign Member is just "not found".
      // Super Admin: any Member; the Session is owned by that Member's Coach.
      .where(
        actor.kind === "coach"
          ? and(eq(members.id, memberId), eq(members.coachId, actor.coachId))
          : eq(members.id, memberId)
      )
      .limit(1);

    if (!member) return notFound("Member not found.");

    const scheduledAt = localDateTimeToUtcIso(dateKey, member.defaultStartTime);
    const dayStart = localDateTimeToUtcIso(dateKey, "00:00");
    const dayEnd = localDateTimeToUtcIso(nextDateKey(dateKey), "00:00");

    // One completed/scheduled submission per member per Tehran calendar day.
    const [duplicate] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          // Member-wide: a Session another Coach created earlier still counts.
          eq(sessions.memberId, member.id),
          gte(sessions.scheduledAt, dayStart),
          lt(sessions.scheduledAt, dayEnd),
          ne(sessions.status, "cancelled")
        )
      )
      .limit(1);

    if (duplicate) {
      return Response.json(
        { error: "A session already exists for this member on this date." },
        { status: 409 }
      );
    }

    const [row] = await db
      .insert(sessions)
      .values({
        memberId: member.id,
        coachId: member.coachId,
        scheduledAt,
        status: "completed",
        durationMinutes: member.defaultDurationMinutes,
        replacementForId: null,
      })
      .returning(sessionColumns);

    return Response.json({ session: row }, { status: 201 });
  } catch (error) {
    return serverError("POST /api/sessions failed", error, "Unable to create the session.");
  }
}

const GET_QUERY_PARAMS = new Set(["from", "to", "memberId", "limit"]);
const MAX_HISTORY_LIMIT = 50;

/** Shared by both query modes so the future UI only ever sees one Session shape. */
const noteColumns = {
  id: sessionNotes.id,
  note: sessionNotes.note,
  createdAt: sessionNotes.createdAt,
  updatedAt: sessionNotes.updatedAt,
};

export async function GET(request: Request) {
  const actor = await resolveSessionActor(request);
  if (actor instanceof Response) return actor;

  const url = new URL(request.url);

  const unsupported = [...url.searchParams.keys()].filter((key) => !GET_QUERY_PARAMS.has(key));
  if (unsupported.length > 0) {
    return badRequest(`Unsupported query parameter(s): ${unsupported.join(", ")}.`);
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const memberIdParam = url.searchParams.get("memberId");
  const limitParam = url.searchParams.get("limit");

  // Which mode a request is in is decided purely from which parameters are
  // present, before any of their values are validated, so an ambiguous mix
  // (e.g. `from` alongside `limit`) is rejected outright rather than
  // reinterpreted as one mode or the other.
  const hasRangeParam = from !== null || to !== null;
  const hasLimitParam = limitParam !== null;

  if (hasRangeParam && hasLimitParam) {
    return badRequest(
      "Use from/to for range mode or memberId/limit for history mode, not both."
    );
  }
  if (!hasRangeParam && !hasLimitParam) {
    return badRequest(
      "Provide from and to for range mode, or memberId and limit for history mode."
    );
  }

  let memberId: number | undefined;
  if (memberIdParam !== null) {
    const parsed = Number(memberIdParam);
    if (!/^\d+$/.test(memberIdParam) || !Number.isInteger(parsed) || parsed <= 0) {
      return badRequest("memberId must be a positive whole number.");
    }
    memberId = parsed;
  }

  // Member: identity is the authenticated profile. A supplied memberId may
  // only echo it back; any other value is rejected rather than reinterpreted.
  if (actor.kind === "member" && memberId !== undefined && memberId !== actor.memberId) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  if (actor.kind === "member") memberId = actor.memberId;

  // Applied to every query at the SQL level. Coach scope is the Member's
  // CURRENT assignment; sessions.coachId is historical attribution only.
  const scope: SQL | undefined =
    actor.kind === "coach"
      ? currentCoachSessionScope(actor.coachId)
      : actor.kind === "member"
        ? eq(sessions.memberId, actor.memberId)
        : undefined;

  if (hasLimitParam) {
    // MODE B — member history: the most recent Sessions for one Member, with
    // no fabricated date range.
    if (memberIdParam === null) return badRequest("memberId is required for history mode.");

    const parsedLimit = Number(limitParam);
    if (
      !/^\d+$/.test(limitParam!) ||
      !Number.isInteger(parsedLimit) ||
      parsedLimit <= 0 ||
      parsedLimit > MAX_HISTORY_LIMIT
    ) {
      return badRequest(`limit must be a whole number from 1 to ${MAX_HISTORY_LIMIT}.`);
    }

    try {
      const db = getDb();

      // Same one joined query as range mode, just newest-first and bounded.
      const rows = await db
        .select({ ...sessionColumns, note: noteColumns })
        .from(sessions)
        .leftJoin(sessionNotes, eq(sessionNotes.sessionId, sessions.id))
        .where(and(scope, eq(sessions.memberId, memberId!)))
        .orderBy(desc(sessions.scheduledAt), desc(sessions.id))
        .limit(parsedLimit);

      return Response.json({ sessions: rows }, { status: 200 });
    } catch (error) {
      return serverError(
        "GET /api/sessions (history mode) failed",
        error,
        "Unable to read sessions."
      );
    }
  }

  // MODE A — range mode (unchanged behaviour).
  if (from === null) return badRequest("from is required.");
  if (to === null) return badRequest("to is required.");
  if (!isValidDateKey(from)) {
    return badRequest("from must be a real Gregorian date in YYYY-MM-DD format.");
  }
  if (!isValidDateKey(to)) {
    return badRequest("to must be a real Gregorian date in YYYY-MM-DD format.");
  }
  // YYYY-MM-DD keys compare correctly as plain strings.
  if (to < from) return badRequest("to cannot be before from.");

  try {
    const db = getDb();

    // Tehran-local calendar-day range, not a UTC calendar-day range: the same
    // conversion the write paths already use for their own date bounds.
    const rangeStart = localDateTimeToUtcIso(from, "00:00");
    const rangeEnd = localDateTimeToUtcIso(nextDateKey(to), "00:00");

    const conditions: (SQL | undefined)[] = [
      scope,
      gte(sessions.scheduledAt, rangeStart),
      lt(sessions.scheduledAt, rangeEnd),
    ];
    if (memberId !== undefined) conditions.push(eq(sessions.memberId, memberId));

    // One joined query, not one Note lookup per Session: the LEFT JOIN keeps
    // every Session row (with or without a Note) and, because session_notes
    // has a UNIQUE(session_id) constraint, can add at most one Note row per
    // Session, so it can't duplicate or drop any Session row.
    const rows = await db
      .select({ ...sessionColumns, note: noteColumns })
      .from(sessions)
      .leftJoin(sessionNotes, eq(sessionNotes.sessionId, sessions.id))
      .where(and(...conditions))
      .orderBy(asc(sessions.scheduledAt), asc(sessions.id));

    return Response.json({ sessions: rows }, { status: 200 });
  } catch (error) {
    return serverError("GET /api/sessions failed", error, "Unable to read sessions.");
  }
}
