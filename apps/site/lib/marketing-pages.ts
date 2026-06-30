/**
 * Single source of truth for the marketing site's standalone pages.
 *
 * Every consumer (page metadata, footer, sitemap, llms.txt, llms-full.txt and
 * JSON-LD) reads from here so the routes, titles, descriptions and FAQs never
 * drift apart. Keep copy plain and human, and never use em dashes (AGENTS.md).
 */

import { DASHBOARD_START_HREF } from "./dashboard-auth-hint";

export const START_HREF = DASHBOARD_START_HREF;
export const GITHUB_URL = "https://github.com/CapSoftware/Rend";

export type MarketingFaq = { q: string; a: string };

export type MarketingPage = {
  /** Route path, e.g. "/features". */
  path: string;
  /** Short label used in the header nav and footer. */
  navLabel: string;
  /** Whether this page appears in the primary header nav. */
  inHeaderNav: boolean;
  /** Footer column the page belongs to. */
  footerGroup: "Product" | "Company";
  /** <title> text. The root layout appends " · Rend". */
  title: string;
  /** Meta description, kept under ~160 characters. */
  description: string;
  /** Subtitle drawn into the generated Open Graph image. */
  ogSubtitle: string;
  /** One plain sentence used by llms.txt to describe the page. */
  summary: string;
  /** sitemap.xml priority. */
  priority: number;
  /** Page level FAQ, surfaced in the UI, JSON-LD and llms-full.txt. */
  faqs: MarketingFaq[];
};

