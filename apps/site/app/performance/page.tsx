import type { Metadata } from "next";
import Effects from "@/components/Effects";
import { CtaSection } from "@/components/marketing/CtaSection";
import { Faq } from "@/components/marketing/Faq";
import { ArrowRight } from "@/components/marketing/Icons";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/PageHero";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Button } from "@/components/ui/Button";
import { Grid } from "@/components/ui/Grid";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getMarketingPage, START_HREF } from "@/lib/marketing-pages";
import { pageMetadata } from "@/lib/seo";
import { breadcrumbLd, faqLd, webPageLd } from "@/lib/structured-data";

const page = getMarketingPage("/performance");

export const metadata: Metadata = pageMetadata({
  title: page.title,
  description: page.description,
  path: page.path,
});

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "Performance", path: "/performance" },
];

const pillars = [
  {
    t: "Tigris-backed HLS by default",
    d: "Rend Cloud serves generated HLS directly from Tigris-backed origin today. The bare-metal edge path stays available in the repo, but it is dormant in production until regional coverage makes it worthwhile.",
  },
  {
    t: "No edge dependency",
    d: "Uploads, readiness, watch pages and embeds do not require active edge nodes. Playback stays behind Rend-controlled URLs without exposing private object-store links.",
  },
  {
    t: "Ready before anyone presses play",
    d: "Rend builds HLS artifacts during media processing so the player can start from real media as soon as the asset reaches hls_ready.",
  },
];

const terms = [
  {
    t: "Cold start",
    d: "The first request for a video nobody has watched yet, with nothing primed in any cache.",
  },
  {
    t: "HLS ready",
    d: "The state where Rend-generated HLS manifests and segments are available for playback from origin.",
  },
  {
    t: "Dormant edge node",
    d: "A bare-metal playback cache service kept in the repo for future reactivation, not required for current production playback.",
  },
];

export default function PerformancePage() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd
        data={[
          webPageLd({
            name: page.title,
            description: page.description,
            path: page.path,
          }),
          breadcrumbLd(breadcrumbs),
          faqLd(page.faqs),
        ]}
      />
      <SiteHeader />

      <main>
        <PageHero
          title="Why Rend is fast"
          lede={
            <>
              <p>
                When a video is slow to start, it's rarely raw server speed.
                It's the round trips before the first frame. Rend cuts those
                trips down with generated HLS and a server-controlled Tigris
                origin path that keeps private storage URLs out of the browser.
              </p>
              <p className="mt-4">
                The bare-metal edge code remains available for a future regional
                fleet, but it is not the active production path today. Current
                playback works without edge warmers or edge cache fanout.
              </p>
            </>
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
        />

        {/* Few trips, all short */}
        <Section tone="sunken" aria-label="Few trips, all short">
          <svg
            className="sketch mb-7 block h-20 w-28 overflow-visible"
            viewBox="0 0 150 110"
            role="img"
            aria-label="Video streams in from origin to an edge node near your viewer, and the first frames hop from there to the screen."
          >
            {/* viewer screen */}
            <path d="M16 36 C30 34 46 34 56 36 C58 48 58 68 56 80 C46 82 30 82 16 80 C14 68 14 48 16 36" />
            <path d="M30 48 L46 58 L30 68 Z" />
            {/* optional edge node; dormant by default */}
            <path d="M80 44 C88 42 100 42 108 44 C110 52 110 64 108 72 C100 74 88 74 80 72 C78 64 78 52 80 44" />
            <path
              d="M90 52 L100 58 L90 64 Z"
              style={{ fill: "var(--color-ink)", stroke: "none" }}
            />
            <path className="anim-twinkle" d="M95 28 L95 38 M90 33 L100 33" />
            {/* origin streaming into the edge */}
            <path className="anim-zip" d="M120 50 L134 49" />
            <path className="anim-zip z2" d="M124 60 L138 60" />
            <path className="anim-zip z3" d="M120 70 L134 71" />
            {/* edge -> viewer */}
            <path id="p-ev" d="M78 60 C70 62 66 60 60 60" />
            {/* first frame hops to the screen */}
            <circle className="dot" r="4">
              <animateMotion
                dur="2.2s"
                repeatCount="indefinite"
                calcMode="linear"
                keyPoints="0;1;1"
                keyTimes="0;0.28;1"
              >
                <mpath href="#p-ev" />
              </animateMotion>
              <animate
                attributeName="opacity"
                values="0;1;1;0;0"
                keyTimes="0;0.05;0.26;0.36;1"
                dur="2.2s"
                repeatCount="indefinite"
              />
            </circle>
          </svg>

          <SectionHeading
            title="Few trips, all short"
            lede="Every hop a request makes across the internet adds time before playback can begin. Rend cuts the path down. The first bytes are already sitting at an edge node near your viewer, so there are fewer trips to make and each one is shorter."
          />

          <Grid cols={3} gap="xl" className="mt-14 text-left">
            {pillars.map((col) => (
              <div key={col.t} className="border-t border-line pt-5">
                <h3 className="mb-2.5 text-[19px]">{col.t}</h3>
                <p className="text-[15px] text-muted">{col.d}</p>
              </div>
            ))}
          </Grid>
        </Section>

        {/* The number that matters */}
        <Section aria-label="Time to first frame">
          <SectionHeading
            title="The number that matters"
            lede="Time to first frame is the gap between pressing play and seeing the picture. It is what viewers notice, and it is hardest on a cold request, the first time a video is opened."
          />

          <div className="mt-7 max-w-[640px] space-y-4 text-[17px] leading-[1.62] text-muted">
            <p>
              A lot of speed claims are measured on the easy case, a video that
              has been watched many times and cached everywhere. The honest
              figure is the cold start, when nothing is primed and the bytes
              have the furthest to travel.
            </p>
            <p>
              That is the case Rend is built for. Rend generates the HLS
              artifacts during processing and serves them through
              Rend-controlled URLs, so the first request can return real media
              while private object-store URLs stay out of the browser.
            </p>
          </div>

          <dl className="mt-10 grid gap-px overflow-hidden rounded-[18px] border border-line bg-line sm:grid-cols-3">
            {terms.map((term) => (
              <div key={term.t} className="bg-card p-6">
                <dt className="font-head text-[17px] leading-snug text-ink">
                  {term.t}
                </dt>
                <dd className="mt-2 text-[14px] leading-[1.6] text-muted">
                  {term.d}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-10 rounded-[18px] border border-line bg-card p-6 sm:p-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-[460px]">
                <p className="font-head text-[20px] leading-snug">
                  Measure it yourself
                </p>
                <p className="mt-1 text-[14px] text-muted">
                  Upload a video, press play from wherever you are, and time the
                  first frame. That is the only benchmark worth trusting.
                </p>
              </div>
              <Button href={START_HREF} size="md" className="shrink-0">
                Upload a test video <ArrowRight />
              </Button>
            </div>
          </div>
        </Section>

        <Faq
          faqs={page.faqs}
          lede="A few questions we get about how Rend keeps playback fast."
        />

        <CtaSection title="See the first frame for yourself" />
      </main>

      <SiteFooter />
    </div>
  );
}
