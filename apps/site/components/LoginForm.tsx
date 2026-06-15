"use client";

import { FormEvent, useState } from "react";
import { LEGAL_ASSENT_VERSION } from "@/lib/legal-assent-constants";

export default function LoginForm({
  configured,
  nextPath,
}: {
  configured: boolean;
  nextPath: string;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState(configured ? "" : "Dashboard authentication is not configured.");
  const [submitting, setSubmitting] = useState(false);

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedCode = code.trim();

  async function postAuth(path: string, body: Record<string, string>, fallbackMessage: string) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          typeof payload?.message === "string" && payload.message ? payload.message : fallbackMessage
        );
      }
      return response;
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        throw new Error("Sign-in request timed out. Check the local dev server and try again.");
      }
      throw requestError;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function sendCode() {
    await postAuth(
      "/api/auth/email-otp/send-verification-otp",
      {
        email: normalizedEmail,
        legal_assent: "accepted",
        legal_assent_version: LEGAL_ASSENT_VERSION,
        type: "sign-in",
      },
      "Unable to send sign-in code"
    );
    setCodeSent(true);
  }

  async function verifyCode() {
    await postAuth(
      "/api/auth/sign-in/email-otp",
      { email: normalizedEmail, otp: normalizedCode },
      "Invalid or expired sign-in code"
    );
    window.location.assign(nextPath);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting) return;

    setSubmitting(true);
    setError("");
    try {
      if (codeSent) {
        await verifyCode();
      } else {
        await sendCode();
        setSubmitting(false);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Sign in failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="app-login-page">
      <section className="app-login-panel">
        <img src="/rend-logo.svg" alt="Rend" className="app-login-logo" />
        <h1>{codeSent ? "Verify your email" : "Sign in or create a workspace"}</h1>
        <form className="app-login-form" onSubmit={onSubmit}>
          <p className="app-login-help">
            {codeSent
              ? "Enter the six-digit code sent to your email."
              : "Use your email to start. Rend creates your workspace after verification."}
          </p>
          <label htmlFor="email">Email</label>
          <input
            autoComplete="email"
            disabled={!configured || submitting || codeSent}
            id="email"
            inputMode="email"
            onChange={(event) => setEmail(event.currentTarget.value)}
            type="email"
            value={email}
          />
          {codeSent ? (
            <>
              <label htmlFor="code">Code</label>
              <input
                autoComplete="one-time-code"
                disabled={!configured || submitting}
                id="code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
                pattern="[0-9]{6}"
                type="text"
                value={code}
              />
            </>
          ) : (
            <div className="app-legal-check">
              <input
                aria-describedby="terms-assent-copy"
                checked={acceptedTerms}
                disabled={!configured || submitting}
                id="terms-assent"
                onChange={(event) => setAcceptedTerms(event.currentTarget.checked)}
                required
                type="checkbox"
              />
              <div>
                <label htmlFor="terms-assent">I agree to Rend's legal terms.</label>
                <p id="terms-assent-copy">
                  This means the{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer">
                    Terms
                  </a>{" "}
                  and{" "}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer">
                    Privacy Notice
                  </a>
                  .
                </p>
              </div>
            </div>
          )}
          <button
            disabled={
              !configured ||
              submitting ||
              !normalizedEmail ||
              (!codeSent && !acceptedTerms) ||
              (codeSent && normalizedCode.length !== 6)
            }
            type="submit"
          >
            {submitting ? "Working..." : codeSent ? "Verify code" : "Send code"}
          </button>
          {codeSent ? (
            <button
              disabled={submitting}
              onClick={() => {
                setCode("");
                setCodeSent(false);
                setError("");
              }}
              type="button"
            >
              Use another email
            </button>
          ) : null}
          {error ? <p className="app-login-error">{error}</p> : null}
        </form>
      </section>
    </div>
  );
}
