// 서비스 전체에서 쓰는 선 아이콘. 24x24 격자, 선 굵기 1.8, currentColor.

const PATHS = {
  map: "M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Zm0 0v13.5m6-11v13.5",
  school: "M3 10.5 12 5l9 5.5M5 9.5V19h14V9.5M9.5 19v-5h5v5M12 5V2.5h3",
  wrench: "M14.5 4.5a4.5 4.5 0 0 0-5.8 5.8L3.5 15.5a2 2 0 0 0 2.8 2.8l5.2-5.2a4.5 4.5 0 0 0 5.8-5.8l-2.8 2.8-2.3-.5-.5-2.3 2.8-2.8Z",
  bolt: "M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8Z",
  report: "M7 3h7l4 4v14H7V3Zm7 0v4h4M10 12h5m-5 4h5",
  camera: "M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm9 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  cameraOff: "m3 3 18 18M9 4h6l1.5 2H19a2 2 0 0 1 2 2v9M17 20H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1m4.5 3.3a4 4 0 0 1 5.2 5.2",
  flip: "M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  minimize: "M5 19h14",
  close: "M6 6l12 12M18 6 6 18",
  alert: "M12 3 2.5 20h19L12 3Zm0 6.5v5m0 3v.5",
  check: "m5 12.5 4.5 4.5L19 7",
  car: "M5 16.5V12l2-5h10l2 5v4.5M5 16.5h14M5 16.5V19m14-2.5V19M7.5 13.5h1m7 0h1",
  walk: "M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM9 21l2.5-7 2.5 2.5V21m-3-7-1-4 3.5-2 2 3.5 3 1.5M10.5 10 7 12",
  gauge: "M4.5 17a8.5 8.5 0 1 1 15 0M12 13l4-4",
  leaf: "M5 19c0-9 5-14 15-14 0 10-5 15-14 15H5Zm0 0 8-8",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  lamp: "M8 21h8M12 21V9m0 0a4 4 0 0 0-4-4h8a4 4 0 0 0-4 4ZM6 5h12",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9.5v.5",
  chevron: "m9 6 6 6-6 6",
  plug: "M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4",
  turn: "M6 21v-8a5 5 0 0 1 5-5h8m0 0-4-4m4 4-4 4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  monitor: "M3 5h18v11H3V5Zm6 15h6m-3-4v4",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "grip" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
