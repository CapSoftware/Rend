import type { Metadata } from "next";
import Link from "next/link";
import Effects from "@/components/Effects";
import { JsonLd } from "@/components/marketing/JsonLd";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Container } from "@/components/ui/Container";
import { getMarketingPage, START_HREF } from "@/lib/marketing-pages";
import { pageMetadata } from "@/lib/seo";
import { breadcrumbLd, webPageLd } from "@/lib/structured-data";
import latest from "@/public/benchmarks/providers/latest.json";
import reference1080 from "@/public/benchmarks/providers/reference-1080p.json";

const page = getMarketingPage("/benchmarks");

export const metadata: Metadata = pageMetadata({
  title: page.title,
  description: page.description,
  path: page.path,
});

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "Benchmarks", path: "/benchmarks" },
];

// Pulled straight from the published artifact so the page never drifts from the run.
const rend = latest.summary.providers.rend;
const mux = latest.summary.providers.mux;
const rend1080 = reference1080.summary.providers.rend;
const mux1080 = reference1080.summary.providers.mux;

const runDate = new Date(latest.generatedAt).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const reference1080RunDate = new Date(reference1080.generatedAt).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const durationSeconds = Math.round(latest.source.verification.observed.rend.durationMedianSeconds);

const ms = (n: number) => `${Math.round(n).toLocaleString("en-US")} ms`;
const resOf = (rendition: string) => `${rendition.split("x")[1]}p (${rendition.replace("x", " × ")})`;
const pctSooner1080 = Math.round(
  (1 - rend1080.metrics.timeToFirstFrameMs.median / mux1080.metrics.timeToFirstFrameMs.median) * 100,
);
const browserLabel = `${latest.environment.browser.automation} ${latest.environment.browser.version}`;
const medianGapMs = Math.abs(rend.metrics.timeToFirstFrameMs.median - mux.metrics.timeToFirstFrameMs.median);
const medianLeader =
  rend.metrics.timeToFirstFrameMs.median <= mux.metrics.timeToFirstFrameMs.median ? "Rend" : "Mux";

const results = [
  {
    id: "rend",
    name: "Rend",
    firstFrame: ms(rend.metrics.timeToFirstFrameMs.median),
    played: `${rend.successfulSamples} / ${rend.sampleCount}`,
    stalls: rend.metrics.stallCount.max,
    resolution: resOf(rend.observed.selectedRendition),
  },
  {
    id: "mux",
    name: "Mux",
    firstFrame: ms(mux.metrics.timeToFirstFrameMs.median),
    played: `${mux.successfulSamples} / ${mux.sampleCount}`,
    stalls: mux.metrics.stallCount.max,
    resolution: resOf(mux.observed.selectedRendition),
  },
];

const spread = [
  { label: "Fastest sample", rend: rend.metrics.timeToFirstFrameMs.min, mux: mux.metrics.timeToFirstFrameMs.min },
  { label: "Median", rend: rend.metrics.timeToFirstFrameMs.median, mux: mux.metrics.timeToFirstFrameMs.median },
  { label: "95th percentile", rend: rend.metrics.timeToFirstFrameMs.p95, mux: mux.metrics.timeToFirstFrameMs.p95 },
  { label: "Slowest sample", rend: rend.metrics.timeToFirstFrameMs.max, mux: mux.metrics.timeToFirstFrameMs.max },
];

const reference1080Results = [
  {
    id: "rend-1080",
    name: "Rend",
    firstFrame: ms(rend1080.metrics.timeToFirstFrameMs.median),
    played: `${rend1080.successfulSamples} / ${rend1080.sampleCount}`,
    stalls: rend1080.metrics.stallCount.max,
    resolution: resOf(rend1080.observed.selectedRendition),
  },
  {
    id: "mux-1080-reference",
    name: "Mux",
    firstFrame: ms(mux1080.metrics.timeToFirstFrameMs.median),
    played: `${mux1080.successfulSamples} / ${mux1080.sampleCount}`,
    stalls: mux1080.metrics.stallCount.max,
    resolution: resOf(mux1080.observed.selectedRendition),
  },
];

