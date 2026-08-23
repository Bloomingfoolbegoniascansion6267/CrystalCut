import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export default function Tooltip({ children, side = "top", align = "center" }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const pointerPressedRef = useRef(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current?.parentElement;
    if (!anchor) return;

    const clearTimer = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const gap = 8;
      if (side === "left") {
        setPosition({ top: rect.top + rect.height / 2, left: rect.left - gap, transform: "translate(-100%, -50%)" });
      } else if (side === "right") {
        setPosition({ top: rect.top + rect.height / 2, left: rect.right + gap, transform: "translate(0, -50%)" });
      } else {
        const top = side === "top" ? rect.top - gap : rect.bottom + gap;
        const vertical = side === "top" ? "-100%" : "0";
        const left = align === "start" ? rect.left : align === "end" ? rect.right : rect.left + rect.width / 2;
        const horizontal = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
        setPosition({ top, left, transform: `translate(${horizontal}, ${vertical})` });
      }
    };
    const show = (delay = 350) => {
      clearTimer();
      timerRef.current = window.setTimeout(place, delay);
    };
    const hide = () => {
      clearTimer();
      setPosition(null);
    };
    const handlePointerEnter = () => {
      pointerPressedRef.current = false;
      show();
    };
    const handlePointerLeave = () => {
      pointerPressedRef.current = false;
      hide();
    };
    const handlePointerDown = () => {
      pointerPressedRef.current = true;
      hide();
    };
    const handleFocus = () => {
      if (!pointerPressedRef.current) show(0);
    };

    anchor.addEventListener("pointerenter", handlePointerEnter);
    anchor.addEventListener("pointerleave", handlePointerLeave);
    anchor.addEventListener("pointerdown", handlePointerDown);
    anchor.addEventListener("focus", handleFocus);
    anchor.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimer();
      anchor.removeEventListener("pointerenter", handlePointerEnter);
      anchor.removeEventListener("pointerleave", handlePointerLeave);
      anchor.removeEventListener("pointerdown", handlePointerDown);
      anchor.removeEventListener("focus", handleFocus);
      anchor.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [align, side]);

  return <>
    <span ref={anchorRef} className="tooltip-anchor" aria-hidden="true" />
    {position && createPortal(<span className="app-tooltip portal" role="tooltip" aria-hidden="true" style={position}>{children}</span>, document.body)}
  </>;
}
