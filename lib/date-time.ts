/**
 * Canonical date/time handling for the coaching app.
 *
 * Rules this module exists to enforce:
 * - The business timezone is fixed, never the host machine's.
 * - Persisted instants are UTC ISO-8601; the database never stores Jalali text.
 * - Jalali/Persian output is presentation only, derived from a stored instant.
 */

export const APP_TIME_ZONE = "Asia/Tehran";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Reads an instant's wall-clock parts in a named timezone. */
function zonedParts(instant: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    if (type !== "literal") parts[type] = value;
  }

  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Offset in ms between the named zone's wall clock and UTC at a given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

function assertValidInstant(value: Date | string, label: string): Date {
  const instant = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(instant.getTime())) throw new Error(`${label} is not a valid instant.`);
  return instant;
}

/** Gregorian calendar date in the app timezone, as `YYYY-MM-DD`. */
export function getAppDateKey(now: Date = new Date()): string {
  const { year, month, day } = zonedParts(assertValidInstant(now, "now"), APP_TIME_ZONE);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Gregorian day-of-month in the app timezone.
 *
 * Note this is the Gregorian day, matching `getAppDateKey`. The calendar screen
 * displays Jalali day numbers, so a Jalali day must come from
 * `formatJalaliDate` rather than from here.
 */
export function getAppDayOfMonth(now: Date = new Date()): number {
  return zonedParts(assertValidInstant(now, "now"), APP_TIME_ZONE).day;
}

/**
 * Interprets a `YYYY-MM-DD` + `HH:MM` wall-clock value in the app timezone and
 * returns the matching UTC instant as `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Never uses the host timezone: the wall clock is first treated as UTC, then
 * corrected by the zone's offset. The correction is applied twice because the
 * offset must be sampled at the target instant, not the provisional one, and
 * the result is round-trip checked so a wall-clock time that does not exist in
 * the zone is rejected instead of being silently shifted.
 */
export function localDateTimeToUtcIso(dateKey: string, time: string): string {
  const dateMatch = DATE_KEY_PATTERN.exec(dateKey);
  if (!dateMatch) throw new Error(`Date must be in YYYY-MM-DD format: received "${dateKey}".`);

  const timeMatch = TIME_PATTERN.exec(time);
  if (!timeMatch) throw new Error(`Time must be a 24-hour HH:MM value: received "${time}".`);

  const [, yearText, monthText, dayText] = dateMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  // Rejects impossible dates such as 2026-02-31, which Date.UTC would roll over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`"${dateKey}" is not a real calendar date.`);
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let instant = new Date(wallClockAsUtc - zoneOffsetMs(new Date(wallClockAsUtc), APP_TIME_ZONE));
  instant = new Date(wallClockAsUtc - zoneOffsetMs(instant, APP_TIME_ZONE));

  const check = zonedParts(instant, APP_TIME_ZONE);
  if (
    check.year !== year || check.month !== month || check.day !== day ||
    check.hour !== hour || check.minute !== minute
  ) {
    throw new Error(`"${dateKey} ${time}" does not exist in ${APP_TIME_ZONE}.`);
  }

  return instant.toISOString();
}

/**
 * Gregorian `YYYY-MM-DD` key shifted by a whole number of calendar days
 * (negative goes backward). Pure calendar arithmetic via `Date.UTC`, so month,
 * year and leap-day overflow normalize on their own and the host timezone
 * never matters.
 */
export function addDaysToDateKey(dateKey: string, deltaDays: number): string {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new Error(`Date must be in YYYY-MM-DD format: received "${dateKey}".`);
  if (!Number.isInteger(deltaDays)) throw new Error("deltaDays must be a whole number.");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`"${dateKey}" is not a real calendar date.`);
  }

  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/** Wall-clock `HH:MM` for an instant in the app timezone, e.g. `08:30`. */
export function formatAppTime(value: Date | string): string {
  const { hour, minute } = zonedParts(assertValidInstant(value, "value"), APP_TIME_ZONE);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Jalali display string with Latin digits, e.g. `2 Mehr 1405`.
 * Derived from a persisted instant; Jalali text is never stored.
 */
export function formatJalaliDate(value: Date | string): string {
  const instant = assertValidInstant(value, "value");
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: APP_TIME_ZONE,
    year: "numeric", month: "long", day: "numeric",
  });

  const parts: Record<string, string> = {};
  for (const { type, value: text } of formatter.formatToParts(instant)) {
    if (type !== "literal") parts[type] = text;
  }

  // Assembled by hand so the order is "<day> <month> <year>" and the era
  // suffix ("AP") the locale appends is left out.
  return `${parts.day} ${parts.month} ${parts.year}`;
}

