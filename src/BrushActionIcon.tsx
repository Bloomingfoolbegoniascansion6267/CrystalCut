interface BrushActionIconProps {
  action: "add" | "subtract";
  size?: number;
}

export default function BrushActionIcon({ action, size = 20 }: BrushActionIconProps) {
  return (
    <svg
      className="brush-action-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="m7.4 14.8 8.85-8.85a2.15 2.15 0 0 1 3.04 3.04l-8.86 8.85" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m14.65 7.55 3.05 3.05" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M10.55 15.25c.15 1.6-.4 3.02-1.63 4.02-1.17.95-2.82 1.18-4.66.65.98-.66 1.45-1.45 1.38-2.38-.1-1.44.92-2.57 2.3-2.66.96-.06 1.8.06 2.61.37Z" fill="currentColor" />
      <circle cx="18" cy="18" r="4.15" fill="white" stroke="currentColor" strokeWidth="1.45" />
      <path d={action === "add" ? "M15.9 18h4.2M18 15.9v4.2" : "M15.9 18h4.2"} stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}
