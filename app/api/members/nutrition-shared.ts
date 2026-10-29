import { and, desc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../../../db";
import { memberMeals, members, mealTypes, type MealType } from "../../../db/schema";
import { addDaysToDateKey, localDateTimeToUtcIso } from "../../../lib/date-time";
import { TIME_PATTERN, isValidDateKey, nextDateKey } from "../sessions/shared";

// Nutrition is deliberately independent of Session retention: nothing here
// imports or registers with the Session-detail cleanup. Meal rows carry no
// coachId; Coach visibility is the Member's CURRENT assignment.

export const MEAL_DESCRIPTION_MAX = 500;
/** Inclusive calendar days a single range read may span. */
export const MAX_RANGE_DAYS = 31;

/** Public Member shape. `memberId` is omitted: the endpoint already identifies the Member. */
export const mealColumns = {
  id: memberMeals.id,
  mealType: memberMeals.mealType,
  loggedAt: memberMeals.loggedAt,
  description: memberMeals.description,
  createdAt: memberMeals.createdAt,
  updatedAt: memberMeals.updatedAt,
};

/** Coach shape: the same fields plus the owning Member, since the read is aggregate. */
const coachMealColumns = { ...mealColumns, memberId: memberMeals.memberId };

export type MealInput = {
  mealType: MealType;
  loggedAt: string;
  description: string;
};

type Result<T> = { error: string } | { value: T };

const FIELDS = ["mealType", "dateKey", "time", "description"] as const;
const ALLOWED_FIELDS = new Set<string>(FIELDS);

/**
 * Create and edit share one body: the COMPLETE editable state (all four fields
 * required, no unknown keys), so the final state is always fully validated.
 * `dateKey` + `time` are Asia/Tehran wall-clock values converted to the stored
 * UTC instant. A meal later than `now` is rejected, including earlier today's
 * date with a later time.
 */
export function validateMealBody(body: unknown, now: Date = new Date()): Result<MealInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) return { error: `Unsupported field(s): ${unknown.join(", ")}.` };
  for (const field of FIELDS) {
    if (input[field] === undefined) return { error: `${field} is required.` };
  }

  const { mealType, dateKey, time, description } = input;
  if (typeof mealType !== "string" || !(mealTypes as readonly string[]).includes(mealType)) {
    return { error: `mealType must be one of: ${mealTypes.join(", ")}.` };
  }
  if (typeof dateKey !== "string" || !isValidDateKey(dateKey)) {
    return { error: "dateKey must be a real Gregorian date in YYYY-MM-DD format." };
  }
  if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
    return { error: "time must be a 24-hour HH:MM value." };
  }
  if (typeof description !== "string") return { error: "description must be a string." };
  const trimmed = description.trim();
  if (trimmed.length === 0) return { error: "description is required." };
  if (trimmed.length > MEAL_DESCRIPTION_MAX) {
    return { error: `description must be at most ${MEAL_DESCRIPTION_MAX} characters.` };
  }

  let loggedAt: string;
  try {
    loggedAt = localDateTimeToUtcIso(dateKey, time);
  } catch {
    return { error: "dateKey and time do not form a valid local date and time." };
  }
  if (loggedAt > now.toISOString()) return { error: "A meal cannot be logged in the future." };

  return { value: { mealType: mealType as MealType, loggedAt, description: trimmed } };
}

/**
 * `from`/`to` query parameters: real Gregorian date keys (Asia/Tehran days),
 * `from <= to`, inclusive, at most MAX_RANGE_DAYS days. Returns the UTC
 * half-open window [startIso, endIso) covering those Tehran days.
 */
export function parseMealRange(url: string): Result<{ startIso: string; endIso: string }> {
  const params = new URL(url).searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (from === null || !isValidDateKey(from)) {
    return { error: "from must be a real Gregorian date in YYYY-MM-DD format." };
  }
  if (to === null || !isValidDateKey(to)) {
    return { error: "to must be a real Gregorian date in YYYY-MM-DD format." };
  }
  if (to < from) return { error: "from must not be after to." };
  if (to > addDaysToDateKey(from, MAX_RANGE_DAYS - 1)) {
    return { error: `The range cannot exceed ${MAX_RANGE_DAYS} days.` };
  }
  return {
    value: {
      startIso: localDateTimeToUtcIso(from, "00:00"),
      endIso: localDateTimeToUtcIso(nextDateKey(to), "00:00"),
    },
  };
}

/** Newest first; id breaks ties deterministically. Uses (member_id, logged_at). */
export async function listMealsForMember(memberId: number, startIso: string, endIso: string) {
  return getDb()
    .select(mealColumns)
    .from(memberMeals)
    .where(and(
      eq(memberMeals.memberId, memberId),
      gte(memberMeals.loggedAt, startIso),
      lt(memberMeals.loggedAt, endIso)
    ))
    .orderBy(desc(memberMeals.loggedAt), desc(memberMeals.id));
}

/**
 * ONE query for every Member CURRENTLY assigned to the Coach (live
 * `members.coachId`, so it follows reassignment). Newest first, id as tiebreak.
 */
export async function listMealsForCoach(coachId: number, startIso: string, endIso: string) {
  return getDb()
    .select(coachMealColumns)
    .from(memberMeals)
    .innerJoin(members, eq(members.id, memberMeals.memberId))
    .where(and(
      eq(members.coachId, coachId),
      gte(memberMeals.loggedAt, startIso),
      lt(memberMeals.loggedAt, endIso)
    ))
    .orderBy(desc(memberMeals.loggedAt), desc(memberMeals.id));
}
