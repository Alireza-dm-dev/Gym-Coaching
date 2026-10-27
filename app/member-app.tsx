"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays, CircleUserRound, Droplets, LayoutDashboard, LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuthUser } from "@/components/auth/login-form";
import { formatAppTime, formatJalaliDate, getAppDateKey, localDateTimeToUtcIso } from "@/lib/date-time";

type View = "today" | "sessions" | "cycle" | "profile";

/** Persisted profile. Shape matches `GET /api/members/me` exactly. */
type MemberProfile = {
  id: number; name: string; coachId: number; goal: string;
  phone: string | null; weightKg: number | null; heightCm: number | null;
  defaultStartTime: string; defaultDurationMinutes: number;
  preferredDays: string[]; photoUrl: string | null;
};

type SessionStatus = "scheduled" | "completed" | "absent" | "cancelled" | "replacement";

type MemberSession = {
  id: number;
  scheduledAt: string;
  status: SessionStatus;
  durationMinutes: number | null;
  replacementForId: number | null;
  note: null | { id: number; note: string; createdAt: string; updatedAt: string };
};

type ProfileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: MemberProfile };

type SessionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; sessions: MemberSession[] };

/** Public cycle record. Shape matches `GET /api/members/me/cycles`. */
type MemberCycle = {
  id: number; periodStart: string; periodEnd: string | null;
  pmsStart: string | null; pmsEnd: string | null;
};

type CyclesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; cycles: MemberCycle[] };

const NOT_RECORDED = "Not recorded";

/** Renders a persisted measurement, or the empty state when it is null. */
function measurement(value: number | null, unit: string) {
  return value === null ? NOT_RECORDED : `${String(value)} ${unit}`;
}

function initialsFor(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

/**
 * Status label and class for a Session row. `replacement` and `completed`
 * (with `replacementForId` set) are the only two states this derives any
 * relationship from; everything else is the plain persisted status.
 */
function sessionStatusLabel(session: MemberSession): string {
  if (session.status === "replacement") return "Replacement scheduled";
  if (session.status === "completed" && session.replacementForId !== null) {
    return "Completed replacement";
  }
  const labels: Record<SessionStatus, string> = {
    scheduled: "Scheduled", completed: "Completed",
    absent: "Absent", cancelled: "Cancelled", replacement: "Replacement scheduled",
  };
  return labels[session.status];
}

const memberNav = [
  ["today", "Today", LayoutDashboard],
  ["sessions", "Sessions", CalendarDays],
  ["cycle", "Cycle", Droplets],
  ["profile", "Profile", CircleUserRound],
] as const;

function Heading({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <section className="page-heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
    </section>
  );
}

function ScheduleCard({ profile }: { profile: MemberProfile }) {
  const allDays = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <article className="surface" style={{ padding: 24, marginBottom: 14 }}>
      <div className="card-head"><div><span className="eyebrow">YOUR SCHEDULE</span><h2>Training rhythm</h2></div></div>
      <div className="profile-stats" style={{ marginTop: 18 }}>
        <span><strong>{profile.defaultStartTime}</strong>start time</span>
        <span><strong>{profile.defaultDurationMinutes} min</strong>duration</span>
        <span><strong>{profile.preferredDays.length}</strong>weekly days</span>
      </div>
      <div className="day-picker" style={{ marginTop: 16 }}>
        {allDays.map((day) => (
          <button
            type="button"
            key={day}
            disabled
            aria-pressed={profile.preferredDays.includes(day)}
            className={profile.preferredDays.includes(day) ? "selected-day" : ""}
            style={{ cursor: "default" }}
          >
            {day}
          </button>
        ))}
      </div>
    </article>
  );
}

