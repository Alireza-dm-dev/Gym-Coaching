"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutDashboard, LogOut, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AuthUser } from "@/components/auth/login-form";

type View = "overview" | "coaches" | "members";
type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Shapes match `GET /api/admin/coaches` and `GET /api/admin/members` exactly. */
type AdminCoach = { id: number; userId: number; name: string; email: string; isActive: boolean; memberCount: number };
type AdminMember = {
  id: number; name: string; email: string | null; userId: number | null; isActive: boolean | null;
  coach: { id: number; name: string };
};

type ListState<T> = { items: T[] | null; loading: boolean; error: string | null };
type Notice = { kind: "ok" | "error"; text: string };
type Send = (method: string, url: string, body?: unknown) => Promise<{ status: number; data: Record<string, unknown> | null }>;

const MIN_PASSWORD_LENGTH = 10;
const weekDays = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
const adminNav = [
  ["overview", "Overview", LayoutDashboard],
  ["coaches", "Coaches", UserRound],
  ["members", "Members", Users],
] as const;

// Same simple rule as the backend; the server stays authoritative.
const validEmail = (value: string) => value.trim().length > 0 && value.includes("@");

function apiMessage(data: Record<string, unknown> | null, fallback: string) {
  return typeof data?.error === "string" ? data.error : fallback;
}

/** Shared status handling for non-OK responses; `conflict` supplies the 409 copy. */
function failureText(status: number, data: Record<string, unknown> | null, conflict?: string) {
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That record no longer exists. The list has been refreshed.";
  if (status === 400) return apiMessage(data, "Please check the details and try again.");
  if (status === 409) return conflict ?? apiMessage(data, "That change conflicts with the current data.");
  return "Something went wrong. Please try again.";
}

