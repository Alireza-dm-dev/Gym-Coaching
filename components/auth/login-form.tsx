"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type AuthUser = {
  id: number;
  role: "super_admin" | "coach" | "member";
  email: string;
};

/** Only the user comes back from the form; the cookie is set by the server. */
export function LoginForm({ onSuccess }: { onSuccess: (user: AuthUser) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (response.ok) {
        const payload = (await response.json()) as { user?: AuthUser };
        if (!payload.user) throw new Error("Login response had no user");
        onSuccess(payload.user);
        return;
      }
      setError(
        response.status === 401
          ? "Invalid email or password."
          : response.status === 400
            ? "Please check your email and password."
            : "Unable to sign in. Please try again."
      );
    } catch {
      setError("Unable to sign in. Please try again.");
    }
    setSubmitting(false);
  }

  return (
    <article className="surface" style={{ width: "min(420px, 100%)", padding: 28 }}>
      <span className="eyebrow">FIT &amp; MISCHIEF</span>
      <h1 style={{ fontSize: 32, fontWeight: 480, letterSpacing: "-.05em", margin: "0 0 22px" }}>Sign in</h1>
      <form className="dialog-form" onSubmit={submit}>
        <label>Email<Input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<Input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="policy-note" role="alert">{error}</p>}
        <Button className="wide-dark" type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </article>
  );
}
