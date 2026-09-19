"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity, Apple, ArrowRight, Bell, CalendarDays, Check, ChevronDown,
  ChevronRight, CircleUserRound, Clock3, Dumbbell, Flame, LayoutDashboard,
  Leaf, LogOut, MessageCircle, MoreHorizontal, Plus, Search, Settings,
  ShieldCheck, Sparkles, Target, TrendingUp, UsersRound, Utensils, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";

type Role = "coach" | "member";
type View = "today" | "clients" | "calendar" | "body" | "nutrition" | "plan" | "settings";
type Attendance = "scheduled" | "present" | "absent" | "cancelled";
type MuscleKey = "shoulders" | "chest" | "arms" | "core" | "back" | "glutes" | "quads" | "hamstrings" | "calves";

type Student = {
  id: number; name: string; initials: string; accent: string; goal: string;
  time: string; sessionsLeft: number; sessionsTotal: number; streak: number;
  attendance: Attendance; next: string; muscles: Record<MuscleKey, number>;
  sessionDuration: number; preferredDays: string[]; periodStart: string; periodEnd: string; photo?: string;
};
type Meal = {
  id: number; owner: string; day: string; type: string; time: string; description: string;
  protein: boolean; produce: boolean; water: number;
};
type SessionNote = { id: number; clientId: number; date: string; muscles: MuscleKey[]; note: string };

const labels: Record<MuscleKey, string> = {
  shoulders: "Shoulders", chest: "Chest", arms: "Arms", core: "Core",
  back: "Back", glutes: "Glutes", quads: "Quads", hamstrings: "Hamstrings", calves: "Calves",
};

const baseMuscles: Record<MuscleKey, number> = {
  shoulders: 1, chest: 1, arms: 3, core: 5, back: 8, glutes: 11, quads: 13, hamstrings: 16, calves: 9,
};

const initialStudents: Student[] = [
  { id: 1, name: "Alex Morgan", initials: "AM", accent: "#dfff24", goal: "Strength & mobility", time: "08:30", sessionsLeft: 6, sessionsTotal: 12, streak: 4, attendance: "scheduled", next: "Today, 08:30", muscles: baseMuscles, sessionDuration: 50, preferredDays: ["Sat", "Mon", "Wed"], periodStart: "1405/05/27", periodEnd: "1405/07/10" },
  { id: 2, name: "Maya Chen", initials: "MC", accent: "#f1b57e", goal: "Build endurance", time: "10:00", sessionsLeft: 2, sessionsTotal: 10, streak: 7, attendance: "scheduled", next: "Today, 10:00", muscles: { shoulders: 6, chest: 10, arms: 6, core: 2, back: 2, glutes: 4, quads: 4, hamstrings: 7, calves: 12 }, sessionDuration: 60, preferredDays: ["Sun", "Tue", "Thu"], periodStart: "1405/05/20", periodEnd: "1405/06/31" },
  { id: 3, name: "Daniel Reed", initials: "DR", accent: "#9dc796", goal: "Return to training", time: "14:30", sessionsLeft: 9, sessionsTotal: 12, streak: 2, attendance: "scheduled", next: "Today, 14:30", muscles: { shoulders: 12, chest: 12, arms: 9, core: 2, back: 3, glutes: 2, quads: 2, hamstrings: 2, calves: 6 }, sessionDuration: 60, preferredDays: ["Mon", "Wed", "Fri"], periodStart: "1405/06/10", periodEnd: "1405/07/25" },
  { id: 4, name: "Nina Patel", initials: "NP", accent: "#b9c2d3", goal: "Body composition", time: "17:00", sessionsLeft: 4, sessionsTotal: 8, streak: 5, attendance: "scheduled", next: "Tomorrow, 17:00", muscles: { shoulders: 3, chest: 8, arms: 3, core: 3, back: 8, glutes: 1, quads: 1, hamstrings: 5, calves: 6 }, sessionDuration: 45, preferredDays: ["Sat", "Tue"], periodStart: "1405/06/01", periodEnd: "1405/07/01" },
];

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

const initialSessionNotes: SessionNote[] = [
  { id: 1, clientId: 1, date: "20 Shahrivar 1405", muscles: ["shoulders", "chest"], note: "Controlled tempo throughout. Shoulder stability improved; keep the pressing load unchanged next session." },
  { id: 2, clientId: 1, date: "17 Shahrivar 1405", muscles: ["core", "back"], note: "Good trunk control. Add one set to the anti-rotation work next week." },
  { id: 3, clientId: 2, date: "19 Shahrivar 1405", muscles: ["core", "quads"], note: "Conditioning pace was steady. Monitor right knee depth during split squats." },
  { id: 4, clientId: 3, date: "18 Shahrivar 1405", muscles: ["glutes", "hamstrings"], note: "Returned to hinge work pain-free. Keep two reps in reserve for the next session." },
  { id: 5, clientId: 4, date: "16 Shahrivar 1405", muscles: ["glutes", "core"], note: "Energy was lower than usual. Reduced volume and finished with mobility." },
];

