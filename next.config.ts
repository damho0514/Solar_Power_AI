import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "@mediapipe/hands": "./lib/stubs/mediapipe-hands.ts",
    },
  },
};

export default nextConfig;
