import type { ReactNode } from "react";

interface TooltipProps {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export default function Tooltip({ children, side = "top", align = "center" }: TooltipProps) {
  return <span className={`app-tooltip ${side} align-${align}`} role="tooltip" aria-hidden="true">{children}</span>;
}
