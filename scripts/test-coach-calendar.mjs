/**
 * Pure-helper tests for the Coach Calendar read model (SEC0I2): no Worker, no
 * database, no browser. Run directly by Node, which loads the TypeScript
 * helpers natively.
 *
 *   npm run test:coach-calendar
 *
 * Fixed "today" is Tuesday 2026-10-27 (Tehran); Saturdays are 10-24 and 10-31.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attendanceActions, buildDayAttendance, memberStartDateKey, summarizeRows, summarizeToday } from "../lib/coach-calendar.ts";
import { getJalaliMonthGrid, localDateTimeToUtcIso, shiftJalaliMonth, weekdayCodeForDate } from "../lib/date-time.ts";

const TODAY = "2026-10-27";
const at = (dateKey, time) => localDateTimeToUtcIso(dateKey, time);
const member = (id, preferredDays, createdAt = "2020-01-01 00:00:00") => ({
  id, name: `Member ${id}`, goal: "fitness", defaultStartTime: "08:30", defaultDurationMinutes: 50, preferredDays, createdAt,
});
let nextId = 1;
const session = (memberId, dateKey, time, status, replacementForId = null) => ({
  id: nextId++, memberId, scheduledAt: at(dateKey, time), status, durationMinutes: 50, replacementForId,
});
const day = (members, sessions, dateKey) => buildDayAttendance(members, sessions, dateKey, TODAY);

describe("fixture sanity", () => {
  it("the fixed calendar days are the weekdays this suite assumes", () => {
    const weekday = (key) => weekdayCodeForDate(new Date(at(key, "12:00")));
    assert.deepEqual(["2026-10-24", "2026-10-27", "2026-10-31"].map(weekday), ["Sat", "Tue", "Sat"]);
  });
});

describe("expected vs actual", () => {
  const sat = member(1, ["Sat"]);

  it("past preferred day with no Session -> Not recorded (never Absent)", () => {
    const rows = day([sat], [], "2026-10-24");
    assert.deepEqual(rows.map((r) => [r.state, r.sessionId, r.time]), [["not-recorded", null, "08:30"]]);
  });

  it("today preferred with no Session -> Expected", () => {
    assert.deepEqual(day([member(2, ["Tue"])], [], TODAY).map((r) => r.state), ["expected"]);
  });

  it("future preferred with no Session -> Expected", () => {
    assert.deepEqual(day([sat], [], "2026-10-31").map((r) => r.state), ["expected"]);
  });

  it("non-preferred day with no Session -> no row", () => {
    assert.deepEqual(day([sat], [], "2026-10-26"), []);
  });

  it("completed row -> Completed at its persisted time, replacing the expectation", () => {
    const rows = day([sat], [session(1, "2026-10-24", "09:15", "completed")], "2026-10-24");
    assert.deepEqual(rows.map((r) => [r.state, r.time]), [["completed", "09:15"]]);
  });

  it("absent row -> Absent (not Not recorded)", () => {
    assert.deepEqual(day([sat], [session(1, "2026-10-24", "08:30", "absent")], "2026-10-24").map((r) => r.state), ["absent"]);
  });

  it("replacement on a non-preferred weekday is visible, also in the future", () => {
    const rows = day([sat], [session(1, "2026-10-28", "10:00", "replacement", 99)], "2026-10-28");
    assert.deepEqual(rows.map((r) => r.state), ["replacement-pending"]);
  });

  it("a persisted row on a past non-preferred day is visible too", () => {
    assert.deepEqual(day([sat], [session(1, "2026-10-26", "11:00", "completed")], "2026-10-26").map((r) => r.state), ["completed"]);
  });

  it("completed replacement -> Replacement completed", () => {
    const rows = day([sat], [session(1, "2026-10-26", "10:00", "completed", 5)], "2026-10-26");
    assert.deepEqual(rows.map((r) => r.state), ["replacement-completed"]);
  });

  it("no expectation before the Member's createdAt business date", () => {
    const late = member(3, ["Sat"], "2026-10-25 09:00:00");
    assert.equal(memberStartDateKey("2026-10-25 09:00:00"), "2026-10-25");
    assert.deepEqual(day([late], [], "2026-10-24"), []);
    assert.deepEqual(day([late], [], "2026-10-31").map((r) => r.state), ["expected"]);
  });

  it("createdAt late in the UTC day maps to the next Tehran day", () => {
    assert.equal(memberStartDateKey("2026-10-24 21:00:00"), "2026-10-25");
  });

  it("a cancelled row never suppresses the expectation and is not shown", () => {
    const rows = day([sat], [session(1, "2026-10-24", "08:30", "cancelled")], "2026-10-24");
    assert.deepEqual(rows.map((r) => r.state), ["not-recorded"]);
  });
});

describe("grouping and linking", () => {
  const sat = member(1, ["Sat"]);

  it("multiple rows for one Member/day are all preserved, in time order", () => {
    nextId = 100;
    const absent = session(1, "2026-10-24", "08:30", "absent");
    const replacement = session(1, "2026-10-24", "17:00", "replacement", absent.id);
    const rows = day([sat], [replacement, absent], "2026-10-24");
    assert.deepEqual(rows.map((r) => r.state), ["absent", "replacement-pending"]);
    assert.equal(rows.length, 2);
  });

  it("Tehran date, not UTC, decides the day (21:00Z is already tomorrow in Tehran)", () => {
    const lateNight = { id: 500, memberId: 1, scheduledAt: "2026-10-24T21:00:00.000Z", status: "completed", durationMinutes: 50, replacementForId: null };
    assert.deepEqual(day([sat], [lateNight], "2026-10-24").map((r) => r.state), ["not-recorded"]);
    const next = day([sat], [lateNight], "2026-10-25");
    assert.deepEqual(next.map((r) => [r.state, r.time]), [["completed", "00:30"]]);
  });

  it("replacement links to its original absence and back, when both are loaded", () => {
    nextId = 200;
    const absent = session(1, "2026-10-24", "08:30", "absent");
    const replacement = session(1, "2026-10-28", "10:00", "replacement", absent.id);
    const all = [absent, replacement];
    assert.deepEqual(day([sat], all, "2026-10-28")[0].link, { kind: "replacement-for", dateKey: "2026-10-24" });
    assert.deepEqual(day([sat], all, "2026-10-24")[0].link, { kind: "replaced-on", dateKey: "2026-10-28" });
  });

  it("an unresolvable relation yields no link and needs no extra data", () => {
    nextId = 300;
    const orphan = session(1, "2026-10-28", "10:00", "replacement", 9999);
    assert.equal(day([sat], [orphan], "2026-10-28")[0].link, null);
    const absent = session(1, "2026-10-24", "08:30", "absent");
    assert.equal(day([sat], [absent], "2026-10-24")[0].link, null);
  });

  it("only Members on the supplied roster produce rows (ownership stays server-side)", () => {
    const stranger = session(77, "2026-10-24", "08:30", "completed");
    assert.deepEqual(day([sat], [stranger], "2026-10-24").map((r) => r.memberId), [1]);
  });
});

describe("day summary priority", () => {
  const row = (state) => ({ state });
  it("completed > replacement pending > absent > not recorded > expected", () => {
    assert.equal(summarizeRows([row("expected"), row("not-recorded"), row("absent")]).top, "absent");
    assert.equal(summarizeRows([row("absent"), row("replacement-pending")]).top, "replacement-pending");
    assert.equal(summarizeRows([row("replacement-pending"), row("replacement-completed")]).top, "replacement-completed");
    assert.equal(summarizeRows([]).top, null);
    assert.deepEqual(summarizeRows([row("absent"), row("absent")]).counts, { absent: 2 });
  });
});

describe("Jalali month grid", () => {
  it("lays out Mehr 1405 with its real length and Saturday-first offset", () => {
    const grid = getJalaliMonthGrid("2026-10-10");
    assert.deepEqual([grid.year, grid.month, grid.monthName], [1405, 7, "Mehr"]);
    assert.equal(grid.days.length, 30);
    assert.equal(grid.startDateKey, "2026-09-23");
    assert.equal(grid.endDateKey, "2026-10-22");
    assert.equal(grid.leadingBlanks, 4); // 23 Sep 2026 is a Wednesday
    assert.deepEqual(grid.days.map((d) => d.jalaliDay), Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("knows 31-day, 30-day and short Esfand months", () => {
    assert.equal(getJalaliMonthGrid("2026-04-10").days.length, 31); // Ordibehesht
    assert.equal(getJalaliMonthGrid("2026-12-10").days.length, 30); // Azar
    const esfand = getJalaliMonthGrid("2026-03-10");
    assert.equal(esfand.monthName, "Esfand");
    assert.equal(esfand.days.length, 29); // 1404 is not a leap year
    assert.equal(esfand.endDateKey, "2026-03-20");
  });

  it("navigates months, across the Jalali year boundary, and back", () => {
    assert.equal(getJalaliMonthGrid("2026-10-27").monthName, "Aban"); // the suite's "today" is Aban 5
    assert.equal(shiftJalaliMonth("2026-10-27", 1), "2026-11-22"); // Azar 1
    assert.equal(shiftJalaliMonth("2026-10-27", -1), "2026-09-23"); // Mehr 1
    assert.equal(shiftJalaliMonth("2026-03-10", 1), "2026-03-21"); // Esfand -> Farvardin 1405
    assert.equal(getJalaliMonthGrid("2026-03-21").year, 1405);
    assert.equal(shiftJalaliMonth("2026-03-21", -1), "2026-02-20"); // Farvardin -> Esfand 1404 day 1 (29 days, ends 03-20)
    assert.equal(shiftJalaliMonth("2026-10-27", 0), "2026-10-23");
  });

  it("every cell's dateKey round-trips to its own Jalali day", () => {
    const grid = getJalaliMonthGrid("2026-10-27");
    for (const d of grid.days) assert.equal(getJalaliMonthGrid(d.dateKey).startDateKey, grid.startDateKey);
  });
});

describe("attendance actions (SEC0I3)", () => {
  const kinds = (row, dateKey) => attendanceActions(row, dateKey, TODAY).map((a) => `${a.kind}:${a.label}`);
  const derived = (state) => ({ state, sessionId: null });
  const persisted = (state) => ({ state, sessionId: 7 });

  it("today Expected -> Present / Absent", () => {
    assert.deepEqual(kinds(derived("expected"), TODAY), ["complete:Present", "absent:Absent"]);
  });
  it("past Not recorded -> Mark completed / Mark absent", () => {
    assert.deepEqual(kinds(derived("not-recorded"), "2026-10-24"), ["complete:Mark completed", "absent:Mark absent"]);
  });
  it("a pending replacement can be completed today or in the past, never in the future", () => {
    assert.deepEqual(kinds(persisted("replacement-pending"), TODAY), ["complete-replacement:Complete replacement"]);
    assert.deepEqual(kinds(persisted("replacement-pending"), "2026-10-20"), ["complete-replacement:Complete replacement"]);
    assert.deepEqual(kinds(persisted("replacement-pending"), "2026-10-28"), []);
  });
  it("future Expected is read-only", () => {
    assert.deepEqual(kinds(derived("expected"), "2026-10-31"), []);
  });
  it("Completed / Absent / Replacement completed never offer a duplicate action", () => {
    for (const state of ["completed", "absent", "replacement-completed"]) {
      assert.deepEqual(kinds(persisted(state), TODAY), []);
      assert.deepEqual(kinds(persisted(state), "2026-10-24"), []);
    }
  });
});

describe("Today summary (SEC0I3)", () => {
  it("counts load, completed (incl. completed replacements), absent and pending replacements", () => {
    const rows = ["expected", "completed", "replacement-completed", "absent", "replacement-pending", "replacement-pending"].map((state) => ({ state }));
    assert.deepEqual(summarizeToday(rows), { load: 6, completed: 2, absent: 1, pendingReplacements: 2 });
    assert.deepEqual(summarizeToday([]), { load: 0, completed: 0, absent: 0, pendingReplacements: 0 });
  });
  it("Today and Calendar derive the same rows for the same date", () => {
    const m = member(1, ["Tue"]);
    assert.deepEqual(day([m], [], TODAY), buildDayAttendance([m], [], TODAY, TODAY));
  });
});
