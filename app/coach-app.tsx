"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Apple, ArrowRight, Bell, CalendarDays, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleUserRound, Dumbbell, LayoutDashboard,
  Leaf, LogOut, MessageCircle, MoreHorizontal, Plus, Search, Settings,
  ShieldCheck, Sparkles, Target, UsersRound, Utensils, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { MemberCycleSection } from "./coach-cycle-section";
import { getAppDateKey, getAppWeek, getJalaliDateParts, getJalaliMonthGrid, shiftJalaliMonth, formatJalaliDate, localDateTimeToUtcIso, getNextAppDates, type WeekdayCode } from "@/lib/date-time";
import { DISPLAY_LABELS, attendanceActions, buildDayAttendance, shortJalaliLabel, summarizeDates, summarizeToday, type AttendanceAction, type AttendanceRow, type DaySummary, type DisplayState } from "@/lib/coach-calendar";
import { isDateKeyInDetailWindow } from "@/lib/session-detail-window";
import { buildMuscleFreshness, freshnessBucket, type MuscleFreshness } from "@/lib/muscle-freshness";
import { newSessionsStoreValue, useCoachSessionsRanges, type SessionsStore } from "./use-coach-sessions-ranges";

type View = "today" | "clients" | "calendar" | "nutrition" | "settings";
type MuscleKey = "shoulders" | "chest" | "arms" | "core" | "back" | "glutes" | "quads" | "hamstrings" | "calves";

/** Persisted member profile. Shape matches `GET /api/members` exactly. */
type MemberProfile = {
  id: number; name: string; coachId: number; goal: string;
  /** Nullable for legacy members created before these fields existed. */
  phone: string | null; weightKg: number | null; heightCm: number | null;
  defaultStartTime: string; defaultDurationMinutes: number;
  preferredDays: string[]; photoUrl: string | null;
  /** Roster only: lets the Calendar avoid "Not recorded" before the Member existed. */
  createdAt: string;
};

/**
 * TEMPORARY MOCK DATA — nothing in here is persisted.
 * Sessions, packages and body-map history have no database tables yet, so these
 * fields are still fixtures joined by member id. Delete each one as its real
 * domain lands; never present these values as stored state.
 */
type MockMemberOperationalState = {
  sessionsLeft: number; sessionsTotal: number;
  periodStart: string; periodEnd: string;
};

/** Render-layer view: persisted profile + mock operational state + UI-only fields. */
type Student = MemberProfile & MockMemberOperationalState & {
  /** Derived from `name`; never fetched or stored. */
  initials: string;
  /** Presentation only: avatar gradient colour. */
  accent: string;
};
type Meal = {
  id: number; owner: string; day: string; type: string; time: string; description: string;
  protein: boolean; produce: boolean; water: number;
};
/** Only the fields the manual "Log session" discovery needs from `GET /api/sessions` rows. */
type PersistedSession = { id: number; status: string; replacementForId: number | null };

/** Only the fields the Client Profile's Session Notes list needs. */
type SessionHistoryItem = {
  id: number;
  scheduledAt: string;
  status: string;
  replacementForId: number | null;
  note: null | { id: number; note: string; createdAt: string; updatedAt: string };
  /** Canonical keys in canonical order; empty when none were recorded or detail has expired. */
  muscles: MuscleKey[];
};

const labels: Record<MuscleKey, string> = {
  shoulders: "Shoulders", chest: "Chest", arms: "Arms", core: "Core",
  back: "Back", glutes: "Glutes", quads: "Quads", hamstrings: "Hamstrings", calves: "Calves",
};

/** Canonical key order, identical to the backend `muscleKeys`. */
const MUSCLE_ORDER = Object.keys(labels) as MuscleKey[];

// TEMPORARY MOCK FIXTURES — keyed by member id, joined onto persisted profiles.
// These cover only domains with no database tables yet (sessions, packages,
// plan-period fields). They contain no profile data: no name, goal, time,
// duration, preferred days or photo.
const mockOperationalState: Record<number, MockMemberOperationalState> = {
  1: { sessionsLeft: 6, sessionsTotal: 12, periodStart: "1405/05/27", periodEnd: "1405/07/10" },
  2: { sessionsLeft: 2, sessionsTotal: 10, periodStart: "1405/05/20", periodEnd: "1405/06/31" },
  3: { sessionsLeft: 9, sessionsTotal: 12, periodStart: "1405/06/10", periodEnd: "1405/07/25" },
  4: { sessionsLeft: 4, sessionsTotal: 8, periodStart: "1405/06/01", periodEnd: "1405/07/01" },
};

/** Neutral placeholders for a member with no fixture. Not persisted data. */
const neutralOperationalState: MockMemberOperationalState = {
  sessionsLeft: 0, sessionsTotal: 0,
  periodStart: "—", periodEnd: "—",
};

// UI-only avatar palette; assigned by position, never stored.
const accentPalette = ["#dfff24", "#f1b57e", "#9dc796", "#b9c2d3"];

const NOT_RECORDED = "Not recorded";

/** Renders a persisted measurement, or the empty state when it is null. */
function measurement(value: number | null, unit: string) {
  // String() keeps 72.5 as "72.5" and 72 as "72": no forced trailing zeros.
  return value === null ? NOT_RECORDED : `${String(value)} ${unit}`;
}

/**
 * Derived, never stored: a member is complete once the product-required
 * contact and measurement fields are present.
 */
function isProfileComplete(member: MemberProfile) {
  return member.phone !== null && member.weightKg !== null && member.heightCm !== null;
}

const WEEKDAY_FULL_NAMES: Record<WeekdayCode, string> = {
  Sat: "SATURDAY", Sun: "SUNDAY", Mon: "MONDAY", Tue: "TUESDAY",
  Wed: "WEDNESDAY", Thu: "THURSDAY", Fri: "FRIDAY",
};

/** `"FRIDAY · 20 SHAHRIVAR 1405"`-style eyebrow for the current app date. */
function todayEyebrow() {
  const today = getJalaliDateParts();
  return `${WEEKDAY_FULL_NAMES[today.weekday]} · ${today.day} ${today.monthName.toUpperCase()} ${today.year}`;
}

/** Jalali display label for a persisted `YYYY-MM-DD` calendar-day key. */
function jalaliLabelForDateKey(dateKey: string): string {
  return formatJalaliDate(localDateTimeToUtcIso(dateKey, "12:00"));
}

