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
import europe from "@/public/benchmarks/providers/europe.json";
import latest from "@/public/benchmarks/providers/latest.json";
import watchStartup from "@/public/benchmarks/watch-startup/latest.json";

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
const europeRend = europe.summary.providers.rend;
const europeMux = europe.summary.providers.mux;

const runDate = new Date(latest.generatedAt).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const europeRunDate = new Date(europe.generatedAt).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const durationSeconds = Math.round(latest.source.verification.observed.rend.durationMedianSeconds);

const ms = (n: number) => `${Math.round(n).toLocaleString("en-US")} ms`;
const msDecimal = (n: number) => `${Math.round(n * 10) / 10} ms`;
const kb = (n: number) => `${Math.round(n / 1024).toLocaleString("en-US")} KB`;
const seconds = (n: number) => `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}s`;
const resOf = (rendition: string) => `${rendition.split("x")[1]}p (${rendition.replace("x", " × ")})`;
const pctSooner = Math.round((1 - rend.metrics.timeToFirstFrameMs.median / mux.metrics.timeToFirstFrameMs.median) * 100);
const europePctSooner = Math.round(
  (1 - europeRend.metrics.timeToFirstFrameMs.median / europeMux.metrics.timeToFirstFrameMs.median) * 100,
);
const browserLabel = `${latest.environment.browser.automation} ${latest.environment.browser.version}`;
const europeBrowserLabel = `${europe.environment.browser.automation} ${europe.environment.browser.version}`;
const currentNativeHls = watchStartup.localNativeHls;
const watchRunDate = new Date(watchStartup.generatedAt).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const results = [
  {
    id: "us-rend",
    region: "US",
    name: "Rend",
    firstFrame: ms(rend.metrics.timeToFirstFrameMs.median),
    played: `${rend.successfulSamples} / ${rend.sampleCount}`,
    stalls: rend.metrics.stallCount.max,
    resolution: resOf(rend.observed.selectedRendition),
  },
  {
    id: "us-mux",
    region: "US",
    name: "Mux",
    firstFrame: ms(mux.metrics.timeToFirstFrameMs.median),
    played: `${mux.successfulSamples} / ${mux.sampleCount}`,
    stalls: mux.metrics.stallCount.max,
    resolution: resOf(mux.observed.selectedRendition),
  },
  {
    id: "europe-rend",
    region: "Europe",
    name: "Rend",
    firstFrame: ms(europeRend.metrics.timeToFirstFrameMs.median),
    played: `${europeRend.successfulSamples} / ${europeRend.sampleCount}`,
    stalls: europeRend.metrics.stallCount.max,
    resolution: resOf(europeRend.observed.selectedRendition),
  },
  {
    id: "europe-mux",
    region: "Europe",
    name: "Mux",
    firstFrame: ms(europeMux.metrics.timeToFirstFrameMs.median),
    played: `${europeMux.successfulSamples} / ${europeMux.sampleCount}`,
    stalls: europeMux.metrics.stallCount.max,
    resolution: resOf(europeMux.observed.selectedRendition),
  },
];

const watchRows = watchStartup.comparison.map((row) => ({
  id: row.id,
  label: row.label,
  segment: `${seconds(row.firstSegmentDurationSeconds)} / ${kb(row.firstSegmentBytes)}`,
  firstFrame: ms(row.firstFrameMedianMs),
  segmentFetch: msDecimal(row.firstSegmentFetchMedianMs),
  firstByteToFrame: msDecimal(row.firstByteToFrameMedianMs),
}));

const playlistChecks = [
  `Master order is ${watchStartup.playlist.masterOrder.join(" -> ")}, so 1080p is available without being listed first.`,
  `Startup hints warm ${watchStartup.playlist.prefetchHints.join(" and ")} before any 1080p segment.`,
  `Both variants have ${seconds(watchStartup.playlist.variants[0].firstSegmentDurationSeconds)} first segments and #EXT-X-INDEPENDENT-SEGMENTS.`,
  `Range requests returned HTTP ${watchStartup.playlist.variants[0].rangeStatus}; repeated 720p and 1080p segment fetches were cache HITs.`,
  `Bootstrap leak scan ${watchStartup.playlist.leakScanPassed ? "passed" : "failed"}.`,
];

