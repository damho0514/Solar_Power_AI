import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /api/solar는 public/ 안의 모델 파일을 fs로 읽는다. 서버리스 배포(Vercel)에서도 함수에 같이 담기게 한다.
  outputFileTracingIncludes: {
    "/api/solar": ["./public/models/solar-gbr.json"],
  },
  turbopack: {
    resolveAlias: {
      "@mediapipe/hands": "./lib/stubs/mediapipe-hands.ts",
    },
  },
};

export default nextConfig;
