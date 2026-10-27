import { and, count, eq, exists, lt, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { sessionMuscles, sessionNotes, sessions } from "../db/schema";
import { addDaysToDateKey, getAppDateKey, localDateTimeToUtcIso } from "./date-time";

/**
 * Per-Session detail (notes, muscles, future child data) is kept this many
 * Tehran calendar days. Core `sessions` rows are never subject to retention.
 */
export const SESSION_DETAIL_RETENTION_DAYS = 30;

export type SessionDetailCutoff = {
  /** Tehran calendar day exactly `SESSION_DETAIL_RETENTION_DAYS` before today. */
  cutoffDateKey: string;
  /** That day's Tehran midnight as UTC ISO; same format as `sessions.scheduledAt`. */
  cutoffIso: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Defensive check so a bad clock or conversion can never yield a cutoff that
 * would make recent detail look expired. Throws; never silently continues.
 */
export function assertValidSessionDetailCutoff(cutoff: SessionDetailCutoff, now: Date): void {
  const cutoffInstant = new Date(cutoff.cutoffIso);
  if (Number.isNaN(cutoffInstant.getTime()) || cutoffInstant.toISOString() !== cutoff.cutoffIso) {
    throw new Error(`Retention cutoff is not a canonical ISO instant: "${cutoff.cutoffIso}".`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff.cutoffDateKey)) {
    throw new Error(`Retention cutoff date key is invalid: "${cutoff.cutoffDateKey}".`);
  }
  if (cutoffInstant.getTime() >= now.getTime()) {
    throw new Error("Retention cutoff must be in the past.");
  }
  // Cutoff is a Tehran midnight, so "now" is 30 days plus part of a day later.
  const ageDays = (now.getTime() - cutoffInstant.getTime()) / DAY_MS;
  if (ageDays < SESSION_DETAIL_RETENTION_DAYS - 0.1 || ageDays >= SESSION_DETAIL_RETENTION_DAYS + 1.1) {
    throw new Error(`Retention cutoff is ${ageDays.toFixed(2)} days old; expected about ${SESSION_DETAIL_RETENTION_DAYS}.`);
  }
}

/**
 * A Session on Tehran day D keeps its detail through D+30 and is eligible from
 * Tehran midnight on D+31. Eligibility is `scheduledAt < cutoffIso` (strict).
 */
export function getSessionDetailCutoff(now: Date = new Date()): SessionDetailCutoff {
  const cutoffDateKey = addDaysToDateKey(getAppDateKey(now), -SESSION_DETAIL_RETENTION_DAYS);
  const cutoff = { cutoffDateKey, cutoffIso: localDateTimeToUtcIso(cutoffDateKey, "00:00") };
  assertValidSessionDetailCutoff(cutoff, now);
  return cutoff;
}

export type SessionDetailDryRun = SessionDetailCutoff & {
  expiredNotes: number;
  expiredMuscles: number;
};

/**
 * Read-only: counts child rows whose parent Session is older than the cutoff.
 * Eligibility comes only from `sessions.scheduledAt`; child timestamps are
 * ignored. Issues SELECTs only.
 */
export async function countExpiredSessionDetails(
  db: ReturnType<typeof getDb>,
  now: Date = new Date()
): Promise<SessionDetailDryRun> {
  const cutoff = getSessionDetailCutoff(now);

  const [notes] = await db
    .select({ total: count() })
    .from(sessionNotes)
    .where(parentExpiredPredicate(db, cutoff.cutoffIso, sessionNotes.sessionId));
  const [muscles] = await db
    .select({ total: count() })
    .from(sessionMuscles)
    .where(parentExpiredPredicate(db, cutoff.cutoffIso, sessionMuscles.sessionId));

  return { ...cutoff, expiredNotes: notes.total, expiredMuscles: muscles.total };
}

/** Shared predicate: child rows whose parent Session is strictly older than the cutoff. */
function parentExpiredPredicate(
  db: ReturnType<typeof getDb>,
  cutoffIso: string,
  childSessionId: typeof sessionNotes.sessionId | typeof sessionMuscles.sessionId
) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(sessions)
      .where(and(eq(sessions.id, childSessionId), lt(sessions.scheduledAt, cutoffIso)))
  );
}

/**
 * Write guard: true when the Session's detail is past retention. Uses the same
 * strict `scheduledAt < cutoffIso` rule as the delete, independent of whether
 * cleanup has run yet. Throws (fails closed) if the cutoff is invalid.
 */
export function isSessionDetailExpired(scheduledAt: string, now: Date = new Date()): boolean {
  return scheduledAt < getSessionDetailCutoff(now).cutoffIso;
}

export type SessionDetailCleanupResult = SessionDetailCutoff & {
  deletedNotes: number;
  deletedMuscles: number;
};

/**
 * Hard-deletes Notes and Muscles whose parent Session is older than the
 * cutoff, in one atomic D1 batch sharing a single cutoff value. Core
 * `sessions` rows are never touched. Idempotent. Internal only: the cutoff is
 * always derived from `now`, never from request input.
 */
export async function deleteExpiredSessionDetails(
  db: ReturnType<typeof getDb>,
  now: Date = new Date()
): Promise<SessionDetailCleanupResult> {
  const cutoff = getSessionDetailCutoff(now);

  const [deletedNoteRows, deletedMuscleRows] = await db.batch([
    db
      .delete(sessionNotes)
      .where(parentExpiredPredicate(db, cutoff.cutoffIso, sessionNotes.sessionId))
      .returning({ id: sessionNotes.id }),
    db
      .delete(sessionMuscles)
      .where(parentExpiredPredicate(db, cutoff.cutoffIso, sessionMuscles.sessionId))
      .returning({ id: sessionMuscles.id }),
  ]);

  return { ...cutoff, deletedNotes: deletedNoteRows.length, deletedMuscles: deletedMuscleRows.length };
}