const coachNav = [
  ["today", "Today", LayoutDashboard], ["clients", "Clients", UsersRound],
  ["calendar", "Calendar", CalendarDays], ["nutrition", "Nutrition", Apple], ["settings", "Settings", Settings],
] as const;
const memberNav = [
  ["today", "Home", LayoutDashboard], ["body", "Body", Activity],
  ["plan", "Plan", Dumbbell], ["nutrition", "Nutrition", Apple], ["settings", "Profile", CircleUserRound],
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
  const content = student.photo ? <img src={student.photo} alt={student.name} /> : student.initials;
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
    <Heading eyebrow="FRIDAY · 20 SHAHRIVAR 1405" title="Good morning, Jordan." sub="Four sessions today. Your first starts in 24 minutes." action={<Button className="primary-action" onClick={logSession}><Plus /> Log a session</Button>} />
    <section className="metrics">
      <article className="metric green"><span>TODAY’S LOAD</span><strong>4</strong><small>sessions</small><MiniWave /></article>
      <article className="metric gold"><span>CLIENT CONSISTENCY</span><strong>87<em>%</em></strong><small><TrendingUp /> 6% from last week</small></article>
      <article className="metric slate"><span>PLANS ENDING SOON</span><strong>2</strong><small>Maya and Nina need attention</small><button onClick={() => select(2)}>Review plans <ArrowRight /></button></article>
    </section>
    <section className="dashboard-grid">
      <article className="surface schedule">
        <div className="card-head"><div><span className="eyebrow">SCHEDULE</span><h2>Today’s sessions</h2></div><button className="soft-button" onClick={addClient}><Plus /> Add client</button></div>
        <div className="schedule-list">{students.slice(0, 3).map((s) => <div className={`schedule-row ${selected.id === s.id ? "selected-row" : ""}`} key={s.id} onClick={() => select(s.id)}><time>{s.time}</time><Avatar student={s} /><div><strong>{s.name}</strong><small>{s.goal}</small></div><div className="attend" onClick={(e) => e.stopPropagation()}>{s.attendance === "scheduled" ? <><button aria-label="Present" onClick={() => attendance(s.id, "present")}><Check /></button><button aria-label="Absent" onClick={() => attendance(s.id, "absent")}><X /></button></> : <StatusPill status={s.attendance} />}</div><ChevronRight /></div>)}</div>
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

function Clients({ students, selected, select, add, log, editSchedule, sessionNotes, muscle, setMuscle }: {
  students: Student[]; selected: Student; select: (id: number) => void; add: () => void;
  log: () => void; editSchedule: () => void; sessionNotes: SessionNote[]; muscle: MuscleKey; setMuscle: (m: MuscleKey) => void;
}) {
  const notes = sessionNotes.filter((item) => item.clientId === selected.id);
  return <>
    <Heading eyebrow="CLIENT DIRECTORY" title="Your people." sub={`${students.length} active clients · 2 plans ending soon`} action={<Button className="primary-action" onClick={add}><Plus /> Add client</Button>} />
    <section className="clients-grid">
      <article className="surface directory"><label className="search"><Search /><input placeholder="Search clients" /></label><div>{students.map((s) => <button className={selected.id === s.id ? "selected-client" : ""} key={s.id} onClick={() => select(s.id)}><Avatar student={s} /><span><strong>{s.name}</strong><small>{s.goal}</small></span><b>{s.sessionsLeft}<small>left</small></b><ChevronRight /></button>)}</div></article>
      <div className="client-detail"><article className="surface profile-card"><div className="person"><Avatar student={selected} large /><div><span className="eyebrow">ACTIVE CLIENT</span><h2>{selected.name}</h2><p>{selected.goal}</p></div></div><div className="action-pair"><Button className="soft-button" onClick={editSchedule}><CalendarDays /> Edit schedule</Button><Button className="wide-dark fit" onClick={log}><Plus /> Log session</Button></div><div className="profile-stats"><span><strong>{selected.sessionsLeft}</strong>sessions left</span><span><strong>{selected.sessionDuration}</strong>minutes / session</span><span><strong>{selected.preferredDays.length}</strong>weekly days</span></div></article><article className="surface session-notes-card"><div className="card-head"><div><span className="eyebrow">COACH SESSION NOTES</span><h2>Recent observations</h2></div><span className="chip">{notes.length} notes</span></div><div className="session-note-list">{notes.map((item) => <div className="session-note" key={item.id}><time>{item.date}</time><div><strong>{item.muscles.map((m) => labels[m]).join(" · ")}</strong><p>{item.note}</p></div></div>)}</div></article><BodyMap student={selected} selected={muscle} onSelect={setMuscle} /></div>
    </section>
  </>;
}

function CalendarView({ students, present, editSchedule }: { students: Student[]; present: (id: number) => void; editSchedule: (id: number) => void }) {
  const [mode, setMode] = useState<"week" | "month">("week");
  const [selectedDay, setSelectedDay] = useState(20);
  const orderedWeekdays = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
  const weekdayFor = (day: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(day - 1) % 7];
  const sessions = selectedDay === 20 ? students.slice(0, 3) : students.filter((s) => s.preferredDays.includes(weekdayFor(selectedDay)));
  const statusFor = (student: Student): Attendance => selectedDay < 20 ? ((student.id + selectedDay) % 4 === 0 ? "absent" : "present") : selectedDay === 20 ? student.attendance : "scheduled";
  const week = [14, 15, 16, 17, 18, 19, 20];
  const dayLabel = `${weekdayFor(selectedDay)}, ${selectedDay} Shahrivar 1405`;
  return <>
    <Heading eyebrow="SHAHRIVAR 1405" title={mode === "week" ? "Your training week." : "Your training month."} sub="Select any Solar Hijri date to review scheduled and completed sessions." action={<div className="calendar-actions"><div className="view-toggle"><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button><button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>Month</button></div><Button className="primary-action" onClick={() => toast.success("Choose a client to edit their schedule")}><Plus /> Schedule</Button></div>} />
    <article className="surface calendar">
      {mode === "week" ? <div className="week">{week.map((day) => <button className={`${day === 20 ? "today-day" : ""} ${day === selectedDay ? "selected-day" : ""}`} key={day} onClick={() => setSelectedDay(day)}><span>{weekdayFor(day)}</span><strong>{day}</strong>{day === 20 && <i />}</button>)}</div> : <div className="month-view"><div className="month-weekdays">{orderedWeekdays.map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid"><i />{Array.from({ length: 31 }, (_, i) => i + 1).map((day) => { const count = day === 20 ? 3 : students.filter((s) => s.preferredDays.includes(weekdayFor(day))).length; return <button className={`${day === 20 ? "today-day" : ""} ${day === selectedDay ? "selected-day" : ""}`} key={day} onClick={() => setSelectedDay(day)}><strong>{day}</strong>{count > 0 && <small>{count} session{count > 1 ? "s" : ""}</small>}</button>; })}</div></div>}
      <div className="agenda"><div className="card-head"><div><span className="eyebrow">{selectedDay < 20 ? "HISTORY" : selectedDay === 20 ? "TODAY" : "UPCOMING"}</span><h2>{dayLabel}</h2></div><span className="chip">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span></div>{sessions.length ? sessions.map((s, i) => { const status = statusFor(s); return <div className="agenda-row" key={s.id}><time>{s.time}<small>{s.sessionDuration} min</small></time><i className={`line line-${i % 3}`} /><Avatar student={s} /><div><strong>{s.name}</strong><small>{s.goal}</small></div>{selectedDay === 20 && status === "scheduled" ? <button className="calendar-present" onClick={() => present(s.id)}><Check /> Present</button> : <StatusPill status={status} />}<button aria-label={`Edit ${s.name} schedule`} onClick={() => editSchedule(s.id)}><MoreHorizontal /></button></div>; }) : <div className="empty-agenda"><CalendarDays /><strong>No sessions on this day</strong><span>Select another date or schedule a client.</span></div>}</div>
    </article>
  </>;
}

const nutritionSignals = [
  { name: "Alex Morgan", consistency: 86, protein: 91, hydration: 72, note: "Strong protein coverage · hydration needs attention" },
  { name: "Maya Chen", consistency: 71, protein: 54, hydration: 61, note: "Add protein to breakfast and post-session meals" },
  { name: "Daniel Reed", consistency: 79, protein: 82, hydration: 78, note: "Balanced week · keep evening hydration steady" },
  { name: "Nina Patel", consistency: 43, protein: 67, hydration: 48, note: "Three missing days · follow up before next session" },
];

function Nutrition({ meals, students, selected, select, add, role }: { meals: Meal[]; students: Student[]; selected: Student; select: (id: number) => void; add: () => void; role: Role }) {
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
    <Heading eyebrow="NUTRITION LOG" title={role === "coach" ? "Your clients’ nutrition." : "Food, without the noise."} sub={role === "coach" ? "Every student’s weekly pattern and latest food entries in one view." : "Simple patterns your training decisions can use."} action={role === "member" ? <Button className="primary-action" onClick={add}><Plus /> Log a meal</Button> : undefined} />
    {role === "coach" && <article className="surface nutrition-overview"><div className="card-head"><div><span className="eyebrow">ALL-CLIENT OVERVIEW</span><h2>Select a client</h2></div><span className="chip">{students.length} clients</span></div><div className="nutrition-client-grid">{students.map((student) => { const itemSignal = nutritionSignals.find((item) => item.name === student.name) ?? nutritionSignals[0]; return <button className={`nutrition-client ${selected.id === student.id ? "active" : ""}`} key={student.id} onClick={() => select(student.id)}><Avatar student={student} /><div><strong>{student.name}</strong><small>{itemSignal.note}</small><span><i style={{ width: `${itemSignal.consistency}%` }} /></span></div><b>{itemSignal.consistency}%<small>consistent</small></b></button>; })}</div></article>}
    <section className="nutrition-grid"><article className="metric gold nutrition-score"><span>WEEKLY CONSISTENCY · {selected.name.toUpperCase()}</span><strong>{signal.consistency}<em>%</em></strong><small>{visibleMeals.length} food entries logged this week</small><MiniWave /></article><article className="surface nutrition-summary"><div className="card-head"><div><span className="eyebrow">RULE-BASED INSIGHT · {selected.name.toUpperCase()}</span><h2>{signal.note.split(" · ")[0]}.</h2></div><Sparkles /></div><p>{signal.note}. Use this pattern when planning the client’s next training session.</p><div className="bars">{[["Protein coverage", signal.protein], ["Produce variety", Math.min(92, signal.consistency + 5)], ["Hydration", signal.hydration]].map(([name, n]) => <span key={String(name)}><i>{name}</i><b><em style={{ width: `${n}%` }} /></b><strong>{n}%</strong></span>)}</div></article></section>
    <article className="surface repeat-insight"><Sparkles /><div><span className="eyebrow">REPETITIVE CONSUMPTION</span><h3>{repeat.title}</h3><p>{repeat.text}</p></div></article>
    <article className="surface meal-section"><div className="card-head"><div><span className="eyebrow">THIS WEEK</span><h2>Client food activity</h2></div><span className="chip">{selected.name} <ChevronDown /></span></div><div className="meal-grid">{visibleMeals.map((m) => <div className="meal" key={m.id}><span><Utensils /></span><div><small>{m.day} · {m.type} · {m.time}</small><h3>{m.description}</h3><small>{m.owner}</small><div className="meal-tags">{m.protein && <i><Dumbbell /> Protein</i>}{m.produce && <i><Leaf /> Produce</i>}<i>{m.water} glasses</i></div></div></div>)}</div></article>
  </>;
}

function SettingsView({ absence, setAbsence, role }: { absence: boolean; setAbsence: (v: boolean) => void; role: Role }) {
  const cards = [
    { icon: ShieldCheck, label: "SESSION POLICY", title: "Absence handling", text: "When enabled, a client absence automatically uses one session. You can still override individual cases.", control: true },
    { icon: Bell, label: "REMINDERS", title: "Session nudges", text: "Send a gentle reminder before scheduled sessions and when a plan has two sessions remaining.", control: false },
    { icon: Target, label: "TRAINING RHYTHM", title: "Body-map thresholds", text: "Muscle freshness uses your default rhythm: active up to 4 days, attention after 7 days, ready after 14 days." },
  ];
  return <>
    <Heading eyebrow={role === "coach" ? "COACH SETTINGS" : "MEMBER PROFILE"} title={role === "coach" ? "Keep your rules clear." : "Your training profile."} sub={role === "coach" ? "Policies apply across your independent coaching space." : "Personal details and training preferences."} />
    <section className="settings-grid">{cards.map((c, i) => { const Icon = c.icon; return <article className="surface setting-card" key={c.title}><span className={`setting-icon setting-${i}`}><Icon /></span><div><span className="eyebrow">{c.label}</span><h2>{c.title}</h2><p>{c.text}</p></div>{i < 2 ? <div className="setting-control"><span><strong>{i ? "Session reminders" : "Count absence as a used session"}</strong><small>{i ? "24 hours before each session" : absence ? "Enabled for new absences" : "Balance stays unchanged"}</small></span><Switch checked={i ? true : absence} onCheckedChange={(v) => { if (!i) setAbsence(v); toast.success("Preference updated"); }} /></div> : <button className="text-link" onClick={() => toast.info("Threshold editor comes next")}>Review thresholds <ArrowRight /></button>}</article>; })}</section>
  </>;
}

function MemberHome({ member, muscle, setMuscle, openBody }: { member: Student; muscle: MuscleKey; setMuscle: (m: MuscleKey) => void; openBody: () => void }) {
  return <>
    <section className="member-head"><div><span className="eyebrow">FRIDAY · 20 SHAHRIVAR 1405</span><h1>Morning, Alex.</h1><p>Your next session starts at 08:30.</p></div><Avatar student={member} large /></section>
    <section className="member-hero"><article className="metric green next-session"><span>NEXT SESSION</span><strong>08:30</strong><h2>Lower body · Strength</h2><small>With Jordan Lee · Studio A</small><div><Button onClick={() => toast.success("You’re checked in")}>Check in <ArrowRight /></Button><button onClick={() => toast.info("Jordan has been notified")}><MessageCircle /> Message coach</button></div></article><article className="surface member-balance"><span className="eyebrow">YOUR PLAN</span><div><strong>{member.sessionsLeft}</strong><span>of {member.sessionsTotal}<br />sessions left</span></div><Progress value={member.sessionsLeft / member.sessionsTotal * 100} /><small><span>Started {member.periodStart}</span><span>Ends {member.periodEnd}</span></small></article></section>
    <section className="body-grid"><BodyMap student={member} selected={muscle} onSelect={setMuscle} /><article className="metric gold recovery"><span>RECOVERY SIGNAL</span><strong>Good</strong><p>Shoulders and chest are in recovery. Your lower body is ready for today’s planned stimulus.</p><div className="recommend"><Flame /><div><strong>4 week streak</strong><span>Consistency is trending up</span></div></div><button onClick={openBody}>Explore body history <ArrowRight /></button></article></section>
  </>;
}

function Plan({ member }: { member: Student }) {
  const items = [["Goblet squat", "4 sets · 8 reps", "Quads · Glutes"], ["Romanian deadlift", "3 sets · 10 reps", "Hamstrings"], ["Reverse lunge", "3 sets · 8 / side", "Glutes · Quads"], ["Dead bug", "3 sets · 10 / side", "Core"]];
  return <>
    <Heading eyebrow="TODAY’S PROGRAM" title="Lower body · Strength." sub={`Prepared by Jordan for ${member.name}`} action={<span className="chip"><Clock3 /> About 52 min</span>} />
    <section className="plan-grid"><article className="surface exercises">{items.map(([name, detail, area], i) => <div className="exercise" key={name}><button className={i === 0 ? "done" : ""} onClick={(e) => e.currentTarget.classList.toggle("done")}><Check /></button><span>0{i + 1}</span><div><h3>{name}</h3><small>{area}</small></div><strong>{detail}</strong><ChevronRight /></div>)}</article><article className="surface coach-note"><span className="eyebrow">COACH NOTE</span><h2>Quality over load.</h2><p>Keep the tempo controlled. Stop the set if your lower back takes over, and leave two good reps in reserve.</p><div className="person"><span className="coach-avatar">JL</span><div><strong>Jordan Lee</strong><small>Added this morning</small></div></div></article></section>
  </>;
}

export default function CoachApp() {
  const [role, setRole] = useState<Role>("coach");
  const [view, setView] = useState<View>("today");
  const [students, setStudents] = useState(initialStudents);
  const [selectedId, setSelectedId] = useState(1);
  const [muscle, setMuscle] = useState<MuscleKey>("shoulders");
  const [absence, setAbsence] = useState(true);
  const [meals, setMeals] = useState(initialMeals);
  const [sessionNotes, setSessionNotes] = useState(initialSessionNotes);
  const [clientOpen, setClientOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const [mealOpen, setMealOpen] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [profilePhotoOpen, setProfilePhotoOpen] = useState(false);
  const [coachPhoto, setCoachPhoto] = useState<string | null>(null);
  const [sessionMuscles, setSessionMuscles] = useState<MuscleKey[]>(["shoulders", "chest"]);
  const [clientDays, setClientDays] = useState<string[]>(["Sat", "Mon", "Wed"]);
  const [scheduleDays, setScheduleDays] = useState<string[]>([]);
  const [replacementDay, setReplacementDay] = useState("1405/06/23");
  const [sessionSource, setSessionSource] = useState<"manual" | "attendance">("manual");
  const selected = useMemo(() => students.find((s) => s.id === selectedId) ?? students[0], [students, selectedId]);
  const nav = role === "coach" ? coachNav : memberNav;

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
      description: "Read the currently visible coaching role, selected client, session balance, and absence policy.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ role, activeClients: students.length, selectedClient: selected.name, sessionsLeft: selected.sessionsLeft, absenceCountsAsUsed: absence }),
    });
    register({
      name: "set_absence_policy", title: "Set absence policy",
      description: "Enable or disable whether a client absence uses one session, and update the visible setting.",
      inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => { if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean"); setAbsence(input.enabled); setRole("coach"); setView("settings"); return { enabled: input.enabled }; },
    });
    register({
      name: "open_client_profile", title: "Open client profile",
      description: "Open a client profile by numeric client id in the visible coach workspace.",
      inputSchema: { type: "object", properties: { clientId: { type: "number" } }, required: ["clientId"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => { const client = students.find((item) => item.id === input.clientId); if (!client) throw new Error("Client not found"); setRole("coach"); setSelectedId(client.id); setView("clients"); return { clientId: client.id, name: client.name }; },
    });
    return () => lifecycle.abort();
  }, [absence, role, selected.name, selected.sessionsLeft, students]);

  function openSession(id = selected.id, source: "manual" | "attendance" = "manual") {
    setSelectedId(id); setSessionMuscles([]); setSessionSource(source); setSessionOpen(true);
  }
  function beginAttendance(id: number, status: Attendance) {
    if (status === "present") openSession(id, "attendance");
    else { setSelectedId(id); setReplacementDay("1405/06/23"); setAbsenceOpen(true); }
  }
  function recordAbsence(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const time = String(f.get("time"));
    setStudents((all) => all.map((s) => s.id === selected.id ? { ...s, attendance: "absent", sessionsLeft: absence ? Math.max(0, s.sessionsLeft - 1) : s.sessionsLeft, next: `${replacementDay}, ${time}` } : s));
    setAbsenceOpen(false); toast.success(`Absence recorded · replacement set for ${replacementDay}`);
  }
  function openScheduleEditor(id = selected.id) {
    const client = students.find((s) => s.id === id);
    if (!client) return;
    setSelectedId(id); setScheduleDays(client.preferredDays); setScheduleOpen(true);
  }
  function addClient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const name = String(f.get("name")); const total = Number(f.get("sessions") || 8); const id = Math.max(...students.map((s) => s.id)) + 1;
    const time = String(f.get("time") || "TBD");
    const s: Student = { id, name, initials: name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase(), accent: "#dfff24", goal: String(f.get("goal")), time, sessionsLeft: total, sessionsTotal: total, streak: 0, attendance: "scheduled", next: clientDays.length ? `${clientDays[0]}, ${time}` : "Not scheduled", muscles: Object.fromEntries(Object.keys(labels).map((k) => [k, 15])) as Record<MuscleKey, number>, sessionDuration: Number(f.get("duration") || 60), preferredDays: clientDays, periodStart: String(f.get("periodStart")), periodEnd: String(f.get("periodEnd")) };
    setStudents((all) => [...all, s]); setSelectedId(id); setClientOpen(false); setView("clients"); toast.success(`${name} added to your roster`);
  }
  function logSession(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const note = String(f.get("notes") || "").trim();
    setStudents((all) => all.map((s) => s.id === selected.id ? { ...s, sessionsLeft: Math.max(0, s.sessionsLeft - 1), attendance: "present", muscles: Object.fromEntries(Object.entries(s.muscles).map(([k, d]) => [k, sessionMuscles.includes(k as MuscleKey) ? 0 : Math.min(30, d + 1)])) as Record<MuscleKey, number> } : s));
    if (note) setSessionNotes((all) => [{ id: Date.now(), clientId: selected.id, date: "20 Shahrivar 1405", muscles: sessionMuscles, note }, ...all]);
    setSessionOpen(false); toast.success(`Session saved · attendance confirmed for ${selected.name}`);
  }
  function updateSchedule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const time = String(f.get("time")); const date = String(f.get("nextDate"));
    setStudents((all) => all.map((s) => s.id === selected.id ? { ...s, preferredDays: scheduleDays, sessionDuration: Number(f.get("duration")), time, next: `${date}, ${time}`, periodStart: String(f.get("periodStart")), periodEnd: String(f.get("periodEnd")) } : s));
    setScheduleOpen(false); toast.success(`${selected.name}’s schedule updated`);
  }
  function addMeal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setMeals((all) => [{ id: Date.now(), owner: selected.name, day: "Fri 20", type: String(f.get("type")), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), description: String(f.get("description")), protein: f.get("protein") === "on", produce: f.get("produce") === "on", water: Number(f.get("water") || 0) }, ...all]); setMealOpen(false); toast.success("Meal added to today’s log");
  }
  function chooseProfilePhoto(file?: File) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (role === "coach") setCoachPhoto(url);
    else setStudents((all) => all.map((s) => s.id === selected.id ? { ...s, photo: url } : s));
    toast.success("Profile photo updated");
  }

  let content: React.ReactNode;
  if (role === "member" && view === "today") content = <MemberHome member={selected} muscle={muscle} setMuscle={setMuscle} openBody={() => setView("body")} />;
  else if (view === "clients") content = <Clients students={students} selected={selected} select={setSelectedId} add={() => setClientOpen(true)} log={() => openSession()} editSchedule={() => openScheduleEditor()} sessionNotes={sessionNotes} muscle={muscle} setMuscle={setMuscle} />;
  else if (view === "calendar") content = <CalendarView students={students} present={(id) => beginAttendance(id, "present")} editSchedule={openScheduleEditor} />;
  else if (view === "body") content = <><Heading eyebrow="BODY HISTORY" title="Know what’s ready." sub="Tap a muscle group to see its latest training signal." /><div className="solo-body"><BodyMap student={selected} selected={muscle} onSelect={setMuscle} /></div></>;
  else if (view === "nutrition") content = <Nutrition meals={meals} students={students} selected={selected} select={setSelectedId} add={() => setMealOpen(true)} role={role} />;
  else if (view === "plan") content = <Plan member={selected} />;
  else if (view === "settings") content = <SettingsView absence={absence} setAbsence={setAbsence} role={role} />;
  else content = <CoachDashboard students={students} selected={selected} select={setSelectedId} attendance={beginAttendance} logSession={() => openSession()} addClient={() => setClientOpen(true)} muscle={muscle} setMuscle={setMuscle} />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><AppLogo onClick={() => setLogoOpen(true)} /><span>FIT & MISCHIEF</span></div><div className="workspace"><AccountPhoto src={coachPhoto} initials="JL" name="Jordan Lee" onClick={() => { setRole("coach"); setProfilePhotoOpen(true); }} /><div><strong>Jordan Lee</strong><small>Independent coach</small></div><ChevronDown /></div><nav>{nav.map(([id, text, Icon]) => <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}><Icon /><span>{text}</span>{id === "clients" && <b>{students.length}</b>}</button>)}</nav><footer><button><MessageCircle />Support</button><button><LogOut />Sign out</button></footer></aside>
    <div className="app-main"><header className="topbar"><div className="mobile-brand"><AppLogo compact onClick={() => setLogoOpen(true)} /></div><div className="role-toggle"><button className={role === "coach" ? "active" : ""} onClick={() => { setRole("coach"); setView("today"); toast.success("Coach workspace opened"); }}>Coach</button><button className={role === "member" ? "active" : ""} onClick={() => { setRole("member"); setView("today"); setSelectedId(1); toast.success("Member app opened"); }}>Member</button></div><div className="top-actions"><button aria-label="Notifications"><Bell /><i /></button><AccountPhoto src={role === "coach" ? coachPhoto : selected.photo} initials={role === "coach" ? "JL" : selected.initials} name={role === "coach" ? "Jordan Lee" : selected.name} onClick={() => setProfilePhotoOpen(true)} /></div></header><main className="content">{content}</main></div>
    <nav className="mobile-nav">{nav.map(([id, text, Icon]) => <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}><Icon /><span>{text}</span></button>)}</nav>

    <Dialog open={logoOpen} onOpenChange={setLogoOpen}><DialogContent className="logo-dialog"><DialogHeader><DialogTitle className="visually-hidden">Fit & Mischief App logo</DialogTitle><DialogDescription className="visually-hidden">Expanded app logo</DialogDescription></DialogHeader><img src="/app-logo.png" alt="Fit & Mischief App — Naughty & Strong Together" /></DialogContent></Dialog>
    <Dialog open={profilePhotoOpen} onOpenChange={setProfilePhotoOpen}><DialogContent className="app-dialog photo-dialog"><DialogHeader><DialogTitle>Profile photo</DialogTitle><DialogDescription>Choose a photo for {role === "coach" ? "Jordan Lee" : selected.name}.</DialogDescription></DialogHeader><div className="photo-preview">{(role === "coach" ? coachPhoto : selected.photo) ? <img src={(role === "coach" ? coachPhoto : selected.photo) as string} alt={role === "coach" ? "Jordan Lee" : selected.name} /> : <span>{role === "coach" ? "JL" : selected.initials}</span>}</div><label className="photo-upload"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => chooseProfilePhoto(e.target.files?.[0])} /><span><Plus /> Choose image</span><small>PNG, JPG or WebP</small></label><DialogFooter><Button className="wide-dark" onClick={() => setProfilePhotoOpen(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={clientOpen} onOpenChange={setClientOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Add a new client</DialogTitle><DialogDescription>Set their plan, preferred rhythm and starting balance.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={addClient}><label>Full name<Input name="name" placeholder="e.g. Sam Taylor" required /></label><label>Primary goal<Input name="goal" placeholder="Strength, mobility, endurance…" required /></label><div className="form-grid"><label>Starting sessions<Input name="sessions" type="number" min="1" defaultValue="8" required /></label><label>Session duration<select name="duration" defaultValue="60"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="75">75 minutes</option><option value="90">90 minutes</option></select></label></div><div className="form-grid"><label>Preferred time<Input name="time" type="time" defaultValue="10:00" required /></label><label>Plan start (Solar Hijri)<Input name="periodStart" placeholder="1405/06/20" required /></label></div><label>Plan end (Solar Hijri)<Input name="periodEnd" placeholder="1405/08/20" required /></label><label>Preferred training days</label><div className="day-picker">{weekDays.map((day) => <button type="button" className={clientDays.includes(day) ? "selected-day" : ""} key={day} onClick={() => setClientDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>)}</div><DialogFooter><Button type="button" variant="ghost" onClick={() => setClientOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!clientDays.length}>Create client</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={sessionOpen} onOpenChange={setSessionOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{sessionSource === "attendance" ? "Complete today’s session" : "Log session"}</DialogTitle><DialogDescription>{sessionSource === "attendance" ? `Record what ${selected.name} trained before confirming attendance.` : `Capture the training signal for ${selected.name}.`}</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={logSession}><label>Muscle groups trained</label><div className="muscle-chips">{(Object.keys(labels) as MuscleKey[]).map((k) => <button type="button" className={sessionMuscles.includes(k) ? "chosen" : ""} key={k} onClick={() => setSessionMuscles((all) => all.includes(k) ? all.filter((x) => x !== k) : [...all, k])}>{sessionMuscles.includes(k) && <Check />}{labels[k]}</button>)}</div><label>Session notes<Textarea name="notes" placeholder="Intensity, limitations, progress or next-session cues…" /></label><DialogFooter><Button type="button" variant="ghost" onClick={() => setSessionOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!sessionMuscles.length}>{sessionSource === "attendance" ? "Save & confirm attendance" : "Save session"}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={absenceOpen} onOpenChange={setAbsenceOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Reschedule before marking absent</DialogTitle><DialogDescription>Choose {selected.name}’s replacement session first. The original visit will then be recorded as absent.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={recordAbsence}><label>Replacement day · Solar Hijri</label><div className="replacement-days">{["1405/06/21", "1405/06/22", "1405/06/23", "1405/06/24", "1405/06/25", "1405/06/26"].map((day) => <button type="button" className={replacementDay === day ? "selected-day" : ""} key={day} onClick={() => setReplacementDay(day)}><small>{["Sat", "Sun", "Mon", "Tue", "Wed", "Thu"][["1405/06/21", "1405/06/22", "1405/06/23", "1405/06/24", "1405/06/25", "1405/06/26"].indexOf(day)]}</small><strong>{day.split("/")[2]}</strong></button>)}</div><label>Replacement time<Input name="time" type="time" defaultValue={selected.time} required /></label><div className="policy-note"><CalendarDays /><span><strong>{absence ? "One session will be used" : "Session balance will stay unchanged"}</strong><small>This follows the coach’s current absence policy.</small></span></div><DialogFooter><Button type="button" variant="ghost" onClick={() => setAbsenceOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit">Confirm absence & reschedule</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Edit training schedule</DialogTitle><DialogDescription>Update {selected.name}’s usual days or move the next session manually.</DialogDescription></DialogHeader><form key={selected.id} className="dialog-form" onSubmit={updateSchedule}><label>Training days</label><div className="day-picker">{weekDays.map((day) => <button type="button" className={scheduleDays.includes(day) ? "selected-day" : ""} key={day} onClick={() => setScheduleDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>)}</div><div className="form-grid"><label>Next session date (Solar Hijri)<Input name="nextDate" defaultValue="1405/06/20" required /></label><label>Start time<Input name="time" type="time" defaultValue={selected.time} required /></label></div><label>Session duration<select name="duration" defaultValue={selected.sessionDuration}><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="75">75 minutes</option><option value="90">90 minutes</option></select></label><div className="form-grid"><label>Plan start<Input name="periodStart" defaultValue={selected.periodStart} required /></label><label>Plan end<Input name="periodEnd" defaultValue={selected.periodEnd} required /></label></div><DialogFooter><Button type="button" variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit" disabled={!scheduleDays.length}>Update schedule</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={mealOpen} onOpenChange={setMealOpen}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Log a meal</DialogTitle><DialogDescription>Add enough structure for useful weekly patterns.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={addMeal}><label>Meal type<select name="type" defaultValue="Lunch"><option>Breakfast</option><option>Lunch</option><option>Dinner</option><option>Snack</option></select></label><label>What did you eat?<Textarea name="description" placeholder="Describe the meal and approximate portion…" required /></label><div className="food-checks"><label><input type="checkbox" name="protein" /> Included a protein source</label><label><input type="checkbox" name="produce" /> Included fruit or vegetables</label></div><label>Glasses of water<Input name="water" type="number" min="0" defaultValue="2" /></label><DialogFooter><Button type="button" variant="ghost" onClick={() => setMealOpen(false)}>Cancel</Button><Button className="wide-dark" type="submit">Add meal</Button></DialogFooter></form></DialogContent></Dialog>
    <Toaster position="top-center" richColors />
  </div>;
}
