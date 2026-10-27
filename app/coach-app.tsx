"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Apple, ArrowRight, Bell, CalendarDays, Check, ChevronDown,
  ChevronRight, CircleUserRound, Dumbbell, LayoutDashboard,
  Leaf, LogOut, MessageCircle, MoreHorizontal, Plus, Search, Settings,
  ShieldCheck, Sparkles, Target, TrendingUp, UsersRound, Utensils, X,
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
import { getAppDateKey, getAppWeek, getJalaliDateParts, formatJalaliDate, localDateTimeToUtcIso, getNextAppDates, type WeekdayCode } from "@/lib/date-time";

type View = "today" | "clients" | "calendar" | "nutrition" | "settings";
type Attendance = "scheduled" | "present" | "absent" | "cancelled";
type MuscleKey = "shoulders" | "chest" | "arms" | "core" | "back" | "glutes" | "quads" | "hamstrings" | "calves";

/** Persisted member profile. Shape matches `GET /api/members` exactly. */
type MemberProfile = {
  id: number; name: string; coachId: number; goal: string;
  /** Nullable for legacy members created before these fields existed. */
  phone: string | null; weightKg: number | null; heightCm: number | null;
  defaultStartTime: string; defaultDurationMinutes: number;
  preferredDays: string[]; photoUrl: string | null;
};

/**
 * TEMPORARY MOCK DATA — nothing in here is persisted.
 * Sessions, packages and body-map history have no database tables yet, so these
 * fields are still fixtures joined by member id. Delete each one as its real
 * domain lands; never present these values as stored state.
 */
