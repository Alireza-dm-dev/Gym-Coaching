/**
 * Pure Body Map read model: "days since each muscle was last trained", from a
 * Member's retained Session detail. No React, no network, no colours. All dates
 * are Tehran `YYYY-MM-DD` keys, so the result never depends on the browser's
 * timezone or on millisecond arithmetic across DST.
 */
// The explicit `.ts` lets plain Node load this module for its pure-helper test.
// @ts-expect-error TS5097
import { getAppDateKey } from "./date-time.ts";
// @ts-expect-error TS5097
import { isDateKeyInDetailWindow } from "./session-detail-window.ts";

export const MUSCLE_KEYS = ["shoulders", "chest", "arms", "core", "back", "glutes", "quads", "hamstrings", "calves"] as const;
export type FreshnessMuscleKey = (typeof MUSCLE_KEYS)[number];

export type FreshnessSession = { scheduledAt: string; status: string; muscles: readonly string[] };
export type MuscleFreshness = Record<FreshnessMuscleKey, null | { lastDateKey: string; daysSince: number }>;

/** Whole calendar days from `fromKey` to `toKey` (pure `Date.UTC` calendar arithmetic). */
export function daysBetweenDateKeys(fromKey: string, toKey: string): number {
  const utc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toKey) - utc(fromKey)) / 86_400_000);
}

/**
 * For each muscle, the most recent completed Session inside the 30-day detail
 * window that recorded it. A Session with `muscles: []` contributes nothing: empty
 * may simply mean the detail expired, so it is never read as "trained nothing".
 */
export function buildMuscleFreshness(sessions: readonly FreshnessSession[], todayKey: string): MuscleFreshness {
  const result = Object.fromEntries(MUSCLE_KEYS.map((key) => [key, null])) as MuscleFreshness;
  for (const session of sessions) {
    if (session.status !== "completed" || session.muscles.length === 0) continue;
    const dateKey = getAppDateKey(new Date(session.scheduledAt));
    if (!isDateKeyInDetailWindow(dateKey, todayKey) || dateKey > todayKey) continue;
    for (const key of session.muscles) {
      if (!(MUSCLE_KEYS as readonly string[]).includes(key)) continue;
      const known = key as FreshnessMuscleKey;
      const current = result[known];
      if (!current || dateKey > current.lastDateKey) {
        result[known] = { lastDateKey: dateKey, daysSince: daysBetweenDateKeys(dateKey, todayKey) };
      }
    }
  }
  return result;
}

/** Visual category of the existing Body Map scale; `none` is grey (never recorded, or older than 14 days). */
export type FreshnessBucket = "l0" | "l1" | "l2" | "l3" | "none";

export function freshnessBucket(daysSince: number | null | undefined): FreshnessBucket {
  if (daysSince === null || daysSince === undefined) return "none";
  if (daysSince <= 1) return "l0";
  if (daysSince <= 4) return "l1";
  if (daysSince <= 7) return "l2";
  if (daysSince <= 14) return "l3";
  return "none";
}
