import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  shortcut?: string;
}

export default function Tooltip({ children, side = "top", align = "center", shortcut }: TooltipProps) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const pointerPressedRef = useRef(false);
  const visibleRef = useRef(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current?.parentElement;
    if (!anchor) return;
    const previousDescription = anchor.getAttribute("aria-describedby");
    const descriptionIds = new Set((previousDescription ?? "").split(/\s+/).filter(Boolean));
    descriptionIds.add(tooltipId);
    anchor.setAttribute("aria-describedby", [...descriptionIds].join(" "));

    const clearTimer = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const gap = 8;
      visibleRef.current = true;
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
      visibleRef.current = false;
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !visibleRef.current) return;
      event.stopPropagation();
      hide();
    };

    anchor.addEventListener("pointerenter", handlePointerEnter);
    anchor.addEventListener("pointerleave", handlePointerLeave);
    anchor.addEventListener("pointerdown", handlePointerDown);
    anchor.addEventListener("focus", handleFocus);
    anchor.addEventListener("blur", hide);
    anchor.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimer();
      anchor.removeEventListener("pointerenter", handlePointerEnter);
      anchor.removeEventListener("pointerleave", handlePointerLeave);
      anchor.removeEventListener("pointerdown", handlePointerDown);
      anchor.removeEventListener("focus", handleFocus);
      anchor.removeEventListener("blur", hide);
      anchor.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      if (previousDescription === null) anchor.removeAttribute("aria-describedby");
      else anchor.setAttribute("aria-describedby", previousDescription);
    };
  }, [align, side, tooltipId]);

  return <>
    <span ref={anchorRef} className="tooltip-anchor" aria-hidden="true" />
    {createPortal(<span id={tooltipId} className="app-tooltip portal" role="tooltip" style={position ?? { display: "none" }}><span>{children}</span>{shortcut && <kbd>{shortcut}</kbd>}</span>, document.body)}
  </>;
}
