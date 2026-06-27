import type { ReactNode } from "react";

/**
 * The six core features, with their hand-drawn sketch icons. Shared by the
 * homepage feature grid and the dedicated /features page. The `detail` array
 * holds the expanded points used on the /features page only.
 */
export type Feature = {
  id: string;
  title: string;
  body: string;
  detail: string[];
  icon: ReactNode;
};

export const features: Feature[] = [
  {
    id: "one-call",
    title: "One call in, one link out",
    body: "Send a file or a URL in a single API call. Rend encodes, packages and stores it, then hands back one playback URL that plays anywhere.",
    detail: [
      "Upload a file body or hand Rend a source URL to pull from. Either way it is one request.",
      "Rend returns an asset you can poll until it is playable, then a single same-origin playback URL.",
      "No buckets to wire up, no manifests to assemble, no separate CDN to configure.",
    ],
    icon: (
      <svg
        className="sketch block h-[78px] w-24 overflow-visible"
        viewBox="0 0 140 120"
        aria-hidden="true"
      >
        <g className="anim-drop">
          <path d="M70 16 C68 30 71 42 69 56" />
          <path d="M56 45 C60 50 65 55 69 59" />
          <path d="M83 44 C79 50 74 55 69 59" />
        </g>
        <path d="M26 70 C24 79 24 89 27 98 C53 102 88 102 113 98 C115 88 115 78 113 70" />
        <path className="anim-twinkle" d="M104 24 L104 36 M98 30 L110 30" />
        <path className="anim-twinkle t2" d="M34 28 L34 38 M29 33 L39 33" />
      </svg>
    ),
  },
  {
    id: "fast-starts",
    title: "Fast starts, even cold",
    body: "Rend generates HLS during media processing and serves it from Tigris-backed origin through Rend-controlled URLs, so playback works without active edge nodes.",
    detail: [
      "HLS manifests and segments are available as soon as the asset reaches hls_ready.",
      "The player receives same-origin artifact URLs, not private object-store links.",
      "The bare-metal edge path is optional and dormant until regional coverage makes it worthwhile.",
    ],
    icon: (
      <svg
        className="sketch block h-[78px] w-24 overflow-visible"
        viewBox="0 0 140 120"
        aria-hidden="true"
      >
        <path d="M70 18 C94 16 112 36 110 60 C108 85 90 102 68 101 C45 100 29 82 30 58 C31 35 47 20 70 18" />
        <path
          className="anim-pulse"
          d="M60 42 C59 53 59 65 61 77 C70 71 80 65 89 59 C79 53 69 47 60 42"
        />
        <path className="anim-zip" d="M8 38 L23 39" />
        <path className="anim-zip z2" d="M2 58 L19 58" />
        <path className="anim-zip z3" d="M8 78 L23 77" />
      </svg>
    ),
  },
  {
    id: "simple-pricing",
    title: "Simple pricing",
    body: "You pay for what's delivered and what's stored, priced by resolution. Encoding is included, with no per-minute fees and no surprise egress charges.",
    detail: [
      "Delivery is billed per second streamed, by resolution from 720p to 4K.",
      "Storage is billed per second-month you keep an asset, by the same resolution tiers.",
      "Encoding is included on every upload, with no per-minute fees and no egress surprises.",
    ],
    icon: (
      <svg
        className="sketch block h-[78px] w-24 overflow-visible"
        viewBox="0 0 140 120"
        aria-hidden="true"
      >
        <g className="anim-swing">
          <path d="M62 20 C75 21 88 23 100 26 C102 38 103 51 103 63 C92 76 81 88 69 99 C56 87 43 75 31 62 C41 48 51 34 62 20" />
          <path d="M67 36 C71 33 76 36 76 41 C76 46 71 49 67 46 C63 43 63 39 67 36" />
          <path d="M73 39 C87 30 102 22 117 17" />
          <path d="M56 62 L84 64" />
          <path d="M53 74 L77 76" />
        </g>
      </svg>
    ),
  },
  {
    id: "open-source",
    title: "100% open source",
    body: "Every line is open: AGPL server, MIT player and SDKs. Run the same binary we run, on your own machines, with no phone-home and no licence to expire.",
    detail: [
      "The server is AGPL; the player and SDKs are MIT.",
      "It is the exact code that runs Rend Cloud, not a cut-down community edition.",
      "Self-host the whole thing free, with nothing phoning home and no licence to expire.",
    ],
    icon: (
      <svg
        className="sketch block h-[78px] w-24 overflow-visible"
        viewBox="0 0 140 120"
        aria-hidden="true"
      >
        <path d="M17 30 C50 26 92 26 123 30 C126 50 126 72 123 92 C90 96 50 96 17 92 C14 72 14 50 17 30" />
        <path d="M16 44 L124 44" />
        <path d="M30 58 L44 66 L30 74" />
        <path className="anim-blink" d="M52 75 L66 75" />
        <path
          className="anim-beat"
          d="M96 60 C92 52 80 54 80 64 C80 72 90 78 96 82 C102 78 112 72 112 64 C112 54 100 52 96 60"
        />
      </svg>
    ),
  },
  {
    id: "agent-native",
    title: "Easy for you and your AI",
    body: "The whole guide fits on one page, with llms.txt, OpenAPI and a generated SDK, so you or the model in your editor can wire up Rend right the first time.",
    detail: [
      "The full integration guide fits on a single page at /docs.",
      "A copyable prompt gives agents the exact sources, key rules and smoke test path.",
      "An llms.txt index and OpenAPI contract point models at the stable reference they need.",
    ],
    icon: (
      <svg
        className="sketch block h-[78px] w-24 overflow-visible"
        viewBox="0 0 140 120"
        aria-hidden="true"
      >
        <path d="M38 40 C52 39 63 50 62 64 C61 78 52 89 38 88 C24 87 14 78 14 64 C14 50 24 41 38 40" />
        <g className="anim-eyes">
          <path d="M30 58 L30 63" />
          <path d="M46 58 L46 63" />
        </g>
        <path d="M28 71 C32 77 44 77 48 71" />
        <path d="M82 46 C94 44 110 44 122 46 C124 58 124 72 122 84 C110 86 94 86 82 84 C80 72 80 58 82 46" />
        <path d="M102 44 L102 33" />
        <path
          className="anim-twinkle"
          d="M102 26 C104 26 105 28 104 30 C103 32 100 31 100 29 C100 27 101 26 102 26"
        />
        <g className="anim-eyes e2">
          <path d="M94 60 L94 65" />
          <path d="M110 60 L110 65" />
        </g>
        <path d="M94 74 L110 74" />
      </svg>
    ),
  },
  {
    id: "verifiable-speed",
    title: "Speed you can check",
    body: "Don't take our word for it. Upload a video, press play from anywhere in the world, and time the first frame yourself. That's the number that matters.",
    detail: [
      "Time to first frame is the number viewers actually feel.",
      "Upload a real video and press play from anywhere in the world.",
      "Measure the first frame yourself instead of trusting a marketing figure.",
    ],
    icon: (
      <svg
        className="sketch block h-[78px] w-24 overflow-visible"
        viewBox="0 0 140 120"
        aria-hidden="true"
      >
        <path d="M21 16 C20 40 20 70 22 100 C55 103 95 103 131 100" />
        <path
          id="speedline"
          d="M30 30 C46 35 60 52 76 66 C92 79 110 85 126 87"
        />
        <circle className="dot" r={4}>
          <animateMotion
            dur="3s"
            repeatCount="indefinite"
            calcMode="linear"
            keyPoints="0;1;1"
            keyTimes="0;0.6;1"
          >
            <mpath href="#speedline" />
          </animateMotion>
          <animate
            attributeName="opacity"
            values="0;1;1;0;0"
            keyTimes="0;0.06;0.62;0.72;1"
            dur="3s"
            repeatCount="indefinite"
          />
        </circle>
        <path className="anim-twinkle" d="M112 24 L112 34 M107 29 L117 29" />
      </svg>
    ),
  },
];
