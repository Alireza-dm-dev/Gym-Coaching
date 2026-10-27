import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { memberCycles } from "../../../db/schema";
import { getAppDateKey } from "../../../lib/date-time";
import { isValidDateKey } from "../sessions/shared";

// Cycle data is deliberately independent of Session retention: nothing here
// imports or registers with the Session-detail cleanup.

/** Public shape. `memberId` is omitted: the endpoint already identifies the Member. */
export const cycleColumns = {
  id: memberCycles.id,
  periodStart: memberCycles.periodStart,
  periodEnd: memberCycles.periodEnd,
  pmsStart: memberCycles.pmsStart,
  pmsEnd: memberCycles.pmsEnd,
  createdAt: memberCycles.createdAt,
  updatedAt: memberCycles.updatedAt,
};

/** Newest first; id breaks ties deterministically. */
export async function listCyclesForMember(memberId: number) {
  return getDb()
    .select(cycleColumns)
    .from(memberCycles)
    .where(eq(memberCycles.memberId, memberId))
    .orderBy(desc(memberCycles.periodStart), desc(memberCycles.id));
}

export type CycleInput = {
  periodStart: string;
  periodEnd: string | null;
  pmsStart: string | null;
  pmsEnd: string | null;
};

const FIELDS = ["periodStart", "periodEnd", "pmsStart", "pmsEnd"] as const;
const ALLOWED_FIELDS = new Set<string>(FIELDS);

type Result<T> = { error: string } | { value: T };

/** One supplied value: `null` is "absent"; anything else must be a real, non-future date key. */
function parseDate(raw: unknown, field: string, today: string): Result<string | null> {
  if (raw === null) return { value: null };
  if (typeof raw !== "string" || !isValidDateKey(raw)) {
    return { error: `${field} must be a real calendar date in YYYY-MM-DD format.` };
  }
  // Observed timing only, never prediction. Keys are zero-padded, so string
  // comparison is chronological.
  if (raw > today) return { error: `${field} must not be in the future.` };
  return { value: raw };
}

/**
 * Relational rules for a COMPLETE record. POST and PATCH both end here, so the
 * create and edit rules cannot drift: end >= start, and a PMS window is either
 * complete or absent.
 */
export function validateCycleRecord(record: CycleInput): { error: string } | null {
  const { periodStart, periodEnd, pmsStart, pmsEnd } = record;
  if (periodEnd !== null && periodEnd < periodStart) {
    return { error: "periodEnd must not be before periodStart." };
  }
  if ((pmsStart === null) !== (pmsEnd === null)) {
    return { error: "pmsStart and pmsEnd must be provided together or both omitted." };
  }
  if (pmsStart !== null && pmsEnd !== null && pmsEnd < pmsStart) {
    return { error: "pmsEnd must not be before pmsStart." };
  }
  return null;
}

/** Object-only, no unknown keys; returns the supplied keys' parsed values (omitted keys stay omitted). */
function parseSuppliedFields(
  body: unknown,
  now: Date
): Result<Partial<Record<(typeof FIELDS)[number], string | null>>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) return { error: `Unsupported field(s): ${unknown.join(", ")}.` };

  const today = getAppDateKey(now);
  const parsed: Partial<Record<(typeof FIELDS)[number], string | null>> = {};
  for (const field of FIELDS) {
    if (input[field] === undefined) continue;
    const result = parseDate(input[field], field, today);
    if ("error" in result) return result;
    parsed[field] = result.value;
  }
  return { value: parsed };
}

/** Create body: `periodStart` required; omitted and `null` both mean "absent" for the rest. */
export function validateCycleBody(
  body: unknown,
  now: Date = new Date()
): { error: string } | { value: CycleInput } {
  const supplied = parseSuppliedFields(body, now);
  if ("error" in supplied) return supplied;
  const { periodStart } = supplied.value;
  if (periodStart === undefined || periodStart === null) return { error: "periodStart is required." };

  const record: CycleInput = {
    periodStart,
    periodEnd: supplied.value.periodEnd ?? null,
    pmsStart: supplied.value.pmsStart ?? null,
    pmsEnd: supplied.value.pmsEnd ?? null,
  };
  return validateCycleRecord(record) ?? { value: record };
}

/**
 * Partial edit: supplied fields overwrite `existing` (null clears an optional
 * one), then the MERGED record is validated with the same rules as create.
 */
export function validateCyclePatch(
  body: unknown,
  existing: CycleInput,
  now: Date = new Date()
): { error: string } | { value: CycleInput } {
  const supplied = parseSuppliedFields(body, now);
  if ("error" in supplied) return supplied;
  if (Object.keys(supplied.value).length === 0) {
    return { error: "Request body must contain at least one field." };
  }
  if (supplied.value.periodStart === null) return { error: "periodStart cannot be cleared." };

  const merged: CycleInput = { ...existing, ...supplied.value } as CycleInput;
  return validateCycleRecord(merged) ?? { value: merged };
}
