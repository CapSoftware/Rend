import type { Metadata } from "next";
import { Headland_One, Inter } from "next/font/google";
import "./globals.css";

const headland = Headland_One({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-headland",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://rend.so"),
  title: {
    default: "Rend, video infrastructure built for speed",
    template: "%s · Rend",
  },
  description:
    "Rend is the video platform for developers. One API call to upload, one URL that plays instantly anywhere in the world. Open source, on hardware we own.",
  openGraph: {
    type: "website",
    url: "https://rend.so",
    siteName: "Rend",
    locale: "en_US",
    title: "Rend, video infrastructure built for speed",
    description:
      "Rend is the video platform for developers. One API call to upload, one URL that plays instantly anywhere in the world. Open source, on hardware we own.",
  },
  icons: { icon: "/rend-mark.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${headland.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
