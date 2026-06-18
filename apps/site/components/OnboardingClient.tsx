"use client";

import { Check, LogOut } from "lucide-react";
import Link from "next/link";
import { FormEvent, useMemo, useRef, useState } from "react";
import type { BillingPlanCard } from "@/components/BillingPlansClient";
import { ArrowRight } from "@/components/marketing/Icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { signOutOfDashboard } from "@/lib/auth-client";

const STEPS = [
  { label: "Your name", kicker: "Welcome to Rend" },
  { label: "Organization", kicker: "Your workspace" },
  { label: "Plan", kicker: "Almost there" },
] as const;

const fieldClass =
  "h-12 w-full rounded-xl border border-line bg-card px-4 text-[15px] text-ink shadow-[0_1px_2px_rgba(22,21,19,0.04)] outline-none transition placeholder:text-faint focus:border-ink/40 focus:ring-4 focus:ring-ink/[0.06] disabled:cursor-not-allowed disabled:opacity-60";

const headingClass =
  "font-head text-[clamp(24px,3vw,29px)] leading-[1.14] tracking-[-0.01em] text-ink";
const kickerClass = "text-[13px] font-medium text-muted";
const leadClass = "mt-2.5 text-[14.5px] leading-[1.6] text-muted";

function priceFor(plan: BillingPlanCard) {
  return plan.priceLabel ?? (plan.id === "local" ? "Free" : "Custom");
}

function captionFor(plan: BillingPlanCard) {
  const price = priceFor(plan);
  return plan.intervalLabel ?? (price === "Free" ? "No monthly fee" : "Billed monthly");
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
  plans,
  checkoutEnabled,
  legalAssentVersion,
}: {
  userEmail: string;
  plans: BillingPlanCard[];
  checkoutEnabled: boolean;
  legalAssentVersion: string;
}) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(() => {
    const active = plans.find((plan) => plan.relationshipStatus === "active");
    return active?.id ?? plans[0]?.id ?? null;
  });
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const checkoutFormRef = useRef<HTMLFormElement>(null);

  const trimmedName = name.trim();
  const trimmedOrg = orgName.trim();

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  const selectedNeedsCheckout = Boolean(
    selectedPlan &&
      checkoutEnabled &&
      selectedPlan.attachAction !== "none" &&
      selectedPlan.relationshipStatus !== "active",
  );

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
          plan_id: selectedPlanId,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message || "We could not save your details. Try again.");
      }
      if (selectedNeedsCheckout && checkoutFormRef.current) {
        checkoutFormRef.current.submit();
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
                <h1 className={headingClass}>Choose your plan</h1>
                <p className={leadClass}>
                  Start on pay as you go, or pick a plan with monthly credits included. Switch anytime,
                  with no lock-in.
                </p>

                <div className="mt-6 flex flex-col gap-3">
                  {plans.map((plan) => {
                    const isSelected = plan.id === selectedPlanId;
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedPlanId(plan.id)}
                        className={cn(
                          "flex items-start justify-between gap-4 rounded-2xl border bg-card p-4 text-left transition-all duration-200 sm:p-5",
                          isSelected
                            ? "border-ink shadow-[0_18px_40px_-30px_rgba(22,21,19,0.4)]"
                            : "border-line hover:border-ink/30 hover:bg-bg-sunken/40",
                        )}
                      >
                        <span className="flex min-w-0 items-start gap-3.5">
                          <span
                            className={cn(
                              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-all duration-200",
                              isSelected ? "border-ink bg-ink text-bg" : "border-line bg-card",
                            )}
                            aria-hidden="true"
                          >
                            {isSelected ? <Check className="size-3" /> : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[14.5px] font-medium text-ink">{plan.name}</span>
                            {plan.description ? (
                              <span className="mt-1 block text-[13px] leading-[1.5] text-muted">
                                {plan.description}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-head text-[20px] leading-none text-ink">
                            {priceFor(plan)}
                          </span>
                          <span className="mt-1 block text-[12px] text-muted">{captionFor(plan)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

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
                  , including renewal, usage, and overage charges for the plan you choose.
                </p>

                <div className="mt-7 flex items-center justify-between gap-3">
                  <Button type="button" variant="ghost" size="lg" onClick={goBack} disabled={submitting}>
                    Back
                  </Button>
                  <Button type="button" size="lg" onClick={finish} disabled={submitting || !selectedPlanId}>
                    {submitting
                      ? "Setting up..."
                      : selectedNeedsCheckout
                        ? "Continue to checkout"
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

      <form ref={checkoutFormRef} action="/api/billing/checkout" method="post" className="hidden">
        <input type="hidden" name="plan_id" value={selectedPlanId ?? ""} />
        <input type="hidden" name="return_url" value="/dashboard/assets" />
        <input type="hidden" name="legal_assent" value="accepted" />
        <input type="hidden" name="legal_assent_version" value={legalAssentVersion} />
      </form>
    </main>
  );
}
