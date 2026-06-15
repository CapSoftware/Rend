import type { MetadataRoute } from "next";
import { marketingPages } from "@/lib/marketing-pages";
import { siteOrigin } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/docs",
          "/terms",
          "/privacy",
          ...marketingPages.map((page) => page.path),
          "/llms.txt",
          "/llms-full.txt",
          "/openapi.json",
        ],
        disallow: ["/api/", "/dashboard/", "/embed/", "/login", "/operator", "/watch/"],
      },
    ],
    sitemap: `${siteOrigin}/sitemap.xml`,
    host: siteOrigin,
  };
}
