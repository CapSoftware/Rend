"use client";

import { FormEvent, useState } from "react";

export default function LoginForm({
  configured,
  nextPath,
}: {
  configured: boolean;
  nextPath: string;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState(configured ? "" : "Dashboard authentication is not configured.");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        throw new Error(body.message || "Sign in failed");
      }
      window.location.assign(nextPath);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Sign in failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="app-login-page">
      <section className="app-login-panel">
        <img src="/rend-logo.svg" alt="Rend" className="app-login-logo" />
        <h1>Sign in</h1>
        <form className="app-login-form" onSubmit={onSubmit}>
          <label htmlFor="operator-token">Operator token</label>
          <input
            autoComplete="current-password"
            disabled={!configured || submitting}
            id="operator-token"
            onChange={(event) => setToken(event.currentTarget.value)}
            type="password"
            value={token}
          />
          <button disabled={!configured || submitting || token.trim().length === 0} type="submit">
            {submitting ? "Signing in..." : "Sign in"}
          </button>
          {error ? <p>{error}</p> : null}
        </form>
      </section>
    </div>
  );
}
