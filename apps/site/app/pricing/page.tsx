import type { Metadata } from "next";
import Effects from "@/components/Effects";
import { CtaSection } from "@/components/marketing/CtaSection";
import { Faq } from "@/components/marketing/Faq";
import { ArrowRight } from "@/components/marketing/Icons";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PricingCalculator } from "@/components/marketing/PricingCalculator";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getMarketingPage, START_HREF } from "@/lib/marketing-pages";
import {
  DELIVERY_UNIT,
  getPublicPricing,
  STORAGE_UNIT,
  type PricePlanCard,
} from "@/lib/pricing";
import { pageMetadata } from "@/lib/seo";
import { breadcrumbLd, faqLd, productOfferLd, webPageLd } from "@/lib/structured-data";

const page = getMarketingPage("/pricing");
const CONTACT_HREF = "mailto:hello@rend.so";

// Refresh live Autumn rates at most once per hour.
export const revalidate = 3600;

export const metadata: Metadata = pageMetadata({
  title: page.title,
  description: page.description,
  path: page.path,
});

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "Pricing", path: "/pricing" },
];

function Rate({ value }: { value: string }) {
  return <span className="font-mono text-[14px] tabular-nums text-ink">{value}</span>;
}

function planCta(plan: PricePlanCard) {
  if (plan.priceLabel === "$0" || /free/i.test(plan.priceLabel)) return "Start free";
  return "Choose plan";
}