type MockMemberOperationalState = {
  sessionsLeft: number; sessionsTotal: number; attendance: Attendance;
  next: string; muscles: Record<MuscleKey, number>;
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
/** Only the fields the completion flow needs from `GET /api/sessions` rows. */
type PersistedSession = { id: number; status: string; replacementForId: number | null };

/** Only the fields the Client Profile's Session Notes list needs. */
type SessionHistoryItem = {
  id: number;
  scheduledAt: string;
  status: string;
  replacementForId: number | null;
  note: null | { id: number; note: string; createdAt: string; updatedAt: string };
};

const labels: Record<MuscleKey, string> = {
  shoulders: "Shoulders", chest: "Chest", arms: "Arms", core: "Core",
  back: "Back", glutes: "Glutes", quads: "Quads", hamstrings: "Hamstrings", calves: "Calves",
};

const baseMuscles: Record<MuscleKey, number> = {
  shoulders: 1, chest: 1, arms: 3, core: 5, back: 8, glutes: 11, quads: 13, hamstrings: 16, calves: 9,
};

// TEMPORARY MOCK FIXTURES — keyed by member id, joined onto persisted profiles.
// These cover only domains with no database tables yet (sessions, packages,
// body-map history). They contain no profile data: no name, goal, time,
// duration, preferred days or photo.
const mockOperationalState: Record<number, MockMemberOperationalState> = {
  1: { sessionsLeft: 6, sessionsTotal: 12, attendance: "scheduled", next: "Today, 08:30", muscles: baseMuscles, periodStart: "1405/05/27", periodEnd: "1405/07/10" },
  2: { sessionsLeft: 2, sessionsTotal: 10, attendance: "scheduled", next: "Today, 10:00", muscles: { shoulders: 6, chest: 10, arms: 6, core: 2, back: 2, glutes: 4, quads: 4, hamstrings: 7, calves: 12 }, periodStart: "1405/05/20", periodEnd: "1405/06/31" },
  3: { sessionsLeft: 9, sessionsTotal: 12, attendance: "scheduled", next: "Today, 14:30", muscles: { shoulders: 12, chest: 12, arms: 9, core: 2, back: 3, glutes: 2, quads: 2, hamstrings: 2, calves: 6 }, periodStart: "1405/06/10", periodEnd: "1405/07/25" },
  4: { sessionsLeft: 4, sessionsTotal: 8, attendance: "scheduled", next: "Tomorrow, 17:00", muscles: { shoulders: 3, chest: 8, arms: 3, core: 3, back: 8, glutes: 1, quads: 1, hamstrings: 5, calves: 6 }, periodStart: "1405/06/01", periodEnd: "1405/07/01" },
};

/** Neutral placeholders for a member with no fixture. Not persisted data. */
const neutralOperationalState: MockMemberOperationalState = {
  sessionsLeft: 0, sessionsTotal: 0, attendance: "scheduled", next: "Not scheduled",
  muscles: Object.fromEntries((Object.keys(labels) as MuscleKey[]).map((k) => [k, 15])) as Record<MuscleKey, number>,
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

function muscleColor(days: number) {
  if (days <= 1) return "#dcff28";
  if (days <= 4) return "#86bd75";
  if (days <= 7) return "#f0cc64";
  if (days <= 14) return "#e6a37d";
  return "#cfd3ce";
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

function StatusPill({ status }: { status: Attendance }) {
  const words = { scheduled: "Scheduled", present: "Present", absent: "Absent", cancelled: "Cancelled" };
  return <span className={`status status-${status}`}>{words[status]}</span>;
}

function MiniWave() {
  return <svg className="wave" viewBox="0 0 320 80" aria-hidden="true"><path d="M2 45C35 45 35 12 70 12s35 53 70 53 35-41 70-41 35 26 108 26" /><path d="M2 45c43 0 48-15 80-15s43 21 78 21 45-13 78-13 37 12 80 12" /><circle cx="2" cy="45" r="5" /><circle className="wave-end" cx="318" cy="50" r="5" /></svg>;
}

type ShapeProps = { k: MuscleKey; d?: string; cx?: number; cy?: number; rx?: number; ry?: number };
function BodyMap({ student, selected, onSelect }: { student: Student; selected: MuscleKey; onSelect: (m: MuscleKey) => void }) {
  const shape = ({ k, d, cx, cy, rx, ry }: ShapeProps) => {
    const common = { fill: muscleColor(student.muscles[k]), onClick: () => onSelect(k), tabIndex: 0, role: "button", "aria-label": labels[k], onKeyDown: (e: React.KeyboardEvent<SVGElement>) => (e.key === "Enter" || e.key === " ") && onSelect(k), className: selected === k ? "muscle active-muscle" : "muscle" };
    return d ? <path {...common} d={d} /> : <ellipse {...common} cx={cx} cy={cy} rx={rx} ry={ry} />;
  };
  return <article className="body-map">
    <div className="card-head"><div><span className="eyebrow">TRAINING BALANCE</span><h2>Your body, at a glance.</h2></div><span className="chip">Last 14 days <ChevronDown /></span></div>
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
      <div className="muscle-pop"><i style={{ background: muscleColor(student.muscles[selected]) }} /><small>{labels[selected]}</small><strong>{student.muscles[selected] <= 1 ? "Trained today" : `${student.muscles[selected]} days ago`}</strong><p>{student.muscles[selected] <= 2 ? "Recovery window active" : student.muscles[selected] > 10 ? "Ready for stimulus" : "Within weekly rhythm"}</p></div>
    </div>
    <div className="legend"><span><i className="l0" />0–1d</span><span><i className="l1" />2–4d</span><span><i className="l2" />5–7d</span><span><i className="l3" />8–14d</span></div>
  </article>;
}

function Heading({ eyebrow, title, sub, action }: { eyebrow: string; title: string; sub: string; action?: React.ReactNode }) {
  return <section className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{sub}</p></div>{action}</section>;
}

function CoachDashboard({ students, selected, select, attendance, logSession, addClient, muscle, setMuscle }: {
  students: Student[]; selected: Student; select: (id: number) => void;
  attendance: (id: number, s: Attendance) => void; logSession: () => void;
  addClient: () => void; muscle: MuscleKey; setMuscle: (m: MuscleKey) => void;
}) {
  return <>
    <Heading eyebrow={todayEyebrow()} title="Good morning, Jordan." sub="Four sessions today. Your first starts in 24 minutes." action={<Button className="primary-action" onClick={logSession}><Plus /> Log a session</Button>} />
    <section className="metrics">
      <article className="metric green"><span>TODAY’S LOAD</span><strong>4</strong><small>sessions</small><MiniWave /></article>
      <article className="metric gold"><span>CLIENT CONSISTENCY</span><strong>87<em>%</em></strong><small><TrendingUp /> 6% from last week</small></article>
      <article className="metric slate"><span>PLANS ENDING SOON</span><strong>2</strong><small>Maya and Nina need attention</small><button onClick={() => select(2)}>Review plans <ArrowRight /></button></article>
    </section>
    <section className="dashboard-grid">
      <article className="surface schedule">
        <div className="card-head"><div><span className="eyebrow">SCHEDULE</span><h2>Today’s sessions</h2></div><button className="soft-button" onClick={addClient}><Plus /> Add client</button></div>
        <div className="schedule-list">{students.slice(0, 3).map((s) => <div className={`schedule-row ${selected.id === s.id ? "selected-row" : ""}`} key={s.id} onClick={() => select(s.id)}><time>{s.defaultStartTime}</time><Avatar student={s} /><div><strong>{s.name}</strong><small>{s.goal}</small></div><div className="attend" onClick={(e) => e.stopPropagation()}>{s.attendance === "scheduled" ? <><button aria-label="Present" onClick={() => attendance(s.id, "present")}><Check /></button><button aria-label="Absent" onClick={() => attendance(s.id, "absent")}><X /></button></> : <StatusPill status={s.attendance} />}</div><ChevronRight /></div>)}</div>
        <button className="text-link">View full calendar <ArrowRight /></button>
      </article>
      <article className="surface session-card">
        <div className="card-head"><div><span className="eyebrow">SELECTED CLIENT</span><h2>{selected.name}</h2></div><Avatar student={selected} /></div>
        <div className="orbit"><svg viewBox="0 0 150 150"><circle cx="75" cy="75" r="57" /><circle className="progress-ring" cx="75" cy="75" r="57" pathLength="100" style={{ strokeDasharray: `${selected.sessionsLeft / selected.sessionsTotal * 100} 100` }} /></svg><div><strong>{selected.sessionsLeft}</strong><span>of {selected.sessionsTotal}<br />sessions left</span></div></div>
        <div className="session-next"><small><CalendarDays /> Next session</small><strong>{selected.next}</strong></div>
        <Button className="wide-dark" onClick={logSession}>Start session <ArrowRight /></Button>
      </article>
    </section>
    <section className="body-grid">
      <BodyMap student={selected} selected={muscle} onSelect={setMuscle} />
      <article className="surface insight-card"><span className="eyebrow">WEEKLY SIGNAL</span><h2>Upper body is carrying the load.</h2><div className="score"><strong>72</strong><span>/ 100<br />balance score</span></div><p>Chest and shoulders were trained in three consecutive sessions. Consider a lower-body or mobility focus next.</p><div className="recommend"><Sparkles /><div><strong>Next best focus</strong><span>Glutes · Hamstrings · Mobility</span></div></div><button className="text-link">Open full body history <ArrowRight /></button></article>
    </section>
  </>;
}

function Clients({ apiFetch, students, selected, select, add, log, editSchedule, editProfile, noteHistory, noteHistoryLoading, noteHistoryError, retryNoteHistory, muscle, setMuscle }: {
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  students: Student[]; selected: Student; select: (id: number) => void; add: () => void;
  log: () => void; editSchedule: () => void; editProfile: () => void;
  noteHistory: SessionHistoryItem[]; noteHistoryLoading: boolean; noteHistoryError: string | null;
  retryNoteHistory: () => void;
  muscle: MuscleKey; setMuscle: (m: MuscleKey) => void;
}) {
  // The API intentionally returns every persisted status; only Sessions that
  // actually have a persisted Note are shown here (Notes only ever attach to
  // completed Sessions, including completed former replacements).
  const notes = noteHistory.filter(
    (item): item is SessionHistoryItem & { note: NonNullable<SessionHistoryItem["note"]> } => item.note !== null
  );
  return <>
    <Heading eyebrow="CLIENT DIRECTORY" title="Your people." sub={`${students.length} active clients · 2 plans ending soon`} action={<Button className="primary-action" onClick={add}><Plus /> Add client</Button>} />
    <section className="clients-grid">
      <article className="surface directory"><label className="search"><Search /><input placeholder="Search clients" /></label><div>{students.map((s) => <button className={selected.id === s.id ? "selected-client" : ""} key={s.id} onClick={() => select(s.id)}><Avatar student={s} /><span><strong>{s.name}</strong><small>{s.goal}</small></span><b>{s.sessionsLeft}<small>left</small></b><ChevronRight /></button>)}</div></article>
      <div className="client-detail"><article className="surface profile-card"><div className="person"><Avatar student={selected} large /><div><span className="eyebrow">ACTIVE CLIENT</span><h2>{selected.name}</h2><p>{selected.goal}</p>{!isProfileComplete(selected) && <span className="chip">Profile incomplete</span>}</div></div><div className="action-pair"><Button className="soft-button" onClick={editProfile}><CircleUserRound /> Edit profile</Button><Button className="soft-button" onClick={editSchedule}><CalendarDays /> Edit schedule</Button><Button className="wide-dark fit" onClick={log}><Plus /> Log session</Button></div><div className="profile-stats"><span><strong>{selected.phone ?? NOT_RECORDED}</strong>phone</span><span><strong>{measurement(selected.weightKg, "kg")}</strong>weight</span><span><strong>{measurement(selected.heightCm, "cm")}</strong>height</span></div><div className="profile-stats"><span><strong>{selected.sessionsLeft}</strong>sessions left</span><span><strong>{selected.defaultDurationMinutes}</strong>minutes / session</span><span><strong>{selected.preferredDays.length}</strong>weekly days</span></div></article><MemberCycleSection key={selected.id} memberId={selected.id} apiFetch={apiFetch} /><article className="surface session-notes-card"><div className="card-head"><div><span className="eyebrow">COACH SESSION NOTES</span><h2>Recent observations</h2></div><span className="chip">{notes.length} notes</span></div>{noteHistoryLoading ? <p className="policy-note">Loading session notes…</p> : noteHistoryError ? <p className="policy-note" role="alert">{noteHistoryError} <button type="button" className="text-link" onClick={retryNoteHistory}>Retry</button></p> : notes.length === 0 ? <p className="policy-note">No session notes from the last 30 days.</p> : <div className="session-note-list">{notes.map((item) => <div className="session-note" key={item.id}><time>{formatJalaliDate(item.scheduledAt)}</time><div><p>{item.note.note}</p></div></div>)}</div>}</article><BodyMap student={selected} selected={muscle} onSelect={setMuscle} /></div>
    </section>
  </>;
}

function CalendarView({ students, present, editSchedule }: { students: Student[]; present: (id: number, dateKey: string) => void; editSchedule: (id: number) => void }) {
  const [mode, setMode] = useState<"week" | "month">("week");
  // Anchored once per mount so the visible week and "today" agree with each other.
  const [anchor] = useState(() => new Date());
  const week = useMemo(() => getAppWeek(anchor), [anchor]);
  const todayKey = useMemo(() => getAppDateKey(anchor), [anchor]);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const selectedCalendarDay = week.find((d) => d.dateKey === selectedDateKey) ?? week.find((d) => d.isToday) ?? week[0];
  const orderedWeekdays: WeekdayCode[] = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
  // MOCK: the month grid has no real per-day calendar source yet, so it fabricates
  // a weekday for each placeholder day-of-month purely for its own session count.
  // This never feeds today/past/future determination, which uses `dateKey` below.
  const mockWeekdayForMonthDay = (day: number): WeekdayCode => orderedWeekdays[(day - 1) % 7];
  const weekByJalaliDay = new Map(week.map((d) => [d.jalaliDay, d]));
  const todayCalendarDay = week.find((d) => d.isToday);

  const sessions = selectedDateKey === todayKey ? students.slice(0, 3) : students.filter((s) => s.preferredDays.includes(selectedCalendarDay.weekday));
  // MOCK: fabricated attendance history until Stage A6 reads real persisted sessions.
  // `jalaliDay` is only used as a fabrication seed here, never to decide chronology.
  const statusFor = (student: Student): Attendance =>
    selectedDateKey < todayKey ? ((student.id + selectedCalendarDay.jalaliDay) % 4 === 0 ? "absent" : "present")
      : selectedDateKey === todayKey ? student.attendance
      : "scheduled";
  const dayLabel = `${selectedCalendarDay.weekday}, ${selectedCalendarDay.jalaliDay} ${selectedCalendarDay.jalaliMonthName} ${selectedCalendarDay.jalaliYear}`;
  const headerEyebrow = `${selectedCalendarDay.jalaliMonthName.toUpperCase()} ${selectedCalendarDay.jalaliYear}`;
  return <>
    <Heading eyebrow={headerEyebrow} title={mode === "week" ? "Your training week." : "Your training month."} sub="Select any Solar Hijri date to review scheduled and completed sessions." action={<div className="calendar-actions"><div className="view-toggle"><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button><button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>Month</button></div><Button className="primary-action" onClick={() => toast.success("Choose a client to edit their schedule")}><Plus /> Schedule</Button></div>} />
    <article className="surface calendar">
      {mode === "week" ? <div className="week">{week.map((d) => <button className={`${d.isToday ? "today-day" : ""} ${d.dateKey === selectedDateKey ? "selected-day" : ""}`} key={d.dateKey} onClick={() => setSelectedDateKey(d.dateKey)}><span>{d.weekday}</span><strong>{d.jalaliDay}</strong>{d.isToday && <i />}</button>)}</div> : <div className="month-view"><div className="month-weekdays">{orderedWeekdays.map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid"><i />{Array.from({ length: 31 }, (_, i) => i + 1).map((day) => { const matchingWeekDay = weekByJalaliDay.get(day); const count = matchingWeekDay ? students.filter((s) => s.preferredDays.includes(matchingWeekDay.weekday)).length : students.filter((s) => s.preferredDays.includes(mockWeekdayForMonthDay(day))).length; return <button className={`${todayCalendarDay?.jalaliDay === day ? "today-day" : ""} ${day === selectedCalendarDay.jalaliDay ? "selected-day" : ""}`} key={day} onClick={() => { if (matchingWeekDay) setSelectedDateKey(matchingWeekDay.dateKey); }}><strong>{day}</strong>{count > 0 && <small>{count} session{count > 1 ? "s" : ""}</small>}</button>; })}</div></div>}
      <div className="agenda"><div className="card-head"><div><span className="eyebrow">{selectedDateKey < todayKey ? "HISTORY" : selectedDateKey === todayKey ? "TODAY" : "UPCOMING"}</span><h2>{dayLabel}</h2></div><span className="chip">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span></div>{sessions.length ? sessions.map((s, i) => { const status = statusFor(s); return <div className="agenda-row" key={s.id}><time>{s.defaultStartTime}<small>{s.defaultDurationMinutes} min</small></time><i className={`line line-${i % 3}`} /><Avatar student={s} /><div><strong>{s.name}</strong><small>{s.goal}</small></div>{selectedDateKey === todayKey && status === "scheduled" ? <button className="calendar-present" onClick={() => present(s.id, selectedDateKey)}><Check /> Present</button> : <StatusPill status={status} />}<button aria-label={`Edit ${s.name} schedule`} onClick={() => editSchedule(s.id)}><MoreHorizontal /></button></div>; }) : <div className="empty-agenda"><CalendarDays /><strong>No sessions on this day</strong><span>Select another date or schedule a client.</span></div>}</div>
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
    { icon: Target, label: "TRAINING RHYTHM", title: "Body-map thresholds", text: "Muscle freshness uses your default rhythm: active up to 4 days, attention after 7 days, ready after 14 days." },
  ];
  return <>
    <Heading eyebrow="COACH SETTINGS" title="Keep your rules clear." sub="Policies apply across your independent coaching space." />
    <section className="settings-grid">{cards.map((c, i) => { const Icon = c.icon; return <article className="surface setting-card" key={c.title}><span className={`setting-icon setting-${i}`}><Icon /></span><div><span className="eyebrow">{c.label}</span><h2>{c.title}</h2><p>{c.text}</p></div>{i < 2 ? <div className="setting-control"><span><strong>{i ? "Session reminders" : "Count absence as a used session"}</strong><small>{i ? "24 hours before each session" : absence ? "Enabled for new absences" : "Balance stays unchanged"}</small></span><Switch checked={i ? true : absence} onCheckedChange={(v) => { if (!i) setAbsence(v); toast.success("Preference updated"); }} /></div> : <button className="text-link" onClick={() => toast.info("Threshold editor comes next")}>Review thresholds <ArrowRight /></button>}</article>; })}</section>
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
  const [noteHistoryError, setNoteHistoryError] = useState<string | null>(null);
  // Bumped to force a refetch of the current selected Member's history —
  // after a Note PUT succeeds, or from Retry. The effect always re-reads
  // `selected?.id` itself, so bumping this never targets a stale Member.
  const [noteHistoryVersion, setNoteHistoryVersion] = useState(0);
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
  const selected: Student | undefined = useMemo(() => students.find((s) => s.id === selectedId) ?? students[0], [students, selectedId]);
  const nav = coachNav;

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
      setNoteHistoryError(null);
      setNoteHistoryLoading(true);
      try {
        const response = await apiFetch(`/api/sessions?memberId=${memberId}&limit=50`);
        if (!response.ok) throw new Error(`Request failed with ${response.status}`);
        const payload: unknown = await response.json();
        const list = (payload as { sessions?: unknown })?.sessions;
        if (!Array.isArray(list)) throw new Error("Response did not contain a sessions array");
        if (active) setNoteHistory(list as SessionHistoryItem[]);
      } catch (error) {
        console.error("Could not load session history", error);
        if (active) setNoteHistoryError("Could not load session history.");
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

  function openSession(id?: number, source: "manual" | "attendance" = "manual", dateKey?: string) {
    const target = id ?? selected?.id;
    if (target === undefined) return;
    setSelectedId(target);
    setSessionDateKey(dateKey ?? getAppDateKey());
    setSessionError(null);
    setSessionNoteText("");
    setResolvedSessionId(null);
    setSessionSource(source);
    setSessionOpen(true);
  }
  function beginAttendance(id: number, status: Attendance, dateKey?: string) {
    if (status === "present") openSession(id, "attendance", dateKey);
    else {
      const originalDateKey = dateKey ?? getAppDateKey();
      setSelectedId(id);
      setAbsenceDateKey(originalDateKey);
      setReplacementDateKey(getNextAppDates(originalDateKey, 1)[0].dateKey);
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
    setSavingAbsence(true);
    setAbsenceError(null);
    try {
      // Only these four fields are sent; the server derives coachId, status,
      // duration and the original session's start time. sessionsLeft,
      // attendance and the mock "next" text stay local/mock and are never
      // mutated from this response.
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
        // Discover what is already persisted for this member/date before
        // deciding how to save: an existing pending replacement must be
        // completed in place, never duplicated with a new normal session.
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
          toast.info(`${member.name} already has a session recorded for this date.`);
          return;
        }

        const pendingReplacement = existing.find(
          (s) => s.status === "replacement" && s.replacementForId !== null
        );

        if (pendingReplacement) {
          // Complete the existing replacement row in place; never fall back
          // to a normal POST here, or history would be duplicated/corrupted.
          const response = await apiFetch(`/api/sessions/${pendingReplacement.id}/complete`, {
            method: "PATCH",
          });
          if (!response.ok) {
            if (response.status === 409) {
              setSessionOpen(false);
              toast.info(`${member.name} already has a session recorded for this date.`);
              return;
            }
            const payload: unknown = await response.json().catch(() => null);
            setSessionError(
              (payload as { error?: string } | null)?.error ?? "Could not complete the replacement session."
            );
            return;
          }
          const payload: unknown = await response.json().catch(() => null);
          completedSessionId = (payload as { session?: { id: number } } | null)?.session?.id ?? null;
        } else {
          // No persisted replacement or completed row: only memberId and
          // dateKey are sent; the server derives coach, status, time and
          // duration. sessionsLeft, attendance and muscle history stay
          // mock/local and are never mutated from this response.
          const response = await apiFetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memberId: member.id, dateKey: sessionDateKey }),
          });
          if (response.status === 409) {
            setSessionOpen(false);
            toast.info(`${member.name} already has a session recorded for this date.`);
            return;
          }
          if (!response.ok) {
            const payload: unknown = await response.json().catch(() => null);
            setSessionError((payload as { error?: string } | null)?.error ?? "Could not save the session.");
            return;
          }
          const payload: unknown = await response.json().catch(() => null);
          completedSessionId = (payload as { session?: { id: number } } | null)?.session?.id ?? null;
        }

        // The real id the server just returned; never guessed/reconstructed.
        setResolvedSessionId(completedSessionId);
      }

      const trimmedNote = sessionNoteText.trim();
      if (!trimmedNote) {
        setSessionOpen(false);
        setResolvedSessionId(null);
        setSessionNoteText("");
        toast.success(`Session confirmed for ${member.name}`);
        return;
      }

      if (completedSessionId === null) {
        // Defensive only: the branches above always resolve a real id before
        // reaching here. Never fabricate one to attempt a note write.
        setSessionError("Could not determine the saved session.");
        return;
      }

      const noteResponse = await apiFetch(`/api/sessions/${completedSessionId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: trimmedNote }),
      });

      if (!noteResponse.ok) {
        // The Session write already succeeded and its id is retained above;
        // keep the dialog open with the note text intact so Retry saves only
        // the note, never a second Session write.
        setSessionError(
          "Session saved, but the note could not be saved. Retry will save the note only."
        );
        return;
      }

      // Note PUT just succeeded: refetch the Client Profile history rather
      // than fabricating a local Note object, so the persisted API stays
      // the single source of truth.
      setNoteHistoryVersion((value) => value + 1);
      setSessionOpen(false);
      setResolvedSessionId(null);
      setSessionNoteText("");
      toast.success(`Session and note saved for ${member.name}`);
    } catch (error) {
      console.error("Could not save session", error);
      setSessionError("Could not reach the server.");
    } finally {
      setSavingSession(false);
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
  if (loadState !== "ready" || !selected) {
    const failed = loadState === "error";
    const empty = loadState === "ready" && !selected;
    return <div className="app-shell">
      <div className="app-main">
        <header className="topbar"><div className="mobile-brand"><AppLogo compact onClick={() => setLogoOpen(true)} /></div></header>
        <main className="content">
          <Heading
            eyebrow="MEMBERS"
            title={failed ? "Couldn't load members." : empty ? "No members yet." : "Loading members…"}
            sub={failed
              ? "The member list could not be read from the database."
              : empty
                ? "The database returned no member records."
                : "Reading persisted member profiles."}
            action={failed ? <Button className="primary-action" onClick={() => { setLoadState("loading"); void fetchMembers().then(applyMembers); }}>Retry</Button> : undefined}
          />
        </main>
      </div>
      <Toaster position="top-center" richColors />
    </div>;
  }

  let content: React.ReactNode;
  if (view === "clients") content = <Clients apiFetch={apiFetch} students={students} selected={selected} select={setSelectedId} add={() => { setClientError(null); setClientOpen(true); }} log={() => openSession()} editSchedule={() => openScheduleEditor()} editProfile={openProfileEditor} noteHistory={noteHistory} noteHistoryLoading={noteHistoryLoading} noteHistoryError={noteHistoryError} retryNoteHistory={() => setNoteHistoryVersion((value) => value + 1)} muscle={muscle} setMuscle={setMuscle} />;
  else if (view === "calendar") content = <CalendarView students={students} present={(id, dateKey) => beginAttendance(id, "present", dateKey)} editSchedule={openScheduleEditor} />;
  else if (view === "nutrition") content = <Nutrition meals={initialMeals} students={students} selected={selected} select={setSelectedId} />;
  else if (view === "settings") content = <SettingsView absence={absence} setAbsence={setAbsence} />;
  else content = <CoachDashboard students={students} selected={selected} select={setSelectedId} attendance={beginAttendance} logSession={() => openSession()} addClient={() => { setClientError(null); setClientOpen(true); }} muscle={muscle} setMuscle={setMuscle} />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><AppLogo onClick={() => setLogoOpen(true)} /><span>FIT & MISCHIEF</span></div><div className="workspace"><AccountPhoto src={coachPhoto} initials="JL" name="Jordan Lee" onClick={() => setProfilePhotoOpen(true)} /><div><strong>Jordan Lee</strong><small>Independent coach</small></div><ChevronDown /></div><nav>{nav.map(([id, text, Icon]) => <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}><Icon /><span>{text}</span>{id === "clients" && <b>{students.length}</b>}</button>)}</nav><footer><button><MessageCircle />Support</button><button onClick={() => onLogout()}><LogOut />Sign out</button></footer></aside>
    <div className="app-main"><header className="topbar"><div className="mobile-brand"><AppLogo compact onClick={() => setLogoOpen(true)} /></div><div className="top-actions"><button aria-label="Notifications"><Bell /><i /></button><AccountPhoto src={coachPhoto} initials="JL" name="Jordan Lee" onClick={() => setProfilePhotoOpen(true)} /></div></header><main className="content">{content}</main></div>
    <nav className="mobile-nav">{nav.map(([id, text, Icon]) => <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}><Icon /><span>{text}</span></button>)}</nav>

    <Dialog open={logoOpen} onOpenChange={setLogoOpen}><DialogContent className="logo-dialog"><DialogHeader><DialogTitle className="visually-hidden">Fit & Mischief App logo</DialogTitle><DialogDescription className="visually-hidden">Expanded app logo</DialogDescription></DialogHeader><img src="/app-logo.png" alt="Fit & Mischief App — Naughty & Strong Together" /></DialogContent></Dialog>
    <Dialog open={profilePhotoOpen} onOpenChange={setProfilePhotoOpen}><DialogContent className="app-dialog photo-dialog"><DialogHeader><DialogTitle>Profile photo</DialogTitle><DialogDescription>Choose a photo for Jordan Lee.</DialogDescription></DialogHeader><div className="photo-preview">{coachPhoto ? <img src={coachPhoto} alt="Jordan Lee" /> : <span>JL</span>}</div><label className="photo-upload"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => chooseProfilePhoto(e.target.files?.[0])} /><span><Plus /> Choose image</span><small>PNG, JPG or WebP</small></label><DialogFooter><Button className="wide-dark" onClick={() => setProfilePhotoOpen(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={clientOpen} onOpenChange={setClientOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Add a new client</DialogTitle><DialogDescription>Contact details, measurements and preferred rhythm.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={addClient}><label>Full name<Input name="name" placeholder="e.g. Sam Taylor" required /></label><label>Phone number<Input name="phone" type="tel" placeholder="e.g. +15550001111" required /></label><div className="form-grid"><label>Weight (kg)<Input name="weight" type="number" step="0.1" min="1" placeholder="72.5" required /></label><label>Height (cm)<Input name="height" type="number" step="1" min="1" placeholder="178" required /></label></div><label>Primary goal<Input name="goal" placeholder="Strength, mobility, endurance…" required /></label><div className="form-grid"><label>Preferred time<Input name="time" type="time" defaultValue="10:00" required /></label><label>Session duration<select name="duration" defaultValue="60"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="75">75 minutes</option><option value="90">90 minutes</option></select></label></div><label>Preferred training days</label><div className="day-picker">{weekDays.map((day) => <button type="button" className={clientDays.includes(day) ? "selected-day" : ""} key={day} onClick={() => setClientDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>)}</div>{clientError && <p className="policy-note" role="alert">{clientError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setClientOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!clientDays.length || creatingClient}>{creatingClient ? "Creating…" : "Create client"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={sessionOpen} onOpenChange={(open) => { if (!savingSession) setSessionOpen(open); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{sessionSource === "attendance" ? "Complete this session" : "Log session"}</DialogTitle><DialogDescription>Confirm the completed session for {selected.name} on {jalaliLabelForDateKey(sessionDateKey)}.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={logSession}><label>Session note (optional)<Textarea value={sessionNoteText} onChange={(e) => setSessionNoteText(e.target.value)} placeholder="Intensity, limitations, progress or next-session cues…" /></label>{sessionError && <p className="policy-note" role="alert">{sessionError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setSessionOpen(false)} disabled={savingSession}>Cancel</Button><Button className="wide-dark" type="submit" disabled={savingSession}>{savingSession ? "Saving…" : sessionSource === "attendance" ? "Save & confirm attendance" : "Save session"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={absenceOpen} onOpenChange={(open) => { if (!savingAbsence) setAbsenceOpen(open); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Reschedule before marking absent</DialogTitle><DialogDescription>The missed session for {selected.name} was on {jalaliLabelForDateKey(absenceDateKey)}. Choose a replacement date before it is recorded as absent.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={recordAbsence}><label>Replacement day</label><div className="replacement-days">{replacementChoices.map((choice) => <button type="button" className={replacementDateKey === choice.dateKey ? "selected-day" : ""} key={choice.dateKey} onClick={() => setReplacementDateKey(choice.dateKey)}><small>{choice.weekday}</small><strong>{choice.jalaliDay} {choice.jalaliMonthName}</strong></button>)}</div><label>Replacement time<Input name="time" type="time" defaultValue={selected.defaultStartTime} required /></label><div className="policy-note"><CalendarDays /><span><strong>{absence ? "One session will be used" : "Session balance will stay unchanged"}</strong><small>This follows the coach’s current absence policy.</small></span></div>{absenceError && <p className="policy-note" role="alert">{absenceError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setAbsenceOpen(false)} disabled={savingAbsence}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!replacementDateKey || savingAbsence}>{savingAbsence ? "Saving…" : "Confirm absence & reschedule"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={profileOpen} onOpenChange={setProfileOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Edit member profile</DialogTitle><DialogDescription>Contact details and measurements for {selected.name}.</DialogDescription></DialogHeader><form key={selected.id} className="dialog-form" onSubmit={updateProfile}><label>Full name<Input name="name" defaultValue={selected.name} required /></label><label>Phone number<Input name="phone" type="tel" defaultValue={selected.phone ?? ""} placeholder="e.g. +15550001111" required /></label><div className="form-grid"><label>Weight (kg)<Input name="weight" type="number" step="0.1" min="1" defaultValue={selected.weightKg ?? ""} placeholder="72.5" required /></label><label>Height (cm)<Input name="height" type="number" step="1" min="1" defaultValue={selected.heightCm ?? ""} placeholder="178" required /></label></div><label>Primary goal<Input name="goal" defaultValue={selected.goal} required /></label>{profileError && <p className="policy-note" role="alert">{profileError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setProfileOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={savingProfile}>{savingProfile ? "Saving\u2026" : "Save profile"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Edit training schedule</DialogTitle><DialogDescription>Update {selected.name}’s usual training days, start time and session length.</DialogDescription></DialogHeader><form key={selected.id} className="dialog-form" onSubmit={updateSchedule}><label>Training days</label><div className="day-picker">{weekDays.map((day) => <button type="button" className={scheduleDays.includes(day) ? "selected-day" : ""} key={day} onClick={() => setScheduleDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>)}</div><div className="form-grid"><label>Start time<Input name="time" type="time" defaultValue={selected.defaultStartTime} required /></label><label>Session duration<select name="duration" defaultValue={selected.defaultDurationMinutes}><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="75">75 minutes</option><option value="90">90 minutes</option></select></label></div>{scheduleError && <p className="policy-note" role="alert">{scheduleError}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!scheduleDays.length || savingSchedule}>{savingSchedule ? "Saving…" : "Update schedule"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Toaster position="top-center" richColors />
  </div>;
}