/** One in-flight action per dialog: blocks double submits and keeps a local error. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

function Heading({ eyebrow, title, sub, action }: { eyebrow: string; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <section className="page-heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </section>
  );
}

function StatusChip({ active }: { active: boolean | null }) {
  if (active === null) return <span className="chip">No login</span>;
  return <span className={`chip ${active ? "admin-active" : "admin-inactive"}`}>{active ? "Active" : "Inactive"}</span>;
}

function ListBody<T>({ state, empty, retry, children }: {
  state: ListState<T>; empty: string; retry: () => void; children: (items: T[]) => React.ReactNode;
}) {
  if (state.items === null) {
    return state.error
      ? <p className="policy-note" role="alert">{state.error} <button type="button" className="text-link" onClick={retry}>Retry</button></p>
      : <p className="policy-note">Loading…</p>;
  }
  return (
    <>
      {state.error && <p className="policy-note" role="alert">{state.error} <button type="button" className="text-link" onClick={retry}>Retry</button></p>}
      {state.items.length === 0 ? <p className="policy-note">{empty}</p> : children(state.items)}
    </>
  );
}

/** Create Coach: POST /api/admin/coaches. The typed password is never shown again. */
function CreateCoachDialog({ send, onClose, onDone }: { send: Send; onClose: () => void; onDone: () => void }) {
  const { busy, error, setError, run } = useAction();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    if (!name) return setError("Name is required.");
    if (!validEmail(email)) return setError("Enter a valid email address.");
    if (password.length < MIN_PASSWORD_LENGTH) return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    void run(async () => {
      const { status, data } = await send("POST", "/api/admin/coaches", { name, email, password });
      if (status === 201) return onDone();
      setError(failureText(status, data, "An account already exists with this email."));
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="app-dialog admin-dialog">
        <DialogHeader><DialogTitle>Create Coach</DialogTitle><DialogDescription>You choose the initial password and hand it to the Coach.</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <label>Name<Input name="name" autoComplete="off" /></label>
          <label>Email<Input name="email" type="text" inputMode="email" autoComplete="off" /></label>
          <label>Initial password<Input name="password" type="password" autoComplete="new-password" /></label>
          {error && <p className="policy-note" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button className="wide-dark" type="submit" disabled={busy}>{busy ? "Creating…" : "Create Coach"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Create Member profile through the existing POST /api/members (Super Admin supplies coachId). */
function CreateMemberDialog({ send, coaches, onClose, onDone }: { send: Send; coaches: AdminCoach[]; onClose: () => void; onDone: () => void }) {
  const { busy, error, setError, run } = useAction();
  const [days, setDays] = useState<string[]>(["Sat", "Mon", "Wed"]);
  const active = coaches.filter((c) => c.isActive);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const coachId = Number(f.get("coachId"));
    if (!active.length || !coachId) return setError("Create or reactivate a Coach first.");
    void run(async () => {
      const { status, data } = await send("POST", "/api/members", {
        name: String(f.get("name") ?? ""),
        phone: String(f.get("phone") ?? ""),
        weightKg: Number(f.get("weight")),
        heightCm: Number(f.get("height")),
        goal: String(f.get("goal") ?? ""),
        defaultStartTime: String(f.get("time") ?? ""),
        defaultDurationMinutes: Number(f.get("duration")),
        preferredDays: days,
        coachId,
      });
      if (status === 201) return onDone();
      setError(failureText(status, data));
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="app-dialog admin-dialog">
        <DialogHeader><DialogTitle>Create Member</DialogTitle><DialogDescription>Creates a profile only. A login can be added afterwards.</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit}>
          <label>Assigned Coach
            <select name="coachId" defaultValue={active[0]?.id} disabled={!active.length} required>
              {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {!active.length && <p className="policy-note">Create or reactivate a Coach first.</p>}
          <label>Full name<Input name="name" required /></label>
          <label>Phone number<Input name="phone" type="tel" required /></label>
          <div className="form-grid">
            <label>Weight (kg)<Input name="weight" type="number" step="0.1" min="1" required /></label>
            <label>Height (cm)<Input name="height" type="number" step="1" min="1" required /></label>
          </div>
          <label>Primary goal<Input name="goal" required /></label>
          <div className="form-grid">
            <label>Preferred time<Input name="time" type="time" defaultValue="10:00" required /></label>
            <label>Session duration
              <select name="duration" defaultValue="60">
                {[30, 45, 50, 60, 75, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </select>
            </label>
          </div>
          <label>Preferred training days</label>
          <div className="day-picker">
            {weekDays.map((day) => (
              <button type="button" key={day} className={days.includes(day) ? "selected-day" : ""}
                onClick={() => setDays((all) => all.includes(day) ? all.filter((d) => d !== day) : [...all, day])}>{day}</button>
            ))}
          </div>
          {error && <p className="policy-note" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button className="wide-dark" type="submit" disabled={busy || !days.length || !active.length}>{busy ? "Creating…" : "Create Member"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Provision the first login for a profile-only Member. */
function AddLoginDialog({ send, member, onClose, onDone }: { send: Send; member: AdminMember; onClose: () => void; onDone: () => void }) {
  const { busy, error, setError, run } = useAction();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    if (!validEmail(email)) return setError("Enter a valid email address.");
    if (password.length < MIN_PASSWORD_LENGTH) return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    void run(async () => {
      const { status, data } = await send("POST", `/api/admin/members/${member.id}/account`, { email, password });
      if (status === 201) return onDone();
      setError(failureText(status, data));
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="app-dialog admin-dialog">
        <DialogHeader><DialogTitle>Add login</DialogTitle><DialogDescription>Create a login for {member.name}. You choose the initial password and hand it over.</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <label>Email<Input name="email" type="text" inputMode="email" autoComplete="off" /></label>
          <label>Initial password<Input name="password" type="password" autoComplete="new-password" /></label>
          {error && <p className="policy-note" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button className="wide-dark" type="submit" disabled={busy}>{busy ? "Creating…" : "Create login"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Email correction and/or password reset for a Coach or Member login. A password change needs confirmation. */
function ManageLoginDialog({ send, who, userId, currentEmail, onClose, onDone }: {
  send: Send; who: "Coach" | "Member"; userId: number; currentEmail: string; onClose: () => void; onDone: (message: string) => void;
}) {
  const { busy, error, setError, run } = useAction();
  const [email, setEmail] = useState(currentEmail);
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== currentEmail.toLowerCase();
  function review(e: FormEvent) {
    e.preventDefault();
    if (!validEmail(email)) return setError("Enter a valid email address.");
    if (password && password.length < MIN_PASSWORD_LENGTH) return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (!emailChanged && !password) return setError("Change the email or enter a new password.");
    setError(null);
    if (password) setConfirming(true);
    else void apply();
  }
  function apply() {
    void run(async () => {
      const body: { email?: string; password?: string } = {};
      if (emailChanged) body.email = email;
      if (password) body.password = password;
      const { status, data } = await send("PATCH", `/api/admin/users/${userId}/credentials`, body);
      if (status === 200) return onDone(password ? "Password updated." : "Login email updated.");
      setConfirming(false);
      setError(failureText(status, data, "An account already exists with this email."));
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="app-dialog admin-dialog">
        <DialogHeader>
          <DialogTitle>{confirming ? `Reset this ${who}'s password?` : "Manage login"}</DialogTitle>
          <DialogDescription>{confirming ? `Their current login sessions will end immediately.` : `Correct the email or set a new password for this ${who}.`}</DialogDescription>
        </DialogHeader>
        {confirming ? (
          <>
            {error && <p className="policy-note" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
              <Button className="wide-dark" type="button" onClick={apply} disabled={busy}>{busy ? "Saving…" : "Reset password"}</Button>
            </DialogFooter>
          </>
        ) : (
          <form className="dialog-form" onSubmit={review} noValidate>
            <label>Email<Input type="text" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>New password (optional)<Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank to keep the current one" /></label>
            {error && <p className="policy-note" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button className="wide-dark" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Deactivation confirmation for a Coach or Member login. */
function DeactivateDialog({ send, who, userId, onClose, onDone }: {
  send: Send; who: "Coach" | "Member"; userId: number; onClose: () => void; onDone: () => void;
}) {
  const { busy, error, setError, run } = useAction();
  function confirm() {
    void run(async () => {
      const { status, data } = await send("PATCH", `/api/admin/users/${userId}/status`, { isActive: false });
      if (status === 200) return onDone();
      if (status === 409 && typeof data?.memberCount === "number") {
        const n = data.memberCount;
        return setError(`This Coach still has ${n} assigned member${n === 1 ? "" : "s"}. Reassign them before deactivating the Coach.`);
      }
      setError(failureText(status, data));
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="app-dialog admin-dialog">
        <DialogHeader>
          <DialogTitle>{who === "Coach" ? "Deactivate this Coach?" : "Deactivate this Member's login?"}</DialogTitle>
          <DialogDescription>
            {who === "Coach" ? "They will be signed out immediately." : "They will be signed out immediately. Their profile and training history will remain."}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="policy-note" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="wide-dark" type="button" onClick={confirm} disabled={busy}>{busy ? "Deactivating…" : "Deactivate"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reassign a Member to an active Coach; confirmation only when the Coach actually changes. */
function ReassignDialog({ send, member, coaches, onClose, onDone, onStaleCoach }: {
  send: Send; member: AdminMember; coaches: AdminCoach[]; onClose: () => void; onDone: () => void; onStaleCoach: () => void;
}) {
  const { busy, error, setError, run } = useAction();
  const active = coaches.filter((c) => c.isActive);
  const [coachId, setCoachId] = useState<number>(active.find((c) => c.id === member.coach.id)?.id ?? active[0]?.id ?? 0);
  const [confirming, setConfirming] = useState(false);
  const target = active.find((c) => c.id === coachId);

  function review(e: FormEvent) {
    e.preventDefault();
    if (!target) return setError("Create or reactivate a Coach first.");
    if (target.id === member.coach.id) return onDone(); // same Coach: nothing to change
    setConfirming(true);
  }
  function apply() {
    if (!target) return;
    void run(async () => {
      const { status, data } = await send("PATCH", `/api/admin/members/${member.id}/assignment`, { coachId: target.id });
      if (status === 200) return onDone();
      setConfirming(false);
      if (status === 409) {
        onStaleCoach();
        return setError("That Coach is no longer active. Choose another Coach.");
      }
      setError(failureText(status, data));
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="app-dialog admin-dialog">
        <DialogHeader>
          <DialogTitle>{confirming && target ? `Reassign this Member to ${target.name}?` : "Reassign Member"}</DialogTitle>
          <DialogDescription>
            {confirming ? "The new Coach will gain access to the Member's training history. The previous Coach will lose access." : `Choose the Coach who should work with ${member.name}.`}
          </DialogDescription>
        </DialogHeader>
        {confirming ? (
          <>
            {error && <p className="policy-note" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
              <Button className="wide-dark" type="button" onClick={apply} disabled={busy}>{busy ? "Reassigning…" : "Reassign"}</Button>
            </DialogFooter>
          </>
        ) : (
          <form className="dialog-form" onSubmit={review}>
            <label>Coach
              <select value={coachId} onChange={(e) => setCoachId(Number(e.target.value))} disabled={!active.length}>
                {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {!active.length && <p className="policy-note">Create or reactivate a Coach first.</p>}
            {error && <p className="policy-note" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button className="wide-dark" type="submit" disabled={busy || !active.length}>Continue</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Modal =
  | { kind: "create-coach" }
  | { kind: "create-member" }
  | { kind: "coach-login"; coach: AdminCoach }
  | { kind: "coach-deactivate"; coach: AdminCoach }
  | { kind: "add-login"; member: AdminMember }
  | { kind: "member-login"; member: AdminMember }
  | { kind: "member-deactivate"; member: AdminMember }
  | { kind: "reassign"; member: AdminMember };

export default function AdminApp({ user, onLogout, onUnauthorized }: { user: AuthUser; onLogout: () => void; onUnauthorized: () => void }) {
  // Only an exact 401 means the auth session is gone; everything else stays a local error.
  const apiFetch: ApiFetch = useCallback(async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  }, [onUnauthorized]);

  const send: Send = useCallback(async (method, url, body) => {
    const response = await apiFetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, data };
  }, [apiFetch]);

  const [view, setView] = useState<View>("overview");
  const [coaches, setCoaches] = useState<ListState<AdminCoach>>({ items: null, loading: true, error: null });
  const [members, setMembers] = useState<ListState<AdminMember>>({ items: null, loading: true, error: null });
  const [modal, setModal] = useState<Modal | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const loadSeq = useRef({ coaches: 0, members: 0 });

  // Each list keeps its own state: a failed refresh never discards rows already loaded.
  const loadCoaches = useCallback(async () => {
    const seq = ++loadSeq.current.coaches;
    setCoaches((s) => ({ ...s, loading: true, error: null }));
    try {
      const { status, data } = await send("GET", "/api/admin/coaches");
      if (seq !== loadSeq.current.coaches) return;
      if (status !== 200 || !Array.isArray(data?.coaches)) throw new Error(String(status));
      setCoaches({ items: data.coaches as AdminCoach[], loading: false, error: null });
    } catch {
      if (seq === loadSeq.current.coaches) setCoaches((s) => ({ ...s, loading: false, error: "Couldn't load Coaches." }));
    }
  }, [send]);
  const loadMembers = useCallback(async () => {
    const seq = ++loadSeq.current.members;
    setMembers((s) => ({ ...s, loading: true, error: null }));
    try {
      const { status, data } = await send("GET", "/api/admin/members");
      if (seq !== loadSeq.current.members) return;
      if (status !== 200 || !Array.isArray(data?.members)) throw new Error(String(status));
      setMembers({ items: data.members as AdminMember[], loading: false, error: null });
    } catch {
      if (seq === loadSeq.current.members) setMembers((s) => ({ ...s, loading: false, error: "Couldn't load Members." }));
    }
  }, [send]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of both management lists
    void loadCoaches();
    void loadMembers();
  }, [loadCoaches, loadMembers]);

  const overview = useMemo(() => {
    const c = coaches.items;
    const m = members.items;
    return {
      totalCoaches: c?.length, activeCoaches: c?.filter((x) => x.isActive).length,
      totalMembers: m?.length, withLogin: m?.filter((x) => x.userId !== null).length,
      withoutLogin: m?.filter((x) => x.userId === null).length, inactiveMembers: m?.filter((x) => x.isActive === false).length,
    };
  }, [coaches.items, members.items]);

  const visibleMembers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = members.items ?? [];
    return needle ? all.filter((m) => [m.name, m.email ?? "", m.coach.name].some((v) => v.toLowerCase().includes(needle))) : all;
  }, [members.items, query]);

  function changeView(next: View) {
    setView(next); setModal(null); setNotice(null); setQuery("");
  }
  const close = () => setModal(null);
  function finish(text: string, refresh: ("coaches" | "members")[]) {
    setModal(null);
    setNotice({ kind: "ok", text });
    if (refresh.includes("coaches")) void loadCoaches();
    if (refresh.includes("members")) void loadMembers();
  }

  async function reactivate(userId: number, refresh: ("coaches" | "members")[]) {
    if (rowBusy !== null) return;
    setRowBusy(userId);
    setNotice(null);
    try {
      const { status, data } = await send("PATCH", `/api/admin/users/${userId}/status`, { isActive: true });
      if (status === 200) finish("Account reactivated.", refresh);
      else {
        setNotice({ kind: "error", text: failureText(status, data) });
        if (status === 404) { void loadCoaches(); void loadMembers(); }
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Please try again." });
    } finally {
      setRowBusy(null);
    }
  }

  const hasActiveCoach = (coaches.items ?? []).some((c) => c.isActive);

  const count = (n: number | undefined) => (n === undefined ? "–" : String(n));
  const overviewView = (
    <>
      <Heading eyebrow="ADMIN" title="Overview" sub="Account management at a glance." />
      <div className="admin-stats">
        {([
          ["Total Coaches", overview.totalCoaches], ["Active Coaches", overview.activeCoaches],
          ["Total Members", overview.totalMembers], ["Members with login", overview.withLogin],
          ["Members without login", overview.withoutLogin], ["Inactive Members", overview.inactiveMembers],
        ] as const).map(([label, value]) => (
          <article className="surface admin-stat" key={label}><strong>{count(value)}</strong><span>{label}</span></article>
        ))}
      </div>
      {(coaches.error || members.error) && (
        <p className="policy-note" role="alert">
          {[coaches.error, members.error].filter(Boolean).join(" ")}{" "}
          <button type="button" className="text-link" onClick={() => { if (coaches.error) void loadCoaches(); if (members.error) void loadMembers(); }}>Retry</button>
        </p>
      )}
    </>
  );

  const coachesView = (
    <>
      <Heading eyebrow="ADMIN" title="Coaches" action={<Button className="primary-action" onClick={() => { setNotice(null); setModal({ kind: "create-coach" }); }}>Create Coach</Button>} />
      <ListBody state={coaches} empty="No Coaches yet. Create one to get started." retry={() => void loadCoaches()}>
        {(items) => (
          <div className="admin-list">
            {items.map((coach) => (
              <article className="surface admin-row" key={coach.id}>
                <div className="admin-row-main">
                  <strong>{coach.name}</strong>
                  <small>{coach.email}</small>
                  <div className="admin-row-meta"><StatusChip active={coach.isActive} /><span className="chip">{coach.memberCount} {coach.memberCount === 1 ? "Member" : "Members"}</span></div>
                </div>
                <div className="admin-row-actions">
                  <Button className="soft-button" onClick={() => { setNotice(null); setModal({ kind: "coach-login", coach }); }}>Manage login</Button>
                  {coach.isActive
                    ? <Button className="soft-button" onClick={() => { setNotice(null); setModal({ kind: "coach-deactivate", coach }); }}>Deactivate</Button>
                    : <Button className="soft-button" disabled={rowBusy !== null} onClick={() => void reactivate(coach.userId, ["coaches"])}>Reactivate</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </ListBody>
    </>
  );

  const membersView = (
    <>
      <Heading eyebrow="ADMIN" title="Members" action={<Button className="primary-action" onClick={() => { setNotice(null); setModal({ kind: "create-member" }); }}>Create Member</Button>} />
      {!hasActiveCoach && coaches.items !== null && <p className="policy-note">Create or reactivate a Coach first.</p>}
      <Input className="admin-search" type="search" placeholder="Search by name, email or Coach" aria-label="Search Members" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ListBody state={members} empty="No Members yet." retry={() => void loadMembers()}>
        {() => visibleMembers.length === 0 ? <p className="policy-note">No Members match your search.</p> : (
          <div className="admin-list">
            {visibleMembers.map((member) => (
              <article className="surface admin-row" key={member.id}>
                <div className="admin-row-main">
                  <strong>{member.name}</strong>
                  <small>{member.email ?? "No login"}</small>
                  <div className="admin-row-meta"><StatusChip active={member.isActive} /><span className="chip">Coach: {member.coach.name}</span></div>
                </div>
                <div className="admin-row-actions">
                  <Button className="soft-button" disabled={!hasActiveCoach} onClick={() => { setNotice(null); setModal({ kind: "reassign", member }); }}>Reassign</Button>
                  {member.userId === null
                    ? <Button className="soft-button" onClick={() => { setNotice(null); setModal({ kind: "add-login", member }); }}>Add login</Button>
                    : <Button className="soft-button" onClick={() => { setNotice(null); setModal({ kind: "member-login", member }); }}>Manage login</Button>}
                  {member.userId !== null && (member.isActive
                    ? <Button className="soft-button" onClick={() => { setNotice(null); setModal({ kind: "member-deactivate", member }); }}>Deactivate</Button>
                    : <Button className="soft-button" disabled={rowBusy !== null} onClick={() => void reactivate(member.userId!, ["members"])}>Reactivate</Button>)}
                </div>
              </article>
            ))}
          </div>
        )}
      </ListBody>
    </>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="app-logo"><img src="/app-logo.png" alt="Fit & Mischief App" /></span>
          <span>FIT &amp; MISCHIEF</span>
        </div>
        <div className="workspace">
          <span className="coach-avatar">SA</span>
          <div><strong>Super Admin</strong><small>{user.email}</small></div>
        </div>
        <nav>
          {adminNav.map(([id, label, Icon]) => (
            <button key={id} className={view === id ? "nav-active" : ""} onClick={() => changeView(id)}><Icon /><span>{label}</span></button>
          ))}
        </nav>
        <footer><button onClick={() => void onLogout()}><LogOut />Sign out</button></footer>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="mobile-brand"><span className="app-logo app-logo-compact"><img src="/app-logo.png" alt="Fit & Mischief App" /></span></div>
          <div className="top-actions"><button aria-label="Sign out" onClick={() => void onLogout()}><LogOut /></button></div>
        </header>
        <main className="content">
          {notice && <p className={`policy-note admin-notice ${notice.kind === "ok" ? "admin-notice-ok" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}
          {view === "overview" ? overviewView : view === "coaches" ? coachesView : membersView}
        </main>
      </div>
      <nav className="mobile-nav">
        {adminNav.map(([id, label, Icon]) => (
          <button key={id} className={view === id ? "nav-active" : ""} onClick={() => changeView(id)}><Icon /><span>{label}</span></button>
        ))}
      </nav>

      {modal?.kind === "create-coach" && <CreateCoachDialog send={send} onClose={close} onDone={() => finish("Coach created.", ["coaches"])} />}
      {modal?.kind === "create-member" && <CreateMemberDialog send={send} coaches={coaches.items ?? []} onClose={close} onDone={() => finish("Member created.", ["members", "coaches"])} />}
      {modal?.kind === "coach-login" && <ManageLoginDialog send={send} who="Coach" userId={modal.coach.userId} currentEmail={modal.coach.email} onClose={close} onDone={(m) => finish(m, ["coaches"])} />}
      {modal?.kind === "coach-deactivate" && <DeactivateDialog send={send} who="Coach" userId={modal.coach.userId} onClose={close} onDone={() => finish("Account deactivated.", ["coaches"])} />}
      {modal?.kind === "add-login" && <AddLoginDialog send={send} member={modal.member} onClose={close} onDone={() => finish("Login created.", ["members"])} />}
      {modal?.kind === "member-login" && modal.member.userId !== null && modal.member.email !== null && (
        <ManageLoginDialog send={send} who="Member" userId={modal.member.userId} currentEmail={modal.member.email} onClose={close} onDone={(m) => finish(m, ["members"])} />
      )}
      {modal?.kind === "member-deactivate" && modal.member.userId !== null && (
        <DeactivateDialog send={send} who="Member" userId={modal.member.userId} onClose={close} onDone={() => finish("Account deactivated.", ["members"])} />
      )}
      {modal?.kind === "reassign" && (
        <ReassignDialog send={send} member={modal.member} coaches={coaches.items ?? []} onClose={close}
          onDone={() => finish("Assignment updated.", ["members", "coaches"])} onStaleCoach={() => void loadCoaches()} />
      )}
    </div>
  );
}
