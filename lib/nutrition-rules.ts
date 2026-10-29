// The explicit `.ts` lets plain Node load this module for its pure-helper test.
// @ts-expect-error TS5097
import { getAppDateKey } from "./date-time.ts";

/**
 * Pure, client-safe Nutrition derivations for the Coach page. Everything is
 * computed from persisted meal rows plus a Saturday-Friday Tehran week; there
 * is no scoring of what was eaten, no AI and no health claims. Days are Tehran
 * `YYYY-MM-DD` keys derived with `getAppDateKey`, never browser-local dates.
 */

/** Canonical strings, identical to `mealTypes` in db/schema (not imported: that module pulls in the DB layer). */
export type NutritionMealType = "breakfast" | "lunch" | "dinner" | "snack";

/** One row of `GET /api/nutrition`. */
export type NutritionMeal = {
  id: number;
  memberId: number;
  mealType: NutritionMealType;
  loggedAt: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

/** Inclusive Tehran date keys of the visible Saturday-Friday week. */
export type NutritionWeek = { from: string; to: string };

const dayNumber = (dateKey: string) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

/** `dateKey` shifted by whole calendar days (pure `Date.UTC` maths, host-timezone independent). */
function shiftKey(dateKey: string, delta: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Days of the week that have happened: Saturday through today for the current
 * week, 7 for a past week, 0 for a week that has not started.
 */
export function elapsedDaysInWeek(week: NutritionWeek, todayKey: string): number {
  if (todayKey < week.from) return 0;
  const last = todayKey < week.to ? todayKey : week.to;
  return dayNumber(last) - dayNumber(week.from) + 1;
}

/** Tehran day keys, inside the elapsed part of the week, that have at least one entry; plus the entries themselves. */
function elapsedEntries(meals: NutritionMeal[], week: NutritionWeek, todayKey: string) {
  const last = todayKey < week.to ? todayKey : week.to;
  const entries = meals
    .map((meal) => ({ meal, dateKey: getAppDateKey(new Date(meal.loggedAt)) }))
    .filter(({ dateKey }) => dateKey >= week.from && dateKey <= last);
  return { entries, days: new Set(entries.map((entry) => entry.dateKey)) };
}

export type NutritionConsistency = {
  loggedDays: number;
  elapsedDays: number;
  /** Whole-number percent; `null` when no day of the week has happened yet. */
  percent: number | null;
};

/** Distinct Tehran days with at least one entry, divided by the elapsed days of the week. One Member's meals. */
export function buildNutritionConsistency(
  meals: NutritionMeal[], week: NutritionWeek, todayKey: string
): NutritionConsistency {
  const elapsedDays = elapsedDaysInWeek(week, todayKey);
  const loggedDays = elapsedEntries(meals, week, todayKey).days.size;
  return { loggedDays, elapsedDays, percent: elapsedDays === 0 ? null : Math.round((loggedDays / elapsedDays) * 100) };
}

export type NutritionInsightKey =
  | "not-started" | "no-activity" | "three-day-gap" | "low-consistency" | "snacks-most-days" | "steady";

export type NutritionInsight = {
  key: NutritionInsightKey;
  title: string;
  /** One neutral sentence describing the observed logging pattern. */
  text: string;
  /** Rule number (1 = highest). The neutral not-started state is 6. */
  priority: number;
  /** Counted in the overview's "needs follow-up". */
  followUp: boolean;
};

/**
 * One primary insight: the FIRST matching rule, in this order.
 *  1. no entries in the elapsed week
 *  2. >= 3 elapsed days and nothing on the last 3 elapsed days
 *  3. logged on fewer than half of the elapsed days
 *  4. snacks on >= 5 distinct days (and >= 5 elapsed days)
 *  5. otherwise steady
 * A week that has not started is neutral and never evaluates the rules.
 */
export function getNutritionInsight(
  meals: NutritionMeal[], week: NutritionWeek, todayKey: string
): NutritionInsight {
  const elapsed = elapsedDaysInWeek(week, todayKey);
  if (elapsed === 0) {
    return { key: "not-started", title: "Week has not started yet.", text: "No days have passed in this week.", priority: 6, followUp: false };
  }

  const { entries, days } = elapsedEntries(meals, week, todayKey);
  const last = todayKey < week.to ? todayKey : week.to;
  const loggedDays = days.size;

  if (entries.length === 0) {
    return { key: "no-activity", title: "No food activity logged this week", text: "No meals or snacks have been logged so far.", priority: 1, followUp: true };
  }
  if (elapsed >= 3 && [0, 1, 2].every((back) => !days.has(shiftKey(last, -back)))) {
    return { key: "three-day-gap", title: "No meals logged for 3 days", text: "Nothing was logged on the last 3 days.", priority: 2, followUp: true };
  }
  if (loggedDays * 2 < elapsed) {
    return { key: "low-consistency", title: "Logging on fewer than half of the days", text: `Logged on ${loggedDays} of ${elapsed} days.`, priority: 3, followUp: true };
  }
  const snackDays = new Set(entries.filter(({ meal }) => meal.mealType === "snack").map((entry) => entry.dateKey)).size;
  if (elapsed >= 5 && snackDays >= 5) {
    return { key: "snacks-most-days", title: "Snacks logged on most days", text: `Snacks were logged on ${snackDays} days.`, priority: 4, followUp: false };
  }
  return { key: "steady", title: "Steady logging", text: `Logged on ${loggedDays} of ${elapsed} days.`, priority: 5, followUp: false };
}

export type MemberNutrition = {
  memberId: number;
  meals: NutritionMeal[];
  consistency: NutritionConsistency;
  insight: NutritionInsight;
};

export type NutritionOverview = {
  members: MemberNutrition[];
  /** Members with >= 1 entry in the elapsed week, out of all assigned Members. */
  loggedMembers: number;
  totalMembers: number;
  /** Breakfast + lunch + dinner entries. */
  meals: number;
  snacks: number;
  /** Mean of each Member's exact consistency (zero-log Members count as 0), rounded; `null` when nothing has elapsed or there are no Members. */
  averagePercent: number | null;
  needsFollowUp: number;
};

/**
 * Overview for the CURRENT roster (`memberIds`): a Member with no meals still
 * appears, and meal rows of Members outside the roster are ignored.
 */
export function buildNutritionOverview(
  memberIds: number[], meals: NutritionMeal[], week: NutritionWeek, todayKey: string
): NutritionOverview {
  const elapsed = elapsedDaysInWeek(week, todayKey);
  const members = memberIds.map((memberId): MemberNutrition => {
    const own = meals.filter((meal) => meal.memberId === memberId);
    return {
      memberId, meals: own,
      consistency: buildNutritionConsistency(own, week, todayKey),
      insight: getNutritionInsight(own, week, todayKey),
    };
  });

  let loggedMembers = 0, mealCount = 0, snacks = 0, fractionSum = 0;
  for (const member of members) {
    const { entries, days } = elapsedEntries(member.meals, week, todayKey);
    if (entries.length > 0) loggedMembers++;
    for (const { meal } of entries) { if (meal.mealType === "snack") snacks++; else mealCount++; }
    if (elapsed > 0) fractionSum += days.size / elapsed;
  }

  return {
    members, loggedMembers, totalMembers: members.length, meals: mealCount, snacks,
    averagePercent: elapsed === 0 || members.length === 0 ? null : Math.round((fractionSum / members.length) * 100),
    needsFollowUp: members.filter((member) => member.insight.followUp).length,
  };
}
