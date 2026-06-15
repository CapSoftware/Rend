import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import Effects from "@/components/Effects";
import { ComparisonTable } from "@/components/marketing/ComparisonTable";
import { features } from "@/components/marketing/feature-data";
import { ArrowRight, GitHubMark } from "@/components/marketing/Icons";
import { JsonLd } from "@/components/marketing/JsonLd";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Container } from "@/components/ui/Container";
import { Grid } from "@/components/ui/Grid";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { GITHUB_URL, START_HREF } from "@/lib/marketing-pages";
import { organizationLd, websiteLd } from "@/lib/structured-data";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
};

function LearnMore({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group mt-7 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink underline decoration-accent/70 decoration-2 underline-offset-4 transition hover:decoration-accent"
    >
      {children} <ArrowRight />
    </Link>
  );
}

/* ---------------------------------- Page ---------------------------------- */

export default function Home() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd data={[organizationLd(), websiteLd()]} />
      <SiteHeader />

      <main>
        {/* ------------------------------- Hero ------------------------------- */}
        <section className="relative pb-16 pt-12 sm:pt-14 md:pb-20 md:pt-20">
          <Container size="wide">
            <div className="max-w-[800px]">
              <h1 className="animate-rise text-[clamp(32px,7vw,56px)] leading-[1.06] tracking-[-0.02em] sm:leading-[1.04]">
                Video infrastructure, built for speed
              </h1>

              <div className="animate-rise animate-rise-2 mt-6 max-w-[660px] space-y-4 font-mono text-[14.5px] leading-[1.75] text-ink-soft sm:mt-7">
                <p>
                  Rend is the video platform for developers.{" "}
                  <strong className="font-semibold text-ink">One API call</strong> to upload, one
                  playback URL that <strong className="font-semibold text-ink">starts fast</strong>.
                  Encoding, storage and delivery, handled for you.
                </p>
                <p>
                  Rend warms the opening bytes of each video onto{" "}
                  <strong className="font-semibold text-ink">edge-local RAM and NVMe/SSD</strong>,
                  close to your viewers, so playback can start with{" "}
                  <Link
                    href="/performance"
                    className="text-ink underline decoration-accent/70 decoration-2 underline-offset-2 transition hover:decoration-accent"
                  >
                    fewer round trips
                  </Link>{" "}
                  even on a cold request. Rend is{" "}
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink underline decoration-accent/70 decoration-2 underline-offset-2 transition hover:decoration-accent"
                  >
                    open source
                  </a>
                  {", so you can inspect the stack and run it on your own infrastructure."}
                </p>
              </div>

              <div className="animate-rise animate-rise-3 mt-8 flex flex-col gap-3 sm:flex-row">
                <Button href={START_HREF} size="lg" className="w-full sm:w-auto">
                  Get started <ArrowRight />
                </Button>
                <Button href="/docs" size="lg" variant="secondary" className="w-full sm:w-auto">
                  Read the quickstart
                </Button>
              </div>
            </div>
          </Container>
        </section>

        {/* ------------------------------- Features ------------------------------- */}
        <Section id="features" tone="sunken" aria-label="What Rend does">
          <SectionHeading
            title="Everything a video platform should be"
            lede="The hard parts of video: encoding, cold starts, global delivery, pricing. Handled for you, so you can ship."
          />
          <div className="mt-12 grid grid-cols-1 gap-4 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Card key={f.id} className="reveal flex flex-col p-6 sm:p-7">
                {f.icon}
                <h3 className="mb-2 mt-5 text-[21px]">{f.title}</h3>
                <p className="text-[15px] text-muted">{f.body}</p>
              </Card>
            ))}
          </div>
          <LearnMore href="/features">Explore all features</LearnMore>
        </Section>

        {/* ------------------------------- Speed / performance ------------------------------- */}
        <Section id="performance" aria-label="Why Rend is fast">
          <svg
            className="sketch mb-7 block h-20 w-28 overflow-visible"
            viewBox="0 0 150 110"
            role="img"
            aria-label="Video streams in from origin to an edge node near your viewer, and the first frames hop from there to the screen."
          >
            {/* viewer screen */}
            <path d="M16 36 C30 34 46 34 56 36 C58 48 58 68 56 80 C46 82 30 82 16 80 C14 68 14 48 16 36" />
            <path d="M30 48 L46 58 L30 68 Z" />
            {/* edge node, with the warmed opener loaded */}
            <path d="M80 44 C88 42 100 42 108 44 C110 52 110 64 108 72 C100 74 88 74 80 72 C78 64 78 52 80 44" />
            <path d="M90 52 L100 58 L90 64 Z" style={{ fill: "var(--color-ink)", stroke: "none" }} />
            <path className="anim-twinkle" d="M95 28 L95 38 M90 33 L100 33" />
            {/* origin streaming into the edge */}
            <path className="anim-zip" d="M120 50 L134 49" />
            <path className="anim-zip z2" d="M124 60 L138 60" />
            <path className="anim-zip z3" d="M120 70 L134 71" />
            {/* edge -> viewer */}
            <path id="p-ev" d="M78 60 C70 62 66 60 60 60" />
            {/* first frame hops to the screen */}
            <circle className="dot" r="4">
              <animateMotion dur="2.2s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.28;1">
                <mpath href="#p-ev" />
              </animateMotion>
              <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.05;0.26;0.36;1" dur="2.2s" repeatCount="indefinite" />
            </circle>
          </svg>

          <SectionHeading
            title="Why it's fast"
            lede="When a video feels slow, it's rarely the server. It's the round trips across the internet before the first frame can show. Rend keeps those trips few and short, starting playback from the edge nearest your viewer instead of a trip back to distant storage."
          />

          <Grid cols={3} gap="xl" className="mt-14 text-left">
            {[
              {
                t: "Bare-metal edge, not shared functions",
                d: "Rend Cloud runs on bare-metal nodes in the regions we operate. The hottest bytes live in edge-local RAM and NVMe, with durable object storage sitting behind the cache.",
              },
              {
                t: "First bytes already at the edge",
                d: "The opening seconds of each video are warmed onto edge-local memory and NVMe, close to your viewers, so startup takes the shortest path we have instead of a trip back to origin.",
              },
              {
                t: "Ready before anyone presses play",
                d: "Rend builds a small opener at upload and pushes it to the edge ahead of the first viewer. That first request can return real frames while the rest of the video streams in behind it.",
              },
            ].map((col) => (
              <div key={col.t} className="border-t border-line pt-5">
                <h3 className="mb-2.5 text-[19px]">{col.t}</h3>
                <p className="text-[15px] text-muted">{col.d}</p>
              </div>
            ))}
          </Grid>
          <LearnMore href="/performance">See why Rend is fast</LearnMore>
        </Section>

        {/* ------------------------------- Open source ------------------------------- */}
        <Section id="open-source" tone="sunken" aria-label="Open source">
          <svg
            className="sketch mb-7 block h-20 w-20 overflow-visible"
            viewBox="0 0 120 120"
            role="img"
            aria-label="An open padlock. Every line of Rend is open to read and run."
          >
            {/* lock body */}
            <path d="M38 56 C52 54 68 54 82 56 C84 70 84 90 82 104 C68 106 52 106 38 104 C36 90 36 70 38 56" />
            {/* keyhole */}
            <path d="M60 73 C63 73 65 75 65 78 C65 81 63 83 60 83 C57 83 55 81 55 78 C55 75 57 73 60 73" />
            <path d="M60 82 L60 92" />
            {/* shackle, swung open */}
            <path d="M48 56 L48 40 C48 27 58 21 68 21 C77 21 84 25 87 33" />
            {/* it's open */}
            <path className="anim-twinkle" d="M98 26 L98 36 M93 31 L103 31" />
            <path className="anim-twinkle t2" d="M28 40 L28 48 M24 44 L32 44" />
          </svg>

          <SectionHeading
            title="Read every line"
            lede="The server is AGPL; the player and SDKs are MIT, and it's the exact code that runs Rend Cloud. Host the whole thing yourself for free, or fork it and make it your own."
          />
          <p className="mt-5 max-w-[620px] text-[17px] leading-[1.6] text-muted">
            It installs as one binary, with no database to set up and nothing phoning home. We don&apos;t
            charge for the software. We charge for the network that makes it fast.
          </p>

          <div className="mt-8 flex flex-wrap gap-2.5">
            <Badge>Server <span className="text-faint">AGPL</span></Badge>
            <Badge>Player &amp; SDKs <span className="text-faint">MIT</span></Badge>
            <Badge>Self-host <span className="text-faint">Free forever</span></Badge>
          </div>

          <div className="mt-7 max-w-[560px]">
            <p className="mb-2 text-[13px] text-faint">Self-host it in one command</p>
            <code className="block overflow-x-auto rounded-xl border border-line bg-card px-4 py-3 font-mono text-[13.5px] text-ink">
              docker run rend --domain video.yoursite.com
            </code>
          </div>

          <div className="mt-8">
            <Button href={GITHUB_URL} external variant="secondary" size="md">
              <GitHubMark />
              Star on GitHub
            </Button>
          </div>
        </Section>

        {/* ------------------------------- Comparison ------------------------------- */}
        <Section aria-label="How Rend compares">
          <SectionHeading
            title="How Rend compares"
            lede="Two prices: seconds delivered and storage kept, both by resolution. Higher resolution is just more data to move and keep. Here's how that compares to the usual ways of paying for video."
          />

          <ComparisonTable />

          <p className="mt-6 max-w-[680px] text-[13px] text-faint">
            The other three columns are broad strokes for how each kind of platform usually bills and
            runs, not a quote from any one vendor. Rend&apos;s own rates are listed live in the
            dashboard.
          </p>
          <LearnMore href="/compare">See the full comparison</LearnMore>
        </Section>

        {/* ------------------------------- Pricing ------------------------------- */}
        <Section id="pricing" tone="sunken" aria-label="Pricing">
          <SectionHeading
            title="Simple, flexible pricing"
            lede="No per-minute fees and no egress surprises. You pay for two things: what's delivered and what's stored, priced by resolution. Encoding is always included."
          />

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="p-7">
              <span className="mb-5 grid h-10 w-10 place-items-center rounded-full border border-line text-ink">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5.5l11 6.5-11 6.5z" />
                </svg>
              </span>
              <h3 className="text-[20px]">Delivery</h3>
              <p className="mt-2 text-[15px] text-muted">
                Per second streamed, by resolution from 720p to 4K. You only pay when someone actually
                watches.
              </p>
            </Card>
            <Card className="p-7">
              <span className="mb-5 grid h-10 w-10 place-items-center rounded-full border border-line text-ink">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <ellipse cx="12" cy="6" rx="7" ry="3" />
                  <path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
                  <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
                </svg>
              </span>
              <h3 className="text-[20px]">Storage</h3>
              <p className="mt-2 text-[15px] text-muted">
                Per second-month you keep a video. Higher resolutions are larger files, so they cost a
                bit more to store. Delete an asset and the meter stops, no minimum commitment.
              </p>
            </Card>
            <Card className="p-7">
              <span className="mb-5 grid h-10 w-10 place-items-center rounded-full border border-line text-ink">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l9 5-9 5-9-5 9-5z" />
                  <path d="M3 13l9 5 9-5" />
                </svg>
              </span>
              <h3 className="text-[20px]">Encoding</h3>
              <p className="mt-2 text-[15px] text-muted">
                Included, every time. We transcode each upload into the renditions players need, and it
                never shows up on the bill.
              </p>
            </Card>
          </div>

          <div className="mt-4 rounded-[18px] border border-line bg-card p-6 sm:p-7">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-head text-[20px] leading-snug">Start free, scale when you need to</p>
                <p className="mt-1 text-[14px] text-muted">
                  Pay as you go from zero, or pick a plan with monthly credits included. Move between
                  tiers whenever you like, with no lock-in and no minimum.
                </p>
              </div>
              <Button href={START_HREF} variant="secondary" size="md" className="shrink-0">
                See live rates
              </Button>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { name: "Pay as you go", credit: "$0" },
                { name: "Builder", credit: "$100" },
                { name: "Scale", credit: "$1,000" },
                { name: "Enterprise", credit: "$10k+" },
              ].map((tier) => (
                <div key={tier.name} className="rounded-xl border border-line-soft bg-bg-sunken/50 px-4 py-3.5">
                  <p className="text-[12.5px] text-muted">{tier.name}</p>
                  <p className="mt-1 font-head text-[22px] leading-none text-ink">{tier.credit}</p>
                  <p className="mt-1.5 text-[11px] text-faint">included credits</p>
                </div>
              ))}
            </div>
          </div>
          <LearnMore href="/pricing">See how pricing works</LearnMore>
        </Section>

        {/* ------------------------------- Cap case study ------------------------------- */}
        <Section aria-label="Built by the team behind Cap">
          <img src="/cap-logo.svg" alt="Cap" className="mb-6 h-8 w-auto sm:h-9" />
          <h2 className="text-[clamp(27px,5.6vw,44px)] leading-[1.12] sm:leading-[1.08]">Built by the team behind Cap</h2>
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.6] text-muted">
            We didn&apos;t set out to sell video infrastructure. We built Rend because Cap, our open
            source screen recorder, needed the fastest video infrastructure we could possibly build.
            Hundreds of thousands of people record with Cap, and every one of those videos has to be
            stored and served fast: petabytes of footage, played back the instant someone opens a share
            link.
          </p>
          <p className="mt-4 max-w-[640px] text-[17px] leading-[1.6] text-muted">
            Cap runs entirely on Rend.
          </p>
          <div className="mt-8 flex flex-col items-start">
            <Button href="https://cap.so" external variant="secondary" size="md">
              Visit Cap
            </Button>
            <LearnMore href="/about">Read our story</LearnMore>
          </div>
        </Section>

        {/* ------------------------------- Final CTA ------------------------------- */}
        <Section tone="ink" container={false} aria-label="Start in production" className="overflow-hidden">
          <div aria-hidden="true" className="bg-line-grid pointer-events-none absolute inset-0 opacity-[0.06]" />
          <Container size="wide" className="relative">
            <h2 className="max-w-[640px] text-[clamp(29px,7vw,52px)] leading-[1.06] text-bg sm:leading-[1.05]">
              Start shipping video today
            </h2>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={START_HREF} size="lg" variant="inverse" className="w-full sm:w-auto">
                Open the dashboard <ArrowRight />
              </Button>
              <Button href="/docs" size="lg" variant="inverse-outline" className="w-full sm:w-auto">
                Read the docs
              </Button>
            </div>
          </Container>
        </Section>
      </main>

      <SiteFooter />
    </div>
  );
}
