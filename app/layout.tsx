import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "스마트 가로등 관제 데모",
  description: "노트북 한 대로 돌리는 AI 가로등 시뮬레이션",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
