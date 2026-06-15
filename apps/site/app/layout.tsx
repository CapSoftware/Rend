import type { Metadata, Viewport } from "next";
import { Headland_One, Inter } from "next/font/google";
import {
  backgroundColor,
  brandColor,
  ogImageSize,
  siteDescription,
  siteLocale,
  siteName,
  siteOrigin,
  siteTitle,
  themeColor,
} from "@/lib/seo";
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

export const viewport: Viewport = {
  themeColor,
  colorScheme: "light",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  applicationName: siteName,
  title: {
    default: siteTitle,
    template: `%s · ${siteName}`,
  },
  description: siteDescription,
  keywords: [
    "video infrastructure",
    "video API",
    "developer video platform",
    "video hosting",
    "video streaming",
    "open source video",
  ],
  authors: [{ name: siteName, url: siteOrigin }],
  creator: siteName,
  publisher: siteName,
  category: "technology",
  referrer: "strict-origin-when-cross-origin",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    url: "/",
    siteName,
    locale: siteLocale,
    title: siteTitle,
    description: siteDescription,
    images: [
      {
        url: "/opengraph-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: siteTitle,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: [
      {
        url: "/twitter-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: siteTitle,
      },
    ],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48", type: "image/x-icon" },
      { url: "/rend-mark.svg", type: "image/svg+xml" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    other: [{ rel: "mask-icon", url: "/rend-mark.svg", color: brandColor }],
  },
  appleWebApp: {
    capable: true,
    title: siteName,
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
  other: {
    "msapplication-TileColor": backgroundColor,
    "msapplication-TileImage": "/mstile-150x150.png",
  },
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
