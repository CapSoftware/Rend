"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { ArrowRight } from "@/components/marketing/Icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { LEGAL_ASSENT_VERSION } from "@/lib/legal-assent-constants";

/**
 * A small hand-drawn envelope in the same sketch language as the marketing
 * pages: a sealed envelope holding the sign-in code, with a couple of
 * twinkling sparkles for a little life.
 */
function EnvelopeSketch({ className }: { className?: string }) {
  return (
    <svg
      className={cn("sketch overflow-visible", className)}
      viewBox="16 24 170 100"
      role="img"
      aria-label="A hand-drawn envelope holding your Rend sign-in code."
    >
      {/* envelope body */}
      <path d="M34 44 C72 40 128 40 166 44 C169 66 169 96 166 116 C128 120 72 120 34 116 C31 96 31 66 34 44" />
      {/* closed flap, meeting at a natural fold point */}
      <path d="M37 47 L100 87 L163 47" />
      {/* sparkles, clear of the corners */}
      <path className="anim-twinkle" d="M176 27 L176 41 M169 34 L183 34" />
      <path className="anim-twinkle t2" d="M24 32 L24 44 M18 38 L30 38" />
    </svg>
  );
}

const fieldClass =
  "h-12 w-full rounded-xl border border-line bg-card px-4 text-[15px] text-ink shadow-[0_1px_2px_rgba(22,21,19,0.04)] outline-none transition placeholder:text-faint focus:border-ink/40 focus:ring-4 focus:ring-ink/[0.06] disabled:cursor-not-allowed disabled:opacity-60";

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

  const submitDisabled =
    !configured ||
    submitting ||
    !normalizedEmail ||
    (!codeSent && !acceptedTerms) ||
    (codeSent && normalizedCode.length !== 6);

  return (
    <main className="grid min-h-screen bg-bg text-ink lg:grid-cols-[1.05fr_0.95fr]">
      {/* ---------------------------- Brand panel ---------------------------- */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-bg-sunken p-10 lg:flex xl:p-14">
        <div aria-hidden className="bg-dot-grid mask-fade-radial pointer-events-none absolute inset-0 opacity-70" />

        <Link href="/" aria-label="Rend home" className="relative inline-block">
          <img src="/rend-logo.svg" alt="Rend" className="h-8 w-auto" />
        </Link>

        <div className="relative">
          <EnvelopeSketch className="w-44" />
          <h2 className="mt-9 max-w-[14ch] text-[clamp(30px,3.2vw,44px)] leading-[1.06] tracking-[-0.02em]">
            Welcome to Rend.
          </h2>
          <p className="mt-5 max-w-[42ch] font-mono text-[14px] leading-[1.75] text-muted">
            The video platform for developers. Sign in to upload, manage, and deliver video that
            starts fast, all from one workspace.
          </p>
        </div>

        <p className="relative font-mono text-[12.5px] leading-[1.6] text-faint">
          Built by the team behind Cap. Trusted with petabytes of video.
        </p>
      </aside>

      {/* ------------------------------- Form ------------------------------- */}
      <section className="relative flex items-center justify-center px-5 py-12 sm:px-8">
        <div
          aria-hidden
          className="bg-dot-grid mask-fade-radial pointer-events-none absolute inset-0 opacity-50 lg:hidden"
        />

        <div className="relative w-full max-w-[400px]">
          {/* Compact brand for small screens */}
          <div className="mb-10 flex flex-col items-center lg:hidden">
            <Link href="/" aria-label="Rend home" className="inline-block">
              <img src="/rend-logo.svg" alt="Rend" className="h-8 w-auto" />
            </Link>
            <EnvelopeSketch className="mt-7 w-28" />
          </div>

          <div className="animate-rise">
            <h1 className="text-[clamp(27px,4.4vw,34px)] leading-[1.1] tracking-[-0.01em]">
              {codeSent ? "Verify your email" : "Sign in or create a workspace"}
            </h1>
            <p className="mt-3 text-[15px] leading-[1.6] text-muted">
              {codeSent ? (
                <>
                  Enter the six-digit code we sent to{" "}
                  <span className="font-medium text-ink">{normalizedEmail}</span>.
                </>
              ) : (
                "Use your email to start. Rend creates your workspace after verification, no password needed."
              )}
            </p>
          </div>

          <form className="animate-rise animate-rise-2 mt-8 flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <label htmlFor="email" className="text-[13px] font-medium text-ink-soft">
                Email
              </label>
              <input
                autoComplete="email"
                autoFocus={!codeSent}
                className={fieldClass}
                disabled={!configured || submitting || codeSent}
                id="email"
                inputMode="email"
                onChange={(event) => setEmail(event.currentTarget.value)}
                placeholder="you@company.com"
                type="email"
                value={email}
              />
            </div>

            {codeSent ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="code" className="text-[13px] font-medium text-ink-soft">
                  Verification code
                </label>
                <input
                  autoComplete="one-time-code"
                  autoFocus
                  className={cn(fieldClass, "h-14 text-center font-mono text-[22px] tracking-[0.5em]")}
                  disabled={!configured || submitting}
                  id="code"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) =>
                    setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))
                  }
                  pattern="[0-9]{6}"
                  placeholder="••••••"
                  type="text"
                  value={code}
                />
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-xl border border-line bg-bg-sunken/40 px-3.5 py-3">
                <input
                  checked={acceptedTerms}
                  className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-ink"
                  disabled={!configured || submitting}
                  id="terms-assent"
                  onChange={(event) => setAcceptedTerms(event.currentTarget.checked)}
                  required
                  type="checkbox"
                />
                <div className="text-[13px] leading-[1.5] text-muted">
                  <label htmlFor="terms-assent" className="cursor-pointer font-medium text-ink-soft">
                    I agree to Rend&apos;s legal terms.
                  </label>
                  <p className="mt-0.5">
                    This means the{" "}
                    <a
                      href="/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-ink underline decoration-line decoration-2 underline-offset-2 transition hover:decoration-accent"
                    >
                      Terms
                    </a>{" "}
                    and{" "}
                    <a
                      href="/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-ink underline decoration-line decoration-2 underline-offset-2 transition hover:decoration-accent"
                    >
                      Privacy Notice
                    </a>
                    .
                  </p>
                </div>
              </div>
            )}

            <Button type="submit" size="lg" className="mt-1 w-full" disabled={submitDisabled}>
              {submitting ? (
                "Working..."
              ) : (
                <>
                  {codeSent ? "Verify code" : "Send code"}
                  <ArrowRight />
                </>
              )}
            </Button>

            {codeSent ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={submitting}
                onClick={() => {
                  setCode("");
                  setCodeSent(false);
                  setError("");
                }}
              >
                Use another email
              </Button>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-[#e9c8c2] bg-[#fbf1ef] px-3.5 py-3 text-[13px] leading-[1.5] text-[#9a2a1c]"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  className="mt-px shrink-0"
                >
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="M12 7.5v5M12 16h.01"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span>{error}</span>
              </div>
            ) : null}
          </form>

          <p className="animate-rise animate-rise-3 mt-8 text-[13px] leading-[1.5] text-faint">
            Trouble signing in? Read the{" "}
            <Link
              href="/docs"
              className="font-medium text-muted underline decoration-line underline-offset-2 transition hover:text-ink hover:decoration-ink"
            >
              docs
            </Link>{" "}
            or head back to the{" "}
            <Link
              href="/"
              className="font-medium text-muted underline decoration-line underline-offset-2 transition hover:text-ink hover:decoration-ink"
            >
              home page
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
