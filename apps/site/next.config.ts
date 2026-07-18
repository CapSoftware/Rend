import type { NextConfig } from "next";

const fastEmbedRedirectOrigin =
  process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN?.trim().replace(/\/+$/, "") ||
  "";

const nextConfig: NextConfig = {
  transpilePackages: ["@rend/player"],
  async redirects() {
    return fastEmbedRedirectOrigin
      ? [
          {
            source: "/embed/:assetId",
            destination: `${fastEmbedRedirectOrigin}/embed-fast/:assetId`,
            permanent: false,
          },
        ]
      : [];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/embed/:assetId",
          destination: "/embed-fast/:assetId",
        },
      ],
    };
  },
};

export default nextConfig;
