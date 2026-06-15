import { ogSize, renderOgImage } from "@/lib/og";
import { siteTitle } from "@/lib/seo";

export const alt = siteTitle;
export const size = ogSize;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage();
}
