import type { Metadata } from "next";
import Link from "next/link";
import Effects from "@/components/Effects";
import { ComparisonTable } from "@/components/marketing/ComparisonTable";
import { CtaSection } from "@/components/marketing/CtaSection";
import { Faq } from "@/components/marketing/Faq";
import { ArrowRight } from "@/components/marketing/Icons";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/PageHero";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Grid } from "@/components/ui/Grid";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getMarketingPage, START_HREF } from "@/lib/marketing-pages";
import { pageMetadata } from "@/lib/seo";
import { breadcrumbLd, faqLd, webPageLd } from "@/lib/structured-data";

const page = getMarketingPage("/compare");

export const metadata: Metadata = pageMetadata({
  title: page.title,
  description: page.description,
  path: page.path,
});

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/compare" },
];

const approaches = [
  {
    title: "Minute-billed platforms",
    body: "These charge per minute of video plus tiers, and encoding and fast cold starts are often paid extras. They are convenient to start with, but the bill grows with your library and your traffic in ways that are hard to predict.",
  },
  {
    title: "Budget per-GB CDNs",
    body: "These bill raw bandwidth by region and leave encoding, packaging and the cold-start problem to you. Cheap per gigabyte, but you assemble the rest of the stack yourself.",
  },
  {
    title: "Roll your own",
    body: "Full control, but you own encoding, storage, a global cache and cold starts. Rend is open source if you want that control without starting from scratch.",
  },
];

const differences = [
  "Delivery and storage billed by resolution, not by the minute.",
  "Encoding included on every upload, not a separate charge.",
  "Warmed openers at a bare-metal edge by default, so the first frame shows fast even cold.",
  "Open source and free to self-host, the same code that runs Rend Cloud.",
  "Agent-ready, with llms.txt, OpenAPI, a generated SDK and a copyable setup prompt for the model in your editor.",
];

export default function ComparePage() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd
        data={[
          webPageLd({ name: page.title, description: page.description, path: page.path, type: "CollectionPage" }),
          breadcrumbLd(breadcrumbs),
          faqLd(page.faqs),
        ]}
      />
      <SiteHeader />

      <main>
        <PageHero
          title="How Rend compares"
          lede={
            <p>
              Two prices, seconds delivered and storage kept, both by resolution. Here is how that
              compares to the usual ways of paying for video.
            </p>
          }
          actions={
            <>
              <Button href={START_HREF} size="lg" className="w-full sm:w-auto">
                Get started <ArrowRight />
              </Button>
              <Button href="/pricing" size="lg" variant="secondary" className="w-full sm:w-auto">
                See pricing
              </Button>
            </>
          }
        />

        {/* The comparison */}
        <Section aria-label="The comparison">
          <SectionHeading
            title="Side by side"
            lede="Three common approaches to paying for and running video, next to Rend."
          />

          <ComparisonTable />

          <p className="mt-6 max-w-[680px] text-[13px] text-faint">
            The other three columns are broad strokes for how each kind of platform usually bills and
            runs, not a quote from any one vendor. Rend&apos;s own rates are listed live in the
            dashboard.
          </p>
        </Section>

        {/* The three usual approaches */}
        <Section tone="sunken" aria-label="The three usual approaches">
          <SectionHeading
            title="What you are comparing against"
            lede="Three common ways teams pay for and run video today."
          />
          <Grid cols={3} gap="xl" className="mt-12 sm:mt-14">
            {approaches.map((a) => (
              <Card key={a.title} className="reveal flex flex-col p-6 sm:p-7">
                <h3 className="mb-2 text-[20px] leading-snug">{a.title}</h3>
                <p className="text-[15px] text-muted">{a.body}</p>
              </Card>
            ))}
          </Grid>
        </Section>

        {/* Where Rend lands */}
        <Section aria-label="Where Rend lands">
          <SectionHeading
            title="What Rend does differently"
            lede="Encoding, storage, a fast edge, and the cold-start problem are handled in one place, and you pay for what people watch."
          />
          <ul className="mt-10 flex max-w-[680px] flex-col gap-4">
            {differences.map((d) => (
              <li key={d} className="flex gap-2.5 text-[16px] leading-snug text-ink-soft">
                <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                {d}
              </li>
            ))}
          </ul>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link
              href="/pricing"
              className="group inline-flex items-center gap-1.5 text-[14px] font-medium text-ink underline decoration-accent/70 decoration-2 underline-offset-4 transition hover:decoration-accent"
            >
              See how pricing works <ArrowRight />
            </Link>
            <Link
              href="/performance"
              className="group inline-flex items-center gap-1.5 text-[14px] font-medium text-ink underline decoration-accent/70 decoration-2 underline-offset-4 transition hover:decoration-accent"
            >
              Why Rend is fast <ArrowRight />
            </Link>
          </div>
        </Section>

        <Faq faqs={page.faqs} lede="Common questions about how Rend compares to other ways of paying for video." />

        <CtaSection
          title="Try Rend against your own numbers"
          primary={{ label: "Open the dashboard", href: START_HREF }}
          secondary={{ label: "See pricing", href: "/pricing" }}
        />
      </main>

      <SiteFooter />
    </div>
  );
}
