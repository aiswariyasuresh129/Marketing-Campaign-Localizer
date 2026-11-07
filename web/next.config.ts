import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingExcludes: { "/api/jobs": ["./.review-data/**/*"] },
};

export default nextConfig;