/** The application's Saturday-through-Friday week codes, in display order. */
export type WeekdayCode = "Sat" | "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri";

const ORDERED_WEEKDAYS: WeekdayCode[] = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

/** Weekday code for an instant's calendar date in the app timezone. */
export function weekdayCodeForDate(value: Date | string): WeekdayCode {
  const instant = assertValidInstant(value, "value");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "short",
  }).format(instant) as WeekdayCode;
}

/** Structured Jalali (Solar Hijri) calendar date, month numbered 1-12. */
export type JalaliDateParts = {
  year: number;
  month: number;
  monthName: string;
  day: number;
  weekday: WeekdayCode;
};

/**
 * Structured Jalali date parts for an instant, in the app timezone.
 *
 * Numeric year/month/day and the English month name both come from `Intl`'s
 * Persian calendar support with Latin digits, so no Gregorian↔Jalali
 * conversion table is hand-maintained here.
 */
export function getJalaliDateParts(value: Date | string = new Date()): JalaliDateParts {
  const instant = assertValidInstant(value, "value");

  const numericFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: APP_TIME_ZONE,
    year: "numeric", month: "numeric", day: "numeric",
  });
  const monthNameFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: APP_TIME_ZONE,
    month: "long",
  });

  const numeric: Record<string, string> = {};
  for (const { type, value: text } of numericFormatter.formatToParts(instant)) {
    if (type !== "literal") numeric[type] = text;
  }
  const monthName = monthNameFormatter.formatToParts(instant).find((p) => p.type === "month")?.value ?? "";

  return {
    year: Number(numeric.year),
    month: Number(numeric.month),
    monthName,
    day: Number(numeric.day),
    weekday: weekdayCodeForDate(instant),
  };
}

/** One day of the application's Saturday-through-Friday week strip. */
export type CalendarDay = {
  /** Gregorian `YYYY-MM-DD` in the app timezone; the bridge to persistence. */
  dateKey: string;
  jalaliYear: number;
  jalaliMonth: number;
  jalaliMonthName: string;
  jalaliDay: number;
  weekday: WeekdayCode;
  isToday: boolean;
};

/**
 * The seven `CalendarDay`s (Saturday → Friday) for the week containing the
 * given/current instant, each carrying its own Gregorian `dateKey` and Jalali
 * parts.
 *
 * Calendar dates are advanced with `Date.UTC`, which normalizes day/month/year
 * overflow on its own, so no fixed millisecond offset is added to an instant
 * (that could land on the wrong app-timezone calendar day). Each resulting
 * Gregorian date is then re-anchored to a representative app-timezone instant
 * via `localDateTimeToUtcIso`, reusing the same conversion `getAppDateKey`
 * relies on rather than duplicating it, so Jalali parts stay correct across
 * Jalali/Gregorian month and year boundaries.
 */
