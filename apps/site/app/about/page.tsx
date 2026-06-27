import type { Metadata } from "next";
import Effects from "@/components/Effects";
import { CtaSection } from "@/components/marketing/CtaSection";
import { Faq } from "@/components/marketing/Faq";
import { ArrowRight, GitHubMark } from "@/components/marketing/Icons";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/PageHero";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import {
  GITHUB_URL,
  getMarketingPage,
  START_HREF,
} from "@/lib/marketing-pages";
import { pageMetadata } from "@/lib/seo";
import {
  breadcrumbLd,
  faqLd,
  organizationLd,
  webPageLd,
} from "@/lib/structured-data";

const page = getMarketingPage("/about");

export const metadata: Metadata = pageMetadata({
  title: page.title,
  description: page.description,
  path: page.path,
});

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "About", path: "/about" },
];

export default function AboutPage() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd
        data={[
          webPageLd({
            name: page.title,
            description: page.description,
            path: page.path,
            type: "AboutPage",
          }),
          breadcrumbLd(breadcrumbs),
          faqLd(page.faqs),
          organizationLd(),
        ]}
      />
      <SiteHeader />

      <main>
        <PageHero
          title="We couldn't buy fast video, so we built it"
          lede={
            <p>
              Rend started as plumbing for Cap, our open source screen recorder.
              The story is short. We needed video that played the instant
              someone opened a link, nothing on the market did it the way we
              wanted, and so we wrote our own.
            </p>
          }
          actions={
            <>
              <Button
                href="https://cap.so"
                external
                size="lg"
                variant="secondary"
                className="w-full sm:w-auto"
              >
                Visit Cap
              </Button>
              <Button
                href={GITHUB_URL}
                external
                size="lg"
                variant="secondary"
                className="w-full sm:w-auto"
              >
                <GitHubMark />
                Star on GitHub
              </Button>
            </>
          }
        />

        {/* The story */}
        <Section tone="sunken" aria-label="Why Rend exists">
          <SectionHeading title="The video we kept losing" />
          <div className="mt-8 flex max-w-[660px] flex-col gap-5 text-[17px] leading-[1.7] text-ink-soft">
            <p>
              Cap is a screen recorder. You hit record, capture something on
              your screen, and send a link. The whole thing rests on one moment:
              a teammate clicks that link, and the video is already playing. If
              it stalls, the moment is gone and so is their attention.
            </p>
            <p>
              For a while we stitched that moment together from the usual parts,
              and it mostly held up. The slow case was always the same one: the
              very first time anyone opened a clip. Nothing was cached, the
              bytes were sitting in some distant bucket, and the player just
              spun while the round trips stacked up. That first frame is the one
              that matters most, and it was the one we kept losing.
            </p>
            <p>
              So we went shopping. Minute-billed platforms, per-gigabyte CDNs,
              the lot. They were good at the easy case, a video that has already
              been watched a thousand times and cached everywhere. None of them
              were built for the cold open, the first request to a brand new
              recording, which for a screen recorder is most of the traffic.
            </p>
            <p>
              In the end we built it ourselves. Rend generates the playback
              artifacts players need during processing and serves them through
              Rend-controlled URLs. The first request can hand back real HLS
              media without exposing private storage links, and Cap started
              feeling instant.
            </p>
            <p>
              Then it occurred to us that every developer shipping video runs
              into the same wall, so we opened it up. Rend is its own product
              now, running on the exact code that serves Cap.
            </p>
            <p className="font-head text-[26px] leading-snug text-ink">
              Cap runs entirely on Rend.
            </p>
          </div>
        </Section>

        {/* Open by default */}
        <Section aria-label="Open by default">
          <SectionHeading
            title="The same code we run"
            lede="We did not keep a faster version for ourselves. Rend is open source, and the code you self-host is what we run for Cap."
          />
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.6] text-muted">
            The server is AGPL and the player and SDKs are MIT. You can read
            every line, run it on your own machines for free, or let us run the
            edge for you. We do not charge for the software. We charge for the
            network that makes it fast.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button href={GITHUB_URL} external variant="secondary" size="md">
              <GitHubMark />
              Read the source
            </Button>
            <a
              href="/docs"
              className="group inline-flex items-center gap-1.5 text-[14px] font-medium text-ink underline decoration-accent/70 decoration-2 underline-offset-4 transition hover:decoration-accent"
            >
              Read the docs <ArrowRight />
            </a>
          </div>
        </Section>

        {/* The team */}
        <Section tone="sunken" aria-label="The team behind Rend">
          <img src="/cap-logo.svg" alt="Cap" className="h-8 w-auto" />
          <h2 className="mt-6 text-[clamp(26px,5vw,40px)] leading-[1.12]">
            A small team that hates buffering
          </h2>
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.6] text-muted">
            We are the team behind Cap. We care, maybe a little too much, about
            video that loads the second you ask for it. Rend is the
            infrastructure we built to get there, and we run it in the open so
            you can hold us to it.
          </p>
          <div className="mt-8">
            <Button
              href="https://cap.so"
              external
              variant="secondary"
              size="md"
            >
              Visit Cap
            </Button>
          </div>
        </Section>

        <Faq
          faqs={page.faqs}
          lede="A few questions we get about who is behind Rend."
        />

        <CtaSection
          title="Build on the infrastructure that runs Cap"
          primary={{ label: "Open the dashboard", href: START_HREF }}
          secondary={{ label: "Visit Cap", href: "https://cap.so" }}
        />
      </main>

      <SiteFooter />
    </div>
  );
}
