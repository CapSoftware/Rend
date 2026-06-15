import type { MetadataRoute } from "next";
import { absoluteSiteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteSiteUrl("/"),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: absoluteSiteUrl("/docs"),
      changeFrequency: "weekly",
      priority: 0.8,
    },
  ];
}