const daytonaStartupRows = [
  {
    region: "US",
    mode: Object.keys(watchStartup.remoteDaytona.us.modes).join(", "),
    played: watchStartup.remoteDaytona.us.success,
    firstFrame: msDecimal(watchStartup.remoteDaytona.us.firstFrame.medianMs),
    edge: Object.keys(watchStartup.remoteDaytona.us.edgeHosts).join(", "),
  },
  {
    region: "Europe",
    mode: Object.keys(watchStartup.remoteDaytona.eu.modes).join(", "),
    played: watchStartup.remoteDaytona.eu.success,
    firstFrame: msDecimal(watchStartup.remoteDaytona.eu.firstFrame.medianMs),
    edge: Object.keys(watchStartup.remoteDaytona.eu.edgeHosts).join(", "),
  },
];

const spread = [
  { region: "US", label: "Fastest sample", rend: rend.metrics.timeToFirstFrameMs.min, mux: mux.metrics.timeToFirstFrameMs.min },
  { region: "US", label: "Median", rend: rend.metrics.timeToFirstFrameMs.median, mux: mux.metrics.timeToFirstFrameMs.median },
  {
    region: "Europe",
    label: "Fastest sample",
    rend: europeRend.metrics.timeToFirstFrameMs.min,
    mux: europeMux.metrics.timeToFirstFrameMs.min,
  },
  {
    region: "Europe",
    label: "Median",
    rend: europeRend.metrics.timeToFirstFrameMs.median,
    mux: europeMux.metrics.timeToFirstFrameMs.median,
  },
];

const method = [
  `The same source video, ${durationSeconds} seconds long, uploaded to both Rend and Mux.`,
  `${latest.run.sampleCountTarget} samples per provider in each region, with provider order randomized each round.`,
  "A fresh browser context for every sample: no cookies, no stored state, and the cache disabled.",
  `A ${Math.round(latest.run.watchWindowMs / 1000)} second watch window per sample, timing the first painted frame and counting any stalls.`,
  `${browserLabel}, run on a Daytona sandbox with the region set to US for the US results.`,
  `${europeBrowserLabel}, run on a Daytona sandbox with the region set to Europe for the Europe results.`,
  "Rend is measured on its fastest production setup for this asset: the native-HLS /watch path with playback assigned from the initial page.",
];

