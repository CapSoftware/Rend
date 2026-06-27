import type { Metadata } from "next";
import Effects from "@/components/Effects";
import { CtaSection } from "@/components/marketing/CtaSection";
import { DashboardPreview } from "@/components/marketing/DashboardPreview";
import { Faq } from "@/components/marketing/Faq";
import { features } from "@/components/marketing/feature-data";
import { ArrowRight } from "@/components/marketing/Icons";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/PageHero";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Terminal, type TerminalLine } from "@/components/marketing/Terminal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getMarketingPage, START_HREF } from "@/lib/marketing-pages";
import { pageMetadata } from "@/lib/seo";
import { breadcrumbLd, faqLd, webPageLd } from "@/lib/structured-data";

const page = getMarketingPage("/features");

export const metadata: Metadata = pageMetadata({
  title: page.title,
  description: page.description,
  path: page.path,
});

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "Features", path: "/features" },
];

const uploadLines: TerminalLine[] = [
  { text: "rend upload product-demo.mp4", kind: "prompt" },
  { text: "encoding renditions (720p, 1080p, 4K)", kind: "out" },
  { text: "publishing HLS playback artifacts", kind: "out" },
  { text: "asset ready, playback URL issued", kind: "ok" },
  { text: "https://rend.so/watch/018f52b2", kind: "ok" },
];

export default function FeaturesPage() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd
        data={[
          webPageLd({
            name: page.title,
            description: page.description,
            path: page.path,
            type: "CollectionPage",
          }),
          breadcrumbLd(breadcrumbs),
          faqLd(page.faqs),
        ]}
      />
      <SiteHeader />

      <main>
        <PageHero
          title="Upload a video. Get back a URL that plays."
          lede={
            <p>
              Send Rend a video and it comes back ready to play behind a single
              URL, already encoded and stored for Tigris-backed HLS playback.
              You write one API call, not a pipeline, and private object-store
              URLs stay out of the browser.
            </p>
          }
          actions={
            <>
              <Button href={START_HREF} size="lg" className="w-full sm:w-auto">
                Get started <ArrowRight />
              </Button>
              <Button
                href="/docs"
                size="lg"
                variant="secondary"
                className="w-full sm:w-auto"
              >
                Read the quickstart
              </Button>
            </>
          }
          aside={<Terminal title="upload.sh" lines={uploadLines} />}
        />

        {/* Feature detail grid */}
        <Section tone="sunken" aria-label="What Rend does">
          <SectionHeading
            title="What you get"
            lede="Six things we think matter most, and what each one means when you build on Rend."
          />
          <div className="mt-12 grid grid-cols-1 gap-4 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Card key={f.id} className="reveal flex flex-col p-6 sm:p-7">
                {f.icon}
                <h2 className="mb-2 mt-5 font-head text-[21px] leading-snug">
                  {f.title}
                </h2>
                <p className="text-[15px] text-muted">{f.body}</p>
                <ul className="mt-4 flex flex-col gap-2 border-t border-line-soft pt-4">
                  {f.detail.map((d) => (
                    <li
                      key={d}
                      className="flex gap-2.5 text-[14px] leading-snug text-ink-soft"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent"
                      />
                      {d}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </Section>

        {/* From upload to playback */}
        <Section aria-label="From upload to playback">
          <div className="grid items-center gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14">
            <div className="max-w-[520px]">
              <SectionHeading
                title="From upload to playback in one flow"
                lede="Upload a source, poll until it is playable, then embed one same-origin URL. The dashboard shows every asset, its renditions and how fast it starts."
              />
              <ul className="mt-7 flex flex-col gap-4">
                {[
                  "Upload a file or a source URL with a single authenticated call.",
                  "Rend encodes the renditions players need and publishes HLS playback artifacts.",
                  "Embed the returned playback URL, or hand it to the Rend player.",
                ].map((step, i) => (
                  <li key={step} className="flex gap-3.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-card font-mono text-[12px] text-ink">
                      {i + 1}
                    </span>
                    <span className="pt-1 text-[15px] leading-snug text-muted">
                      {step}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <Button href="/docs" variant="secondary" size="md">
                  Read the quickstart <ArrowRight />
                </Button>
              </div>
            </div>
            <DashboardPreview className="reveal" />
          </div>
        </Section>

        <Faq
          faqs={page.faqs}
          lede="Common questions about what Rend does and how it fits your stack."
        />

        <CtaSection title="Ship your first video today" />
      </main>

      <SiteFooter />
    </div>
  );
}
