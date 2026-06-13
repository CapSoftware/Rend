import { ogSize, renderOgImage } from "@/lib/og";

export const alt = "Rend, video infrastructure built for speed";
export const size = ogSize;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage();
}
