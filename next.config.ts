import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// 콘텐츠 보안 정책. 이 앱이 실제로 쓰는 것만 연다.
// - 'wasm-unsafe-eval': 브라우저 속 인식 AI(MediaPipe, TF.js WASM)가 WebAssembly를 컴파일하는 데 필요
// - 'unsafe-inline' 스크립트: Next.js가 페이지에 넣는 인라인 스크립트. nonce 방식으로 바꾸면 뺄 수 있다(모든 페이지가 동적 렌더링이 됨)
// - 'unsafe-eval'은 개발 모드에서만 (React 개발 도구)
// - cdn.jsdelivr.net: 본문 글꼴(Pretendard) CSS와 글꼴 파일
// - ws: wss:: 현장 MQTT 브로커(주소는 사용자가 넣는다)와 개발 서버 새로고침
// - blob:: 카메라 영상 캡처, 사건 영상 재생·내려받기, 인식 AI 작업 스레드
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss: blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'", // 다른 사이트가 이 화면을 iframe에 넣어 버튼을 몰래 누르게 하지 못하게 (클릭재킹)
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" }, // frame-ancestors를 모르는 오래된 브라우저용
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // 카메라는 이 사이트만, 마이크·위치·결제 등은 아무도 못 쓰게
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

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
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