const method = [
  `The same source video, ${durationSeconds} seconds long, uploaded to both Rend and Mux.`,
  `${latest.run.sampleCountTarget} samples per provider, with provider order randomized each round.`,
  "A fresh browser context for every sample: no cookies, no stored state, and the cache disabled.",
  `A ${Math.round(latest.run.watchWindowMs / 1000)} second watch window per sample, timing the first painted frame and counting any stalls.`,
  `${browserLabel}, run on a Daytona sandbox with the region set to US (Daytona picks a specific US region), the same machine for both providers.`,
  "For the headline 720p run, Rend used the production player's HLS/MSE path so the browser selected the 720p rendition.",
];

const caveats = [
  "This is one video, one region, one browser profile, and one run. It is not a universal claim about either service.",
  "We did not purge or warm any CDN. Mux serves from its own network and Rend from ours, each in whatever cache state it happened to be in.",
  "Encoders, packaging and player implementations differ between the two providers.",
  "The headline run is resolution matched at 720p, but it uses Rend's HLS/MSE path to hold that resolution; the separate native-HLS reference run below selected 1080p.",
  "The 1080p reference run is separate context and should not be averaged into the headline result.",
  "Source file identity is not independently verified beyond matching duration and observable metadata.",
];

const headCell = "border-b border-line pb-2.5 text-[13px] font-medium text-muted";
const linkClass =
  "text-ink underline decoration-accent/60 decoration-2 underline-offset-4 transition hover:decoration-accent";

