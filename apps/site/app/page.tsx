import type { Metadata } from "next";
import Effects from "@/components/Effects";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
};

type CmpCell = { kind: "yes" | "no" | "mid" } | { kind: "text"; value: string };

const cmpColumns = [
  "Rend",
  "Minute-billed platforms",
  "Budget per-GB CDNs",
  "Roll your own",
];

const cmpRows: { feature: string; cells: CmpCell[] }[] = [
  {
    feature: "Pricing model",
    cells: [
      { kind: "text", value: "Delivery + storage by resolution" },
      { kind: "text", value: "Per minute, plus tiers" },
      { kind: "text", value: "Per GB, by region" },
      { kind: "text", value: "Whatever the bill says" },
    ],
  },
  {
    feature: "Plans",
    cells: [
      { kind: "text", value: "PAYG, Builder, Scale, Enterprise" },
      { kind: "text", value: "Monthly bundles" },
      { kind: "text", value: "Usage commitments" },
      { kind: "text", value: "Your own budget" },
    ],
  },
  {
    feature: "Included credits",
    cells: [
      { kind: "text", value: "$0, $100, $1k, or $10k" },
      { kind: "text", value: "Varies by plan" },
      { kind: "text", value: "Usually none" },
      { kind: "text", value: "None" },
    ],
  },
  {
    feature: "1080p delivery",
    cells: [
      { kind: "text", value: "1080p delivered seconds" },
      { kind: "text", value: "Higher per minute" },
      { kind: "text", value: "Per GB streamed" },
      { kind: "text", value: "Egress $50–90 / TB" },
    ],
  },
  {
    feature: "4K delivery",
    cells: [
      { kind: "text", value: "4K delivered seconds" },
      { kind: "text", value: "Premium minute tier" },
      { kind: "text", value: "Per GB streamed" },
      { kind: "text", value: "Bitrate-dependent" },
    ],
  },
  {
    feature: "Storage",
    cells: [
      { kind: "text", value: "Tiered second-months" },
      { kind: "text", value: "Per stored minute" },
      { kind: "text", value: "Per GB stored" },
      { kind: "text", value: "You run the disks" },
    ],
  },
  {
    feature: "Encoding included",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "no" }],
  },
  {
    feature: "Instant start on cold video",
    cells: [{ kind: "yes" }, { kind: "mid" }, { kind: "no" }, { kind: "no" }],
  },
  {
    feature: "Open source",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "yes" }],
  },
  {
    feature: "Self-host, free forever",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "yes" }],
  },
  {
    feature: "Runs on owned bare metal",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "mid" }, { kind: "no" }],
  },
  {
    feature: "Agent-native, MCP + llms.txt",
    cells: [{ kind: "yes" }, { kind: "mid" }, { kind: "no" }, { kind: "no" }],
  },
  {
    feature: "Measured in public",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "no" }],
  },
];

function CmpMark({ kind }: { kind: "yes" | "no" | "mid" }) {
  if (kind === "yes") {
    return (
      <svg className="cmp-mark cmp-yes" viewBox="0 0 24 24" role="img" aria-label="Yes">
        <path pathLength={1} d="M4 13 C7 15 9 17 11 20 C14 12 17 7 21 4" />
      </svg>
    );
  }
  if (kind === "no") {
    return (
      <svg className="cmp-mark cmp-no" viewBox="0 0 24 24" role="img" aria-label="No">
        <path pathLength={1} d="M6 6 C10 10 14 14 18 18" />
        <path pathLength={1} d="M18 6 C14 10 10 14 6 18" />
      </svg>
    );
  }
  return (
    <svg className="cmp-mark cmp-mid" viewBox="0 0 24 24" role="img" aria-label="Partial">
      <path pathLength={1} d="M4 13 C7 9 10 9 12 13 C14 17 17 17 20 13" />
    </svg>
  );
}

function renderCmpCell(cell: CmpCell) {
  if (cell.kind === "text") return <span>{cell.value}</span>;
  return <CmpMark kind={cell.kind} />;
}

