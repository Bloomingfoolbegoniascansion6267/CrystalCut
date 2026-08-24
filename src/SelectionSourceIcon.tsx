import type { SelectionSource } from "./lib/mask";

interface SelectionSourceIconProps {
  source: SelectionSource;
  size?: number;
  className?: string;
}

export default function SelectionSourceIcon({ source, size = 20, className }: SelectionSourceIconProps) {
  if (source === "automatic") {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.75 13.35 7a5.3 5.3 0 0 0 3.4 3.4L21 11.75 16.75 13.1a5.3 5.3 0 0 0-3.4 3.4L12 20.75l-1.35-4.25a5.3 5.3 0 0 0-3.4-3.4L3 11.75l4.25-1.35A5.3 5.3 0 0 0 10.65 7L12 2.75Z" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
        <path d="m18.5 3 .48 1.52L20.5 5l-1.52.48L18.5 7l-.48-1.52L16.5 5l1.52-.48L18.5 3Z" fill="currentColor" />
      </svg>
    );
  }

  if (source === "sam") {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M8.25 3.5H5.5a2 2 0 0 0-2 2v2.75M15.75 3.5h2.75a2 2 0 0 1 2 2v2.75M20.5 15.75v2.75a2 2 0 0 1-2 2h-2.75M8.25 20.5H5.5a2 2 0 0 1-2-2v-2.75" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        <circle cx="12" cy="12" r="4.25" stroke="currentColor" strokeWidth="1.65" />
        <circle cx="12" cy="12" r="1.35" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m15.8 4.1 4.1 4.1L9.25 18.85l-5.1 1 1-5.1L15.8 4.1Z" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
      <path d="m13.7 6.2 4.1 4.1M5.15 14.75l4.1 4.1" stroke="currentColor" strokeWidth="1.65" />
    </svg>
  );
}
