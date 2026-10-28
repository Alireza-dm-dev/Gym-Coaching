/**
 * Pure, client-safe description of the Session-detail (notes, muscles) retention
 * window. Kept apart from `session-retention.ts`, which imports the database
 * schema and so must never be bundled into the browser.
 */
// The explicit `.ts` lets plain Node load this module for its pure-helper test.
// @ts-expect-error TS5097
import { addDaysToDateKey } from "./date-time.ts";

/** Per-Session detail is kept this many Tehran calendar days; core `sessions` rows never expire. */
export const SESSION_DETAIL_RETENTION_DAYS = 30;

/**
 * UI-side mirror of the server rule: a Session on Tehran day D keeps its detail
 * through D+30 (expired from Tehran midnight on D+31). The API stays authoritative.
 */
export function isDateKeyInDetailWindow(dateKey: string, todayKey: string): boolean {
  return dateKey >= addDaysToDateKey(todayKey, -SESSION_DETAIL_RETENTION_DAYS);
}
