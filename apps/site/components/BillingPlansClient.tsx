"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { StatusBadge } from "@/components/dashboard";

export type BillingPlanCard = {
  id: string;
  name: string;
  description?: string;
  priceLabel?: string;
  intervalLabel?: string;
  attachAction?: string;
  relationshipStatus?: string;
};

function priceFor(plan: BillingPlanCard) {
  return plan.priceLabel ?? (plan.id === "local" ? "Free" : "Custom");
}

function captionFor(plan: BillingPlanCard) {
  const price = priceFor(plan);
  return plan.intervalLabel ?? (price === "Free" ? "No monthly fee" : "Billed monthly");
}

export default function BillingPlansClient({
  plans,
  checkoutEnabled,
  returnUrl,
  legalAssentVersion,
}: {
  plans: BillingPlanCard[];
  checkoutEnabled: boolean;
  returnUrl: string;
  legalAssentVersion: string;
}) {
  const [selected, setSelected] = useState<BillingPlanCard | null>(null);
  const hasActivePlan = plans.some((plan) => plan.relationshipStatus === "active" && plan.id !== "local");

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = plan.relationshipStatus === "active";
          const actionDisabled = !checkoutEnabled || plan.attachAction === "none" || isCurrent;
          const ctaLabel = isCurrent ? "Current plan" : hasActivePlan ? "Switch to this plan" : "Choose plan";

          return (
            <article
              key={plan.id}
              className={cn(
                "flex flex-col rounded-[18px] border bg-card p-6 transition-shadow",
                isCurrent
                  ? "border-ink shadow-[0_20px_44px_-26px_rgba(22,21,19,0.32)]"
                  : "border-line hover:shadow-[0_18px_42px_-30px_rgba(22,21,19,0.3)]",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[14px] font-medium text-ink">{plan.name}</p>
                {isCurrent ? <StatusBadge tone="success">Current</StatusBadge> : null}
              </div>

              <p className="mt-5 font-head text-[32px] leading-none text-ink">{priceFor(plan)}</p>
              <p className="mt-2 text-[12.5px] text-muted">{captionFor(plan)}</p>

              {plan.description ? (
                <p className="mt-4 text-[13.5px] leading-[1.55] text-muted">{plan.description}</p>
              ) : null}

              <div className="mt-auto pt-6">
                <Button
                  type="button"
                  size="md"
                  variant={isCurrent ? "secondary" : "primary"}
                  className="w-full"
                  disabled={actionDisabled}
                  onClick={actionDisabled ? undefined : () => setSelected(plan)}
                >
                  {ctaLabel}
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      <Dialog.Root
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-line bg-card p-6 shadow-[0_30px_70px_-30px_rgba(22,21,19,0.5)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 sm:p-7">
            {selected ? (
              <>
                <Dialog.Title className="font-head text-[21px] leading-tight text-ink">
                  {hasActivePlan ? "Switch plan" : "Confirm your plan"}
                </Dialog.Title>

                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-bg-sunken/40 p-4">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-ink">{selected.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-muted">{captionFor(selected)}</p>
                  </div>
                  <p className="shrink-0 font-head text-[24px] leading-none text-ink">{priceFor(selected)}</p>
                </div>

                <Dialog.Description className="mt-4 text-[13px] leading-[1.6] text-muted">
                  By continuing you agree to the{" "}
                  <Link href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                    Terms
                  </Link>{" "}
                  and{" "}
                  <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                    Privacy Notice
                  </Link>
                  , including renewal, usage, and overage charges for this plan.
                </Dialog.Description>

                <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    className="w-full sm:w-auto"
                    onClick={() => setSelected(null)}
                  >
                    Cancel
                  </Button>
                  <form action="/api/billing/checkout" method="post" className="w-full sm:w-auto">
                    <input name="plan_id" type="hidden" value={selected.id} />
                    <input name="return_url" type="hidden" value={returnUrl} />
                    <input name="legal_assent_version" type="hidden" value={legalAssentVersion} />
                    <input name="legal_assent" type="hidden" value="accepted" />
                    <Button type="submit" size="md" className="w-full">
                      I agree to the Terms
                    </Button>
                  </form>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