export function getAppWeek(value: Date | string = new Date()): CalendarDay[] {
  const instant = assertValidInstant(value, "value");
  const todayKey = getAppDateKey(instant);
  const { year, month, day } = zonedParts(instant, APP_TIME_ZONE);
  const saturdayIndex = ORDERED_WEEKDAYS.indexOf(weekdayCodeForDate(instant));

  const days: CalendarDay[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const cursor = new Date(Date.UTC(year, month - 1, day - saturdayIndex + offset));
    const dateKey = `${String(cursor.getUTCFullYear()).padStart(4, "0")}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;

    // Noon avoids any ambiguity near a app-timezone calendar-day boundary.
    const representativeInstant = new Date(localDateTimeToUtcIso(dateKey, "12:00"));
    const jalali = getJalaliDateParts(representativeInstant);

    days.push({
      dateKey,
      jalaliYear: jalali.year,
      jalaliMonth: jalali.month,
      jalaliMonthName: jalali.monthName,
      jalaliDay: jalali.day,
      weekday: ORDERED_WEEKDAYS[offset],
      isToday: dateKey === todayKey,
    });
  }

  return days;
}

/** One app-calendar date with its Gregorian `dateKey` and Jalali display parts. */
export type AppCalendarDate = {
  /** Gregorian `YYYY-MM-DD` in the app timezone; the bridge to persistence. */
  dateKey: string;
  jalaliYear: number;
  jalaliMonth: number;
  jalaliMonthName: string;
  jalaliDay: number;
  weekday: WeekdayCode;
};

/**
 * `count` app-calendar dates starting the day after `fromDateKey` (or, with
 * `includeStart: true`, starting at `fromDateKey` itself), each carrying its
 * own Gregorian `dateKey` and Jalali display parts.
 *
 * Calendar-safe and host-timezone independent: like `getAppWeek`, dates are
 * advanced with `Date.UTC`, which normalizes day/month/year overflow on its
 * own (no fixed millisecond offset is added to an instant), and each
 * resulting Gregorian date is re-anchored to a representative app-timezone
 * instant via `localDateTimeToUtcIso`, reusing the same conversion rather
 * than duplicating it, so Jalali parts stay correct across Jalali/Gregorian
 * month and year boundaries.
 */
export function getNextAppDates(
  fromDateKey: string,
  count: number,
  options?: { includeStart?: boolean }
): AppCalendarDate[] {
  const match = DATE_KEY_PATTERN.exec(fromDateKey);
  if (!match) {
    throw new Error(`fromDateKey must be in YYYY-MM-DD format: received "${fromDateKey}".`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const startOffset = options?.includeStart ? 0 : 1;

  const dates: AppCalendarDate[] = [];
  for (let i = 0; i < count; i++) {
    const cursor = new Date(Date.UTC(year, month - 1, day + startOffset + i));
    const dateKey = `${String(cursor.getUTCFullYear()).padStart(4, "0")}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;

    // Noon avoids any ambiguity near an app-timezone calendar-day boundary.
    const representativeInstant = new Date(localDateTimeToUtcIso(dateKey, "12:00"));
    const jalali = getJalaliDateParts(representativeInstant);

    dates.push({
      dateKey,
      jalaliYear: jalali.year,
      jalaliMonth: jalali.month,
      jalaliMonthName: jalali.monthName,
      jalaliDay: jalali.day,
      weekday: jalali.weekday,
    });
  }

  return dates;
}

/** One real Jalali (Solar Hijri) month laid out for a Saturday-first calendar grid. */
export type JalaliMonthGrid = {
  year: number;
  month: number;
  monthName: string;
  /** Gregorian `YYYY-MM-DD` of Jalali day 1 and of the real last day. */
  startDateKey: string;
  endDateKey: string;
  /** Empty cells before day 1 in a Saturday-first week (0-6). */
  leadingBlanks: number;
  days: { dateKey: string; jalaliDay: number; weekday: WeekdayCode }[];
};

/**
 * The Jalali month containing `dateKey`, with its real length (29-31 days,
 * leap years included) taken from `Intl`'s Persian calendar rather than a
 * hand-kept table. Every day carries its Gregorian `dateKey`, the bridge to
 * persistence, so nothing here depends on the host timezone.
 */
export function getJalaliMonthGrid(dateKey: string): JalaliMonthGrid {
  const noon = (key: string) => new Date(localDateTimeToUtcIso(key, "12:00"));
  const probe = getJalaliDateParts(noon(dateKey));
  const startDateKey = addDaysToDateKey(dateKey, -(probe.day - 1));

  const days: JalaliMonthGrid["days"] = [];
  for (let offset = 0; offset < 31; offset++) {
    const key = addDaysToDateKey(startDateKey, offset);
    const parts = getJalaliDateParts(noon(key));
    if (parts.month !== probe.month) break;
    days.push({ dateKey: key, jalaliDay: parts.day, weekday: parts.weekday });
  }

  return {
    year: probe.year,
    month: probe.month,
    monthName: probe.monthName,
    startDateKey,
    endDateKey: days[days.length - 1].dateKey,
    leadingBlanks: ORDERED_WEEKDAYS.indexOf(days[0].weekday),
    days,
  };
}

/** Gregorian `dateKey` of Jalali day 1 of the month `delta` months after (or before) `dateKey`'s month. */
export function shiftJalaliMonth(dateKey: string, delta: number): string {
  let grid = getJalaliMonthGrid(dateKey);
  for (let step = 0; step < Math.abs(delta); step++) {
    grid = getJalaliMonthGrid(addDaysToDateKey(delta > 0 ? grid.endDateKey : grid.startDateKey, delta > 0 ? 1 : -1));
  }
  return grid.startDateKey;
}
