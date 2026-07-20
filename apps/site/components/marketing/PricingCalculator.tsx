"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ArrowRight } from "@/components/marketing/Icons";
import type { PricingCalculatorModel } from "@/lib/pricing";
import { START_HREF } from "@/lib/marketing-pages";

const DELIVERY_MAX = 2_000_000;
const STORAGE_MAX = 250_000;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(value: number) {
  return usd.format(value);
}

function clamp(value: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function trackStyle(value: number, max: number) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100));
  return { background: `linear-gradient(to right, var(--color-ink) ${percent}%, var(--color-line) ${percent}%)` };
}

function MinuteSlider({
  id,
  label,
  hint,
  value,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const setFromText = (raw: string) => onChange(clamp(Number.parseInt(raw.replace(/[^0-9]/g, ""), 10) || 0, max));

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
            onChange={(event) => setFromText(event.currentTarget.value)}
            className="w-[132px] bg-transparent text-right font-head text-[22px] leading-none text-ink tabular-nums outline-none"
          />
          <span className="text-[13px] text-muted">min</span>
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
        aria-valuetext={`${value.toLocaleString("en-US")} minutes`}
        style={trackStyle(value, max)}
        onChange={(event) => onChange(clamp(event.currentTarget.valueAsNumber, max))}
      />
      <p className="mt-2 text-[12px] text-faint">{hint}</p>
    </div>
  );
}

export function PricingCalculator({ model }: { model: PricingCalculatorModel }) {
  const [deliveryMinutes, setDeliveryMinutes] = useState(100_000);
  const [storageMinutes, setStorageMinutes] = useState(10_000);

  const deliveryCost = deliveryMinutes * model.deliveryPerMinute;
  const storageCost = storageMinutes * model.storagePerMinuteMonth;
  const total = deliveryCost + storageCost;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr] lg:gap-6">
      <div className="rounded-[18px] border border-line bg-card p-6 sm:p-8">
        <div className="flex flex-col gap-8">
          <MinuteSlider
            id="calc-delivery"
            label="Minutes delivered per month"
            hint="Total viewer watch time delivered by Rend."
            value={deliveryMinutes}
            max={DELIVERY_MAX}
            step={5_000}
            onChange={setDeliveryMinutes}
          />
          <MinuteSlider
            id="calc-storage"
            label="Minutes stored"
            hint="Total video duration kept in your library for the month."
            value={storageMinutes}
            max={STORAGE_MAX}
            step={1_000}
            onChange={setStorageMinutes}
          />
        </div>
      </div>

      <div className="flex flex-col rounded-[18px] bg-ink p-6 text-bg sm:p-8">
        <div aria-live="polite" aria-atomic="true">
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-bg/65">Estimated monthly cost</p>
          <p className="mt-2 flex items-baseline gap-2 font-head leading-none">
            <span className="text-[clamp(38px,7.5vw,54px)] tabular-nums">{money(total)}</span>
            <span className="text-[18px] text-bg/65">/mo</span>
          </p>
          <p className="mt-4 text-[13px] leading-[1.55] text-bg/75">
            Encoding is included, with no separate egress charge.
          </p>
        </div>

        <dl className="mt-6 flex flex-col gap-2.5 border-t border-bg/15 pt-6 text-[14px]">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-bg/70">Delivery</dt>
            <dd className="font-mono tabular-nums text-bg">{money(deliveryCost)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-bg/70">Storage</dt>
            <dd className="font-mono tabular-nums text-bg">{money(storageCost)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-bg/70">Encoding</dt>
            <dd className="font-mono text-bg/80">Included</dd>
          </div>
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