export const marketingPages: MarketingPage[] = [
  {
    path: "/features",
    navLabel: "Features",
    inHeaderNav: true,
    footerGroup: "Product",
    title: "Features",
    description:
      "What Rend does for developers: one API call to upload, encoding included, Tigris-backed HLS playback, and tooling your AI editor understands.",
    ogSubtitle:
      "One call to upload, one fast playback URL out. Encoding, storage and delivery handled.",
    summary:
      "What Rend does: upload with one API call, encoding included, generated HLS from Tigris-backed origin, pricing by resolution, fully open source, and llms.txt plus OpenAPI for AI editors.",
    priority: 0.9,
    faqs: [
      {
        q: "What does Rend actually do?",
        a: "You hand Rend a video file or a URL in one API call. It encodes, packages and stores the video, then gives you back a single playback URL that plays anywhere. The renditions players need are built for you.",
      },
      {
        q: "Do I have to deal with encoding?",
        a: "No. Every upload is encoded for you, and it is included in the price. Rend builds the renditions players need so you never touch a transcoding pipeline.",
      },
      {
        q: "What do I get back to play the video?",
        a: "An adaptive HLS ladder served through Rend-controlled playback URLs. Browser playback uses same-origin URLs with no tokens to manage, so you drop in one source and it plays.",
      },
      {
        q: "Can I run it on my own servers?",
        a: "Yes. Rend is open source and installs as a single binary, so you can self-host it for free. Or use Rend Cloud and let us run the hosted playback stack for you.",
      },
      {
        q: "Is it easy to wire up with an AI coding assistant?",
        a: "Yes. The whole guide fits on one page, and Rend ships llms.txt, OpenAPI, a generated TypeScript SDK and a copyable agent prompt so the model in your editor can set it up correctly the first time.",
      },
    ],
  },
  {
    path: "/performance",
    navLabel: "Performance",
    inHeaderNav: true,
    footerGroup: "Product",
    title: "Why Rend is fast",
    description:
      "Rend serves generated HLS from Tigris-backed origin through Rend-controlled playback URLs, with the bare-metal edge path kept dormant until regional coverage makes it worthwhile.",
    ogSubtitle:
      "Generated HLS from Tigris-backed origin, with the edge path dormant by default.",
    summary:
      "Why Rend is fast: generated HLS, Rend-controlled playback URLs, private origin URLs kept out of the browser, and an optional bare-metal edge path kept dormant until regional coverage makes it worthwhile.",
    priority: 0.9,
    faqs: [
      {
        q: "Why does video usually feel slow to start?",
        a: "It is rarely the server working hard. The wait comes from the round trips across the internet before the first frame can show. The further the first bytes have to travel, the longer playback takes to begin.",
      },
      {
        q: "What is active today?",
        a: "When you upload, Rend generates the HLS master playlist, rendition playlists, and media segments during processing. Production playback serves those artifacts from Tigris-backed origin through Rend-controlled URLs.",
      },
      {
        q: "Do you run on serverless functions?",
        a: "Current production playback does not depend on edge functions or active edge nodes; it uses Rend API-origin streaming from Tigris. The optional bare-metal edge service remains available behind REND_PLAYBACK_MODE=edge.",
      },
      {
        q: "What is time to first frame?",
        a: "It is the gap between pressing play and seeing the first frame. It is the part viewers actually feel, and the part Rend is built to keep short, especially the first time a video is requested.",
      },
      {
        q: "Can I check the speed myself?",
        a: "Yes, and we would rather you did. Upload a video, press play from wherever you are, and time the first frame. That is the only number that counts.",
      },
    ],
  },
  {
    path: "/pricing",
    navLabel: "Pricing",
    inHeaderNav: true,
    footerGroup: "Product",
    title: "Pricing",
    description:
      "You pay for two things, both by resolution: seconds delivered and storage kept. Encoding is included, there are no per-minute fees and no egress surprises. Start free and scale when you need to.",
    ogSubtitle:
      "Pay for delivery and storage by resolution. Encoding included. No egress surprises.",
    summary:
      "Rend pricing: pay for delivery (per second streamed, by resolution) and storage (per second-month kept, by resolution). Encoding is included, there are no egress fees, and plans run from pay as you go up to Enterprise.",
    priority: 0.9,
    faqs: [
      {
        q: "How does pricing work?",
        a: "You pay for what gets delivered and what you store, both priced by resolution. Higher resolution is more data to move and keep, so it costs a little more. Encoding is included on every upload.",
      },
      {
        q: "Are there egress or bandwidth surprises?",
        a: "No. There are no per-minute fees and no surprise egress charges. Delivery is billed per second streamed by resolution, so you pay for what people actually watched.",
      },
      {
        q: "Do you charge separately for encoding?",
        a: "No. Encoding is always included. Rend builds the renditions players need on every upload, and it never shows up as its own line on the bill.",
      },
      {
        q: "What happens when I delete a video?",
        a: "The storage meter stops. Storage is billed per second-month you keep an asset, with no minimum, so removing a video stops its cost.",
      },
      {
        q: "How do I start?",
        a: "Start on pay as you go with no commitment, or pick a plan with monthly credits included. You can move between plans whenever you like, with no lock-in.",
      },
      {
        q: "Can I avoid usage fees altogether?",
        a: "Yes. Rend is open source and free to self-host. You only pay for Rend Cloud, the managed edge network that makes hosted playback fast.",
      },
    ],
  },
  {
    path: "/compare",
    navLabel: "Compare",
    inHeaderNav: false,
    footerGroup: "Product",
    title: "How Rend compares",
    description:
      "How Rend compares to minute-billed platforms, per-GB CDNs, and rolling your own. Delivery and storage by resolution, encoding included, open source, and Tigris-backed HLS playback.",
    ogSubtitle:
      "Rend next to minute-billed platforms, per-GB CDNs, and rolling your own.",
    summary:
      "How Rend compares to other ways of paying for video: minute-billed platforms, budget per-GB CDNs, and rolling your own. Rend bills delivery and storage by resolution, includes encoding, is open source and self-hostable, and serves generated HLS from Tigris-backed origin by default.",
    priority: 0.8,
    faqs: [
      {
        q: "How is Rend different from minute-billed platforms?",
        a: "They charge per minute of video plus tiers, and things like encoding and fast starts are often extras. Rend bills delivery and storage by resolution, includes encoding, and serves generated HLS from Tigris-backed origin by default.",
      },
      {
        q: "How does Rend compare to budget per-GB CDNs?",
        a: "A per-GB CDN bills raw bandwidth by region and leaves encoding and packaging to you. Rend handles encoding, packaging, storage and delivery through one playback stack.",
      },
      {
        q: "Why not just roll my own video stack?",
        a: "You can, and Rend is open source if you want to. But rolling your own means owning encoding, storage, a global cache and the cold-start problem. Rend gives you that stack, or the option to self-host the same code.",
      },
      {
        q: "Is Rend cheaper than the alternatives?",
        a: "It depends on your traffic, but Rend takes away two common surprises: per-minute fees and egress charges. You pay for seconds delivered and storage kept by resolution, with encoding included.",
      },
    ],
  },
  {
    path: "/benchmarks",
    navLabel: "Benchmarks",
    inHeaderNav: false,
    footerGroup: "Product",
    title: "Benchmarks",
    description:
      "An honest startup benchmark: time to first frame for Rend versus Mux on the same source video, measured from a clean browser with the raw results published.",
    ogSubtitle:
      "Time to first frame, Rend versus Mux on the same source video, with raw results published.",
    summary:
      "A startup speed benchmark comparing Rend's production playback path against Mux on the same source video: median time to first frame, stall counts and reliability across US and Europe runs, with the full raw artifacts published.",
    priority: 0.8,
    faqs: [
      {
        q: "What does this benchmark measure?",
        a: "Time to first frame, the gap between opening the page and the first painted video frame, plus how often playback stalls. It is the part a viewer actually feels the moment they press play.",
      },
      {
        q: "Is this a fair comparison?",
        a: "Within each region we use the same source video, the same machine and browser, a clean cache for every sample, and we randomize provider order each round. We also publish the raw results and the caveats so you can check the methodology yourself.",
      },
      {
        q: "Why did Rend serve 1080p and Mux serve 720p?",
        a: "The benchmark uses Rend's production setup for this asset: native HLS from the embed player. Each player then selected its own rendition, so Rend served full 1920 by 1080 while Mux selected 1280 by 720.",
      },
      {
        q: "Can I reproduce these numbers?",
        a: "Yes. The full machine readable results and every raw sample are linked on the page, and you can upload your own video to both services and time the first frame yourself.",
      },
    ],
  },
  {
    path: "/about",
    navLabel: "About",
    inHeaderNav: false,
    footerGroup: "Company",
    title: "Built by the team behind Cap",
    description:
      "Rend is built by the team behind Cap, the open source screen recorder. We needed video that played the instant a link opened, could not buy it, so we built it. Cap runs entirely on Rend.",
    ogSubtitle:
      "We needed video that loaded instantly, could not buy it, so we built it.",
    summary:
      "Rend is built by the team behind Cap, the open source screen recorder. Cap serves a huge library of recordings that have to play the instant a share link opens, so the team built Rend to make that happen, then opened it up for other developers. Cap runs entirely on Rend.",
    priority: 0.7,
    faqs: [
      {
        q: "Who builds Rend?",
        a: "The team behind Cap, the open source screen recorder. Rend is the video infrastructure we built for ourselves, then opened up for other developers.",
      },
      {
        q: "What is Cap?",
        a: "Cap is an open source screen recorder used by a lot of people. Every recording has to be stored and play back the moment someone opens a share link, which is exactly the problem Rend solves.",
      },
      {
        q: "Does Cap really run on Rend?",
        a: "Yes. Cap runs entirely on Rend. The footage you share from Cap is served through the same infrastructure we offer everyone else.",
      },
      {
        q: "Is Rend a separate product from Cap?",
        a: "Yes. Rend is standalone video infrastructure that any developer can use or self-host. It just happens to be the stack that powers Cap.",
      },
    ],
  },
];

export function getMarketingPage(path: string): MarketingPage {
  const page = marketingPages.find((p) => p.path === path);
  if (!page) throw new Error(`Unknown marketing page: ${path}`);
  return page;
}
