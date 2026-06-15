import type { MetadataRoute } from "next";
import { marketingPages } from "@/lib/marketing-pages";
import { absoluteSiteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteSiteUrl("/"),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...marketingPages.map((page) => ({
      url: absoluteSiteUrl(page.path),
      changeFrequency: "monthly" as const,
      priority: page.priority,
    })),
    {
      url: absoluteSiteUrl("/docs"),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: absoluteSiteUrl("/terms"),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: absoluteSiteUrl("/privacy"),
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];
}