function initialsFor(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

/** Compose a persisted profile with derived UI fields and mock operational state. */
function toStudent(profile: MemberProfile, index: number): Student {
  return {
    ...profile,
    ...(mockOperationalState[profile.id] ?? neutralOperationalState),
    initials: initialsFor(profile.name),
    accent: accentPalette[index % accentPalette.length],
  };
}

const weekDays = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

const initialMeals: Meal[] = [
  { id: 1, owner: "Alex Morgan", day: "Sat 14", type: "Breakfast", time: "07:20", description: "Greek yogurt, berries, oats and almonds", protein: true, produce: true, water: 2 },
  { id: 2, owner: "Alex Morgan", day: "Sun 15", type: "Lunch", time: "12:45", description: "Chicken bowl with rice, greens and avocado", protein: true, produce: true, water: 3 },
  { id: 3, owner: "Alex Morgan", day: "Tue 17", type: "Snack", time: "16:10", description: "Greek yogurt, banana and almonds", protein: true, produce: true, water: 1 },
  { id: 4, owner: "Alex Morgan", day: "Thu 19", type: "Breakfast", time: "07:35", description: "Greek yogurt, berries and oats", protein: true, produce: true, water: 2 },
  { id: 5, owner: "Maya Chen", day: "Sat 14", type: "Breakfast", time: "08:10", description: "Toast, banana and coffee", protein: false, produce: true, water: 1 },
  { id: 6, owner: "Maya Chen", day: "Mon 16", type: "Snack", time: "15:40", description: "Banana and coffee", protein: false, produce: true, water: 1 },
  { id: 7, owner: "Maya Chen", day: "Wed 18", type: "Dinner", time: "20:15", description: "Salmon, potatoes and green beans", protein: true, produce: true, water: 2 },
  { id: 8, owner: "Daniel Reed", day: "Sun 15", type: "Lunch", time: "13:05", description: "Tuna sandwich and side salad", protein: true, produce: true, water: 2 },
  { id: 9, owner: "Daniel Reed", day: "Tue 17", type: "Dinner", time: "19:50", description: "Chicken, rice and roasted vegetables", protein: true, produce: true, water: 3 },
  { id: 10, owner: "Daniel Reed", day: "Thu 19", type: "Snack", time: "16:20", description: "Protein shake and apple", protein: true, produce: true, water: 2 },
  { id: 11, owner: "Nina Patel", day: "Mon 16", type: "Lunch", time: "12:30", description: "Pasta with tomato sauce", protein: false, produce: true, water: 1 },
  { id: 12, owner: "Nina Patel", day: "Fri 20", type: "Snack", time: "17:15", description: "Crackers and coffee", protein: false, produce: false, water: 1 },
];

const coachNav = [
  ["today", "Today", LayoutDashboard], ["clients", "Clients", UsersRound],
  ["calendar", "Calendar", CalendarDays], ["nutrition", "Nutrition", Apple], ["settings", "Settings", Settings],
] as const;

const BUCKET_COLORS = { l0: "#dcff28", l1: "#86bd75", l2: "#f0cc64", l3: "#e6a37d", none: "#cfd3ce" } as const;
/** Existing Body Map scale, now fed by real days-since (null = nothing recorded). */
function muscleColor(daysSince: number | null) {
  return BUCKET_COLORS[freshnessBucket(daysSince)];
}

/** "Trained today" / "1 day ago" / "12 days ago", or the empty-detail sentence. */
function freshnessText(entry: MuscleFreshness[MuscleKey]) {
  if (!entry) return "No muscle detail recorded in the last 30 days";
  if (entry.daysSince <= 0) return "Trained today";
  return `${entry.daysSince} ${entry.daysSince === 1 ? "day" : "days"} ago`;
}

function Avatar({ student, large = false, onClick }: { student: Student; large?: boolean; onClick?: () => void }) {
  const className = large ? "avatar avatar-lg" : "avatar";
  const content = student.photoUrl ? <img src={student.photoUrl} alt={student.name} /> : student.initials;
  return onClick ? <button type="button" className={className} style={{ background: `linear-gradient(145deg,${student.accent},#fff)` }} onClick={onClick} aria-label={`Open ${student.name} profile photo`}>{content}</button> : <span className={className} style={{ background: `linear-gradient(145deg,${student.accent},#fff)` }}>{content}</span>;
}

function AppLogo({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return <button type="button" className={compact ? "app-logo app-logo-compact" : "app-logo"} onClick={onClick} aria-label="Open Fit & Mischief logo"><img src="/app-logo.png" alt="Fit & Mischief App" /></button>;
}

function AccountPhoto({ src, initials, name, onClick }: { src?: string | null; initials: string; name: string; onClick: () => void }) {
  return <button type="button" className="coach-avatar account-photo" onClick={onClick} aria-label={`Choose ${name} profile photo`}>{src ? <img src={src} alt={name} /> : initials}</button>;
}

function AttendanceButtons({ actions, onAction }: { actions: AttendanceAction[]; onAction: (kind: AttendanceAction["kind"]) => void }) {
  return <>{actions.map((a) => <button type="button" key={a.kind} data-action={a.kind} className={`att-btn att-${a.kind}${a.label === "Present" ? " calendar-present" : ""}`} onClick={(e) => { e.stopPropagation(); onAction(a.kind); }}>{a.kind === "absent" ? <X /> : <Check />} {a.label}</button>)}</>;
}

/** The attendance-row action Today and Calendar both raise; CoachApp owns the dialogs and writes. */
type AttendanceTarget = { memberId: number; dateKey: string; sessionId: number | null };
type OnAttendance = (target: AttendanceTarget, kind: AttendanceAction["kind"]) => void;

function MiniWave() {
  return <svg className="wave" viewBox="0 0 320 80" aria-hidden="true"><path d="M2 45C35 45 35 12 70 12s35 53 70 53 35-41 70-41 35 26 108 26" /><path d="M2 45c43 0 48-15 80-15s43 21 78 21 45-13 78-13 37 12 80 12" /><circle cx="2" cy="45" r="5" /><circle className="wave-end" cx="318" cy="50" r="5" /></svg>;
}

type ShapeProps = { k: MuscleKey; d?: string; cx?: number; cy?: number; rx?: number; ry?: number };
/** The nine canonical muscles as toggle chips; shared by the completion dialog and history editing. */
function MusclePicker({ value, onChange, disabled }: { value: MuscleKey[]; onChange: (next: MuscleKey[]) => void; disabled?: boolean }) {
  return <div className="muscle-picker" role="group" aria-label="Muscles trained">{MUSCLE_ORDER.map((key) => { const on = value.includes(key); return <button type="button" key={key} className="muscle-chip" aria-pressed={on} disabled={disabled} onClick={() => onChange(on ? value.filter((k) => k !== key) : [...value, key])}>{labels[key]}</button>; })}</div>;
}

type BodyMapData = { freshness: MuscleFreshness; status: "loading" | "error" | "ready"; retry: () => void };
function BodyMap({ student, data, selected, onSelect }: { student: Student; data: BodyMapData; selected: MuscleKey; onSelect: (m: MuscleKey) => void }) {
  const ready = data.status === "ready";
  const daysFor = (k: MuscleKey) => (ready ? data.freshness[k]?.daysSince ?? null : null);
  const anyRecorded = ready && MUSCLE_ORDER.some((k) => data.freshness[k] !== null);
  const shape = ({ k, d, cx, cy, rx, ry }: ShapeProps) => {
    const common = { fill: muscleColor(daysFor(k)), onClick: () => onSelect(k), tabIndex: 0, role: "button", "aria-label": labels[k], onKeyDown: (e: React.KeyboardEvent<SVGElement>) => (e.key === "Enter" || e.key === " ") && onSelect(k), className: selected === k ? "muscle active-muscle" : "muscle" };
    return d ? <path {...common} d={d} /> : <ellipse {...common} cx={cx} cy={cy} rx={rx} ry={ry} />;
  };
  return <article className="body-map">
    <div className="card-head"><div><span className="eyebrow">TRAINING FOCUS</span><h2>Your body, at a glance.</h2><p className="body-map-copy">Training focus from session details kept in the last 30 days.</p></div></div>
    <div className="anatomy-stage">
      <svg viewBox="0 0 340 420" role="img" aria-label={`Interactive muscle map for ${student.name}`}>
        <defs><linearGradient id="bodyFade" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#f5f7f3" /><stop offset="1" stopColor="#dce3da" /></linearGradient></defs>
        <text x="88" y="408">FRONT</text><text x="240" y="408">BACK</text>
        {[28, 181].map((x) => <g className="body-base" transform={`translate(${x} 12)`} key={x}><circle cx="72" cy="32" r="22" /><path d="M50 58C38 72 36 104 40 138l10 78c3 34 1 71-5 144h25l6-125 7 125h25c-6-73-8-110-5-144l11-78c4-34 0-66-20-80z" /><path d="M43 76c-18 28-25 75-26 135h17l17-85zM101 76c21 28 28 75 29 135h-17l-17-85z" /></g>)}
        <g transform="translate(28 12)">
          {shape({ k: "shoulders", cx: 47, cy: 79, rx: 15, ry: 20 })}{shape({ k: "shoulders", cx: 99, cy: 79, rx: 15, ry: 20 })}
          {shape({ k: "chest", d: "M54 72q18-9 18 21-14 9-22-2z" })}{shape({ k: "chest", d: "M74 72q18-9 22 19-9 11-22 2z" })}
          {shape({ k: "arms", d: "M37 91q-9 29-12 89l13 1 13-80z" })}{shape({ k: "arms", d: "M107 91q11 29 15 89l-13 1-14-80z" })}
          {shape({ k: "core", d: "M55 105q18-7 36 0l-3 72q-15 10-30 0z" })}
          {shape({ k: "quads", d: "M52 195q11-7 21 4l-5 80H49z" })}{shape({ k: "quads", d: "M76 199q11-11 22-4l3 84H82z" })}
          {shape({ k: "calves", d: "M49 288q11-10 19 0l-4 51H50z" })}{shape({ k: "calves", d: "M82 288q9-10 19 0l-3 51H84z" })}
        </g>
        <g transform="translate(181 12)">
          {shape({ k: "shoulders", cx: 47, cy: 79, rx: 15, ry: 20 })}{shape({ k: "shoulders", cx: 99, cy: 79, rx: 15, ry: 20 })}
          {shape({ k: "back", d: "M52 73q21-10 43 0l-4 78q-18 17-36 0z" })}
          {shape({ k: "arms", d: "M37 91q-9 29-12 89l13 1 13-80z" })}{shape({ k: "arms", d: "M107 91q11 29 15 89l-13 1-14-80z" })}
          {shape({ k: "glutes", cx: 63, cy: 180, rx: 17, ry: 18 })}{shape({ k: "glutes", cx: 83, cy: 180, rx: 17, ry: 18 })}
          {shape({ k: "hamstrings", d: "M52 201q10-11 20 0l-5 76H49z" })}{shape({ k: "hamstrings", d: "M76 201q11-11 22 0l3 76H83z" })}
          {shape({ k: "calves", d: "M49 288q11-10 19 0l-4 51H50z" })}{shape({ k: "calves", d: "M82 288q9-10 19 0l-3 51H84z" })}
        </g>
      </svg>
      <div className="muscle-pop"><i style={{ background: muscleColor(daysFor(selected)) }} /><small>{labels[selected]}</small>{data.status === "loading" ? <strong>Loading…</strong> : data.status === "error" ? <><strong>Could not load</strong><p role="alert">Session history could not be read. <button type="button" className="text-link" onClick={data.retry}>Retry</button></p></> : <strong>{freshnessText(data.freshness[selected])}</strong>}</div>
    </div>
    <div className="legend"><span><i className="l0" />0–1d</span><span><i className="l1" />2–4d</span><span><i className="l2" />5–7d</span><span><i className="l3" />8–14d</span><span><i className="l4" />Over 14d / none</span></div>
    {ready && !anyRecorded && <p className="body-map-empty">No muscle detail recorded in the last 30 days.</p>}
  </article>;
}

function Heading({ eyebrow, title, sub, action }: { eyebrow: string; title: string; sub: string; action?: React.ReactNode }) {
  return <section className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{sub}</p></div>{action}</section>;
}

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The Jalali-month range containing `dateKey`: the same range shape the Calendar requests. */
function monthRangeOf(dateKey: string) {
  const grid = getJalaliMonthGrid(dateKey);
  return { from: grid.startDateKey, to: grid.endDateKey };
}

function CoachDashboard({ students, selected, select, apiFetch, version, store, onAttendance, logSession, addClient, openCalendar, muscle, setMuscle, bodyMap }: {
  students: Student[]; selected?: Student; select: (id: number) => void;
  apiFetch: ApiFetch;
  /** Bumped by CoachApp after a Session write so Today reloads from the database. */
  version: number; store: SessionsStore;
  onAttendance: OnAttendance; logSession: () => void;
  addClient: () => void; openCalendar: () => void; muscle: MuscleKey; setMuscle: (m: MuscleKey) => void;
  bodyMap: BodyMapData;
}) {
  // Same read model as the Calendar: expected schedule merged with persisted Sessions.
  const [todayKey] = useState(() => getAppDateKey());
  const ranges = useMemo(() => [monthRangeOf(todayKey)], [todayKey]);
  const data = useCoachSessionsRanges(apiFetch, ranges, version, store);
  const rows = useMemo(
    () => (data.ready ? buildDayAttendance(students, data.sessions, todayKey, todayKey) : []),
    [data.ready, data.sessions, students, todayKey]
  );
  const summary = summarizeToday(rows);
  const stat = (value: number) => (data.ready ? String(value) : "—");
  const memberFor = (id: number) => students.find((s) => s.id === id);
  const sub = !data.ready ? "Reading today’s sessions…"
    : summary.load === 0 ? "No members scheduled today."
    : `${summary.load} ${summary.load === 1 ? "session" : "sessions"} today · ${summary.completed} completed.`;
  return <>
    <Heading eyebrow={todayEyebrow()} title="Your day, at a glance." sub={sub} action={selected && <Button className="primary-action" onClick={logSession}><Plus /> Log a session</Button>} />
    <section className="metrics">
      <article className="metric green"><span>TODAY’S LOAD</span><strong>{stat(summary.load)}</strong><small>{summary.load === 1 ? "session" : "sessions"}</small><MiniWave /></article>
      <article className="metric gold"><span>COMPLETED TODAY</span><strong>{stat(summary.completed)}</strong><small>of {data.ready ? summary.load : "—"} scheduled</small></article>
      <article className="metric slate"><span>ABSENT TODAY</span><strong>{stat(summary.absent)}</strong><small>{data.ready ? summary.pendingReplacements : "—"} replacement{summary.pendingReplacements === 1 ? "" : "s"} pending today</small></article>
    </section>
    <section className="dashboard-grid">
      <article className="surface schedule">
        <div className="card-head"><div><span className="eyebrow">SCHEDULE</span><h2>Today’s sessions</h2></div><button className="soft-button" onClick={addClient}><Plus /> Add client</button></div>
        {data.error ? <div className="empty-agenda" role="alert"><CalendarDays /><strong>Could not load sessions</strong><span>Your clients are still available.</span><button className="soft-button" onClick={data.retry}>Retry</button></div>
          : !data.ready ? <div className="empty-agenda"><CalendarDays /><strong>Loading sessions…</strong></div>
          : rows.length === 0 ? <div className="empty-agenda"><CalendarDays /><strong>No members scheduled.</strong><span>{students.length === 0 ? "Add a client to start scheduling." : "Nobody is expected today."}</span></div>
          : <div className="schedule-list">{rows.map((row: AttendanceRow) => { const s = memberFor(row.memberId); if (!s) return null; return <div className={`schedule-row ${selected?.id === s.id ? "selected-row" : ""}`} key={row.key} data-member={s.name} data-state={row.state} onClick={() => select(s.id)}><time>{row.time}</time><Avatar student={s} /><div><strong>{s.name}</strong><small>{row.durationMinutes ?? s.defaultDurationMinutes} min · {s.goal}</small></div><div className="attend" onClick={(e) => e.stopPropagation()}><span className={`status status-${row.state}`}>{DISPLAY_LABELS[row.state]}</span><AttendanceButtons actions={attendanceActions(row, todayKey, todayKey)} onAction={(kind) => onAttendance({ memberId: s.id, dateKey: todayKey, sessionId: row.sessionId }, kind)} /></div><ChevronRight /></div>; })}</div>}
        <button className="text-link" onClick={openCalendar}>View full calendar <ArrowRight /></button>
      </article>
      {selected && <article className="surface session-card">
        <div className="card-head"><div><span className="eyebrow">SELECTED CLIENT</span><h2>{selected.name}</h2></div><Avatar student={selected} /></div>
        <div className="session-next"><small><CalendarDays /> Usual schedule</small><strong>{selected.preferredDays.join(" · ") || "No preferred days"} · {selected.defaultStartTime}</strong></div>
        <div className="session-next"><small><Target /> Goal</small><strong>{selected.goal}</strong></div>
        <Button className="wide-dark" onClick={logSession}>Log a session <ArrowRight /></Button>
      </article>}
    </section>
    {selected && <section className="body-grid body-grid-single">
      <BodyMap student={selected} data={bodyMap} selected={muscle} onSelect={setMuscle} />
    </section>}
  </>;
}

function Clients({ apiFetch, students, selected, select, add, log, editSchedule, editProfile, noteHistory, noteHistoryLoading, noteHistoryError, retryNoteHistory, muscle, setMuscle, bodyMap, onEditMuscles }: {
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  students: Student[]; selected: Student; select: (id: number) => void; add: () => void;
  log: () => void; editSchedule: () => void; editProfile: () => void;
  noteHistory: SessionHistoryItem[]; noteHistoryLoading: boolean; noteHistoryError: string | null;
  retryNoteHistory: () => void;
  muscle: MuscleKey; setMuscle: (m: MuscleKey) => void;
  bodyMap: BodyMapData; onEditMuscles: (item: SessionHistoryItem) => void;
}) {
  // The API returns every persisted status. Detail (note, muscles) only ever attaches
  // to completed Sessions, and only exists inside the 30-day window, so the list is
  // the completed Sessions still inside it; older rows keep their attendance
  // elsewhere (Calendar) but have no detail to show or edit.
  const todayKey = getAppDateKey();
  const retained = noteHistory
    .map((item) => ({ item, dateKey: getAppDateKey(new Date(item.scheduledAt)) }))
    .filter(({ item, dateKey }) => item.status === "completed" && isDateKeyInDetailWindow(dateKey, todayKey));
  return <>
    <Heading eyebrow="CLIENT DIRECTORY" title="Your people." sub={`${students.length} active ${students.length === 1 ? "client" : "clients"}`} action={<Button className="primary-action" onClick={add}><Plus /> Add client</Button>} />
    <section className="clients-grid">
      <article className="surface directory"><label className="search"><Search /><input placeholder="Search clients" /></label><div>{students.map((s) => <button className={selected.id === s.id ? "selected-client" : ""} key={s.id} onClick={() => select(s.id)}><Avatar student={s} /><span><strong>{s.name}</strong><small>{s.goal}</small></span><b>{s.sessionsLeft}<small>left</small></b><ChevronRight /></button>)}</div></article>
      <div className="client-detail"><article className="surface profile-card"><div className="person"><Avatar student={selected} large /><div><span className="eyebrow">ACTIVE CLIENT</span><h2>{selected.name}</h2><p>{selected.goal}</p>{!isProfileComplete(selected) && <span className="chip">Profile incomplete</span>}</div></div><div className="action-pair"><Button className="soft-button" onClick={editProfile}><CircleUserRound /> Edit profile</Button><Button className="soft-button" onClick={editSchedule}><CalendarDays /> Edit schedule</Button><Button className="wide-dark fit" onClick={log}><Plus /> Log session</Button></div><div className="profile-stats"><span><strong>{selected.phone ?? NOT_RECORDED}</strong>phone</span><span><strong>{measurement(selected.weightKg, "kg")}</strong>weight</span><span><strong>{measurement(selected.heightCm, "cm")}</strong>height</span></div><div className="profile-stats"><span><strong>{selected.sessionsLeft}</strong>sessions left</span><span><strong>{selected.defaultDurationMinutes}</strong>minutes / session</span><span><strong>{selected.preferredDays.length}</strong>weekly days</span></div></article><MemberCycleSection key={selected.id} memberId={selected.id} apiFetch={apiFetch} /><article className="surface session-notes-card"><div className="card-head"><div><span className="eyebrow">SESSION HISTORY</span><h2>Recent sessions</h2></div><span className="chip">{retained.length} {retained.length === 1 ? "session" : "sessions"}</span></div>{noteHistoryLoading ? <p className="policy-note">Loading session history…</p> : noteHistoryError ? <p className="policy-note" role="alert">{noteHistoryError} <button type="button" className="text-link" onClick={retryNoteHistory}>Retry</button></p> : retained.length === 0 ? <p className="policy-note">No completed sessions with details from the last 30 days.</p> : <div className="session-note-list">{retained.map(({ item }) => <div className="session-note" key={item.id} data-session={item.id}><time>{formatJalaliDate(item.scheduledAt)}{item.replacementForId !== null && <small>Replacement</small>}</time><div>{item.note && <p>{item.note.note}</p>}{item.muscles.length > 0 && <div className="muscle-tags" aria-label="Muscles trained">{item.muscles.map((key) => <span className="muscle-tag" key={key}>{labels[key]}</span>)}</div>}<button type="button" className="text-link edit-muscles" onClick={() => onEditMuscles(item)}>{item.muscles.length > 0 ? "Edit muscles" : "Add muscles"}</button></div></div>)}</div>}</article><BodyMap student={selected} data={bodyMap} selected={muscle} onSelect={setMuscle} /></div>
    </section>
  </>;
}

const CALENDAR_WEEKDAYS: WeekdayCode[] = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
const MARK_ORDER: DisplayState[] = ["completed", "replacement-completed", "replacement-pending", "absent", "not-recorded", "expected"];

/** Compact per-day indicator: one dot per state present, plus the entry count. */
function DayMarks({ summary }: { summary?: DaySummary }) {
  if (!summary || summary.total === 0) return null;
  return <span className="cal-marks">{MARK_ORDER.filter((state) => summary.counts[state]).map((state) => <i key={state} className={`cal-dot cal-dot-${state}`} title={`${DISPLAY_LABELS[state]}: ${summary.counts[state]}`} />)}<small>{summary.total}</small></span>;
}

function CalendarView({ students, apiFetch, version, store, onAttendance, editSchedule }: {
  students: Student[];
  apiFetch: ApiFetch;
  /** Bumped by CoachApp after a Session mutation so the visible months reload. */
  version: number; store: SessionsStore;
  onAttendance: OnAttendance;
  editSchedule: (id: number) => void;
}) {
  const [mode, setMode] = useState<"week" | "month">("week");
  // Anchored once per mount so the visible month and "today" agree with each other.
  const [anchor] = useState(() => new Date());
  const todayKey = useMemo(() => getAppDateKey(anchor), [anchor]);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const [visibleMonth, setVisibleMonth] = useState(todayKey);
  const grid = useMemo(() => getJalaliMonthGrid(visibleMonth), [visibleMonth]);
  const week = useMemo(() => getAppWeek(new Date(localDateTimeToUtcIso(selectedDateKey, "12:00"))), [selectedDateKey]);

  // One range per displayed Jalali month. In week mode a week that straddles two
  // months also needs the neighbouring month; each month is requested once.
  const ranges = useMemo(() => {
    const list = [{ from: grid.startDateKey, to: grid.endDateKey }];
    if (mode === "week") {
      for (const edge of [week[0].dateKey, week[6].dateKey]) {
        if (edge >= grid.startDateKey && edge <= grid.endDateKey) continue;
        const other = getJalaliMonthGrid(edge);
        if (!list.some((r) => r.from === other.startDateKey)) list.push({ from: other.startDateKey, to: other.endDateKey });
      }
    }
    return list;
  }, [mode, grid, week]);
  const data = useCoachSessionsRanges(apiFetch, ranges, version, store);

  const summaries = useMemo(() => {
    if (!data.ready) return new Map<string, DaySummary>();
    const dateKeys = [...new Set([...grid.days.map((d) => d.dateKey), ...week.map((d) => d.dateKey)])];
    return summarizeDates(students, data.sessions, dateKeys, todayKey);
  }, [data.ready, data.sessions, students, grid, week, todayKey]);
  const rows = useMemo(
    () => (data.ready ? buildDayAttendance(students, data.sessions, selectedDateKey, todayKey) : []),
    [data.ready, data.sessions, students, selectedDateKey, todayKey]
  );

  const selectDate = (dateKey: string) => {
    setSelectedDateKey(dateKey);
    if (dateKey < grid.startDateKey || dateKey > grid.endDateKey) setVisibleMonth(dateKey);
  };
  const goToMonth = (delta: number) => {
    const first = shiftJalaliMonth(visibleMonth, delta);
    const target = getJalaliMonthGrid(first);
    setVisibleMonth(first);
    setSelectedDateKey(todayKey >= target.startDateKey && todayKey <= target.endDateKey ? todayKey : first);
  };
  const goToToday = () => { setVisibleMonth(todayKey); setSelectedDateKey(todayKey); };

  const selectedParts = getJalaliDateParts(new Date(localDateTimeToUtcIso(selectedDateKey, "12:00")));
  const dayLabel = `${selectedParts.weekday}, ${selectedParts.day} ${selectedParts.monthName} ${selectedParts.year}`;
  const headerEyebrow = `${grid.monthName.toUpperCase()} ${grid.year}`;
  const memberFor = (id: number) => students.find((s) => s.id === id);
  const entryLabel = rows.length === 1 ? "entry" : "entries";
  const linkText = (row: (typeof rows)[number]) => {
    if (row.link?.kind === "replacement-for") return `Replacement for ${shortJalaliLabel(row.link.dateKey)}`;
    if (row.link?.kind === "replaced-on") return `Replaced on ${shortJalaliLabel(row.link.dateKey)}`;
    return row.state === "replacement-pending" || row.state === "replacement-completed" ? "Replacement" : null;
  };
  const dayButton = (dateKey: string, children: React.ReactNode) => (
    <button key={dateKey} data-date={dateKey} data-top={summaries.get(dateKey)?.top ?? ""}
      className={`${dateKey === todayKey ? "today-day" : ""} ${dateKey === selectedDateKey ? "selected-day" : ""}`}
      onClick={() => selectDate(dateKey)}>{children}</button>
  );

  return <>
    <Heading eyebrow={headerEyebrow} title={mode === "week" ? "Your training week." : "Your training month."} sub="Select any Solar Hijri date to review scheduled and completed sessions." action={<div className="calendar-actions"><div className="month-nav"><button className="soft-button" aria-label="Previous month" onClick={() => goToMonth(-1)}><ChevronLeft /></button><button className="soft-button" onClick={goToToday}>Today</button><button className="soft-button" aria-label="Next month" onClick={() => goToMonth(1)}><ChevronRight /></button></div><div className="view-toggle"><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button><button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>Month</button></div><Button className="primary-action" onClick={() => toast.success("Choose a client to edit their schedule")}><Plus /> Schedule</Button></div>} />
    <article className="surface calendar">
      {mode === "week"
        ? <div className="week">{week.map((d) => dayButton(d.dateKey, <><span>{d.weekday}</span><strong>{d.jalaliDay}</strong><DayMarks summary={summaries.get(d.dateKey)} />{d.dateKey === todayKey && <i />}</>))}</div>
        : <div className="month-view"><div className="month-weekdays">{CALENDAR_WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid">{Array.from({ length: grid.leadingBlanks }, (_, i) => <i key={`blank-${i}`} />)}{grid.days.map((d) => dayButton(d.dateKey, <><strong>{d.jalaliDay}</strong><DayMarks summary={summaries.get(d.dateKey)} /></>))}</div></div>}
      <div className="agenda">
        <div className="card-head"><div><span className="eyebrow">{selectedDateKey < todayKey ? "HISTORY" : selectedDateKey === todayKey ? "TODAY" : "UPCOMING"}</span><h2>{dayLabel}</h2></div>{data.ready && <span className="chip">{rows.length} {entryLabel}</span>}</div>
        {data.error ? <div className="empty-agenda" role="alert"><CalendarDays /><strong>Could not load sessions</strong><span>Your clients are still available.</span><button className="soft-button" onClick={data.retry}>Retry</button></div>
          : data.loading ? <div className="empty-agenda"><CalendarDays /><strong>Loading sessions…</strong></div>
          : rows.length ? rows.map((row, i) => { const s = memberFor(row.memberId); if (!s) return null; const link = linkText(row); return <div className="agenda-row" key={row.key} data-member={s.name} data-state={row.state}><time>{row.time}<small>{row.durationMinutes ?? s.defaultDurationMinutes} min</small></time><i className={`line line-${i % 3}`} /><Avatar student={s} /><div><strong>{s.name}</strong><small>{link ?? s.goal}</small></div><div className="agenda-actions"><span className={`status status-${row.state}`}>{DISPLAY_LABELS[row.state]}</span><AttendanceButtons actions={attendanceActions(row, selectedDateKey, todayKey)} onAction={(kind) => onAttendance({ memberId: s.id, dateKey: selectedDateKey, sessionId: row.sessionId }, kind)} /></div><button aria-label={`Edit ${s.name} schedule`} onClick={() => editSchedule(s.id)}><MoreHorizontal /></button></div>; })
          : <div className="empty-agenda"><CalendarDays /><strong>No sessions on this day</strong><span>Select another date or schedule a client.</span></div>}
      </div>
    </article>
  </>;
}

const nutritionSignals = [
  { name: "Alex Morgan", consistency: 86, protein: 91, hydration: 72, note: "Strong protein coverage · hydration needs attention" },
  { name: "Maya Chen", consistency: 71, protein: 54, hydration: 61, note: "Add protein to breakfast and post-session meals" },
  { name: "Daniel Reed", consistency: 79, protein: 82, hydration: 78, note: "Balanced week · keep evening hydration steady" },
  { name: "Nina Patel", consistency: 43, protein: 67, hydration: 48, note: "Three missing days · follow up before next session" },
];

function Nutrition({ meals, students, selected, select }: { meals: Meal[]; students: Student[]; selected: Student; select: (id: number) => void }) {
  const visibleMeals = meals.filter((m) => m.owner === selected.name);
  const signal = nutritionSignals.find((item) => item.name === selected.name) ?? nutritionSignals[0];
  const repetition: Record<string, { title: string; text: string }> = {
    "Alex Morgan": { title: "Greek yogurt appears 3 times", text: "A useful protein anchor, but rotate one serving with eggs or cottage cheese for more variety." },
    "Maya Chen": { title: "Banana and coffee repeat twice", text: "The pattern is low in protein. Pair the next snack with yogurt, milk or a handful of nuts." },
    "Daniel Reed": { title: "Chicken and tuna lead the week", text: "Protein variety is reasonable. Add one plant-based protein meal next week." },
    "Nina Patel": { title: "Coffee appears in every entry", text: "Food logging is incomplete and hydration is low. Check whether coffee is replacing water or a full snack." },
  };
  const repeat = repetition[selected.name] ?? repetition["Alex Morgan"];
  return <>
    <Heading eyebrow="NUTRITION LOG" title="Your clients’ nutrition." sub="Every student’s weekly pattern and latest food entries in one view." />
    <article className="surface nutrition-overview"><div className="card-head"><div><span className="eyebrow">ALL-CLIENT OVERVIEW</span><h2>Select a client</h2></div><span className="chip">{students.length} clients</span></div><div className="nutrition-client-grid">{students.map((student) => { const itemSignal = nutritionSignals.find((item) => item.name === student.name) ?? nutritionSignals[0]; return <button className={`nutrition-client ${selected.id === student.id ? "active" : ""}`} key={student.id} onClick={() => select(student.id)}><Avatar student={student} /><div><strong>{student.name}</strong><small>{itemSignal.note}</small><span><i style={{ width: `${itemSignal.consistency}%` }} /></span></div><b>{itemSignal.consistency}%<small>consistent</small></b></button>; })}</div></article>
    <section className="nutrition-grid"><article className="metric gold nutrition-score"><span>WEEKLY CONSISTENCY · {selected.name.toUpperCase()}</span><strong>{signal.consistency}<em>%</em></strong><small>{visibleMeals.length} food entries logged this week</small><MiniWave /></article><article className="surface nutrition-summary"><div className="card-head"><div><span className="eyebrow">RULE-BASED INSIGHT · {selected.name.toUpperCase()}</span><h2>{signal.note.split(" · ")[0]}.</h2></div><Sparkles /></div><p>{signal.note}. Use this pattern when planning the client’s next training session.</p><div className="bars">{[["Protein coverage", signal.protein], ["Produce variety", Math.min(92, signal.consistency + 5)], ["Hydration", signal.hydration]].map(([name, n]) => <span key={String(name)}><i>{name}</i><b><em style={{ width: `${n}%` }} /></b><strong>{n}%</strong></span>)}</div></article></section>
    <article className="surface repeat-insight"><Sparkles /><div><span className="eyebrow">REPETITIVE CONSUMPTION</span><h3>{repeat.title}</h3><p>{repeat.text}</p></div></article>
    <article className="surface meal-section"><div className="card-head"><div><span className="eyebrow">THIS WEEK</span><h2>Client food activity</h2></div><span className="chip">{selected.name} <ChevronDown /></span></div><div className="meal-grid">{visibleMeals.map((m) => <div className="meal" key={m.id}><span><Utensils /></span><div><small>{m.day} · {m.type} · {m.time}</small><h3>{m.description}</h3><small>{m.owner}</small><div className="meal-tags">{m.protein && <i><Dumbbell /> Protein</i>}{m.produce && <i><Leaf /> Produce</i>}<i>{m.water} glasses</i></div></div></div>)}</div></article>
  </>;
}

function SettingsView({ absence, setAbsence }: { absence: boolean; setAbsence: (v: boolean) => void }) {
  const cards = [
    { icon: ShieldCheck, label: "SESSION POLICY", title: "Absence handling", text: "When enabled, a client absence automatically uses one session. You can still override individual cases.", control: true },
    { icon: Bell, label: "REMINDERS", title: "Session nudges", text: "Send a gentle reminder before scheduled sessions and when a plan has two sessions remaining.", control: false },
    { icon: Target, label: "BODY MAP", title: "How the body map is coloured", text: "Each muscle shows days since it was last recorded in a session, using details kept for 30 days: 0–1, 2–4, 5–7 and 8–14 days. Grey means nothing recorded." },
  ];
  return <>
    <Heading eyebrow="COACH SETTINGS" title="Keep your rules clear." sub="Policies apply across your independent coaching space." />
    <section className="settings-grid">{cards.map((c, i) => { const Icon = c.icon; return <article className="surface setting-card" key={c.title}><span className={`setting-icon setting-${i}`}><Icon /></span><div><span className="eyebrow">{c.label}</span><h2>{c.title}</h2><p>{c.text}</p></div>{i < 2 ? <div className="setting-control"><span><strong>{i ? "Session reminders" : "Count absence as a used session"}</strong><small>{i ? "24 hours before each session" : absence ? "Enabled for new absences" : "Balance stays unchanged"}</small></span><Switch checked={i ? true : absence} onCheckedChange={(v) => { if (!i) setAbsence(v); toast.success("Preference updated"); }} /></div> : null}</article>; })}</section>
  </>;
}

export default function CoachApp({ onLogout, onUnauthorized }: { onLogout: () => void; onUnauthorized: () => void }) {
  // Only an exact 401 means the auth session is gone; 400/403/404/409/5xx stay local errors.
  const apiFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  }, [onUnauthorized]);
  const [view, setView] = useState<View>("today");
  const [students, setStudents] = useState<Student[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState(1);
  const [muscle, setMuscle] = useState<MuscleKey>("shoulders");
  const [absence, setAbsence] = useState(true);
  const [noteHistory, setNoteHistory] = useState<SessionHistoryItem[]>([]);
  const [noteHistoryLoading, setNoteHistoryLoading] = useState(false);
  // Which Member `noteHistory` belongs to, so a Member switch reads as loading, never as stale or empty data.
  const [noteHistoryOwner, setNoteHistoryOwner] = useState<number | null>(null);
  const [noteHistoryError, setNoteHistoryError] = useState<string | null>(null);
  // Bumped to force a refetch of the current selected Member's history —
  // after a Note PUT succeeds, or from Retry. The effect always re-reads
  // `selected?.id` itself, so bumping this never targets a stale Member.
  const [noteHistoryVersion, setNoteHistoryVersion] = useState(0);
  // Bumped after any Session write so the Calendar reloads its visible months.
  const [calendarVersion, setCalendarVersion] = useState(0);
  // Loaded Session months shared by Today and Calendar; a version bump orphans every entry.
  const sessionsStore: SessionsStore = useRef(newSessionsStoreValue());
  const [clientOpen, setClientOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [profilePhotoOpen, setProfilePhotoOpen] = useState(false);
  const [coachPhoto, setCoachPhoto] = useState<string | null>(null);
  const [sessionDateKey, setSessionDateKey] = useState(() => getAppDateKey());
  const [savingSession, setSavingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionNoteText, setSessionNoteText] = useState("");
  const [sessionMuscleSelection, setSessionMuscleSelection] = useState<MuscleKey[]>([]);
  // Which detail pieces already persisted for the resolved Session (retry sends only the rest).
  const [noteSaved, setNoteSaved] = useState(false);
  const [musclesSaved, setMusclesSaved] = useState(false);
  const [resolvedSessionId, setResolvedSessionId] = useState<number | null>(null);
  const [clientDays, setClientDays] = useState<string[]>(["Sat", "Mon", "Wed"]);
  const [clientError, setClientError] = useState<string | null>(null);
  const [creatingClient, setCreatingClient] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [scheduleDays, setScheduleDays] = useState<string[]>([]);
  const [absenceDateKey, setAbsenceDateKey] = useState(() => getAppDateKey());
  const [replacementDateKey, setReplacementDateKey] = useState("");
  const [savingAbsence, setSavingAbsence] = useState(false);
  const [absenceError, setAbsenceError] = useState<string | null>(null);
  const replacementChoices = useMemo(() => getNextAppDates(absenceDateKey, 6), [absenceDateKey]);
  const [sessionSource, setSessionSource] = useState<"manual" | "attendance">("manual");
  // Set when the dialog completes a known pending replacement row (PATCH, never a new Session).
  const [sessionTargetId, setSessionTargetId] = useState<number | null>(null);
  const selected: Student | undefined = useMemo(() => students.find((s) => s.id === selectedId) ?? students[0], [students, selectedId]);
  const nav = coachNav;

  // One Member-history request feeds the notes list, the muscle chips and BOTH Body Maps.
  const bodyMap: BodyMapData = useMemo(() => ({
    freshness: buildMuscleFreshness(noteHistory, getAppDateKey()),
    status: noteHistoryOwner !== selected?.id || noteHistoryLoading ? "loading" : noteHistoryError ? "error" : "ready",
    retry: () => setNoteHistoryVersion((value) => value + 1),
  }), [noteHistory, noteHistoryOwner, noteHistoryLoading, noteHistoryError, selected?.id]);

  const [muscleEdit, setMuscleEdit] = useState<{ item: SessionHistoryItem; selection: MuscleKey[] } | null>(null);
  const [muscleEditError, setMuscleEditError] = useState<string | null>(null);
  const [savingMuscleEdit, setSavingMuscleEdit] = useState(false);

  // Persisted member profiles come from the database; there is no mock fallback.
  // Kept free of setState so it can be shared by the mount effect and Retry.
  const fetchMembers = useCallback(async (): Promise<Student[] | null> => {
    try {
      const response = await apiFetch("/api/members");
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      const payload: unknown = await response.json();
      const list = (payload as { members?: unknown })?.members;
      if (!Array.isArray(list)) throw new Error("Response did not contain a members array");
      return (list as MemberProfile[]).map(toStudent);
    } catch (error) {
      console.error("Could not load members", error);
      return null;
    }
  }, [apiFetch]);

  const applyMembers = useCallback((result: Student[] | null) => {
    setStudents(result ?? []);
    setLoadState(result ? "ready" : "error");
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await fetchMembers();
      if (active) applyMembers(result);
    })();
    return () => { active = false; };
  }, [fetchMembers, applyMembers]);

  // Real persisted Session+Note history for the Client Profile, replacing
  // the old mock/seed session-note list. One request per selected Member,
  // newest first; a stale in-flight response for a Member the coach has
  // since switched away from is discarded rather than applied.
  useEffect(() => {
    const memberId = selected?.id;
    if (memberId === undefined) return;
    let active = true;
    void (async () => {
      // Clearing the previous Member's history and entering loading state
      // happen here, inside the same async task as the fetch, rather than
      // synchronously in the effect body, so this can't cascade a second
      // render pass before the request even starts.
      setNoteHistory([]);
      setNoteHistoryOwner(null);
      setNoteHistoryError(null);
      setNoteHistoryLoading(true);
      try {
        const response = await apiFetch(`/api/sessions?memberId=${memberId}&limit=50`);
        if (!response.ok) throw new Error(`Request failed with ${response.status}`);
        const payload: unknown = await response.json();
        const list = (payload as { sessions?: unknown })?.sessions;
        if (!Array.isArray(list)) throw new Error("Response did not contain a sessions array");
        if (active) { setNoteHistory(list as SessionHistoryItem[]); setNoteHistoryOwner(memberId); }
      } catch (error) {
        console.error("Could not load session history", error);
        if (active) { setNoteHistoryError("Could not load session history."); setNoteHistoryOwner(memberId); }
      } finally {
        if (active) setNoteHistoryLoading(false);
      }
    })();
    return () => { active = false; };
  }, [selected?.id, noteHistoryVersion, apiFetch]);

  useEffect(() => {
    type Tool = {
      name: string; title: string; description: string; inputSchema: object;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
      execute: (input: Record<string, unknown>) => unknown;
    };
    type Context = { registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => void | Promise<void> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Tool) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined); } catch { /* Unsupported preview context. */ }
    };
    register({
      name: "read_coaching_summary", title: "Read coaching summary",
      description: "Read the active client count, selected client, session balance, and absence policy.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ activeClients: students.length, selectedClient: selected?.name ?? null, sessionsLeft: selected?.sessionsLeft ?? null, absenceCountsAsUsed: absence }),
    });
    register({
      name: "set_absence_policy", title: "Set absence policy",
      description: "Enable or disable whether a client absence uses one session, and update the visible setting.",
      inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => { if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean"); setAbsence(input.enabled); setView("settings"); return { enabled: input.enabled }; },
    });
    register({
      name: "open_client_profile", title: "Open client profile",
      description: "Open a client profile by numeric client id in the visible coach workspace.",
      inputSchema: { type: "object", properties: { clientId: { type: "number" } }, required: ["clientId"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => { const client = students.find((item) => item.id === input.clientId); if (!client) throw new Error("Client not found"); setSelectedId(client.id); setView("clients"); return { clientId: client.id, name: client.name }; },
    });
    return () => lifecycle.abort();
  }, [absence, selected?.name, selected?.sessionsLeft, students]);

  function openSession(id?: number, source: "manual" | "attendance" = "manual", dateKey?: string, targetSessionId: number | null = null) {
    const target = id ?? selected?.id;
    if (target === undefined) return;
    setSelectedId(target);
    setSessionDateKey(dateKey ?? getAppDateKey());
    setSessionError(null);
    setSessionNoteText("");
    setSessionMuscleSelection([]);
    setNoteSaved(false);
    setMusclesSaved(false);
    setResolvedSessionId(null);
    setSessionSource(source);
    setSessionTargetId(targetSessionId);
    setSessionOpen(true);
  }
  /** Shared by Today and Calendar: the row's own date and Session id drive the write, never "today". */
  function beginAttendance(target: AttendanceTarget, kind: AttendanceAction["kind"]) {
    if (target.dateKey > getAppDateKey()) return; // future attendance is read-only (the API refuses it too)
    if (kind === "complete") openSession(target.memberId, "attendance", target.dateKey);
    else if (kind === "complete-replacement") openSession(target.memberId, "attendance", target.dateKey, target.sessionId);
    else {
      setSelectedId(target.memberId);
      setAbsenceDateKey(target.dateKey);
      setReplacementDateKey(getNextAppDates(target.dateKey, 1)[0].dateKey);
      setAbsenceError(null);
      setAbsenceOpen(true);
    }
  }
  async function recordAbsence(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const member = selected;
    if (!member || savingAbsence) return;
    const f = new FormData(e.currentTarget);
    const replacementTime = String(f.get("time") ?? "");
    if (!replacementDateKey || !replacementTime) {
      setAbsenceError("Choose a replacement date and time.");
      return;
    }
    // Obvious mistake only; the API stays authoritative for every other rule.
    if (replacementDateKey < absenceDateKey) {
      setAbsenceError("The replacement cannot be before the missed session.");
      return;
    }
    setSavingAbsence(true);
    setAbsenceError(null);
    try {
      // Only these four fields are sent; the server derives coachId, status,
      // duration and the original session's start time. sessionsLeft,
      // attendance is never patched locally: the success path bumps
      // `calendarVersion` so Today and Calendar refetch the persisted Sessions.
      const response = await apiFetch("/api/sessions/absence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          dateKey: absenceDateKey,
          replacementDateKey,
          replacementTime,
        }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        setAbsenceError((payload as { error?: string } | null)?.error ?? "Could not save the absence.");
        return;
      }
      setAbsenceOpen(false);
      setCalendarVersion((value) => value + 1);
      toast.success(`Absence and replacement saved for ${member.name}`);
    } catch (error) {
      console.error("Could not record absence", error);
      setAbsenceError("Could not reach the server.");
    } finally {
      setSavingAbsence(false);
    }
  }
  function openScheduleEditor(id?: number) {
    const target = id ?? selected?.id;
    const client = students.find((s) => s.id === target);
    if (!client) return;
    setSelectedId(client.id); setScheduleDays(client.preferredDays);
    setScheduleError(null); setScheduleOpen(true);
  }
  async function addClient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setCreatingClient(true);
    setClientError(null);
    try {
      const response = await apiFetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(f.get("name") ?? ""),
          phone: String(f.get("phone") ?? ""),
          weightKg: Number(f.get("weight")),
          heightCm: Number(f.get("height")),
          goal: String(f.get("goal") ?? ""),
          defaultStartTime: String(f.get("time") ?? ""),
          defaultDurationMinutes: Number(f.get("duration")),
          preferredDays: clientDays,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const created = (payload as { member?: MemberProfile } | null)?.member;
      if (!response.ok || !created) {
        // Keep the dialog open so the entered values are not lost.
        setClientError(
          (payload as { error?: string } | null)?.error ?? "Could not create the client."
        );
        return;
      }
      // Re-read the roster so the UI shows persisted rows, never local guesses.
      const refreshed = await fetchMembers();
      if (refreshed) applyMembers(refreshed);
      setSelectedId(created.id);
      setClientOpen(false);
      setClientDays(["Sat", "Mon", "Wed"]);
      setView("clients");
      toast.success(`${created.name} added to your roster`);
    } catch (error) {
      console.error("Could not create member", error);
      setClientError("Could not reach the server.");
    } finally {
      setCreatingClient(false);
    }
  }
  async function logSession(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || savingSession) return;
    const member = selected;
    setSavingSession(true);
    setSessionError(null);
    try {
      // If a Session was already successfully resolved in a prior submit of
      // this same dialog attempt (a note-only retry after a partial
      // failure), skip discovery/POST/PATCH entirely: never write the
      // Session twice just because its note failed to save.
      let completedSessionId = resolvedSessionId;

      if (completedSessionId === null) {
        // A pending replacement is completed in place, never duplicated with a new
        // normal Session. Attendance rows already know their row id; only the manual
        // "Log session" flow has to discover what is persisted for the member/date.
        let replacementId = sessionTargetId;

        if (replacementId === null && sessionSource === "manual") {
          const discoveryResponse = await apiFetch(
            `/api/sessions?from=${sessionDateKey}&to=${sessionDateKey}&memberId=${member.id}`
          );
          if (!discoveryResponse.ok) {
            const payload: unknown = await discoveryResponse.json().catch(() => null);
            setSessionError(
              (payload as { error?: string } | null)?.error ?? "Could not check existing sessions."
            );
            return;
          }
          const discoveryPayload: unknown = await discoveryResponse.json().catch(() => null);
          const existing = (discoveryPayload as { sessions?: PersistedSession[] } | null)?.sessions ?? [];

          if (existing.some((s) => s.status === "completed")) {
            // Already completed before this dialog attempt: never overwrite an
            // existing note here, this is not a general note-edit flow.
            setSessionOpen(false);
            setCalendarVersion((value) => value + 1);
            toast.info(`${member.name} already has a session recorded for this date.`);
            return;
          }
          replacementId = existing.find((s) => s.status === "replacement" && s.replacementForId !== null)?.id ?? null;
        }

        // Completing a replacement PATCHes its row; anything else POSTs the row's own date.
        const response = replacementId !== null
          ? await apiFetch(`/api/sessions/${replacementId}/complete`, { method: "PATCH" })
          : await apiFetch("/api/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ memberId: member.id, dateKey: sessionDateKey }),
            });
        if (response.status === 409 && replacementId === null) {
          setSessionOpen(false);
          setCalendarVersion((value) => value + 1);
          toast.info(`${member.name} already has a session recorded for this date.`);
          return;
        }
        if (!response.ok) {
          if (response.status === 409) {
            setSessionOpen(false);
            setCalendarVersion((value) => value + 1);
            toast.info(`${member.name}’s replacement can’t be completed (already completed, or not due yet).`);
            return;
          }
          const payload: unknown = await response.json().catch(() => null);
          setSessionError((payload as { error?: string } | null)?.error ?? "Could not save the session.");
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        completedSessionId = (payload as { session?: { id: number } } | null)?.session?.id ?? null;

        // The real id the server just returned; never guessed/reconstructed.
        setResolvedSessionId(completedSessionId);
        setCalendarVersion((value) => value + 1);
      }

      if (completedSessionId === null) {
        // Defensive only: the branches above always resolve a real id before
        // reaching here. Never fabricate one to attempt a detail write.
        setSessionError("Could not determine the saved session.");
        return;
      }

      // Detail (note, muscles) is only writable inside the retention window; an
      // older backfill keeps its attendance but never sends detail.
      const detailWritable = isDateKeyInDetailWindow(sessionDateKey, getAppDateKey());
      const trimmedNote = detailWritable ? sessionNoteText.trim() : "";
      const chosenMuscles = detailWritable ? MUSCLE_ORDER.filter((key) => sessionMuscleSelection.includes(key)) : [];

      // Each piece is saved at most once: a retry sends only what is still unsaved,
      // and never touches the Session itself. Tracked with locals as well as state
      // because state updates are not visible until the next render.
      let noteDone = noteSaved || !trimmedNote;
      let musclesDone = musclesSaved || chosenMuscles.length === 0;
      let noteFailed = false;
      let musclesFailed = false;

      if (!noteDone) {
        const noteResponse = await apiFetch(`/api/sessions/${completedSessionId}/note`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: trimmedNote }),
        });
        if (noteResponse.ok) { noteDone = true; setNoteSaved(true); } else noteFailed = true;
      }
      if (!musclesDone) {
        // Whole-set replacement; canonical slugs only.
        const musclesResponse = await apiFetch(`/api/sessions/${completedSessionId}/muscles`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ muscles: chosenMuscles }),
        });
        if (musclesResponse.ok) { musclesDone = true; setMusclesSaved(true); } else musclesFailed = true;
      }

      // Detail is part of the Client Profile history response: refetch rather than
      // fabricating local objects, so the persisted API stays the source of truth.
      if ((noteDone && trimmedNote) || (musclesDone && chosenMuscles.length > 0)) setNoteHistoryVersion((value) => value + 1);

      if (noteFailed || musclesFailed) {
        // The Session write already succeeded and its id is retained: keep the
        // dialog open with the entries intact; Retry saves only what is unsaved.
        const what = noteFailed && musclesFailed ? "the note and muscle details" : noteFailed ? "the note" : "muscle details";
        setSessionError(`Session saved, but ${what} could not be saved. Retry will save the remaining details only.`);
        return;
      }

      setSessionOpen(false);
      setResolvedSessionId(null);
      setSessionNoteText("");
      setSessionMuscleSelection([]);
      toast.success(
        trimmedNote || chosenMuscles.length > 0
          ? `Session and details saved for ${member.name}`
          : `Session confirmed for ${member.name}`
      );
    } catch (error) {
      console.error("Could not save session", error);
      setSessionError("Could not reach the server.");
    } finally {
      setSavingSession(false);
    }
  }
  function openMuscleEditor(item: SessionHistoryItem) {
    setMuscleEditError(null);
    setMuscleEdit({ item, selection: [...item.muscles] });
  }
  async function saveMuscleEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!muscleEdit || savingMuscleEdit) return;
    setSavingMuscleEdit(true);
    setMuscleEditError(null);
    try {
      // Whole-set replacement; an empty set is an explicit "clear". Nothing but
      // session_muscles changes (status, replacementForId and coachId are untouched).
      const response = await apiFetch(`/api/sessions/${muscleEdit.item.id}/muscles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muscles: MUSCLE_ORDER.filter((key) => muscleEdit.selection.includes(key)) }),
      });
      if (response.ok) {
        setMuscleEdit(null);
        setNoteHistoryVersion((value) => value + 1);
        toast.success("Muscles updated");
      } else if (response.status === 403) {
        setMuscleEditError("You can’t edit muscles on this session.");
      } else if (response.status === 409) {
        setMuscleEditError("These details can no longer be edited.");
        setNoteHistoryVersion((value) => value + 1);
      } else {
        setMuscleEditError("Could not save the muscles.");
      }
    } catch (error) {
      console.error("Could not save muscles", error);
      setMuscleEditError("Could not reach the server.");
    } finally {
      setSavingMuscleEdit(false);
    }
  }
  function openProfileEditor() {
    if (!selected) return;
    setProfileError(null);
    setProfileOpen(true);
  }

  async function updateProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || savingProfile) return;
    const f = new FormData(e.currentTarget);
    const member = selected;
    const name = String(f.get("name") ?? "").trim();
    const phone = String(f.get("phone") ?? "").trim();
    const goal = String(f.get("goal") ?? "").trim();
    // Read the raw strings first: Number("") is 0, which would silently turn a
    // blank measurement into a real-looking value.
    const rawWeight = String(f.get("weight") ?? "").trim();
    const rawHeight = String(f.get("height") ?? "").trim();
    const weightKg = rawWeight === "" ? NaN : Number(rawWeight);
    const heightCm = rawHeight === "" ? NaN : Number(rawHeight);

    // Minimal client-side checks for feedback; the API stays authoritative.
    if (!name) return setProfileError("Name is required.");
    if (!phone) return setProfileError("Phone number is required.");
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
      return setProfileError("Weight must be a number greater than zero.");
    }
    if (!Number.isInteger(heightCm) || heightCm <= 0) {
      return setProfileError("Height must be a whole number of centimetres.");
    }
    if (!goal) return setProfileError("Primary goal is required.");

    setSavingProfile(true);
    setProfileError(null);
    try {
      // Profile fields only; schedule fields are owned by Edit Schedule.
      const response = await apiFetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, weightKg, heightCm, goal }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setProfileError(
          (payload as { error?: string } | null)?.error ?? "Could not save the profile."
        );
        return;
      }
      const refreshed = await fetchMembers();
      if (refreshed) applyMembers(refreshed);
      setSelectedId(member.id);
      setProfileOpen(false);
      toast.success(`${name}’s profile updated`);
    } catch (error) {
      console.error("Could not save profile", error);
      setProfileError("Could not reach the server.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function updateSchedule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || savingSchedule) return;
    const f = new FormData(e.currentTarget);
    const member = selected;
    setSavingSchedule(true);
    setScheduleError(null);
    try {
      // Only the three persisted schedule fields are sent; nothing is mutated
      // locally before the write succeeds.
      const response = await apiFetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferredDays: scheduleDays,
          defaultStartTime: String(f.get("time") ?? ""),
          defaultDurationMinutes: Number(f.get("duration")),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setScheduleError(
          (payload as { error?: string } | null)?.error ?? "Could not save the schedule."
        );
        return;
      }
      // Re-read the roster so the UI shows persisted rows, never local guesses.
      const refreshed = await fetchMembers();
      if (refreshed) applyMembers(refreshed);
      setSelectedId(member.id);
      setScheduleOpen(false);
      toast.success(`${member.name}’s schedule updated`);
    } catch (error) {
      console.error("Could not save schedule", error);
      setScheduleError("Could not reach the server.");
    } finally {
      setSavingSchedule(false);
    }
  }
  function chooseProfilePhoto(file?: File) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setCoachPhoto(url);
    toast.success("Profile photo updated");
  }

  // No member data is rendered until the database responds; there is no
  // fabricated roster to fall back on.
  if (loadState !== "ready") {
    const failed = loadState === "error";
    return <div className="app-shell">
      <div className="app-main">
        <header className="topbar"><div className="mobile-brand"><AppLogo compact onClick={() => setLogoOpen(true)} /></div></header>
        <main className="content">
          <Heading
            eyebrow="MEMBERS"
            title={failed ? "Couldn't load members." : "Loading members…"}
            sub={failed
              ? "The member list could not be read from the database."
              : "Reading persisted member profiles."}
            action={failed ? <Button className="primary-action" onClick={() => { setLoadState("loading"); void fetchMembers().then(applyMembers); }}>Retry</Button> : undefined}
          />
        </main>
      </div>
      <Toaster position="top-center" richColors />
    </div>;
  }

  const openAddClient = () => { setClientError(null); setClientOpen(true); };
  let content: React.ReactNode;
  if (view === "clients") content = selected
    ? <Clients apiFetch={apiFetch} students={students} selected={selected} select={setSelectedId} add={openAddClient} log={() => openSession()} editSchedule={() => openScheduleEditor()} editProfile={openProfileEditor} noteHistory={noteHistory} noteHistoryLoading={noteHistoryLoading} noteHistoryError={noteHistoryError} retryNoteHistory={() => setNoteHistoryVersion((value) => value + 1)} muscle={muscle} setMuscle={setMuscle} bodyMap={bodyMap} onEditMuscles={openMuscleEditor} />
    : <><Heading eyebrow="CLIENT DIRECTORY" title="No members yet." sub="Add your first client to start scheduling sessions." action={<Button className="primary-action" onClick={openAddClient}><Plus /> Add client</Button>} /><article className="surface empty-members"><div className="empty-agenda"><UsersRound /><strong>No members yet.</strong><span>Clients you add will appear here.</span></div></article></>;
  else if (view === "calendar") content = <CalendarView students={students} apiFetch={apiFetch} version={calendarVersion} store={sessionsStore} onAttendance={beginAttendance} editSchedule={openScheduleEditor} />;
  else if (view === "nutrition") content = selected
    ? <Nutrition meals={initialMeals} students={students} selected={selected} select={setSelectedId} />
    : <><Heading eyebrow="NUTRITION LOG" title="Your clients’ nutrition." sub="Every student’s weekly pattern and latest food entries in one view." /><article className="surface empty-members"><div className="empty-agenda"><Apple /><strong>No members yet.</strong><span>Nutrition appears once you have clients.</span></div></article></>;
  else if (view === "settings") content = <SettingsView absence={absence} setAbsence={setAbsence} />;
  else content = <CoachDashboard students={students} selected={selected} select={setSelectedId} apiFetch={apiFetch} version={calendarVersion} store={sessionsStore} onAttendance={beginAttendance} logSession={() => openSession()} addClient={openAddClient} openCalendar={() => setView("calendar")} muscle={muscle} setMuscle={setMuscle} bodyMap={bodyMap} />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><AppLogo onClick={() => setLogoOpen(true)} /><span>FIT & MISCHIEF</span></div><div className="workspace"><AccountPhoto src={coachPhoto} initials="JL" name="Jordan Lee" onClick={() => setProfilePhotoOpen(true)} /><div><strong>Jordan Lee</strong><small>Independent coach</small></div><ChevronDown /></div><nav>{nav.map(([id, text, Icon]) => <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}><Icon /><span>{text}</span>{id === "clients" && <b>{students.length}</b>}</button>)}</nav><footer><button><MessageCircle />Support</button><button onClick={() => onLogout()}><LogOut />Sign out</button></footer></aside>
    <div className="app-main"><header className="topbar"><div className="mobile-brand"><AppLogo compact onClick={() => setLogoOpen(true)} /></div><div className="top-actions"><button aria-label="Notifications"><Bell /><i /></button><AccountPhoto src={coachPhoto} initials="JL" name="Jordan Lee" onClick={() => setProfilePhotoOpen(true)} /></div></header><main className="content">{content}</main></div>
    <nav className="mobile-nav">{nav.map(([id, text, Icon]) => <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}><Icon /><span>{text}</span></button>)}</nav>

    <Dialog open={logoOpen} onOpenChange={setLogoOpen}><DialogContent className="logo-dialog"><DialogHeader><DialogTitle className="visually-hidden">Fit & Mischief App logo</DialogTitle><DialogDescription className="visually-hidden">Expanded app logo</DialogDescription></DialogHeader><img src="/app-logo.png" alt="Fit & Mischief App — Naughty & Strong Together" /></DialogContent></Dialog>
    <Dialog open={profilePhotoOpen} onOpenChange={setProfilePhotoOpen}><DialogContent className="app-dialog photo-dialog"><DialogHeader><DialogTitle>Profile photo</DialogTitle><DialogDescription>Choose a photo for Jordan Lee.</DialogDescription></DialogHeader><div className="photo-preview">{coachPhoto ? <img src={coachPhoto} alt="Jordan Lee" /> : <span>JL</span>}</div><label className="photo-upload"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => chooseProfilePhoto(e.target.files?.[0])} /><span><Plus /> Choose image</span><small>PNG, JPG or WebP</small></label><DialogFooter><Button className="wide-dark" onClick={() => setProfilePhotoOpen(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={clientOpen} onOpenChange={setClientOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Add a new client</DialogTitle><DialogDescription>Contact details, measurements and preferred rhythm.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={addClient}><label>Full name<Input name="name" placeholder="e.g. Sam Taylor" required /></label><label>Phone number<Input name="phone" type="tel" placeholder="e.g. +15550001111" required /></label><div className="form-grid"><label>Weight (kg)<Input name="weight" type="number" step="0.1" min="1" placeholder="72.5" required /></label><label>Height (cm)<Input name="height" type="number" step="1" min="1" placeholder="178" required /></label></div><label>Primary goal<Input name="goal" placeholder="Strength, mobility, endurance…" required /></label><div className="form-grid"><label>Preferred time<Input name="time" type="time" defaultValue="10:00" required /></label><label>Session duration<select name="duration" defaultValue="60"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="75">75 minutes</option><option value="90">90 minutes</option></select></label></div><label>Preferred training days</label><div className="day-picker">{weekDays.map((day) => <button type="button" className={clientDays.includes(day) ? "selected-day" : ""} key={day} onClick={() => setClientDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>)}</div>{clientError && <p className="policy-note" role="alert">{clientError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setClientOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!clientDays.length || creatingClient}>{creatingClient ? "Creating…" : "Create client"}</Button></DialogFooter></form></DialogContent></Dialog>
    {selected && <>
    <Dialog open={sessionOpen} onOpenChange={(open) => { if (!savingSession) setSessionOpen(open); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{sessionSource === "attendance" ? "Complete this session" : "Log session"}</DialogTitle><DialogDescription>Confirm the completed session for {selected.name} on {jalaliLabelForDateKey(sessionDateKey)}.</DialogDescription></DialogHeader>{(() => { const detailWritable = isDateKeyInDetailWindow(sessionDateKey, getAppDateKey()); const retrying = resolvedSessionId !== null; return <form className="dialog-form" onSubmit={logSession}><label>Session note (optional)<Textarea value={sessionNoteText} disabled={!detailWritable || noteSaved} onChange={(e) => setSessionNoteText(e.target.value)} placeholder="Intensity, limitations, progress or next-session cues…" /></label><div className="muscle-field"><span className="muscle-field-label">Muscles trained (optional)</span><MusclePicker value={sessionMuscleSelection} onChange={setSessionMuscleSelection} disabled={!detailWritable || musclesSaved || savingSession} /></div>{!detailWritable && <p className="policy-note">Session details are only editable for 30 days.</p>}{sessionError && <p className="policy-note" role="alert">{sessionError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setSessionOpen(false)} disabled={savingSession}>{retrying ? "Close" : "Cancel"}</Button><Button className="wide-dark" type="submit" disabled={savingSession}>{savingSession ? "Saving…" : retrying ? "Retry" : sessionSource === "attendance" ? "Save & confirm attendance" : "Save session"}</Button></DialogFooter></form>; })()}</DialogContent></Dialog>
    <Dialog open={muscleEdit !== null} onOpenChange={(open) => { if (!open && !savingMuscleEdit) setMuscleEdit(null); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Edit muscles</DialogTitle><DialogDescription>Muscles trained for {selected.name} on {muscleEdit ? formatJalaliDate(muscleEdit.item.scheduledAt) : ""}. Clearing every chip removes the muscle detail.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={saveMuscleEdit}><MusclePicker value={muscleEdit?.selection ?? []} onChange={(selection) => setMuscleEdit((current) => current && { ...current, selection })} disabled={savingMuscleEdit} />{muscleEditError && <p className="policy-note" role="alert">{muscleEditError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setMuscleEdit(null)} disabled={savingMuscleEdit}>Cancel</Button><Button className="wide-dark" type="submit" disabled={savingMuscleEdit}>{savingMuscleEdit ? "Saving…" : "Save muscles"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={absenceOpen} onOpenChange={(open) => { if (!savingAbsence) setAbsenceOpen(open); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Reschedule before marking absent</DialogTitle><DialogDescription>The missed session for {selected.name} was on {jalaliLabelForDateKey(absenceDateKey)}. Choose a replacement date before it is recorded as absent.</DialogDescription></DialogHeader><form className="dialog-form" noValidate onSubmit={recordAbsence}><label>Replacement day</label><div className="replacement-days">{replacementChoices.map((choice) => <button type="button" className={replacementDateKey === choice.dateKey ? "selected-day" : ""} key={choice.dateKey} onClick={() => setReplacementDateKey(choice.dateKey)}><small>{choice.weekday}</small><strong>{choice.jalaliDay} {choice.jalaliMonthName}</strong></button>)}</div><label>Or choose a date<Input type="date" name="replacementDate" min={absenceDateKey} value={replacementDateKey} onChange={(e) => setReplacementDateKey(e.target.value)} /></label><label>Replacement time<Input name="time" type="time" defaultValue={selected.defaultStartTime} required /></label><div className="policy-note"><CalendarDays /><span><strong>{absence ? "One session will be used" : "Session balance will stay unchanged"}</strong><small>This follows the coach’s current absence policy.</small></span></div>{absenceError && <p className="policy-note" role="alert">{absenceError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setAbsenceOpen(false)} disabled={savingAbsence}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!replacementDateKey || savingAbsence}>{savingAbsence ? "Saving…" : "Confirm absence & reschedule"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={profileOpen} onOpenChange={setProfileOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Edit member profile</DialogTitle><DialogDescription>Contact details and measurements for {selected.name}.</DialogDescription></DialogHeader><form key={selected.id} className="dialog-form" onSubmit={updateProfile}><label>Full name<Input name="name" defaultValue={selected.name} required /></label><label>Phone number<Input name="phone" type="tel" defaultValue={selected.phone ?? ""} placeholder="e.g. +15550001111" required /></label><div className="form-grid"><label>Weight (kg)<Input name="weight" type="number" step="0.1" min="1" defaultValue={selected.weightKg ?? ""} placeholder="72.5" required /></label><label>Height (cm)<Input name="height" type="number" step="1" min="1" defaultValue={selected.heightCm ?? ""} placeholder="178" required /></label></div><label>Primary goal<Input name="goal" defaultValue={selected.goal} required /></label>{profileError && <p className="policy-note" role="alert">{profileError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setProfileOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={savingProfile}>{savingProfile ? "Saving\u2026" : "Save profile"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Edit training schedule</DialogTitle><DialogDescription>Update {selected.name}’s usual training days, start time and session length.</DialogDescription></DialogHeader><form key={selected.id} className="dialog-form" onSubmit={updateSchedule}><label>Training days</label><div className="day-picker">{weekDays.map((day) => <button type="button" className={scheduleDays.includes(day) ? "selected-day" : ""} key={day} onClick={() => setScheduleDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>)}</div><div className="form-grid"><label>Start time<Input name="time" type="time" defaultValue={selected.defaultStartTime} required /></label><label>Session duration<select name="duration" defaultValue={selected.defaultDurationMinutes}><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="75">75 minutes</option><option value="90">90 minutes</option></select></label></div>{scheduleError && <p className="policy-note" role="alert">{scheduleError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!scheduleDays.length || savingSchedule}>{savingSchedule ? "Saving…" : "Update schedule"}</Button></DialogFooter></form></DialogContent></Dialog>
    </>}
    <Toaster position="top-center" richColors />
  </div>;
}
