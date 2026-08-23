import type { ReactNode } from "react";

interface TooltipProps {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}

export default function Tooltip({ children, side = "top" }: TooltipProps) {
  return <span className={`app-tooltip ${side}`} role="tooltip" aria-hidden="true">{children}</span>;
}