const caveats = [
  "This is one video, one region, one browser profile, and one run. It is not a universal claim about either service.",
  "We did not purge or warm any CDN. Mux serves from its own network and Rend from ours, each in whatever cache state it happened to be in.",
  "Encoders, packaging and player implementations differ between the two providers.",
  "This is the fastest real Rend playback path, not a forced-resolution run. Rend selected 1080p and Mux selected 720p in the benchmark viewport.",
  "The Europe run used a Daytona sandbox requested in Europe; Daytona reported the sandbox target as eu.",
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
              raw results so anyone can check them. We publish the provider comparison and the current
              /watch startup guardrail separately, because native HLS and hls.js/MSE numbers should not
              be mixed. We will keep adding providers and regions over time.
            </p>
            <p>
              If you spot a mistake in the methodology, tell us at{" "}
              <a href="mailto:hello@rend.so" className={linkClass}>
                hello@rend.so
              </a>
              .
            </p>
          </div>

          {/* Watch startup guardrail */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">Latest /watch startup check</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            Fresh production upload on {watchRunDate}, after restoring ABR-first HLS startup. This is the
            native-HLS regression check for Rend&apos;s own /watch path, separate from the provider comparison
            below.
          </p>

          <div className="mt-6 max-w-[860px] overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-[15px]">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>Run</th>
                  <th scope="col" className={headCell}>First segment</th>
                  <th scope="col" className={headCell}>First frame</th>
                  <th scope="col" className={headCell}>Segment fetch</th>
                  <th scope="col" className={headCell}>First byte to frame</th>
                </tr>
              </thead>
              <tbody>
                {watchRows.map((row) => (
                  <tr key={row.id} className="border-b border-line-soft last:border-0">
                    <th scope="row" className="py-4 pr-4 font-medium text-ink">
                      {row.label}
                    </th>
                    <td className="py-4 pr-4 tabular-nums text-ink-soft">{row.segment}</td>
                    <td className="py-4 pr-4 tabular-nums text-ink">{row.firstFrame}</td>
                    <td className="py-4 pr-4 tabular-nums text-ink-soft">{row.segmentFetch}</td>
                    <td className="py-4 tabular-nums text-ink-soft">{row.firstByteToFrame}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-5 max-w-[680px] text-[14px] leading-[1.6] text-muted">
            Current native-HLS run: {currentNativeHls.successCount} / {currentNativeHls.sampleCount} samples
            played, mode{" "}
            <span className="font-mono text-ink">native_hls</span>, edge{" "}
            {Object.keys(currentNativeHls.edgeHosts).join(", ")}. Median first frame was{" "}
            {ms(currentNativeHls.firstFrame.medianMs)} with p75 {ms(currentNativeHls.firstFrame.p75Ms)};
            median first-byte-to-frame was {msDecimal(currentNativeHls.firstByteToFrame.medianMs)}.
          </p>

          <ul className="mt-5 flex max-w-[680px] flex-col gap-3">
            {playlistChecks.map((check) => (
              <li key={check} className="flex gap-2.5 text-[15px] leading-[1.6] text-ink-soft">
                <span aria-hidden="true" className="mt-[10px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                {check}
              </li>
            ))}
          </ul>

          <p className="mt-5 max-w-[680px] text-[14px] leading-[1.6] text-muted">
            Daytona checks for this same asset used hls.js/MSE rather than native HLS, so they stay out of
            the native-HLS comparison: {daytonaStartupRows.map((row) => `${row.region} ${row.played} at ${row.firstFrame}`).join("; ")}.
          </p>

          {/* Regional results */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">Regional results</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            Time to first frame, median of {latest.run.sampleCountTarget} samples per provider. The US run
            was on {runDate} in a Daytona sandbox. The Europe run was on {europeRunDate}{" "}
            in a Daytona Europe sandbox. Both use Rend&apos;s fastest production playback path.
          </p>

          <div className="mt-6 max-w-[860px] overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-[15px]">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>Region</th>
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
                    <td className="py-4 pr-4 text-ink-soft">{row.region}</td>
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
            Same source video ({durationSeconds} seconds). Rend selected native HLS at{" "}
            {resOf(rend.observed.selectedRendition)} while Mux selected{" "}
            {resOf(mux.observed.selectedRendition)} in both regional runs. In the US run, Rend reached the
            first frame about {pctSooner}% sooner on median. In the Europe run, Rend reached it about{" "}
            {europePctSooner}% sooner on median. Rend had zero stalls and zero browser network errors in
            both regions.
          </p>

          {/* Sample spread */}
          <h2 className="mt-16 font-head text-[22px] leading-snug">How the samples spread</h2>
          <p className="mt-2 max-w-[680px] text-[15px] leading-[1.6] text-muted">
            Time to first frame for the fastest sample and median in each region.
          </p>

          <div className="mt-6 max-w-[680px] overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>Region</th>
                  <th scope="col" className={headCell}>Time to first frame</th>
                  <th scope="col" className={headCell}>Rend</th>
                  <th scope="col" className={headCell}>Mux</th>
                </tr>
              </thead>
              <tbody>
                {spread.map((s) => (
                  <tr key={`${s.region}-${s.label}`} className="border-b border-line-soft last:border-0">
                    <td className="py-3.5 pr-4 text-ink-soft">{s.region}</td>
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
              US summary JSON
            </a>
            <a href={latest.artifacts.rawSamplesUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              US raw samples
            </a>
            <a
              href={europe.artifacts.machineReadableUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Europe summary JSON
            </a>
            <a
              href={europe.artifacts.rawSamplesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Europe raw samples
            </a>
          </p>
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
