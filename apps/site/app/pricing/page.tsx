import type { Metadata } from "next";
import Effects from "@/components/Effects";
import { CtaSection } from "@/components/marketing/CtaSection";
import { Faq } from "@/components/marketing/Faq";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PricingCalculator } from "@/components/marketing/PricingCalculator";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getMarketingPage, START_HREF } from "@/lib/marketing-pages";
import { getPublicPricing } from "@/lib/pricing";
import { pageMetadata } from "@/lib/seo";
import { breadcrumbLd, faqLd, productOfferLd, webPageLd } from "@/lib/structured-data";

const page = getMarketingPage("/pricing");

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

export default async function PricingPage() {
  const pricing = await getPublicPricing();

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
        <Section
          aria-label="Minute rates"
          spacing="none"
          className="pt-8 pb-[clamp(56px,8vw,96px)] sm:pt-10"
        >
          <div className="max-w-[720px]">
            <h1 className="animate-rise text-[clamp(32px,6.4vw,52px)] leading-[1.05] tracking-[-0.02em]">
              Pricing you can predict
            </h1>
            <p className="animate-rise animate-rise-2 mt-4 text-[17px] leading-[1.6] text-muted">
              Two prices: minutes delivered to viewers and minutes stored in your library. Encoding is
              included, and the rate is the same at every resolution.
            </p>
          </div>

          <div className="reveal mt-10 grid gap-4 sm:grid-cols-2">
            {[pricing.delivery, pricing.storage].map((meter) => (
              <div key={meter.featureId} className="rounded-[18px] border border-line bg-card p-6 sm:p-7">
                <p className="text-[13px] font-medium text-muted">{meter.label}</p>
                <p className="mt-4 flex items-baseline gap-2">
                  <span className="font-head text-[clamp(34px,6vw,46px)] leading-none text-ink tabular-nums">
                    {meter.priceLabel}
                  </span>
                  <span className="text-[13px] text-muted">{meter.unitLabel}</span>
                </p>
                <p className="mt-4 text-[14px] leading-[1.55] text-muted">{meter.description}</p>
              </div>
            ))}
          </div>

          <p className="mt-6 max-w-[640px] text-[13px] text-faint">
            Usage is measured precisely and shown in minutes. We do not round each video or viewing session up to a whole minute.
          </p>
        </Section>

        <Section tone="sunken" aria-label="Plans">
          <SectionHeading
            title="One plan"
            lede="Pay as you go with no monthly fee or plan math to work through."
          />
          <div className="mt-12 max-w-[520px] sm:mt-14">
            <div className="flex flex-col rounded-[18px] border border-ink bg-card p-6 shadow-[0_20px_44px_-26px_rgba(22,21,19,0.32)]">
              <p className="text-[14px] font-medium text-ink">{pricing.plan.name}</p>
              <p className="mt-4 font-head text-[30px] leading-none text-ink">{pricing.plan.priceLabel}</p>
              <p className="mt-1.5 text-[11.5px] uppercase tracking-[0.08em] text-faint">{pricing.plan.priceCaption}</p>
              <p className="mt-4 flex-1 text-[14px] leading-[1.55] text-muted">{pricing.plan.includedLabel}</p>
              <Button href={START_HREF} variant="primary" size="md" className="mt-6 w-full">
                Open the dashboard
              </Button>
            </div>
          </div>
        </Section>

        <Section aria-label="Estimate your costs">
          <SectionHeading
            title="Estimate your monthly cost"
            lede="Enter the minutes you expect to deliver and store. The calculation is just rate multiplied by minutes."
          />
          <div className="mt-12 sm:mt-14">
            <PricingCalculator model={pricing.calculator} />
          </div>
        </Section>

        <Faq faqs={page.faqs} tone="default" lede="A few questions we get about how Rend pricing works." />

        <CtaSection
          title="Start with pay as you go"
          primary={{ label: "Open the dashboard", href: START_HREF }}
          secondary={{ label: "Compare options", href: "/compare" }}
        />
      </main>

      <SiteFooter />
    </div>
  );
}