export default async function PricingPage() {
  const pricing = await getPublicPricing();
  const selfServePlans = pricing.plans.filter((p) => !/enterprise/i.test(p.name));
  const enterprise = pricing.plans.find((p) => /enterprise/i.test(p.name));

  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd
        data={[
          webPageLd({ name: page.title, description: page.description, path: page.path }),
          breadcrumbLd(breadcrumbs),
          faqLd(page.faqs),
          productOfferLd(),
        ]}
      />
      <SiteHeader />

      <main>
        {/* Lead with the actual rates */}
        <Section
          aria-label="Rates by resolution"
          spacing="none"
          className="pt-8 pb-[clamp(56px,8vw,96px)] sm:pt-10"
        >
          <div className="max-w-[720px]">
            <h1 className="animate-rise text-[clamp(32px,6.4vw,52px)] leading-[1.05] tracking-[-0.02em]">
              Pricing you can predict
            </h1>
            <p className="animate-rise animate-rise-2 mt-4 text-[17px] leading-[1.6] text-muted">
              Two prices, both by resolution: seconds delivered and storage kept. Encoding is included,
              with no per-minute fees and no egress charges. You pay for what people actually watched.
            </p>
          </div>

          {/* Desktop table */}
          <div className="reveal mt-10 hidden overflow-hidden rounded-[18px] border border-line bg-card md:block">
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead>
                <tr className="bg-bg-sunken/50">
                  <th scope="col" className="px-6 py-4 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
                    Resolution
                  </th>
                  <th scope="col" className="px-6 py-4 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
                    Delivery
                    <span className="mt-0.5 block font-normal normal-case tracking-normal text-faint/80">{DELIVERY_UNIT}</span>
                  </th>
                  <th scope="col" className="px-6 py-4 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
                    Storage
                    <span className="mt-0.5 block font-normal normal-case tracking-normal text-faint/80">{STORAGE_UNIT}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pricing.resolution.map((row, i) => (
                  <tr key={row.label}>
                    <th
                      scope="row"
                      className={cn("px-6 py-5 text-left align-middle", i !== 0 && "border-t border-line-soft")}
                    >
                      <span className="font-head text-[20px] leading-none text-ink">{row.label}</span>
                      <span className="mt-1 block text-[13px] font-normal text-muted">{row.blurb}</span>
                    </th>
                    <td className={cn("px-6 py-5 align-middle", i !== 0 && "border-t border-line-soft")}>
                      <Rate value={row.delivery} />
                    </td>
                    <td className={cn("px-6 py-5 align-middle", i !== 0 && "border-t border-line-soft")}>
                      <Rate value={row.storage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="mt-8 flex flex-col gap-3 md:hidden">
            {pricing.resolution.map((row) => (
              <div key={row.label} className="rounded-[16px] border border-line bg-card p-5">
                <p className="font-head text-[20px] leading-none text-ink">{row.label}</p>
                <p className="mt-1 text-[13px] text-muted">{row.blurb}</p>
                <dl className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-line-soft bg-bg-sunken/40 px-3 py-2.5">
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-faint">Delivery</dt>
                    <dd className="mt-1"><Rate value={row.delivery} /></dd>
                  </div>
                  <div className="rounded-xl border border-line-soft bg-bg-sunken/40 px-3 py-2.5">
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-faint">Storage</dt>
                    <dd className="mt-1"><Rate value={row.storage} /></dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <p className="mt-6 max-w-[640px] text-[13px] text-faint">
            {pricing.creditNote ??
              "Your exact rates are shown in the dashboard before you ship, and you only pay for what you deliver and store."}
          </p>
        </Section>

        {/* Plans */}
        <Section tone="sunken" aria-label="Plans">
          <SectionHeading
            title="Plans"
            lede="Start on pay as you go, or pick a plan with monthly credits included. Move between plans whenever you like, with no lock-in and no minimum."
          />
          <div className="mt-12 grid gap-4 sm:mt-14 sm:grid-cols-3">
            {selfServePlans.map((plan) => (
              <div
                key={plan.name}
                className={cn(
                  "flex flex-col rounded-[18px] border bg-card p-6",
                  plan.highlighted ? "border-ink shadow-[0_20px_44px_-26px_rgba(22,21,19,0.32)]" : "border-line",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[14px] font-medium text-ink">{plan.name}</p>
                  {plan.highlighted ? (
                    <span className="rounded-full border border-line bg-bg-sunken px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">
                      Popular
                    </span>
                  ) : null}
                </div>
                <p className="mt-4 font-head text-[30px] leading-none text-ink">{plan.priceLabel}</p>
                <p className="mt-1.5 text-[11.5px] uppercase tracking-[0.08em] text-faint">{plan.priceCaption}</p>
                <p className="mt-4 flex-1 text-[14px] leading-[1.55] text-muted">{plan.includedLabel}</p>
                <Button
                  href={START_HREF}
                  variant={plan.highlighted ? "primary" : "secondary"}
                  size="md"
                  className="mt-6 w-full"
                >
                  {planCta(plan)}
                </Button>
              </div>
            ))}
          </div>
        </Section>

        {/* Cost calculator */}
        <Section aria-label="Estimate your costs">
          <SectionHeading
            title="Estimate your monthly cost"
            lede="Drag the sliders to match your traffic and see what you would pay, with the best plan picked for you."
          />
          <div className="mt-12 sm:mt-14">
            <PricingCalculator model={pricing.calculator} />
          </div>
        </Section>

        {/* Enterprise */}
        {enterprise ? (
          <Section tone="sunken" aria-label="Enterprise">
            <div className="grid gap-7 rounded-[18px] border border-line bg-card p-7 sm:p-9 md:grid-cols-[1.5fr_1fr] md:items-center">
              <div>
                <h2 className="text-[clamp(24px,4vw,34px)] leading-[1.1]">Enterprise</h2>
                <p className="mt-3 max-w-[520px] text-[16px] leading-[1.6] text-muted">
                  Running a big library or heavy traffic? We will set up committed credits and volume
                  pricing, and give you a direct line to the team.
                </p>
                <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-head text-[28px] leading-none text-ink">{enterprise.priceLabel}</span>
                  <span className="text-[13px] text-muted">{enterprise.priceCaption}</span>
                  <span className="text-faint" aria-hidden="true">·</span>
                  <span className="text-[14px] text-muted">{enterprise.includedLabel}</span>
                </div>
              </div>
              <div className="md:justify-self-end">
                <Button href={CONTACT_HREF} external variant="primary" size="lg" className="w-full sm:w-auto">
                  Talk to us <ArrowRight />
                </Button>
              </div>
            </div>
          </Section>
        ) : null}

        <Faq faqs={page.faqs} tone="default" lede="A few questions we get about how Rend pricing works." />

        <CtaSection
          title="Start free, scale when you need to"
          primary={{ label: "Open the dashboard", href: START_HREF }}
          secondary={{ label: "Compare options", href: "/compare" }}
        />
      </main>

      <SiteFooter />
    </div>
  );
}
