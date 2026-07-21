"use client";

import { Check, CreditCard, LogOut } from "lucide-react";
import Link from "next/link";
import { FormEvent, useRef, useState } from "react";
import { ArrowRight } from "@/components/marketing/Icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { signOutOfDashboard } from "@/lib/auth-client";
import type { BillingPaymentMethod } from "@/lib/billing";

const STEPS = [
  { label: "Your name", kicker: "Welcome to Rend" },
  { label: "Organization", kicker: "Your workspace" },
  { label: "Billing", kicker: "Almost there" },
] as const;

const fieldClass =
  "h-12 w-full rounded-xl border border-line bg-card px-4 text-[15px] text-ink shadow-[0_1px_2px_rgba(22,21,19,0.04)] outline-none transition placeholder:text-faint focus:border-ink/40 focus:ring-4 focus:ring-ink/[0.06] disabled:cursor-not-allowed disabled:opacity-60";

const headingClass =
  "font-head text-[clamp(24px,3vw,29px)] leading-[1.14] tracking-[-0.01em] text-ink";
const kickerClass = "text-[13px] font-medium text-muted";
const leadClass = "mt-2.5 text-[14.5px] leading-[1.6] text-muted";

function savedPaymentMethodLabel(paymentMethod: BillingPaymentMethod) {
  if (paymentMethod.status !== "on_file") return null;
  const brand = paymentMethod.brand
    ? paymentMethod.brand.charAt(0).toUpperCase() + paymentMethod.brand.slice(1)
    : "Card";
  return paymentMethod.last4 ? `${brand} ending in ${paymentMethod.last4}` : brand;
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-2.5" aria-label="Onboarding progress">
      {STEPS.map((entry, index) => {
        const done = index < step;
        const current = index === step;
        return (
          <li key={entry.label} className="flex flex-1 items-center gap-2.5">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border text-[12.5px] font-medium transition-all duration-300",
                done
                  ? "border-ink bg-ink text-bg"
                  : current
                    ? "border-ink bg-card text-ink scale-105"
                    : "border-line bg-card text-faint",
              )}
              aria-current={current ? "step" : undefined}
            >
              {done ? <Check className="size-3.5" /> : index + 1}
            </span>
            <span
              className={cn(
                "hidden text-[13px] transition-colors duration-300 sm:block",
                current ? "text-ink" : done ? "text-muted" : "text-faint",
              )}
            >
              {entry.label}
            </span>
            {index < STEPS.length - 1 ? (
              <span
                className={cn(
                  "h-px flex-1 origin-left transition-colors duration-500",
                  done ? "bg-ink/30" : "bg-line",
                )}
                aria-hidden="true"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function OnboardingClient({
  userEmail,
  paymentMethod,
  paymentSetupEnabled,
  legalAssentVersion,
}: {
  userEmail: string;
  paymentMethod: BillingPaymentMethod;
  paymentSetupEnabled: boolean;
  legalAssentVersion: string;
}) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const paymentFormRef = useRef<HTMLFormElement>(null);

  const trimmedName = name.trim();
  const trimmedOrg = orgName.trim();

  const paymentReady = paymentMethod.status === "on_file" || paymentMethod.status === "not_required";
  const needsPaymentSetup = !paymentReady && paymentSetupEnabled;

  function goNext() {
    setError("");
    setDirection("forward");
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  }

  function goBack() {
    setError("");
    setDirection("back");
    setStep((current) => Math.max(0, current - 1));
  }

  function onTextStepSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    goNext();
  }

  async function finish() {
    if (submitting || !trimmedName || !trimmedOrg) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          organization_name: trimmedOrg,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message || "We could not save your details. Try again.");
      }
      if (needsPaymentSetup && paymentFormRef.current) {
        paymentFormRef.current.submit();
        return;
      }
      window.location.assign("/dashboard/assets");
    } catch (finishError) {
      setError(finishError instanceof Error ? finishError.message : "Something went wrong. Try again.");
      setSubmitting(false);
    }
  }

  async function logOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutOfDashboard();
    } catch {
      setSigningOut(false);
    }
  }

  const stepAnimation = direction === "forward" ? "onb-step-forward" : "onb-step-back";

  return (
    <main className="relative grid min-h-screen place-items-center bg-bg px-5 py-10 text-ink">
      <div
        aria-hidden
        className="bg-dot-grid mask-fade-radial pointer-events-none absolute inset-0 opacity-60"
      />

      <div className="animate-rise relative w-full max-w-[520px]">
        <div className="mb-9 flex items-center justify-between gap-4">
          <Link href="/" aria-label="Rend home" className="inline-block">
            <img src="/rend-logo.svg" alt="Rend" className="h-7 w-auto" />
          </Link>
          <span className="truncate font-mono text-[12.5px] text-faint">{userEmail}</span>
        </div>

        <Stepper step={step} />

        <div className="mt-7 overflow-hidden rounded-[22px] border border-line bg-card p-7 shadow-[0_28px_70px_-46px_rgba(22,21,19,0.45)] sm:p-9">
          <div key={step} className={cn("onb-step flex flex-col", stepAnimation)}>
            <p className={kickerClass}>{STEPS[step].kicker}</p>

            {step === 0 ? (
              <form className="mt-3 flex flex-col" onSubmit={onTextStepSubmit}>
                <h1 className={headingClass}>What is your name?</h1>
                <p className={leadClass}>
                  We use this to personalize your account. You can change it later in settings.
                </p>

                <div className="mt-7 flex flex-col gap-2">
                  <label htmlFor="onboarding-name" className="text-[13px] font-medium text-ink-soft">
                    Your name
                  </label>
                  <input
                    autoComplete="name"
                    autoFocus
                    className={fieldClass}
                    id="onboarding-name"
                    maxLength={80}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Rendy McRenderface"
                    type="text"
                    value={name}
                  />
                </div>

                <div className="mt-8 flex justify-end">
                  <Button type="submit" size="lg" disabled={!trimmedName}>
                    Continue
                    <ArrowRight />
                  </Button>
                </div>
              </form>
            ) : null}

            {step === 1 ? (
              <form className="mt-3 flex flex-col" onSubmit={onTextStepSubmit}>
                <h1 className={headingClass}>Name your organization</h1>
                <p className={leadClass}>
                  This is your workspace for uploads, API keys, and billing. Pick a name your team will
                  recognize.
                </p>

                <div className="mt-7 flex flex-col gap-2">
                  <label htmlFor="onboarding-org" className="text-[13px] font-medium text-ink-soft">
                    Organization name
                  </label>
                  <input
                    autoComplete="organization"
                    autoFocus
                    className={fieldClass}
                    id="onboarding-org"
                    maxLength={80}
                    onChange={(event) => setOrgName(event.currentTarget.value)}
                    placeholder="Acme Inc"
                    type="text"
                    value={orgName}
                  />
                </div>

                <div className="mt-8 flex items-center justify-between gap-3">
                  <Button type="button" variant="ghost" size="lg" onClick={goBack}>
                    Back
                  </Button>
                  <Button type="submit" size="lg" disabled={!trimmedOrg}>
                    Continue
                    <ArrowRight />
                  </Button>
                </div>
              </form>
            ) : null}

            {step === 2 ? (
              <div className="mt-3 flex flex-col">
                <h1 className={headingClass}>{paymentReady ? "Billing is ready" : "Add a payment method"}</h1>
                <p className={leadClass}>
                  Pay as you go is automatic. There is no monthly fee, and you are billed only for
                  delivered watch minutes and stored video minutes.
                </p>

                <div className="mt-6 flex items-center gap-4 rounded-2xl border border-line bg-bg-sunken/40 p-5">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-card text-ink">
                    <CreditCard className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[14.5px] font-medium text-ink">
                      {paymentMethod.status === "on_file"
                        ? "Card on file"
                        : paymentMethod.status === "not_required"
                          ? "Not required locally"
                          : paymentMethod.status === "unknown"
                            ? "Payment status unavailable"
                            : "No card on file"}
                    </p>
                    <p className="mt-1 text-[13px] leading-[1.5] text-muted">
                      {savedPaymentMethodLabel(paymentMethod) ??
                        (paymentMethod.status === "not_required"
                          ? "Local development can continue without a card."
                          : "Add a card before your first upload or API key.")}
                    </p>
                  </div>
                </div>

                {needsPaymentSetup ? (
                  <p className="mt-5 text-[12.5px] leading-[1.6] text-faint">
                    By continuing you agree to the{" "}
                    <Link
                      href="/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-muted underline decoration-line underline-offset-2 transition hover:text-ink"
                    >
                      Terms
                    </Link>{" "}
                    and{" "}
                    <Link
                      href="/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-muted underline decoration-line underline-offset-2 transition hover:text-ink"
                    >
                      Privacy Notice
                    </Link>
                    , including usage charges for delivered and stored minutes.
                  </p>
                ) : null}

                <div className="mt-7 flex items-center justify-between gap-3">
                  <Button type="button" variant="ghost" size="lg" onClick={goBack} disabled={submitting}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    onClick={finish}
                    disabled={submitting || (!paymentReady && !needsPaymentSetup)}
                  >
                    {submitting
                      ? "Setting up..."
                      : needsPaymentSetup
                        ? "Add payment method"
                        : "Go to dashboard"}
                    {submitting ? null : <ArrowRight />}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="animate-rise mt-5 flex items-start gap-2.5 rounded-xl border border-[#e9c8c2] bg-[#fbf1ef] px-3.5 py-3 text-[13px] leading-[1.5] text-[#9a2a1c]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="mt-px shrink-0">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path d="M12 7.5v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={logOut}
            disabled={signingOut}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-faint transition-colors hover:text-ink disabled:opacity-60"
          >
            <LogOut className="size-3.5" />
            {signingOut ? "Logging out..." : "Log out"}
          </button>
        </div>
      </div>

      <form ref={paymentFormRef} action="/api/billing/payment-method" method="post" className="hidden">
        <input type="hidden" name="return_url" value="/dashboard/assets" />
        <input type="hidden" name="legal_assent" value="accepted" />
        <input type="hidden" name="legal_assent_version" value={legalAssentVersion} />
      </form>
    </main>
  );
}
