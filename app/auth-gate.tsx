"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoginForm, type AuthUser } from "@/components/auth/login-form";
import AdminApp from "./admin-app";
import CoachApp from "./coach-app";
import MemberApp from "./member-app";

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error" }
  | { status: "authenticated"; user: AuthUser };

function Centered({ children }: { children: React.ReactNode }) {
  return <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>{children}</main>;
}

function Notice({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <article className="surface" style={{ width: "min(420px, 100%)", padding: 28 }}>
      <h1 style={{ fontSize: 24, fontWeight: 480, margin: 0 }}>{title}</h1>
      {body && <p style={{ color: "#777f78", fontSize: 14, margin: "10px 0 0" }}>{body}</p>}
      {action && <div style={{ marginTop: 18 }}>{action}</div>}
    </article>
  );
}

/** Decides what mounts. CoachApp fetches secured data on mount, so only a real Coach gets it. */
export default function AuthGate() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  const check = useCallback(async (): Promise<AuthState> => {
    try {
      const response = await fetch("/api/auth/me");
      if (response.status === 401) return { status: "unauthenticated" };
      if (!response.ok) return { status: "error" };
      const payload = (await response.json()) as { user?: AuthUser };
      return payload.user ? { status: "authenticated", user: payload.user } : { status: "error" };
    } catch {
      return { status: "error" };
    }
  }, []);

  useEffect(() => {
    let active = true;
    void check().then((next) => { if (active) setAuth(next); });
    return () => { active = false; };
  }, [check]);

  // A dead session needs no logout call; the server already considers it gone.
  const handleUnauthorized = useCallback(() => setAuth({ status: "unauthenticated" }), []);

  // Explicit sign-out always ends the client session, even if the request fails:
  // private data must stop rendering, and the server call is best-effort.
  const loggingOut = useRef(false);
  const handleLogout = useCallback(async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* Network failure: still sign out locally. */
    } finally {
      loggingOut.current = false;
      setAuth({ status: "unauthenticated" });
    }
  }, []);

  if (auth.status === "loading") {
    return <Centered><Notice title="Loading…" /></Centered>;
  }
  if (auth.status === "error") {
    return (
      <Centered>
        <Notice
          title="Unable to check your session."
          body="Please try again."
          action={<Button className="wide-dark" onClick={() => { setAuth({ status: "loading" }); void check().then(setAuth); }}>Retry</Button>}
        />
      </Centered>
    );
  }
  if (auth.status === "unauthenticated") {
    return <Centered><LoginForm onSuccess={(user) => setAuth({ status: "authenticated", user })} /></Centered>;
  }

  const { user } = auth;
  const signOut = <Button className="wide-dark" onClick={() => void handleLogout()}>Sign out</Button>;
  // key=user.id plus the unmount on sign-out gives every login a fresh app instance.
  if (user.role === "coach") {
    return <CoachApp key={user.id} onLogout={handleLogout} onUnauthorized={handleUnauthorized} />;
  }
  if (user.role === "member") {
    return <MemberApp key={user.id} user={user} onLogout={handleLogout} onUnauthorized={handleUnauthorized} />;
  }
  if (user.role === "super_admin") {
    return <AdminApp key={user.id} user={user} onLogout={handleLogout} onUnauthorized={handleUnauthorized} />;
  }
  return (
    <Centered>
      <Notice title="Unsupported account" body="This account type has no app." action={signOut} />
    </Centered>
  );
}
