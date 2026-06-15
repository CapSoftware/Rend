import { getMarketingPage } from "@/lib/marketing-pages";
import { ogSize, renderOgImage } from "@/lib/og";

const page = getMarketingPage("/about");

export const alt = page.title;
export const size = ogSize;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage({ title: page.title, subtitle: page.ogSubtitle });
}
