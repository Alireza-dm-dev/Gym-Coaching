"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CalendarSession } from "@/lib/coach-calendar";

export type SessionRange = { from: string; to: string };
/**
 * Owned by CoachApp so Today and Calendar share loaded months, and a request one
 * view started is joined (not repeated) by the other, even mid-flight.
 */
export type SessionsStore = MutableRefObject<{ data: Record<string, CalendarSession[]>; pending: Map<string, Promise<CalendarSession[]>> }>;
export const newSessionsStoreValue = (): SessionsStore["current"] => ({ data: {}, pending: new Map() });
type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Loads persisted Sessions for whole date ranges (normally Jalali months) with
 * ONE `GET /api/sessions?from&to` per range, cached by `from|to`. Visibility is
 * already scoped by the backend, so no ownership filtering happens here.
 *
 * - `sessions`: every row of every cached range that is current (deduplicated),
 *   so relation labels can resolve across months without extra requests.
 * - `ready`: all requested ranges are loaded; `error` is local to these ranges.
 * - `store`: optional cache that outlives this hook (views unmount when the Coach
 *   switches tabs). Entries are keyed by `from|to|version`, so a mutation's
 *   version bump makes every earlier entry unreachable; only visible ranges reload.
 * - `version`: a Coach mutation invalidates by bumping one counter; the visible ranges
 *   then reload from the database.
 */
export function useCoachSessionsRanges(apiFetch: ApiFetch, ranges: SessionRange[], version = 0, store?: SessionsStore) {
  const [attempt, setAttempt] = useState(0);
  const [cache, setCache] = useState<Record<string, CalendarSession[]>>(() => store?.current.data ?? {});
  const [failed, setFailed] = useState<string | null>(null);
  const stamp = String(version);

  const keys = ranges.map((r) => `${r.from}|${r.to}|${stamp}`);
  const wanted = keys.join(",");
  const missing = keys.filter((k) => !(k in cache)).join(",");
  const requestId = `${wanted}#${attempt}`;

  // A key is requested once even if other ranges resolve (and re-render) meanwhile.
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    for (const key of missing ? missing.split(",") : []) {
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      const [from, to] = key.split("|");
      const request = store?.current.pending.get(key) ?? (async () => {
        const response = await apiFetch(`/api/sessions?from=${from}&to=${to}`);
        if (!response.ok) throw new Error(`Request failed with ${response.status}`);
        const payload: unknown = await response.json();
        const list = (payload as { sessions?: unknown })?.sessions;
        if (!Array.isArray(list)) throw new Error("Response did not contain a sessions array");
        return list as CalendarSession[];
      })();
      if (store && !store.current.pending.has(key)) {
        store.current.pending.set(key, request);
        const settle = () => { store.current.pending.delete(key); };
        request.then((list) => { store.current.data = { ...store.current.data, [key]: list }; settle(); }, settle);
      }
      void (async () => {
        try {
          const list = await request;
          setCache((c) => ({ ...c, [key]: list }));
        } catch (error) {
          console.error("Could not load calendar sessions", error);
          setFailed(`${wanted}#${attempt}`);
        } finally {
          inflight.current.delete(key);
        }
      })();
    }
  }, [missing, attempt, wanted, apiFetch, store]);

  const sessions = useMemo(() => {
    const byId = new Map<number, CalendarSession>();
    for (const [key, list] of Object.entries(cache)) {
      if (!key.endsWith(`|${stamp}`)) continue;
      for (const s of list) byId.set(s.id, s);
    }
    return [...byId.values()];
  }, [cache, stamp]);

  const ready = missing === "";
  const error = !ready && failed === requestId;
  return {
    sessions, ready, loading: !ready && !error, error,
    retry: useCallback(() => { setFailed(null); setAttempt((a) => a + 1); }, []),
  };
}