export default function BenchmarksPage() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <JsonLd
        data={[
          webPageLd({ name: page.title, description: page.description, path: page.path }),
          breadcrumbLd(breadcrumbs),
        ]}
      />
      <SiteHeader />

      <main className="py-16 sm:py-20">
        <Container size="prose">
          {/* Title */}
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="h-7 w-[3px] rounded-full bg-accent" />
            <h1 className="font-head text-[clamp(28px,5vw,40px)] leading-[1.1]">Benchmarks</h1>
          </div>

          <div className="mt-7 max-w-[680px] space-y-4 text-[16px] leading-[1.65] text-ink-soft">
            <p>
              Plenty of things matter for video: quality, reliability, cost, how it holds up on a weak
              connection. Time to first frame is just one of them, the gap between opening a page and
              seeing the picture, but it is the one a viewer feels right away, so it is where we started.
              We measure it on the same source video, from a clean browser, over several randomized
              samples per provider.
            </p>
            <p>
              We built a small harness to run these in a standardized, repeatable way, and we publish the
              raw results so anyone can check them. Here is how Rend and Mux compared on the latest run.
              We will keep adding providers and regions over time.
            </p>
            <p>
              If you spot a mistake in the methodology, tell us at{" "}
              <a href="mailto:hello@rend.so" className={linkClass}>
                hello@rend.so
              </a>
              .
            </p>
          </div>

          {/* Latest results */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">Latest results</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            Time to first frame, median of {latest.run.sampleCountTarget} samples each. Last run {runDate}{" "}
            on a Daytona sandbox with the region set to US. In this run, both players selected 720p.
          </p>

          <div className="mt-6 max-w-[760px] overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>Provider</th>
                  <th scope="col" className={headCell}>First frame (median)</th>
                  <th scope="col" className={headCell}>Played</th>
                  <th scope="col" className={headCell}>Stalls</th>
                  <th scope="col" className={headCell}>Resolution</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.id} className="border-b border-line-soft last:border-0">
                    <th scope="row" className="py-4 pr-4 font-medium text-ink">
                      {row.name}
                    </th>
                    <td className="py-4 pr-4 tabular-nums text-ink">{row.firstFrame}</td>
                    <td className="py-4 pr-4 tabular-nums text-ink-soft">{row.played}</td>
                    <td className="py-4 pr-4 tabular-nums text-ink-soft">{row.stalls}</td>
                    <td className="py-4 tabular-nums text-ink-soft">{row.resolution}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-5 max-w-[680px] text-[14px] leading-[1.6] text-muted">
            Same source video ({durationSeconds} seconds). Rend selected {resOf(rend.observed.selectedRendition)}{" "}
            and Mux selected {resOf(mux.observed.selectedRendition)}, so this headline comparison is
            resolution matched. {medianLeader} reached the first frame {ms(medianGapMs)}{" "}sooner on median.
            Rend&apos;s five samples stayed between {ms(rend.metrics.timeToFirstFrameMs.min)} and{" "}
            {ms(rend.metrics.timeToFirstFrameMs.max)}, with {rend.metrics.stallCount.max} stall recorded
            across the five watch windows.
          </p>

          {/* 1080p reference */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">1080p reference run</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            We also keep a separate native-HLS Daytona run where Rend selected 1080p. It is useful context
            for startup on the production hot path at a heavier rendition, but it is not the headline 720p
            comparison above. Run date {reference1080RunDate}.
          </p>

          <div className="mt-6 max-w-[760px] overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>Provider</th>
                  <th scope="col" className={headCell}>First frame (median)</th>
                  <th scope="col" className={headCell}>Played</th>
                  <th scope="col" className={headCell}>Stalls</th>
                  <th scope="col" className={headCell}>Resolution</th>
                </tr>
              </thead>
              <tbody>
                {reference1080Results.map((row) => (
                  <tr key={row.id} className="border-b border-line-soft last:border-0">
                    <th scope="row" className="py-4 pr-4 font-medium text-ink">
                      {row.name}
                    </th>
                    <td className="py-4 pr-4 tabular-nums text-ink">{row.firstFrame}</td>
                    <td className="py-4 pr-4 tabular-nums text-ink-soft">{row.played}</td>
                    <td className="py-4 pr-4 tabular-nums text-ink-soft">{row.stalls}</td>
                    <td className="py-4 tabular-nums text-ink-soft">{row.resolution}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-5 max-w-[680px] text-[14px] leading-[1.6] text-muted">
            In that run, Rend reached first frame in {ms(rend1080.metrics.timeToFirstFrameMs.median)}{" "}
            median while serving {resOf(rend1080.observed.selectedRendition)}. Mux selected{" "}
            {resOf(mux1080.observed.selectedRendition)} and reached first frame in{" "}
            {ms(mux1080.metrics.timeToFirstFrameMs.median)} median. Both providers had zero stalls.
            Rend was about {pctSooner1080}% sooner on median in that reference run.
          </p>

          {/* Sample spread */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">How the samples spread</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            Time to first frame across every sample, fastest to slowest.
          </p>

          <div className="mt-6 max-w-[560px] overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-left text-[15px]">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>Time to first frame</th>
                  <th scope="col" className={headCell}>Rend</th>
                  <th scope="col" className={headCell}>Mux</th>
                </tr>
              </thead>
              <tbody>
                {spread.map((s) => (
                  <tr key={s.label} className="border-b border-line-soft last:border-0">
                    <th scope="row" className="py-3.5 pr-4 font-medium text-ink-soft">{s.label}</th>
                    <td className="py-3.5 pr-4 tabular-nums text-ink">{ms(s.rend)}</td>
                    <td className="py-3.5 tabular-nums text-muted">{ms(s.mux)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* How we ran it */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">How we ran it</h2>
          <ul className="mt-5 flex max-w-[680px] flex-col gap-3">
            {method.map((m) => (
              <li key={m} className="flex gap-2.5 text-[15px] leading-[1.6] text-ink-soft">
                <span aria-hidden="true" className="mt-[10px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                {m}
              </li>
            ))}
          </ul>

          {/* Caveats */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">What this does not prove</h2>
          <ul className="mt-5 flex max-w-[680px] flex-col gap-3">
            {caveats.map((c) => (
              <li key={c} className="flex gap-2.5 text-[15px] leading-[1.6] text-muted">
                <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-faint" />
                {c}
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-[680px] text-[15px] leading-[1.6] text-ink-soft">
            The benchmark we trust most is the one you run.{" "}
            <Link href={START_HREF} className={linkClass}>
              Upload a video
            </Link>{" "}
            to both services, press play from wherever you are, and time the first frame yourself.
          </p>

          {/* Raw results */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">The raw results</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            Every number on this page comes from these files, redacted of any secrets before they are
            published.
          </p>
          <p className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
            <a href={latest.artifacts.machineReadableUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              Latest summary JSON
            </a>
            <a href={latest.artifacts.rawSamplesUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              Latest raw samples
            </a>
            <a
              href={reference1080.artifacts.machineReadableUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              1080p summary JSON
            </a>
            <a
              href={reference1080.artifacts.rawSamplesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              1080p raw samples
            </a>
          </p>
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
