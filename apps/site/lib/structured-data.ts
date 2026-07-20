/**
 * schema.org JSON-LD builders. Each returns a plain object that the <JsonLd>
 * component serialises into a <script type="application/ld+json"> tag.
 *
 * Keeping these centralised means every page emits consistent, valid structured
 * data for search engines and for LLMs that parse JSON-LD.
 */
import type { MarketingFaq } from "./marketing-pages";
import { absoluteSiteUrl, siteDescription, siteName, siteOrigin } from "./seo";

const GITHUB_URL = "https://github.com/CapSoftware/Rend";
const CAP_URL = "https://cap.so";
const LOGO_URL = absoluteSiteUrl("/icon-512x512.png");

export const ORGANIZATION_ID = `${siteOrigin}/#organization`;
export const WEBSITE_ID = `${siteOrigin}/#website`;

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: siteName,
    legalName: "Cap Software, Inc.",
    url: siteOrigin,
    logo: LOGO_URL,
    description: siteDescription,
    sameAs: [GITHUB_URL, CAP_URL],
  };
}

export function websiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: siteName,
    url: siteOrigin,
    description: siteDescription,
    inLanguage: "en-US",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

export function webPageLd({
  name,
  description,
  path,
  type = "WebPage",
}: {
  name: string;
  description: string;
  path: string;
  type?: "WebPage" | "AboutPage" | "CollectionPage";
}) {
  return {
    "@context": "https://schema.org",
    "@type": type,
    name,
    description,
    url: absoluteSiteUrl(path),
    inLanguage: "en-US",
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORGANIZATION_ID },
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: absoluteSiteUrl(item.path),
    })),
  };
}

export function faqLd(faqs: MarketingFaq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };
}

/** Usage-based product offer for the pricing page. PAYG starts at $0. */
export function productOfferLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Rend video infrastructure",
    description: siteDescription,
    brand: { "@id": ORGANIZATION_ID },
    url: absoluteSiteUrl("/pricing"),
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: "0",
      offerCount: 1,
      description:
        "Pay as you go with no base fee. Delivery is $0.001 per watched minute and storage is $0.003 per stored minute per month. Encoding is included.",
    },
  };
}
