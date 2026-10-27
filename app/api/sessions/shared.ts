import { and, eq, inArray, type SQL } from "drizzle-orm";
import { getDb } from "../../../db";
import { members, sessions } from "../../../db/schema";
import {
  authErrorResponse, requireCoach, requireMember, requireUser,
} from "../../../lib/authorization";
import { serverError } from "../members/shared";

// Kept in one place so `POST /api/sessions/absence` does not hand-duplicate
// the date/session helpers already proven in `POST /api/sessions`. The
// completed-session route itself is left untouched (out of scope for A3A),
// so it keeps its own copies of the same logic.

export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Rejects impossible dates such as 2026-02-31, which `Date.UTC` would roll over. */
export function isValidDateKey(dateKey: string): boolean {
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
 */
export function nextDateKey(dateKey: string): string {
  const [, yearText, monthText, dayText] = DATE_KEY_PATTERN.exec(dateKey)!;
  const next = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + 1));
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/** Shared projection: every session-writing route returns the identical shape. */
export const sessionColumns = {
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

export type SessionActor =
  | { kind: "super_admin" }
  | { kind: "coach"; coachId: number }
  | { kind: "member"; memberId: number };

/** Resolves the caller from the session cookie; returns the actor or a 401/403/500 Response. */
export async function resolveSessionActor(request: Request): Promise<SessionActor | Response> {
  try {
    const user = await requireUser(request);
    if (user.role === "super_admin") return { kind: "super_admin" };
    if (user.role === "coach") {
      const { coach } = await requireCoach(request);
      return { kind: "coach", coachId: coach.id };
    }
    const { member } = await requireMember(request);
    return { kind: "member", memberId: member.id };
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError("Session actor resolution failed", error, "Unable to process the request.");
  }
}

/**
 * Caller for Session child resources (note, muscles). Authentication runs
 * first; a Member is read-only, so a write is denied (403) before any lookup.
 */
export async function resolveChildActor(
  request: Request,
  write: boolean
): Promise<SessionActor | Response> {
  const actor = await resolveSessionActor(request);
  if (actor instanceof Response) return actor;
  if (write && actor.kind === "member") {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  return actor;
}

/**
 * Coach visibility follows the Member's CURRENT assignment (`members.coachId`),
 * not the Session's historical `sessions.coachId`, which stays attribution
 * only. Expressed as `member_id IN (this Coach's Members)` so SQLite can drive
 * from `members(coach_id)` into `sessions(member_id, scheduled_at)`.
 */
export function currentCoachSessionScope(coachId: number): SQL {
  return inArray(
    sessions.memberId,
    getDb().select({ id: members.id }).from(members).where(eq(members.coachId, coachId))
  );
}

/**
 * Looks up the Session with the role's visibility condition in the WHERE, so a
 * Session the caller can't see is indistinguishable from a missing one (null
 * -> 404). Coach visibility is current assignment (see above); a former Coach
 * sees nothing. Returns the attribution fields `canWriteSessionDetail` needs.
 */
export async function findAccessibleSession(actor: SessionActor, id: number) {
  const visibility: SQL | undefined =
    actor.kind === "coach"
      ? currentCoachSessionScope(actor.coachId)
      : actor.kind === "member"
        ? eq(sessions.memberId, actor.memberId)
        : undefined;
  const [session] = await getDb()
    .select({
      id: sessions.id,
      status: sessions.status,
      scheduledAt: sessions.scheduledAt,
      coachId: sessions.coachId,
      replacementForId: sessions.replacementForId,
    })
    .from(sessions)
    .where(and(eq(sessions.id, id), visibility))
    .limit(1);
  return session ?? null;
}

/**
 * Read continuity is not write ownership. A Coach who can SEE a Session may
 * write its Note/Muscles only if they are its historical Coach, or it is a
 * former replacement (`replacementForId` set), the one kind of Session that
 * can legitimately be completed by a Coach other than its recorded owner.
 * Lifecycle (completed-only) and retention are still enforced by the routes
 * afterwards. Super Admin is unrestricted; Members never write.
 */
export function canWriteSessionDetail(
  actor: SessionActor,
  session: { coachId: number; replacementForId: number | null }
): boolean {
  if (actor.kind === "super_admin") return true;
  if (actor.kind === "coach") {
    return session.coachId === actor.coachId || session.replacementForId !== null;
  }
  return false;
}
