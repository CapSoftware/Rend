import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@rend/player"],
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