function TodayView({ profile, sessionsState }: { profile: MemberProfile; sessionsState: SessionsState }) {
  // Sampled once per mount, same lazy-init pattern CalendarView uses for `anchor`.
  const [now] = useState(() => Date.now());
  // Derived only from already-fetched Sessions; never fabricated.
  const upcoming = sessionsState.status === "ready"
    ? sessionsState.sessions
      .filter((s) => s.status === "scheduled" && new Date(s.scheduledAt).getTime() > now)
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())[0]
    : undefined;

  return (
    <>
      <Heading eyebrow="TODAY" title={`Hi, ${profile.name.split(" ")[0]}.`} sub={profile.goal} />
      <ScheduleCard profile={profile} />
      {upcoming && (
        <article className="surface" style={{ padding: 24 }}>
          <div className="card-head">
            <div><span className="eyebrow">NEXT SESSION</span><h2>{formatJalaliDate(upcoming.scheduledAt)}</h2></div>
            <span className="chip">{formatAppTime(upcoming.scheduledAt)}</span>
          </div>
        </article>
      )}
    </>
  );
}

function SessionsView({
  sessionsState, retry,
}: { sessionsState: SessionsState; retry: () => void }) {
  return (
    <>
      <Heading eyebrow="SESSION HISTORY" title="Your sessions." sub="A read-only record of your training history." />
      {sessionsState.status === "loading" ? (
        <p className="policy-note">Loading your sessions…</p>
      ) : sessionsState.status === "error" ? (
        <p className="policy-note" role="alert">
          Could not load your sessions. <button type="button" className="text-link" onClick={retry}>Retry</button>
        </p>
      ) : sessionsState.sessions.length === 0 ? (
        <div className="empty-agenda">
          <CalendarDays />
          <strong>No sessions recorded yet.</strong>
          <span>Your coach will log sessions as you train together.</span>
        </div>
      ) : (
        <>
        <p className="policy-note">Coach notes are available for 30 days after each session.</p>
        <article className="surface" style={{ padding: 0 }}>
          {sessionsState.sessions.map((session) => (
            <div
              className="session-note"
              key={session.id}
              style={{ gridTemplateColumns: "120px 1fr auto", alignItems: "start" }}
            >
              <time>
                {formatJalaliDate(session.scheduledAt)}
                <br />
                <small>{formatAppTime(session.scheduledAt)}</small>
              </time>
              <div>
                {session.note && <p>{session.note.note}</p>}
                {session.durationMinutes !== null && <small>{session.durationMinutes} min</small>}
              </div>
              <span className={`status status-${session.status}`}>{sessionStatusLabel(session)}</span>
            </div>
          ))}
        </article>
        </>
      )}
    </>
  );
}

/** Cycle keys are plain Gregorian dates; noon in the app zone keeps the Jalali day unambiguous. */
function cycleDate(dateKey: string) {
  return formatJalaliDate(localDateTimeToUtcIso(dateKey, "12:00"));
}

const EMPTY_CYCLE_FORM = { periodStart: "", periodEnd: "", pmsStart: "", pmsEnd: "" };

/**
 * Optional Period/PMS logging. Owns its own state and loads only when the
 * view is opened, so Members who never use it make no cycle requests. The
 * backend is authoritative; local checks only save an obvious round trip.
 */
