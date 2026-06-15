"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ArrowRight } from "@/components/marketing/Icons";
import type { PricingCalculatorModel } from "@/lib/pricing";
import { START_HREF } from "@/lib/marketing-pages";

const WATCH_MAX = 50_000;
const STORE_MAX = 20_000;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(n: number) {
  return usd.format(n);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function trackStyle(value: number, max: number) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return { background: `linear-gradient(to right, var(--color-ink) ${pct}%, var(--color-line) ${pct}%)` };
}

function Slider({
  id,
  label,
  hint,
  unit,
  value,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const setFromText = (raw: string) => onChange(clamp(parseInt(raw.replace(/[^0-9]/g, ""), 10) || 0, 0, max));
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <label htmlFor={id} className="text-[14px] font-medium text-ink">
          {label}
        </label>
        <span className="flex items-baseline gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            value={value.toLocaleString("en-US")}
            aria-label={label}
            onChange={(e) => setFromText(e.currentTarget.value)}
            className="w-[116px] bg-transparent text-right font-head text-[22px] leading-none text-ink tabular-nums outline-none"
          />
          <span className="text-[13px] text-muted">{unit}</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        className="pricing-range mt-3.5"
        min={0}
        max={max}
        step={step}
        value={value}
        aria-valuetext={`${value.toLocaleString("en-US")} ${unit}`}
        style={trackStyle(value, max)}
        onChange={(e) => onChange(clamp(e.currentTarget.valueAsNumber, 0, max))}
      />
      <p className="mt-2 text-[12px] text-faint">{hint}</p>
    </div>
  );
}

export function PricingCalculator({ model }: { model: PricingCalculatorModel }) {
  const resolutions = model.resolutions;
  const defaultRes = Math.min(1, resolutions.length - 1); // 1080p when present
  const [resIndex, setResIndex] = useState(defaultRes);
  const [watchHours, setWatchHours] = useState(1_000);
  const [storeHours, setStoreHours] = useState(200);

  const res = resolutions[resIndex] ?? resolutions[0];

  const result = useMemo(() => {
    const deliveryCost = watchHours * res.deliveryPerHour;
    const storageCost = storeHours * res.storagePerHourMonth;
    const usage = deliveryCost + storageCost;

    const ranked = model.plans
      .map((plan) => {
        const creditsApplied = Math.min(usage, plan.includedCredits);
        const overage = Math.max(0, usage - plan.includedCredits);
        return { plan, creditsApplied, overage, total: plan.monthly + overage };
      })
      .sort((a, b) => a.total - b.total || a.plan.monthly - b.plan.monthly);

    const best = ranked[0];
    let explanation: string;
    if (best.plan.monthly === 0) {
      explanation = "Pay as you go, billed on your usage with no monthly fee.";
    } else if (best.overage === 0) {
      explanation = `Your ${money(usage)} of usage fits inside ${best.plan.name}'s ${money(best.plan.includedCredits)} of monthly credits.`;
    } else {
      explanation = `${money(best.plan.monthly)} plan, plus ${money(best.overage)} of usage beyond your ${money(best.plan.includedCredits)} in credits.`;
    }

    return { deliveryCost, storageCost, usage, best, explanation };
  }, [watchHours, storeHours, res, model.plans]);

  const { best } = result;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr] lg:gap-6">
      {/* Inputs */}
      <div className="rounded-[18px] border border-line bg-card p-6 sm:p-8">
        <div className="mb-7">
          <p className="mb-3 text-[13px] font-medium text-ink">Resolution</p>
          <div className="inline-flex gap-1 rounded-xl border border-line bg-bg-sunken p-1">
            {resolutions.map((r, i) => (
              <button
                key={r.label}
                type="button"
                aria-pressed={i === resIndex}
                onClick={() => setResIndex(i)}
                className={cn(
                  "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition",
                  i === resIndex
                    ? "bg-card text-ink shadow-[0_1px_2px_rgba(22,21,19,0.12)]"
                    : "text-muted hover:text-ink",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-7">
          <Slider
            id="calc-watch"
            label="Hours watched per month"
            hint="Streaming delivered to your viewers."
            unit="hrs"
            value={watchHours}
            max={WATCH_MAX}
            step={50}
            onChange={setWatchHours}
          />
          <Slider
            id="calc-store"
            label="Hours kept in your library"
            hint="Footage stored on Rend this month."
            unit="hrs"
            value={storeHours}
            max={STORE_MAX}
            step={25}
            onChange={setStoreHours}
          />
        </div>
      </div>

      {/* Result */}
      <div className="flex flex-col rounded-[18px] bg-ink p-6 text-bg sm:p-8">
        <div aria-live="polite" aria-atomic="true">
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-bg/65">Estimated monthly cost</p>
          <p className="mt-2 flex items-baseline gap-2 font-head leading-none">
            <span className="text-[clamp(38px,7.5vw,54px)] tabular-nums">{money(best.total)}</span>
            <span className="text-[18px] text-bg/65">/mo</span>
          </p>
          <p className="mt-3 inline-flex w-fit items-center rounded-full border border-bg/25 px-2.5 py-1 text-[12px] font-medium text-bg/85">
            Best on the {best.plan.name} plan
          </p>
          <p className="mt-4 text-[13px] leading-[1.55] text-bg/75">{result.explanation}</p>
        </div>

        <dl className="mt-6 flex flex-col gap-2.5 border-t border-bg/15 pt-6 text-[14px]">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-bg/70">Delivery, {res.label}</dt>
            <dd className="font-mono tabular-nums text-bg">{money(result.deliveryCost)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-bg/70">Storage, {res.label}</dt>
            <dd className="font-mono tabular-nums text-bg">{money(result.storageCost)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-bg/70">Encoding</dt>
            <dd className="font-mono text-bg/80">Included</dd>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-bg/15 pt-3.5">
            <dt className="text-bg/70">Usage</dt>
            <dd className="font-mono tabular-nums text-bg">{money(result.usage)}</dd>
          </div>
          {best.plan.monthly > 0 ? (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-bg/70">{best.plan.name} plan</dt>
              <dd className="font-mono tabular-nums text-bg">{money(best.plan.monthly)}</dd>
            </div>
          ) : null}
          {best.creditsApplied > 0 ? (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-bg/70">Credits applied</dt>
              <dd className="font-mono tabular-nums text-bg">{`−${money(best.creditsApplied)}`}</dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-auto pt-7">
          <Button href={START_HREF} variant="inverse" size="md" className="w-full">
            Get started <ArrowRight />
          </Button>
          <p className="mt-3 text-center text-[11.5px] text-bg/65">An estimate, not a quote.</p>
        </div>
      </div>
    </div>
  );
}
