/**
 * Pure Nutrition rule tests (no Worker, no DB): consistency, insight priority and
 * overview aggregation, with Tehran-day semantics.   npm run test:nutrition-rules
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNutritionConsistency, buildNutritionOverview, elapsedDaysInWeek, getNutritionInsight } from "../lib/nutrition-rules.ts";
import { localDateTimeToUtcIso } from "../lib/date-time.ts";

// Saturday 2025-03-15 .. Friday 2025-03-21 (Asia/Tehran).
const WEEK = { from: "2025-03-15", to: "2025-03-21" };
const DAYS = ["2025-03-15", "2025-03-16", "2025-03-17", "2025-03-18", "2025-03-19", "2025-03-20", "2025-03-21"];
let nextId = 1;
const meal = (dateKey, mealType = "lunch", time = "12:00", memberId = 1) => ({
  id: nextId++, memberId, mealType, loggedAt: localDateTimeToUtcIso(dateKey, time), description: "x", createdAt: "", updatedAt: "",
});
const onDays = (...keys) => keys.map((k) => meal(k));
const PAST = "2025-04-01"; // the whole week has elapsed
const MID = "2025-03-19"; // Wednesday: 5 elapsed days

describe("elapsed days", () => {
  it("current week = Saturday through today inclusive, past week = 7, future week = 0", () => {
    assert.equal(elapsedDaysInWeek(WEEK, "2025-03-15"), 1);
    assert.equal(elapsedDaysInWeek(WEEK, MID), 5);
    assert.equal(elapsedDaysInWeek(WEEK, "2025-03-21"), 7);
    assert.equal(elapsedDaysInWeek(WEEK, PAST), 7);
    assert.equal(elapsedDaysInWeek(WEEK, "2025-03-14"), 0);
  });
});

describe("consistency", () => {
  it("zero entries is 0% once a day has elapsed", () => {
    assert.deepEqual(buildNutritionConsistency([], WEEK, MID), { loggedDays: 0, elapsedDays: 5, percent: 0 });
  });
  it("one day of one elapsed day is 100%", () => {
    assert.equal(buildNutritionConsistency(onDays("2025-03-15"), WEEK, "2025-03-15").percent, 100);
  });
  it("several entries on the same day count once", () => {
    const meals = [meal("2025-03-15", "breakfast"), meal("2025-03-15", "lunch"), meal("2025-03-15", "snack", "23:59")];
    assert.deepEqual(buildNutritionConsistency(meals, WEEK, MID), { loggedDays: 1, elapsedDays: 5, percent: 20 });
  });
  it("past week divides by 7; current week divides by days so far; rounds to a whole percent", () => {
    const four = onDays(...DAYS.slice(0, 4));
    assert.equal(buildNutritionConsistency(four, WEEK, PAST).percent, 57); // 4/7
    assert.equal(buildNutritionConsistency(four, WEEK, MID).percent, 80); // 4/5
    assert.equal(buildNutritionConsistency(onDays(...DAYS), WEEK, PAST).percent, 100);
  });
  it("future week has no percentage", () => {
    assert.deepEqual(buildNutritionConsistency([], WEEK, "2025-03-14"), { loggedDays: 0, elapsedDays: 0, percent: null });
  });
  it("days come from Tehran, not UTC: 23:30 and 00:30 Tehran are different days; entries outside the week are ignored", () => {
    const meals = [meal("2025-03-15", "dinner", "23:30"), meal("2025-03-16", "snack", "00:30")];
    assert.equal(meals[1].loggedAt, "2025-03-15T21:00:00.000Z", "00:30 Tehran is the previous UTC day");
    assert.equal(buildNutritionConsistency(meals, WEEK, PAST).loggedDays, 2);
    assert.equal(buildNutritionConsistency([meal("2025-03-14", "dinner", "23:59"), meal("2025-03-22", "snack", "00:01")], WEEK, PAST).loggedDays, 0);
  });
  it("entries on days that have not happened yet do not count", () => {
    assert.equal(buildNutritionConsistency(onDays("2025-03-20"), WEEK, MID).loggedDays, 0);
  });
});

describe("insight rules and priority", () => {
  const key = (meals, today) => getNutritionInsight(meals, WEEK, today).key;
  it("1 no activity", () => {
    const insight = getNutritionInsight([], WEEK, MID);
    assert.deepEqual([insight.key, insight.title, insight.priority, insight.followUp], ["no-activity", "No food activity logged this week", 1, true]);
  });
  it("2 three-day gap needs >= 3 elapsed days and nothing on the last 3", () => {
    const insight = getNutritionInsight(onDays("2025-03-15", "2025-03-16"), WEEK, "2025-03-19");
    assert.deepEqual([insight.key, insight.title, insight.priority, insight.followUp], ["three-day-gap", "No meals logged for 3 days", 2, true]);
    assert.notEqual(key(onDays("2025-03-15", "2025-03-17"), "2025-03-19"), "three-day-gap", "one of the last 3 days logged");
    assert.equal(key(onDays("2025-03-15"), "2025-03-16"), "steady", "only 2 elapsed days: rule 2 cannot apply (1/2 is not under half)");
    assert.equal(key(onDays("2025-03-15", "2025-03-16", "2025-03-17"), PAST), "three-day-gap", "past week: the last 3 days are Wed-Fri");
  });
  it("3 low consistency is strictly under half", () => {
    const insight = getNutritionInsight(onDays("2025-03-15", "2025-03-16", "2025-03-19"), WEEK, PAST); // 3/7, Wed logged -> not a gap
    assert.deepEqual([insight.key, insight.title, insight.priority, insight.followUp], ["low-consistency", "Logging on fewer than half of the days", 3, true]);
    assert.equal(key(onDays("2025-03-16", "2025-03-18", "2025-03-19", "2025-03-21"), PAST), "steady", "4/7 is above half");
    assert.equal(key(onDays("2025-03-15", "2025-03-17"), "2025-03-18"), "steady", "exactly half (2/4) is not low");
  });
  it("4 snacks on >= 5 distinct days and >= 5 elapsed days, and is not follow-up", () => {
    const snacks = DAYS.slice(0, 5).map((d) => meal(d, "snack"));
    const insight = getNutritionInsight(snacks, WEEK, MID);
    assert.deepEqual([insight.key, insight.title, insight.priority, insight.followUp], ["snacks-most-days", "Snacks logged on most days", 4, false]);
    assert.equal(key(DAYS.slice(0, 4).map((d) => meal(d, "snack")), MID), "steady", "4 snack days");
    assert.equal(key([...DAYS.slice(0, 5).map((d) => meal(d, "snack")), ...DAYS.slice(0, 5).map((d) => meal(d, "snack", "18:00"))], MID), "snacks-most-days", "several snacks one day count once");
  });
  it("5 steady otherwise", () => {
    const insight = getNutritionInsight(onDays(...DAYS.slice(0, 5)), WEEK, MID);
    assert.deepEqual([insight.key, insight.title, insight.priority, insight.followUp], ["steady", "Steady logging", 5, false]);
  });
  it("future week is neutral and never negative", () => {
    const insight = getNutritionInsight([], WEEK, "2025-03-14");
    assert.deepEqual([insight.key, insight.followUp], ["not-started", false]);
  });
  it("priority: the first matching rule wins when several apply", () => {
    // Gap + low consistency at once -> gap (2) beats low (3).
    assert.equal(key(onDays("2025-03-15"), "2025-03-19"), "three-day-gap");
    // No activity beats the gap.
    assert.equal(key([], "2025-03-19"), "no-activity");
    const snacks = DAYS.slice(0, 5).map((d) => meal(d, "snack"));
    assert.equal(key(snacks, PAST), "snacks-most-days", "5/7 logged, last 3 days (Wed-Fri) include Wed");
    assert.equal(key(DAYS.slice(0, 4).map((d) => meal(d, "snack")), PAST), "three-day-gap", "Sat-Tue only: Wed-Fri empty");
  });
});

describe("overview", () => {
  const meals = [
    ...onDays(...DAYS.slice(0, 5)).map((m) => ({ ...m, memberId: 1 })),            // member 1: 5/5 in MID
    { ...meal("2025-03-15", "snack"), memberId: 2 }, { ...meal("2025-03-16", "breakfast"), memberId: 2 },
    { ...meal("2025-03-16", "dinner"), memberId: 99 },                              // not in the roster: ignored
  ];
  it("counts logged Members, meals vs snacks, average and follow-up over the roster (Members with no meals still appear)", () => {
    const o = buildNutritionOverview([1, 2, 3], meals, WEEK, MID);
    assert.deepEqual(o.members.map((m) => m.memberId), [1, 2, 3]);
    assert.equal(o.loggedMembers, 2);
    assert.equal(o.totalMembers, 3);
    assert.equal(o.meals, 5 + 1);
    assert.equal(o.snacks, 1);
    // exact fractions: 5/5, 2/5, 0/5 -> mean 0.4667 -> 47
    assert.equal(o.averagePercent, 47);
    // member 2: gap (nothing Mon-Wed) and member 3: no activity; member 1 steady.
    assert.equal(o.needsFollowUp, 2);
  });
  it("zero Members: 0 of 0, no average, no division error", () => {
    const o = buildNutritionOverview([], [], WEEK, MID);
    assert.deepEqual([o.loggedMembers, o.totalMembers, o.meals, o.snacks, o.averagePercent, o.needsFollowUp], [0, 0, 0, 0, null, 0]);
  });
  it("future week: no average and nobody needs follow-up", () => {
    const o = buildNutritionOverview([1, 2], [], WEEK, "2025-03-14");
    assert.deepEqual([o.loggedMembers, o.averagePercent, o.needsFollowUp], [0, null, 0]);
  });
});