function CycleView({ apiFetch }: { apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }) {
  const [state, setState] = useState<CyclesState>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  // Edit/delete target records by id, never by index or periodStart.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rowMessage, setRowMessage] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_CYCLE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setState({ status: "loading" });
      try {
        const response = await apiFetch("/api/members/me/cycles");
        if (response.status === 401) return; // onUnauthorized already fired.
        if (!response.ok) {
          if (active) setState({ status: "error" });
          return;
        }
        const payload = (await response.json()) as { cycles?: unknown };
        if (!active) return;
        setState(Array.isArray(payload.cycles)
          ? { status: "ready", cycles: payload.cycles as MemberCycle[] }
          : { status: "error" });
      } catch {
        if (active) setState({ status: "error" });
      }
    })();
    return () => { active = false; };
  }, [apiFetch, version]);

  const today = getAppDateKey();
  const set = (field: keyof typeof EMPTY_CYCLE_FORM) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setFormError(null);
  };

  function localError(): string | null {
    const { periodStart, periodEnd, pmsStart, pmsEnd } = form;
    if (!periodStart) return "Period start is required.";
    if ([periodStart, periodEnd, pmsStart, pmsEnd].some((value) => value > today)) {
      return "Dates can't be in the future.";
    }
    if (periodEnd && periodEnd < periodStart) return "Period end can't be before period start.";
    if (Boolean(pmsStart) !== Boolean(pmsEnd)) return "Enter both PMS start and PMS end, or leave both empty.";
    if (pmsStart && pmsEnd < pmsStart) return "PMS end can't be before PMS start.";
    return null;
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setForm(EMPTY_CYCLE_FORM);
    setFormError(null);
  }

  function startAdd() {
    closeForm();
    setConfirmDeleteId(null);
    setSaved(null);
    setRowMessage(null);
    setAdding(true);
  }

  function startEdit(cycle: MemberCycle) {
    closeForm();
    setConfirmDeleteId(null);
    setSaved(null);
    setRowMessage(null);
    setForm({
      periodStart: cycle.periodStart, periodEnd: cycle.periodEnd ?? "",
      pmsStart: cycle.pmsStart ?? "", pmsEnd: cycle.pmsEnd ?? "",
    });
    setEditingId(cycle.id);
  }

  async function confirmDelete(id: number) {
    if (deleting) return;
    setDeleting(true);
    setRowMessage(null);
    try {
      const response = await apiFetch(`/api/members/me/cycles/${id}`, { method: "DELETE" });
      if (response.status === 401) return;
      if (response.status === 204) {
        setConfirmDeleteId(null);
        setSaved("Entry deleted.");
        setVersion((v) => v + 1);
      } else if (response.status === 404) {
        setConfirmDeleteId(null);
        setRowMessage("This cycle entry is no longer available.");
        setVersion((v) => v + 1);
      } else {
        setRowMessage("Could not delete. Please try again.");
      }
    } catch {
      setRowMessage("Could not reach the server.");
    } finally {
      setDeleting(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const invalid = localError();
    if (invalid) { setFormError(invalid); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await apiFetch(
        editingId === null ? "/api/members/me/cycles" : `/api/members/me/cycles/${editingId}`,
        {
        method: editingId === null ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          periodStart: form.periodStart,
          periodEnd: form.periodEnd || null,
          pmsStart: form.pmsStart || null,
          pmsEnd: form.pmsEnd || null,
        }),
        }
      );
      if (response.status === 401) return;
      if (response.status === (editingId === null ? 201 : 200)) {
        closeForm();
        setSaved(editingId === null ? "Saved." : "Changes saved.");
        setVersion((v) => v + 1); // Refetch: the server owns ordering.
        return;
      }
      if (response.status === 404 && editingId !== null) {
        closeForm();
        setRowMessage("This cycle entry is no longer available.");
        setVersion((v) => v + 1);
        return;
      }
      if (response.status === 409) {
        setFormError("A cycle entry already exists for that period start date.");
      } else if (response.status === 400) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? "Please check the dates and try again.");
      } else {
        setFormError("Could not save. Please try again.");
      }
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  const formElement = (
    <form noValidate className="surface dialog-form" style={{ padding: 20, marginBottom: editingId === null ? 14 : 0 }} onSubmit={(event) => void submit(event)}>
      {editingId !== null && <strong>Edit dates</strong>}
      <div className="form-grid">
        <label>Period start
          <input type="date" required max={today} value={form.periodStart} onChange={set("periodStart")} />
        </label>
        <label>Period end (optional)
          <input type="date" max={today} value={form.periodEnd} onChange={set("periodEnd")} />
        </label>
        <label>PMS start (optional)
          <input type="date" max={today} value={form.pmsStart} onChange={set("pmsStart")} />
        </label>
        <label>PMS end (optional)
          <input type="date" max={today} value={form.pmsEnd} onChange={set("pmsEnd")} />
        </label>
      </div>
      <small>Leave period end empty if it is ongoing. PMS start and end go together.</small>
      {formError && <p className="policy-note" role="alert">{formError}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <Button type="submit" className="primary-action" disabled={submitting}>{submitting ? "Saving…" : editingId === null ? "Save" : "Save changes"}</Button>
        <Button type="button" variant="outline" disabled={submitting}
          onClick={closeForm}>Cancel</Button>
      </div>
    </form>
  );

  return (
    <>
      <Heading eyebrow="OPTIONAL" title="Period & PMS" sub="Track period and PMS dates if this is useful for your training." />
      <p className="policy-note">Your current coach can view these dates to help adjust your training plan.</p>
      {saved && <p className="policy-note" role="status">{saved}</p>}
      {rowMessage && <p className="policy-note" role="alert">{rowMessage}</p>}
      {adding ? formElement : (
        <div style={{ marginBottom: 14 }}>
          <Button className="primary-action" onClick={startAdd}>Add dates</Button>
        </div>
      )}
      {state.status === "loading" ? (
        <p className="policy-note">Loading your cycle dates…</p>
      ) : state.status === "error" ? (
        <p className="policy-note" role="alert">
          Could not load your cycle dates. <button type="button" className="text-link" onClick={() => setVersion((v) => v + 1)}>Retry</button>
        </p>
      ) : state.cycles.length === 0 ? (
        <div className="empty-agenda">
          <Droplets />
          <strong>No cycle dates recorded yet.</strong>
        </div>
      ) : (
        <article className="surface" style={{ padding: 0 }}>
          {state.cycles.map((cycle) => editingId === cycle.id ? (
            <div className="session-note" key={cycle.id} style={{ gridTemplateColumns: "1fr" }}>{formElement}</div>
          ) : (
            <div className="session-note" key={cycle.id} style={{ gridTemplateColumns: "1fr", gap: 4 }}>
              <div><small>Period</small><p>{cycleDate(cycle.periodStart)} – {cycle.periodEnd ? cycleDate(cycle.periodEnd) : "Ongoing"}</p></div>
              {cycle.pmsStart && cycle.pmsEnd && (
                <div><small>PMS</small><p>{cycleDate(cycle.pmsStart)} – {cycleDate(cycle.pmsEnd)}</p></div>
              )}
              {confirmDeleteId === cycle.id ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>Delete this cycle entry?</strong>
                  <button type="button" className="text-link" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  <button type="button" className="text-link" style={{ color: "var(--destructive)" }} disabled={deleting}
                    onClick={() => void confirmDelete(cycle.id)}>{deleting ? "Deleting…" : "Delete"}</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 14 }}>
                  <button type="button" className="text-link" onClick={() => startEdit(cycle)}>Edit</button>
                  <button type="button" className="text-link" style={{ color: "var(--destructive)" }}
                    onClick={() => { closeForm(); setSaved(null); setRowMessage(null); setConfirmDeleteId(cycle.id); }}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </article>
      )}
    </>
  );
}

function ProfileView({ profile, email }: { profile: MemberProfile; email: string }) {
  return (
    <>
      <Heading eyebrow="PROFILE" title={profile.name} sub={email} />
      <article className="surface profile-card" style={{ gridTemplateColumns: "1fr", padding: 24 }}>
        <div className="person">
          <span className="avatar avatar-lg">
            {profile.photoUrl ? <img src={profile.photoUrl} alt={profile.name} /> : initialsFor(profile.name)}
          </span>
          <div><span className="eyebrow">MEMBER</span><h2>{profile.name}</h2><p>{profile.goal}</p></div>
        </div>
        <div className="profile-stats">
          <span><strong>{profile.phone ?? NOT_RECORDED}</strong>phone</span>
          <span><strong>{measurement(profile.weightKg, "kg")}</strong>weight</span>
          <span><strong>{measurement(profile.heightCm, "cm")}</strong>height</span>
        </div>
        <div className="profile-stats">
          <span><strong>{profile.defaultStartTime}</strong>start time</span>
          <span><strong>{profile.defaultDurationMinutes} min</strong>duration</span>
          <span><strong>{profile.preferredDays.join(", ")}</strong>training days</span>
        </div>
      </article>
    </>
  );
}

export default function MemberApp({
  user, onLogout, onUnauthorized,
}: { user: AuthUser; onLogout: () => void; onUnauthorized: () => void }) {
  // Only an exact 401 means the auth session is gone; everything else stays a local error.
  const apiFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  }, [onUnauthorized]);

  const [view, setView] = useState<View>("today");
  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });
  const [profileVersion, setProfileVersion] = useState(0);
  const [sessionsState, setSessionsState] = useState<SessionsState>({ status: "loading" });
  const [sessionsVersion, setSessionsVersion] = useState(0);

  // Identity is resolved entirely from the authenticated session; never from
  // user.id, email or a guessed id. `/api/members` is never called here.
  useEffect(() => {
    let active = true;
    void (async () => {
      setProfileState({ status: "loading" });
      try {
        const response = await apiFetch("/api/members/me");
        if (response.status === 401) return; // onUnauthorized already fired.
        if (!response.ok) {
          if (!active) return;
          setProfileState({
            status: "error",
            message: response.status === 403
              ? "Your account isn't linked to a Member profile."
              : "Could not load your profile.",
          });
          return;
        }
        const payload = (await response.json()) as { member?: MemberProfile };
        if (!active) return;
        if (!payload.member) {
          setProfileState({ status: "error", message: "Could not load your profile." });
          return;
        }
        setProfileState({ status: "ready", profile: payload.member });
      } catch {
        if (active) setProfileState({ status: "error", message: "Could not reach the server." });
      }
    })();
    return () => { active = false; };
  }, [apiFetch, profileVersion]);

  // Only fires once the real member.id is known; never derived any other way.
  useEffect(() => {
    if (profileState.status !== "ready") return;
    const memberId = profileState.profile.id;
    let active = true;
    void (async () => {
      setSessionsState({ status: "loading" });
      try {
        const response = await apiFetch(`/api/sessions?memberId=${memberId}&limit=50`);
        if (response.status === 401) return;
        if (!response.ok) {
          if (active) setSessionsState({ status: "error" });
          return;
        }
        const payload = (await response.json()) as { sessions?: unknown };
        if (!active) return;
        if (!Array.isArray(payload.sessions)) {
          setSessionsState({ status: "error" });
          return;
        }
        setSessionsState({ status: "ready", sessions: payload.sessions as MemberSession[] });
      } catch {
        if (active) setSessionsState({ status: "error" });
      }
    })();
    return () => { active = false; };
  }, [apiFetch, profileState, sessionsVersion]);

  const signOut = <Button className="wide-dark" onClick={() => void onLogout()}>Sign out</Button>;

  if (profileState.status === "loading") {
    return (
      <div className="app-shell">
        <div className="app-main">
          <main className="content"><Heading eyebrow="MEMBER" title="Loading your profile…" /></main>
        </div>
      </div>
    );
  }

  if (profileState.status === "error") {
    return (
      <div className="app-shell">
        <div className="app-main">
          <main className="content">
            <Heading eyebrow="MEMBER" title="Couldn't load your profile." sub={profileState.message} />
            <div style={{ display: "flex", gap: 10 }}>
              <Button className="primary-action" onClick={() => setProfileVersion((v) => v + 1)}>Retry</Button>
              {signOut}
            </div>
          </main>
        </div>
      </div>
    );
  }

  const { profile } = profileState;
  let content: React.ReactNode;
  if (view === "sessions") {
    content = <SessionsView sessionsState={sessionsState} retry={() => setSessionsVersion((v) => v + 1)} />;
  } else if (view === "cycle") {
    content = <CycleView apiFetch={apiFetch} />;
  } else if (view === "profile") {
    content = <ProfileView profile={profile} email={user.email} />;
  } else {
    content = <TodayView profile={profile} sessionsState={sessionsState} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="app-logo"><img src="/app-logo.png" alt="Fit & Mischief App" /></span>
          <span>FIT &amp; MISCHIEF</span>
        </div>
        <div className="workspace">
          <span className="coach-avatar">{initialsFor(profile.name)}</span>
          <div><strong>{profile.name}</strong><small>Member</small></div>
        </div>
        <nav>
          {memberNav.map(([id, label, Icon]) => (
            <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}>
              <Icon /><span>{label}</span>
            </button>
          ))}
        </nav>
        <footer><button onClick={() => void onLogout()}><LogOut />Sign out</button></footer>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="app-logo app-logo-compact"><img src="/app-logo.png" alt="Fit & Mischief App" /></span>
          </div>
        </header>
        <main className="content">{content}</main>
      </div>
      <nav className="mobile-nav">
        {memberNav.map(([id, label, Icon]) => (
          <button key={id} className={view === id ? "nav-active" : ""} onClick={() => setView(id)}>
            <Icon /><span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