export default function Home() {
  return (
    <>
      <Effects />

      <header className="mx-auto flex max-w-[1080px] items-center justify-between px-6 py-[26px]">
        <div className="flex flex-col items-start gap-0.5">
          <a href="#" aria-label="Rend home">
            <img src="/rend-logo.svg" alt="Rend" className="block h-[38px] w-auto" />
          </a>
          <a
            href="https://cap.so"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 flex items-center gap-[5px] text-[9px] font-medium leading-none text-muted transition hover:text-ink"
          >
            A
            <img src="/cap-logo.svg" alt="Cap" className="block h-[11px] w-auto" />
            company
          </a>
        </div>
        <nav className="flex items-center gap-3" aria-label="Primary navigation">
          <a
            href="/docs"
            className="text-sm font-medium text-muted transition hover:text-ink"
          >
            Docs
          </a>
          <a
            href="/login?next=%2Fdashboard%2Fassets"
            className="rounded-full bg-ink px-[18px] py-[9px] text-sm font-medium text-bg transition hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(22,21,19,0.18)]"
          >
            Start with email
          </a>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-[760px] px-6 pb-16 pt-[64px] text-center sm:pb-20 sm:pt-[92px]">
          <h1 className="mb-7 text-[clamp(33px,8.5vw,62px)]">
            Video infrastructure, built for{" "}
            <span className="relative inline-block whitespace-nowrap">
              speed
              <svg className="squiggle absolute -bottom-3 left-0 w-full overflow-visible" viewBox="0 0 240 20" aria-hidden="true">
                <path pathLength={1} d="M4 14 C40 5 80 16 120 8 C160 1 200 13 236 6" />
              </svg>
            </span>
          </h1>
          <p className="mx-auto mb-9 max-w-[640px] text-lg text-muted">
            Rend is the video platform for developers. One API call to upload, one URL
            that plays instantly anywhere in the world. Encoding, storage, and delivery,
            all on hardware we own. And we&apos;re open source.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="/login?next=%2Fdashboard%2Fassets"
              className="rounded-full bg-ink px-5 py-3 text-sm font-medium text-bg transition hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(22,21,19,0.18)]"
            >
              Start with email
            </a>
            <a
              href="/docs"
              className="rounded-full border border-line bg-card px-5 py-3 text-sm font-medium text-ink transition hover:-translate-y-px hover:border-ink"
            >
              Read the quickstart
            </a>
          </div>
        </section>

        <section
          className="mx-auto grid max-w-[1080px] grid-cols-1 gap-4 px-6 pb-20 md:grid-cols-2 md:pb-[110px] lg:grid-cols-3"
          aria-label="What Rend does"
        >
          <article className="card reveal md:col-span-2">
            <svg className="sketch mb-5 block h-[82px] w-24 overflow-visible" viewBox="0 0 140 120" aria-hidden="true">
              <g className="anim-drop">
                <path d="M70 16 C68 30 71 42 69 56" />
                <path d="M56 45 C60 50 65 55 69 59" />
                <path d="M83 44 C79 50 74 55 69 59" />
              </g>
              <path d="M26 70 C24 79 24 89 27 98 C53 102 88 102 113 98 C115 88 115 78 113 70" />
              <path className="anim-twinkle" d="M104 24 L104 36 M98 30 L110 30" />
              <path className="anim-twinkle t2" d="M34 28 L34 38 M29 33 L39 33" />
            </svg>
            <h3 className="mb-2.5 text-[21px]">One call in, one link out</h3>
            <p className="text-[15px] text-muted">
              Send a video with a single API call and get back a link that plays anywhere. No pipeline to build, no settings to study.
            </p>
          </article>

          <article className="card reveal">
            <svg className="sketch mb-5 block h-[82px] w-24 overflow-visible" viewBox="0 0 140 120" aria-hidden="true">
              <path d="M70 18 C94 16 112 36 110 60 C108 85 90 102 68 101 C45 100 29 82 30 58 C31 35 47 20 70 18" />
              <path className="anim-pulse" d="M60 42 C59 53 59 65 61 77 C70 71 80 65 89 59 C79 53 69 47 60 42" />
              <path className="anim-zip" d="M8 38 L23 39" />
              <path className="anim-zip z2" d="M2 58 L19 58" />
              <path className="anim-zip z3" d="M8 78 L23 77" />
            </svg>
            <h3 className="mb-2.5 text-[21px]">No waiting, ever</h3>
            <p className="text-[15px] text-muted">
              Every video starts right away, even one nobody has watched in months, from anywhere in the world.
            </p>
          </article>

          <article className="card reveal">
            <svg className="sketch mb-5 block h-[82px] w-24 overflow-visible" viewBox="0 0 140 120" aria-hidden="true">
              <g className="anim-swing">
                <path d="M62 20 C75 21 88 23 100 26 C102 38 103 51 103 63 C92 76 81 88 69 99 C56 87 43 75 31 62 C41 48 51 34 62 20" />
                <path d="M67 36 C71 33 76 36 76 41 C76 46 71 49 67 46 C63 43 63 39 67 36" />
                <path d="M73 39 C87 30 102 22 117 17" />
                <path d="M56 62 L84 64" />
                <path d="M53 74 L77 76" />
              </g>
            </svg>
            <h3 className="mb-2.5 text-[21px]">Two prices, no surprises</h3>
            <p className="text-[15px] text-muted">
              You pay for minutes watched and minutes stored. That is the whole bill, simple enough to work out in your head.
            </p>
          </article>

          <article className="card reveal">
            <svg className="sketch mb-5 block h-[82px] w-24 overflow-visible" viewBox="0 0 140 120" aria-hidden="true">
              <path d="M17 30 C50 26 92 26 123 30 C126 50 126 72 123 92 C90 96 50 96 17 92 C14 72 14 50 17 30" />
              <path d="M16 44 L124 44" />
              <path d="M30 58 L44 66 L30 74" />
              <path className="anim-blink" d="M52 75 L66 75" />
              <path className="anim-beat" d="M96 60 C92 52 80 54 80 64 C80 72 90 78 96 82 C102 78 112 72 112 64 C112 54 100 52 96 60" />
            </svg>
            <h3 className="mb-2.5 text-[21px]">Yours to run, free forever</h3>
            <p className="text-[15px] text-muted">
              All the code is open for anyone to read and use. Run Rend on your own machine, and it keeps working even if we vanish.
            </p>
          </article>

          <article className="card reveal">
            <svg className="sketch mb-5 block h-[82px] w-24 overflow-visible" viewBox="0 0 140 120" aria-hidden="true">
              <path d="M38 40 C52 39 63 50 62 64 C61 78 52 89 38 88 C24 87 14 78 14 64 C14 50 24 41 38 40" />
              <g className="anim-eyes">
                <path d="M30 58 L30 63" />
                <path d="M46 58 L46 63" />
              </g>
              <path d="M28 71 C32 77 44 77 48 71" />
              <path d="M82 46 C94 44 110 44 122 46 C124 58 124 72 122 84 C110 86 94 86 82 84 C80 72 80 58 82 46" />
              <path d="M102 44 L102 33" />
              <path className="anim-twinkle" d="M102 26 C104 26 105 28 104 30 C103 32 100 31 100 29 C100 27 101 26 102 26" />
              <g className="anim-eyes e2">
                <path d="M94 60 L94 65" />
                <path d="M110 60 L110 65" />
              </g>
              <path d="M94 74 L110 74" />
            </svg>
            <h3 className="mb-2.5 text-[21px]">Easy for people, easy for AI</h3>
            <p className="text-[15px] text-muted">
              The whole guide fits on one short page, clear enough that you, or the AI helping you build, get it right on the first try.
            </p>
          </article>

          <article className="card reveal flex flex-col items-start md:col-span-2 lg:col-span-3 sm:flex-row sm:items-center sm:gap-9">
            <svg className="sketch mb-5 block h-[82px] w-24 shrink-0 overflow-visible sm:mb-0" viewBox="0 0 140 120" aria-hidden="true">
              <path d="M21 16 C20 40 20 70 22 100 C55 103 95 103 131 100" />
              <path id="speedline" d="M30 30 C46 35 60 52 76 66 C92 79 110 85 126 87" />
              <circle className="dot" r={4}>
                <animateMotion dur="3s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.6;1">
                  <mpath href="#speedline" />
                </animateMotion>
                <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.06;0.62;0.72;1" dur="3s" repeatCount="indefinite" />
              </circle>
              <path className="anim-twinkle" d="M112 24 L112 34 M107 29 L117 29" />
            </svg>
            <div>
              <h3 className="mb-2.5 text-[21px]">Speed you can check</h3>
              <p className="text-[15px] text-muted">
                We measure how fast videos start, around the world, side by side with the big names, and publish the results live. Including the places where we are not the fastest yet.
              </p>
            </div>
          </article>
        </section>

        <section className="reveal mx-auto max-w-[880px] px-6 pb-20 text-center md:pb-[110px]">
          <h2 className="mb-[18px] text-[clamp(27px,6vw,42px)]">Why it&apos;s fast</h2>
          <p className="mx-auto mb-14 max-w-[620px] text-[17px] text-muted">
            When a video feels slow, the server is rarely the problem. Almost all of the wait
            is messages crossing the internet, back and forth, before the first frame can show.
            Rend is built around one idea: make fewer trips, and make them short.
          </p>

          <div className="mx-auto mb-16 flex max-w-[640px] flex-col gap-7 text-left" aria-label="Round trips compared">
            <div className="flex flex-col items-start gap-4 rounded-[18px] border border-line bg-card px-[26px] py-[22px] sm:flex-row sm:items-center sm:gap-7">
              <div className="flex flex-col gap-0.5 sm:w-[190px] sm:shrink-0">
                <strong className="font-head text-lg font-normal">Most video platforms</strong>
                <span className="text-[13.5px] leading-[1.45] text-muted">Four or five trips before the first frame shows</span>
              </div>
              <svg className="race-svg h-auto w-full min-w-0 sm:flex-1" viewBox="0 0 340 80" aria-hidden="true">
                <path d="M22 16 C30 14 38 15 42 17 C44 32 44 50 42 64 C34 66 26 66 22 64 C20 49 20 31 22 16" />
                <path d="M28 32 C28 36 28 40 28 44 C31 42 34 40 37 38 C34 36 31 34 28 32" />
                <path d="M298 16 C306 14 314 15 320 17 C322 32 322 50 320 64 C312 66 304 66 298 64 C296 49 296 31 298 16" />
                <path d="M303 28 L315 28" />
                <path d="M303 40 L315 40" />
                <path d="M303 52 L315 52" />
                <path d="M58 20 C130 18 210 21 284 20" />
                <path d="M277 15 L285 20 L277 25" />
                <path d="M284 34 C210 35 130 33 60 34" />
                <path d="M67 29 L59 34 L67 39" />
                <path d="M58 48 C130 46 210 49 284 48" />
                <path d="M277 43 L285 48 L277 53" />
                <path d="M284 62 C210 63 130 61 60 62" />
                <path d="M67 57 L59 62 L67 67" />
                <path
                  id="trip-many"
                  d="M58 20 C130 18 210 21 284 20 L284 34 C210 35 130 33 60 34 L60 48 C130 46 210 49 284 48 L284 62 C210 63 130 61 60 62"
                  fill="none"
                  stroke="none"
                />
                <circle className="dot" r={4.5}>
                  <animateMotion dur="4s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.88;1">
                    <mpath href="#trip-many" />
                  </animateMotion>
                  <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.03;0.88;0.94;1" dur="4s" repeatCount="indefinite" />
                </circle>
              </svg>
            </div>
            <div className="flex flex-col items-start gap-4 rounded-[18px] border border-line bg-card px-[26px] py-[22px] sm:flex-row sm:items-center sm:gap-7">
              <div className="flex flex-col gap-0.5 sm:w-[190px] sm:shrink-0">
                <strong className="font-head text-lg font-normal">Rend</strong>
                <span className="text-[13.5px] leading-[1.45] text-muted">One trip. The first bytes are already nearby</span>
              </div>
              <svg className="race-svg h-auto w-full min-w-0 sm:flex-1" viewBox="0 0 340 80" aria-hidden="true">
                <path d="M22 16 C30 14 38 15 42 17 C44 32 44 50 42 64 C34 66 26 66 22 64 C20 49 20 31 22 16" />
                <path d="M28 32 C28 36 28 40 28 44 C31 42 34 40 37 38 C34 36 31 34 28 32" />
                <path d="M298 16 C306 14 314 15 320 17 C322 32 322 50 320 64 C312 66 304 66 298 64 C296 49 296 31 298 16" />
                <path d="M303 28 L315 28" />
                <path d="M303 40 L315 40" />
                <path d="M303 52 L315 52" />
                <path d="M58 40 C130 38 210 41 284 40" />
                <path d="M277 35 L285 40 L277 45" />
                <path id="trip-one" d="M58 40 C130 38 210 41 284 40" fill="none" stroke="none" />
                <circle className="dot" r={4.5}>
                  <animateMotion dur="4s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.18;1">
                    <mpath href="#trip-one" />
                  </animateMotion>
                  <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.03;0.88;0.94;1" dur="4s" repeatCount="indefinite" />
                </circle>
              </svg>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-7 text-left md:grid-cols-3 md:gap-10">
            <div className="border-t border-line pt-[22px]">
              <h3 className="mb-2.5 text-[19px]">Bare metal, not rented cloud</h3>
              <p className="text-[15px] text-muted">
                Rend is being built on machines we own, in the cities where viewers actually are. No cloud provider sits between our disks and your viewers, so nothing gets metered, throttled, or marked up along the way.
              </p>
            </div>
            <div className="border-t border-line pt-[22px]">
              <h3 className="mb-2.5 text-[19px]">First bytes straight from NVMe</h3>
              <p className="text-[15px] text-muted">
                The opening seconds of every video sit in memory and on NVMe flash on every machine. Owning the drives means unlimited IOPS: no quotas, no burst credits, no waiting for storage to wake up.
              </p>
            </div>
            <div className="border-t border-line pt-[22px]">
              <h3 className="mb-2.5 text-[19px]">Ready before anyone presses play</h3>
              <p className="text-[15px] text-muted">
                At upload, a small opener of every video is copied to every location. The first request returns real frames in a single trip, while the rest of the video streams in behind it.
              </p>
            </div>
          </div>
        </section>

        <section className="reveal mx-auto max-w-[880px] px-6 pb-20 text-center md:pb-[110px]" aria-label="Open source">
          <svg className="sketch mx-auto mb-7 block h-[118px] w-auto overflow-visible" viewBox="0 0 160 150" aria-hidden="true">
            <g className="anim-unlock">
              <path d="M60 70 L60 50 C60 30 100 30 100 50 L100 70" />
            </g>
            <path d="M44 70 C44 67 46 65 49 65 L111 65 C114 65 116 67 116 70 L116 124 C116 127 114 129 111 129 L49 129 C46 129 44 127 44 124 Z" />
            <path d="M80 84 C84 84 87 87 87 91 C87 94 85 96 82 97 L85 112 L75 112 L78 97 C73 96 73 88 80 84" />
            <path className="anim-twinkle" d="M128 44 L128 56 M122 50 L134 50" />
            <path className="anim-twinkle t2" d="M30 92 L30 102 M25 97 L35 97" />
          </svg>
          <h2 className="mb-[18px] text-[clamp(27px,6vw,42px)]">Open source, all the way down</h2>
          <p className="mx-auto mb-11 max-w-[640px] text-[17px] text-muted">
            Every line of Rend is out in the open. The server is AGPL, the player and SDKs are
            MIT. Read it, change it, and run the whole thing on your own machines, free forever.
            The only thing we sell is the network we run it on.
          </p>

          <div className="mx-auto mb-9 max-w-[620px] overflow-hidden rounded-[16px] border border-line bg-card text-left">
            <div className="flex items-center gap-2 border-b border-line px-[18px] py-3">
              <span className="block h-[11px] w-[11px] rounded-full border border-line" />
              <span className="block h-[11px] w-[11px] rounded-full border border-line" />
              <span className="block h-[11px] w-[11px] rounded-full border border-line" />
              <span className="ml-2 text-[12px] text-muted">your-server</span>
            </div>
            <pre className="overflow-x-auto px-4 py-[18px] font-mono text-[12px] leading-[2] sm:px-[22px] sm:py-[20px] sm:text-[13.5px]">
              <code>
                <span className="text-muted">{"$ "}</span>docker run rend --domain video.yoursite.com{"\n"}
                <span className="text-muted">{"# upload · encode · mux · store · sign · deliver"}</span>{"\n"}
                <span className="text-muted">{"# dashboard, API and player included. nothing else."}</span>
              </code>
            </pre>
          </div>

          <div className="mb-12 flex flex-wrap justify-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-[14px] py-[7px] text-[13px] font-medium">
              Server <span className="text-muted">AGPL</span>
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-[14px] py-[7px] text-[13px] font-medium">
              Player &amp; SDKs <span className="text-muted">MIT</span>
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-[14px] py-[7px] text-[13px] font-medium">
              Self-host <span className="text-muted">Free forever</span>
            </span>
          </div>

          <div className="grid grid-cols-1 gap-7 text-left md:grid-cols-3 md:gap-10">
            <div className="border-t border-line pt-[22px]">
              <h3 className="mb-2.5 text-[19px]">One binary, no dependencies</h3>
              <p className="text-[15px] text-muted">
                No managed database, no queue account, no analytics service, no phone-home. The
                whole video API, dashboard and player ship as a single thing you run.
              </p>
            </div>
            <div className="border-t border-line pt-[22px]">
              <h3 className="mb-2.5 text-[19px]">The cloud, minus the network</h3>
              <p className="text-[15px] text-muted">
                The self-hosted binary is not a demo. It is the exact code that runs Rend Cloud,
                with the one thing we sell, the anycast network, left out.
              </p>
            </div>
            <div className="border-t border-line pt-[22px]">
              <h3 className="mb-2.5 text-[19px]">It outlives us</h3>
              <p className="text-[15px] text-muted">
                The strongest guarantee in infrastructure is a licence, not a support tier. If the
                company behind Rend vanished tomorrow, your video keeps serving.
              </p>
            </div>
          </div>
        </section>

        <section className="reveal mx-auto max-w-[1080px] px-6 pb-20 md:pb-[110px]" aria-label="How Rend compares">
          <div className="mb-12 text-center">
            <svg className="sketch mx-auto mb-7 block h-[112px] w-auto overflow-visible" viewBox="0 0 180 130" aria-hidden="true">
              <path d="M18 114 L162 114" />
              <path className="anim-grow" d="M30 114 L30 82 L50 82 L50 114" />
              <path className="anim-grow g2" d="M62 114 L62 66 L82 66 L82 114" />
              <path className="anim-grow g3" d="M94 114 L94 46 L114 46 L114 114" />
              <path className="anim-grow g4" d="M126 114 L126 22 L146 22 L146 114" />
              <path className="anim-twinkle" d="M136 10 C138 10 139 12 138 14 C137 16 134 15 134 13 C134 11 135 10 136 10" />
              <path className="anim-twinkle t2" d="M152 8 L152 16 M148 12 L156 12" />
            </svg>
            <h2 className="mb-[18px] text-[clamp(27px,6vw,42px)]">How Rend compares</h2>
          <p className="mx-auto max-w-[640px] text-[17px] text-muted">
              Delivery seconds, storage second-months, hardware we own, and a licence that outlives
              us, lined up against how the rest of the category tends to work.
          </p>
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="cmp-table w-full min-w-[720px] border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="cmp-corner" aria-hidden="true" />
                  {cmpColumns.map((col, i) => (
                    <th key={col} scope="col" className={i === 0 ? "cmp-head cmp-head-rend" : "cmp-head"}>
                      <span className="relative inline-block px-1">
                        {col}
                        {i === 0 && (
                          <svg className="cmp-ring" viewBox="0 0 150 64" aria-hidden="true">
                            <path
                              pathLength={1}
                              d="M34 16 C70 5 120 8 134 26 C141 40 116 54 75 56 C34 58 9 47 13 30 C16 17 44 11 78 13"
                            />
                          </svg>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cmpRows.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row" className="cmp-feature">
                      {row.feature}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={i} className={i === 0 ? "cmp-cell cmp-cell-rend" : "cmp-cell"}>
                        {renderCmpCell(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-4 md:hidden">
            {cmpRows.map((row) => (
              <div key={row.feature} className="rounded-[16px] border border-line bg-card p-5">
                <p className="mb-3 font-head text-[18px] leading-snug text-ink">{row.feature}</p>
                <ul className="flex flex-col gap-1">
                  {row.cells.map((cell, i) => (
                    <li
                      key={i}
                      className={
                        i === 0
                          ? "flex items-center justify-between gap-4 rounded-[10px] bg-[rgba(22,21,19,0.05)] px-3 py-2"
                          : "flex items-center justify-between gap-4 px-3 py-2"
                      }
                    >
                      <span className={i === 0 ? "text-[13.5px] font-medium text-ink" : "text-[13.5px] text-muted"}>
                        {cmpColumns[i]}
                      </span>
                      <span className={i === 0 ? "shrink-0 text-right text-[14px] font-medium text-ink" : "shrink-0 text-right text-[14px] text-ink"}>
                        {renderCmpCell(cell)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="mx-auto mt-6 max-w-[680px] text-center text-[13px] text-muted">
            Rend figures are launch targets for supported regions. The other columns describe
            how each kind of platform tends to bill and operate, not a quote from any one vendor.
          </p>
        </section>

        <section className="reveal mx-auto max-w-[940px] px-6 pb-20 md:pb-[110px]" aria-label="Case study, Cap">
          <div className="mb-12 text-center">
            <h2 className="mb-[18px] flex flex-wrap items-center justify-center gap-[0.45em] text-[clamp(27px,6vw,42px)]">
              <img src="/cap-logo.svg" alt="Cap" className="w-auto" style={{ height: "1.15em" }} />
              <span>runs on Rend</span>
            </h2>
            <p className="mx-auto max-w-[660px] text-[17px] text-muted">
              Cap is the open source screen recorder behind Rend, used by hundreds of thousands of
              people. Every recording they share is uploaded, encoded, muxed, stored and delivered
              through Rend, built to reach millions of viewers worldwide.
            </p>
          </div>

          <div className="rounded-[20px] border border-line bg-card px-5 py-9 sm:px-10">
            <svg className="sketch mx-auto block h-auto w-full max-w-[560px] overflow-visible" viewBox="0 0 560 150" aria-hidden="true">
              <path id="pipe-flow" className="flow-path" d="M70 69 L470 69" />

              <path d="M40 50 C38 50 36 52 36 54 L36 84 C36 86 38 88 40 88 L100 88 C102 88 104 86 104 84 L104 54 C104 52 102 50 100 50 Z" />
              <path d="M60 88 L56 98 L84 98 L80 88" />
              <path d="M48 98 L92 98" />
              <circle className="dot anim-beat" cx={70} cy={69} r={4} />

              <path d="M110 69 C140 64 182 74 210 69" />
              <path d="M202 63 L212 69 L202 75" />

              <path d="M250 48 L286 64 L250 80 L214 64 Z" />
              <path d="M214 72 L250 88 L286 72" />
              <path d="M214 80 L250 96 L286 80" />

              <path d="M294 69 C330 64 386 74 422 69" />
              <path d="M414 63 L424 69 L414 75" />

              <path d="M470 33 C491 33 508 50 508 71 C508 92 491 109 470 109 C449 109 432 92 432 71 C432 50 449 33 470 33" />
              <path d="M470 33 C456 50 456 92 470 109" />
              <path d="M470 33 C484 50 484 92 470 109" />
              <path d="M470 33 L470 109" />
              <path d="M441 56 C453 62 487 62 499 56" />
              <path d="M434 71 L506 71" />
              <path d="M441 86 C453 80 487 80 499 86" />
              <path className="anim-twinkle" d="M520 46 C523 46 525 48 525 51 C525 56 520 62 520 62 C520 62 515 56 515 51 C515 48 517 46 520 46" />
              <path className="anim-twinkle t2" d="M424 88 C427 88 429 90 429 93 C429 98 424 104 424 104 C424 104 419 98 419 93 C419 90 421 88 424 88" />

              <circle className="dot" r={4.5}>
                <animateMotion dur="3.6s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.7;1">
                  <mpath href="#pipe-flow" />
                </animateMotion>
                <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.06;0.62;0.72;1" dur="3.6s" repeatCount="indefinite" />
              </circle>
              <circle className="dot" r={4.5}>
                <animateMotion dur="3.6s" begin="1.8s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.7;1">
                  <mpath href="#pipe-flow" />
                </animateMotion>
                <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.06;0.62;0.72;1" dur="3.6s" begin="1.8s" repeatCount="indefinite" />
              </circle>
            </svg>

            <div className="mx-auto mt-7 grid max-w-[560px] grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-[14px] font-medium leading-snug">Recorded in Cap</p>
                <p className="mt-1 text-[12.5px] text-muted">one API call</p>
              </div>
              <div>
                <p className="text-[14px] font-medium leading-snug">Encoded, muxed, stored</p>
                <p className="mt-1 text-[12.5px] text-muted">just in time, on Rend</p>
              </div>
              <div>
                <p className="text-[14px] font-medium leading-snug">Delivered worldwide</p>
                <p className="mt-1 text-[12.5px] text-muted">instant start, even cold</p>
              </div>
            </div>
          </div>

          <div className="mx-auto mt-14 max-w-[720px] text-center">
            <p className="font-head text-[clamp(22px,3.4vw,30px)] leading-[1.3]">
              Cap already runs all of its video on Rend.
            </p>
            <p className="mx-auto mt-4 max-w-[540px] text-[14px] text-muted">
              Cap and Rend come from the same team. The infrastructure we&apos;re opening up to you is
              the same one carrying Cap&apos;s video today, end to end and around the world.
            </p>
          </div>
        </section>

        <section className="reveal mx-auto max-w-[560px] px-6 pb-20 text-center md:pb-[110px]">
          <h2 className="mb-3.5 text-[clamp(25px,5.6vw,38px)]">Start in production</h2>
          <p className="mb-[30px] text-muted">
            Sign in with an email code, choose a plan, create an API key, upload a video, and embed playback from the dashboard.
          </p>
          <a
            href="/login?next=%2Fdashboard%2Fassets"
            className="inline-flex rounded-full bg-ink px-5 py-3 text-sm font-medium text-bg transition hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(22,21,19,0.18)]"
          >
            Open the dashboard
          </a>
        </section>
      </main>

      <footer className="border-t border-line px-6 pb-14 pt-12 text-center text-sm text-muted">
        <img src="/rend-mark.svg" alt="" className="mx-auto mb-3.5 h-[22px] w-auto opacity-85" />
        <p>Rend is made by Cap Software, the team behind Cap.</p>
        <p className="mt-2">
          <a
            href="https://rend.so"
            className="border-b border-line transition hover:border-ink hover:text-ink"
          >
            Rend.so
          </a>
        </p>
      </footer>
    </>
  );
}
