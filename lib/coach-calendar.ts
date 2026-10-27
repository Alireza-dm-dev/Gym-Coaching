/**
 * Pure Coach Calendar read model: merges the EXPECTED schedule (derived from a
 * Member's profile) with ACTUAL attendance (persisted Sessions). No React, no
 * network. Business dates are always Tehran `YYYY-MM-DD` keys, never browser
 * local dates, and no backend status is invented for display.
 */
// The explicit `.ts` lets plain Node load this module for its pure-helper test.
// @ts-expect-error TS5097
import { getAppDateKey, getJalaliDateParts, localDateTimeToUtcIso, weekdayCodeForDate } from "./date-time.ts";

export type CalendarMember = {
  id: number;
  name: string;
  goal: string;
  defaultStartTime: string;
  defaultDurationMinutes: number;
  preferredDays: string[];
  /** `members.created_at` as returned by the roster (UTC, `YYYY-MM-DD HH:MM:SS`). */
  createdAt: string;
};

export type CalendarSession = {
  id: number;
  memberId: number;
  scheduledAt: string;
  status: string;
  durationMinutes: number | null;
  replacementForId: number | null;
};

export type DisplayState =
  | "expected" | "completed" | "absent" | "replacement-pending" | "replacement-completed" | "not-recorded";

export const DISPLAY_LABELS: Record<DisplayState, string> = {
  expected: "Expected", completed: "Completed", absent: "Absent",
  "replacement-pending": "Replacement pending", "replacement-completed": "Replacement completed",
  "not-recorded": "Not recorded",
};

export type AttendanceRow = {
  /** Stable React key. */
  key: string;
  memberId: number;
  state: DisplayState;
  /** Wall-clock `HH:MM` in the app timezone. */
  time: string;
  durationMinutes: number | null;
  /** The persisted row behind this display row; null for a purely derived row. */
  sessionId: number | null;
  /** Related row resolved from loaded data only: the original absence, or the replacement. */
  link: null | { kind: "replacement-for" | "replaced-on"; dateKey: string };
};

/** Display priority for one compact day indicator (highest first). */
const PRIORITY: DisplayState[] = [
  "completed", "replacement-completed", "replacement-pending", "absent", "not-recorded", "expected",
];

const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/** Tehran business date a Member was created on; "always existed" if unparseable. */
export function memberStartDateKey(createdAt: string): string {
  const match = SQLITE_UTC.exec(createdAt);
  const instant = new Date(match ? `${match[1]}T${match[2]}Z` : createdAt);
  return Number.isNaN(instant.getTime()) ? "0000-01-01" : getAppDateKey(instant);
}

const noon = (dateKey: string) => new Date(localDateTimeToUtcIso(dateKey, "12:00"));

