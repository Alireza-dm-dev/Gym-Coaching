"use client";

import { useEffect, useState } from "react";
import { formatJalaliDate, localDateTimeToUtcIso } from "@/lib/date-time";

type MemberCycle = {
  id: number; periodStart: string; periodEnd: string | null;
  pmsStart: string | null; pmsEnd: string | null;
};

type State =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "ready"; cycles: MemberCycle[] };

/** Cycle keys are plain Gregorian dates; noon in the app zone keeps the Jalali day unambiguous. */
function cycleDate(dateKey: string) {
  return formatJalaliDate(localDateTimeToUtcIso(dateKey, "12:00"));
}

/**
 * Read-only Period/PMS history for one Member. The parent renders it with
 * `key={memberId}`, so switching Clients remounts it: state starts at loading,
 * and the effect's `active` flag discards any late response for the previous
 * Member. It mounts only while the Clients view is open, so nothing here is
 * requested at boot. Only an exact 401 logs out (handled by `apiFetch`).
 */
export function MemberCycleSection({
  memberId, apiFetch,
}: {
  memberId: number;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      setState({ status: "loading" });
      try {
        const response = await apiFetch(`/api/members/${memberId}/cycles`);
        if (response.status === 401) return; // onUnauthorized already fired.
        if (response.status === 404) {
          if (active) setState({ status: "unavailable" });
          return;
        }
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
  }, [apiFetch, memberId, version]);

  return (
    <article className="surface session-notes-card">
      <div className="card-head">
        <div><span className="eyebrow">MEMBER-REPORTED</span><h2>Period &amp; PMS</h2></div>
      </div>
      {state.status === "loading" ? (
        <p className="policy-note">Loading cycle dates…</p>
      ) : state.status === "unavailable" ? (
        <p className="policy-note">Cycle dates aren&apos;t available for this client.</p>
      ) : state.status === "error" ? (
        <p className="policy-note" role="alert">
          Could not load cycle dates. <button type="button" className="text-link" onClick={() => setVersion((v) => v + 1)}>Retry</button>
        </p>
      ) : state.cycles.length === 0 ? (
        <p className="policy-note">No cycle dates recorded.</p>
      ) : (
        <>
          <p className="policy-note">Member-reported dates to help with training planning.</p>
          <div className="session-note-list">
            {state.cycles.map((cycle) => (
              <div className="session-note" key={cycle.id} style={{ gridTemplateColumns: "1fr", gap: 4 }}>
                <div><small>Period</small><p>{cycleDate(cycle.periodStart)} – {cycle.periodEnd ? cycleDate(cycle.periodEnd) : "Ongoing"}</p></div>
                {cycle.pmsStart && cycle.pmsEnd && (
                  <div><small>PMS</small><p>{cycleDate(cycle.pmsStart)} – {cycleDate(cycle.pmsEnd)}</p></div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}