/** `HH:MM` of an instant in the app timezone, via the same conversion as every other helper. */
function wallTime(scheduledAt: string): string {
  const instant = new Date(scheduledAt);
  const key = getAppDateKey(instant);
  const probe = new Date(localDateTimeToUtcIso(key, "00:00"));
  const minutes = Math.round((instant.getTime() - probe.getTime()) / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `5 Mehr`-style label for a Gregorian date key. */
export function shortJalaliLabel(dateKey: string): string {
  const parts = getJalaliDateParts(noon(dateKey));
  return `${parts.day} ${parts.monthName}`;
}

export type SessionIndex = {
  byMemberDate: Map<string, CalendarSession[]>;
  byId: Map<number, CalendarSession>;
  replacementOf: Map<number, CalendarSession>;
};

/** Groups rows by `memberId|Tehran dateKey`; `cancelled` rows never take part. */
export function indexSessions(sessions: CalendarSession[]): SessionIndex {
  const byMemberDate = new Map<string, CalendarSession[]>();
  const byId = new Map<number, CalendarSession>();
  const replacementOf = new Map<number, CalendarSession>();
  for (const session of sessions) {
    if (session.status === "cancelled") continue;
    byId.set(session.id, session);
    if (session.replacementForId !== null) replacementOf.set(session.replacementForId, session);
    const key = `${session.memberId}|${getAppDateKey(new Date(session.scheduledAt))}`;
    const list = byMemberDate.get(key);
    if (list) list.push(session);
    else byMemberDate.set(key, [session]);
  }
  for (const list of byMemberDate.values()) list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id - b.id);
  return { byMemberDate, byId, replacementOf };
}

function stateFor(session: CalendarSession): DisplayState {
  if (session.status === "completed") return session.replacementForId === null ? "completed" : "replacement-completed";
  if (session.status === "absent") return "absent";
  if (session.status === "replacement") return "replacement-pending";
  return "expected"; // a persisted `scheduled` row is still just an expectation
}

/** Rows for one date from a prebuilt index (shared by day and month derivations). */
export function rowsForDate(
  members: CalendarMember[], index: SessionIndex, dateKey: string, todayKey: string,
): AttendanceRow[] {
  const weekday = weekdayCodeForDate(noon(dateKey));
  const rows: AttendanceRow[] = [];
  for (const member of members) {
    const actual = index.byMemberDate.get(`${member.id}|${dateKey}`) ?? [];
    if (actual.length > 0) {
      for (const session of actual) {
        let link: AttendanceRow["link"] = null;
        if (session.replacementForId !== null) {
          const original = index.byId.get(session.replacementForId);
          if (original) link = { kind: "replacement-for", dateKey: getAppDateKey(new Date(original.scheduledAt)) };
        } else if (session.status === "absent") {
          const replacement = index.replacementOf.get(session.id);
          if (replacement) link = { kind: "replaced-on", dateKey: getAppDateKey(new Date(replacement.scheduledAt)) };
        }
        rows.push({
          key: `s${session.id}`, memberId: member.id, state: stateFor(session), time: wallTime(session.scheduledAt),
          durationMinutes: session.durationMinutes ?? member.defaultDurationMinutes, sessionId: session.id, link,
        });
      }
    } else if (member.preferredDays.includes(weekday) && dateKey >= memberStartDateKey(member.createdAt)) {
      rows.push({
        key: `e${member.id}|${dateKey}`, memberId: member.id, state: dateKey < todayKey ? "not-recorded" : "expected",
        time: member.defaultStartTime, durationMinutes: member.defaultDurationMinutes, sessionId: null, link: null,
      });
    }
  }
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  return rows.sort((a, b) => a.time.localeCompare(b.time) || (nameOf.get(a.memberId) ?? "").localeCompare(nameOf.get(b.memberId) ?? ""));
}

/** The Calendar's single source of per-day truth (Today will reuse it). */
export function buildDayAttendance(
  members: CalendarMember[], sessions: CalendarSession[], dateKey: string, todayKey: string = getAppDateKey(),
): AttendanceRow[] {
  return rowsForDate(members, indexSessions(sessions), dateKey, todayKey);
}

export type DaySummary = { total: number; counts: Partial<Record<DisplayState, number>>; top: DisplayState | null };

/** Compact month-cell summary derived from that day's rows. */
export function summarizeRows(rows: AttendanceRow[]): DaySummary {
  const counts: DaySummary["counts"] = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return { total: rows.length, counts, top: PRIORITY.find((state) => counts[state]) ?? null };
}

/** Summaries for many dates with ONE session index. */
export function summarizeDates(
  members: CalendarMember[], sessions: CalendarSession[], dateKeys: string[], todayKey: string,
): Map<string, DaySummary> {
  const index = indexSessions(sessions);
  return new Map(dateKeys.map((dateKey) => [dateKey, summarizeRows(rowsForDate(members, index, dateKey, todayKey))]));
}

/** Write actions the Coach may take on one attendance row. Future dates never have any. */
export type AttendanceActionKind = "complete" | "absent" | "complete-replacement";
export type AttendanceAction = { kind: AttendanceActionKind; label: string };

/**
 * Which attendance writes a row offers. Today's Expected row is Present/Absent;
 * a past Not recorded day is backfilled with Mark completed/Mark absent; a pending
 * replacement can be completed once its date has arrived (today or past). Anything
 * on a future date is read-only. The backend enforces the same rules.
 */
export function attendanceActions(row: Pick<AttendanceRow, "state" | "sessionId">, dateKey: string, todayKey: string): AttendanceAction[] {
  if (dateKey > todayKey) return [];
  if (row.state === "replacement-pending" && row.sessionId !== null) return [{ kind: "complete-replacement", label: "Complete replacement" }];
  if (row.sessionId !== null) return [];
  if (row.state === "expected" && dateKey === todayKey) return [{ kind: "complete", label: "Present" }, { kind: "absent", label: "Absent" }];
  if (row.state === "not-recorded" && dateKey < todayKey) return [{ kind: "complete", label: "Mark completed" }, { kind: "absent", label: "Mark absent" }];
  return [];
}

export type TodaySummary = { load: number; completed: number; absent: number; pendingReplacements: number };

/** Real Today metrics, derived from the same rows the list shows. */
export function summarizeToday(rows: Pick<AttendanceRow, "state">[]): TodaySummary {
  const count = (...states: DisplayState[]) => rows.filter((r) => states.includes(r.state)).length;
  return {
    load: rows.length,
    completed: count("completed", "replacement-completed"),
    absent: count("absent"),
    pendingReplacements: count("replacement-pending"),
  };
}
