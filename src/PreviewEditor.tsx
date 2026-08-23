import {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BrushMode, BrushStroke, ImageAsset, ManualMaskRecipe, MaskPoint, MaskMode } from "./types";
import { useI18n } from "./i18n/I18nProvider";

export type PreviewViewMode = "original" | "result" | "mask" | "compare";
export type PreviewBackground = "checker" | "light" | "dark";
export type PreviewStatus = "idle" | "updating" | "current" | "error";

interface PreviewEditorProps {
  asset: ImageAsset;
  viewMode: PreviewViewMode;
  background: PreviewBackground;
  editing: boolean;
  onMaskChange: (recipe: ManualMaskRecipe) => void;
  onApply: () => void;
  onCancel: () => void;
  previewStatus?: PreviewStatus;
  previewError?: string | null;
}

interface Size {
  width: number;
  height: number;
}

type EditorTool = "keep" | "remove" | "pan";
type SelectionSource = "automatic" | "sam" | "manual";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function StrokeShape({ stroke, width, height, color, opacity = 1 }: {
  stroke: BrushStroke;
  width: number;
  height: number;
  color: string;
  opacity?: number;
}) {
  const points = stroke.points.map((point) => `${point.x * width},${point.y * height}`).join(" ");
  const strokeWidth = Math.max(1, stroke.radius * 2 * Math.min(width, height));
  if (stroke.points.length === 1) {
    return <circle cx={stroke.points[0].x * width} cy={stroke.points[0].y * height} r={strokeWidth / 2} fill={color} opacity={opacity} />;
  }
  return <polyline points={points} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity={opacity} />;
}

const sourceForMode = (mode: MaskMode): SelectionSource => {
  if (mode === "sam") return "sam";
  if (mode === "manual") return "manual";
  return "automatic";
};

export default function PreviewEditor({
  asset,
  viewMode,
  background,
  editing,
  onMaskChange,
  onApply,
  onCancel,
  previewStatus = "idle",
  previewError = null,
}: PreviewEditorProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const imageGroupRef = useRef<HTMLDivElement>(null);
  const sourceCardRef = useRef<HTMLDivElement>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement>(null);
  const sourceOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [sourceSize, setSourceSize] = useState<Size>({ width: asset.width ?? 1, height: asset.height ?? 1 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [comparePosition, setComparePosition] = useState(50);
  const [tool, setTool] = useState<EditorTool>("pan");
  const [brushSize, setBrushSize] = useState(48);
  const [activeStroke, setActiveStroke] = useState<BrushStroke | null>(null);
  const activeStrokeRef = useRef<BrushStroke | null>(null);
  const [redoStack, setRedoStack] = useState<BrushStroke[]>([]);
  const [isSourcePickerOpen, setIsSourcePickerOpen] = useState(false);
  const pointerAction = useRef<null | {
    type: "pan" | "stroke";
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  }>(null);
  const spacePressed = useRef(false);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSourceSize({ width: asset.width ?? 1, height: asset.height ?? 1 });
    setZoom(null);
    setPan({ x: 0, y: 0 });
    setComparePosition(50);
    setRedoStack([]);
    setActiveStroke(null);
    setTool("pan");
    setIsSourcePickerOpen(false);
    activeStrokeRef.current = null;
  }, [asset.id, asset.width, asset.height]);

  useEffect(() => {
    if (!isSourcePickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sourceCardRef.current?.contains(event.target as Node)) setIsSourcePickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [isSourcePickerOpen]);

  const rotated = asset.rotation === 90 || asset.rotation === 270;
  const orientedSize = useMemo<Size>(() => rotated
    ? { width: sourceSize.height, height: sourceSize.width }
    : sourceSize, [rotated, sourceSize]);
  const fitScale = Math.min(
    Math.max(1, stageSize.width - (editing ? 112 : 40)) / Math.max(1, orientedSize.width),
    Math.max(1, stageSize.height - (editing ? 136 : 40)) / Math.max(1, orientedSize.height),
  );
  const effectiveZoom = zoom ?? fitScale;
  const displaySize = orientedSize;
  const baseImageSize = rotated
    ? { width: displaySize.height, height: displaySize.width }
    : displaySize;
  const sourceMinimumEdge = Math.max(1, Math.min(asset.width ?? orientedSize.width, asset.height ?? orientedSize.height));
  const currentRadius = clamp(brushSize / 2 / sourceMinimumEdge, 0.0001, 0.5);
  const correctionActive = asset.maskRecipe.mode !== "automatic";
  const visibleStrokes = correctionActive
    ? activeStroke ? [...asset.maskRecipe.strokes, activeStroke] : asset.maskRecipe.strokes
    : [];
  const inactiveStrokeCount = asset.maskRecipe.mode === "automatic" ? asset.maskRecipe.strokes.length : 0;
  const selectionSource = sourceForMode(asset.maskRecipe.mode);
  const previewIsActive = editing || previewStatus !== "idle";
  const selectionNeedsPrompt = (asset.maskRecipe.mode === "manual" || asset.maskRecipe.mode === "sam")
    && !asset.maskRecipe.strokes.some((stroke) => stroke.mode === "keep" && stroke.points.length > 0);
  const resultUrl = selectionNeedsPrompt ? null : previewIsActive
    ? asset.editBasePreviewUrl ?? asset.resultPreviewUrl ?? null
    : asset.resultPreviewUrl ?? asset.editBasePreviewUrl ?? null;
  const showingEditPreview = Boolean(asset.editBasePreviewUrl) && (previewIsActive || !asset.resultPreviewUrl);
  const resultLabel = t(showingEditPreview ? "editor.unsavedPreview" : "editor.savedPreview");
  const maskId = `manual-mask-${asset.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const canPaint = editing && tool !== "pan" && asset.maskRecipe.mode !== "automatic";

  const normalizedPoint = useCallback((clientX: number, clientY: number): MaskPoint | null => {
    const bounds = imageGroupRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const x = (clientX - bounds.left) / bounds.width;
    const y = (clientY - bounds.top) / bounds.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }, []);

  const changeZoom = useCallback((next: number) => setZoom(clamp(next, 0.01, 16)), []);
  const fitToScreen = useCallback(() => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  }, []);

  const commitStroke = useCallback((stroke: BrushStroke | null) => {
    if (!stroke?.points.length) return;
    onMaskChange({ ...asset.maskRecipe, strokes: [...asset.maskRecipe.strokes, stroke] });
    setRedoStack([]);
  }, [asset.maskRecipe, onMaskChange]);

  const undo = useCallback(() => {
    const last = asset.maskRecipe.strokes.at(-1);
    if (!last) return;
    setRedoStack((current) => [...current, last]);
    onMaskChange({ ...asset.maskRecipe, strokes: asset.maskRecipe.strokes.slice(0, -1) });
  }, [asset.maskRecipe, onMaskChange]);

  const redo = useCallback(() => {
    const stroke = redoStack.at(-1);
    if (!stroke) return;
    setRedoStack((current) => current.slice(0, -1));
    onMaskChange({ ...asset.maskRecipe, strokes: [...asset.maskRecipe.strokes, stroke] });
  }, [asset.maskRecipe, onMaskChange, redoStack]);

  const selectSource = (source: SelectionSource) => {
    if (source === selectionSource) {
      setIsSourcePickerOpen(false);
      sourceTriggerRef.current?.focus();
      return;
    }
    if (asset.maskRecipe.strokes.length > 0 && !window.confirm(t("editor.changeSourceConfirm"))) return;
    setRedoStack([]);
    setTool("pan");
    setIsSourcePickerOpen(false);
    if (source === "automatic") {
      onMaskChange({ mode: "automatic", strokes: [] });
      sourceTriggerRef.current?.focus();
      return;
    }
    const nextMode: MaskMode = source === "sam" ? "sam" : "manual";
    onMaskChange({ mode: nextMode, strokes: [] });
    sourceTriggerRef.current?.focus();
  };

  const openSourcePicker = (focusSelected = false) => {
    setIsSourcePickerOpen(true);
    if (focusSelected) {
      requestAnimationFrame(() => sourceOptionRefs.current.find((option) => option?.dataset.source === selectionSource)?.focus());
    }
  };

  const handleSourceOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setIsSourcePickerOpen(false);
      sourceTriggerRef.current?.focus();
      return;
    }
    const lastIndex = sourceOptionRefs.current.length - 1;
    const nextIndex = event.key === "ArrowDown" ? Math.min(lastIndex, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? lastIndex
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    sourceOptionRefs.current[nextIndex]?.focus();
  };

  const selectBrush = (mode: BrushMode) => {
    if (asset.maskRecipe.mode === "automatic") {
      onMaskChange({ ...asset.maskRecipe, mode: "refine" });
    }
    setTool(mode);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const shouldPaint = canPaint && event.button === 0 && !spacePressed.current;
    if (shouldPaint) {
      const point = normalizedPoint(event.clientX, event.clientY);
      if (!point) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerAction.current = { type: "stroke", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
      const stroke = { mode: tool as BrushMode, radius: currentRadius, points: [point] } satisfies BrushStroke;
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
      event.preventDefault();
      return;
    }
    if (!editing || tool === "pan" || spacePressed.current || event.button === 1) {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerAction.current = { type: "pan", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
      event.preventDefault();
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const action = pointerAction.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (action.type === "pan") {
      setPan({ x: action.panX + event.clientX - action.startX, y: action.panY + event.clientY - action.startY });
      return;
    }
    const point = normalizedPoint(event.clientX, event.clientY);
    if (!point) return;
    setActiveStroke((current) => {
      if (!current) return current;
      const previous = current.points.at(-1)!;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const next = distance < Math.max(0.001, current.radius * 0.18)
        ? current
        : { ...current, points: [...current.points, point] };
      activeStrokeRef.current = next;
      return next;
    });
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const action = pointerAction.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (action.type === "stroke") commitStroke(activeStrokeRef.current);
    activeStrokeRef.current = null;
    setActiveStroke(null);
    pointerAction.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeZoom(effectiveZoom * (event.deltaY < 0 ? 1.12 : 0.89));
  };

  const updateComparePosition = (clientX: number) => {
    const bounds = imageGroupRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setComparePosition(clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.code === "Space") {
      spacePressed.current = true;
      event.preventDefault();
    }
    if (!editing) return;
    if (event.key === "Escape") onCancel();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    }
    if (event.key === "[") setBrushSize((value) => clamp(value - 4, 4, 240));
    if (event.key === "]") setBrushSize((value) => clamp(value + 4, 4, 240));
  };

  const imageStyle = {
    width: `${baseImageSize.width}px`,
    height: `${baseImageSize.height}px`,
    transform: `translate(-50%, -50%) rotate(${asset.rotation}deg)`,
  };

  const sourceLabel = t(selectionSource === "automatic" ? "editor.source.auto" : selectionSource === "sam" ? "editor.source.sam" : "editor.source.manualLabel");
  const sourceIcon = selectionSource === "automatic" ? "✦" : selectionSource === "sam" ? "◎" : "✎";
  const sourceDescriptionKey = selectionSource === "automatic" ? "editor.source.autoDescription" : selectionSource === "sam" ? "editor.source.samDescription" : "editor.source.manualDescription";
  const keepLabel = t(selectionSource === "sam" ? "editor.include" : "editor.keepArea");
  const removeLabel = t(selectionSource === "sam" ? "editor.exclude" : selectionSource === "manual" ? "editor.eraseArea" : "editor.removeArea");
  const sourceOptions: Array<{ source: SelectionSource; icon: string; labelKey: string; descriptionKey: string; useCaseKey: string; recommended?: boolean }> = [
    { source: "automatic", icon: "✦", labelKey: "editor.source.auto", descriptionKey: "editor.source.autoDescription", useCaseKey: "editor.source.autoUseCase", recommended: true },
    { source: "sam", icon: "◎", labelKey: "editor.source.sam", descriptionKey: "editor.source.samDescription", useCaseKey: "editor.source.samUseCase" },
    { source: "manual", icon: "✎", labelKey: "editor.source.manualLabel", descriptionKey: "editor.source.manualDescription", useCaseKey: "editor.source.manualUseCase" },
  ];

  return (
    <div
      ref={stageRef}
      className={`preview-stage interactive preview-bg-${background} ${editing ? `mask-editing tool-${tool}` : ""}`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onKeyUp={(event) => { if (event.code === "Space") spacePressed.current = false; }}
      aria-label={t(editing ? "editor.canvasEdit" : "editor.canvasView")}
    >
      <div
        ref={imageGroupRef}
        className="preview-transform"
        style={{ width: displaySize.width, height: displaySize.height, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${effectiveZoom})` }}
      >
        {(viewMode === "original" || viewMode === "compare" || (!resultUrl && viewMode === "result")) && asset.previewUrl && (
          <img className="editor-source-image" src={asset.previewUrl} alt={t("editor.originalAlt", { name: asset.name })} style={imageStyle} onLoad={(event) => {
            if (asset.width === null || asset.height === null) {
              setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
            }
          }} draggable={false} />
        )}
        {viewMode === "result" && resultUrl && <img className="editor-result-image" src={resultUrl} alt={`${asset.name} ${resultLabel}`} draggable={false} />}
        {viewMode === "mask" && asset.maskPreviewUrl && <img className="editor-result-image mask-image" src={asset.maskPreviewUrl} alt={t("editor.maskAlt", { name: asset.name })} draggable={false} />}
        {viewMode === "compare" && resultUrl && (
          <div className={`compare-result-clip preview-bg-${background}`} style={{ clipPath: `inset(0 0 0 ${comparePosition}%)` }}>
            <img className="editor-result-image" src={resultUrl} alt={`${asset.name} ${resultLabel}`} draggable={false} />
          </div>
        )}
        {editing && correctionActive && viewMode !== "compare" && (
          <svg className="mask-overlay" viewBox={`0 0 ${displaySize.width} ${displaySize.height}`} aria-hidden="true">
            {asset.maskRecipe.mode === "manual" && !asset.maskPreviewUrl && (
              <>
                <defs><mask id={maskId}><rect width="100%" height="100%" fill="white" />{visibleStrokes.map((stroke, index) => <StrokeShape key={`mask-${index}`} stroke={stroke} width={displaySize.width} height={displaySize.height} color={stroke.mode === "keep" ? "black" : "white"} />)}</mask></defs>
                <rect width="100%" height="100%" fill="rgba(31, 35, 43, .58)" mask={`url(#${maskId})`} />
              </>
            )}
            {visibleStrokes.map((stroke, index) => <StrokeShape key={`stroke-${index}`} stroke={stroke} width={displaySize.width} height={displaySize.height} color={stroke.mode === "keep" ? "#35d07f" : "#ff506c"} opacity={0.68} />)}
          </svg>
        )}
        {viewMode === "compare" && resultUrl && (
          <div className="compare-control" style={{ left: `${comparePosition}%` }} role="slider" tabIndex={0} aria-label={t("editor.comparePosition")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(comparePosition)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); updateComparePosition(event.clientX); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateComparePosition(event.clientX); }} onKeyDown={(event) => { if (event.key === "ArrowLeft") setComparePosition((value) => clamp(value - 1, 0, 100)); if (event.key === "ArrowRight") setComparePosition((value) => clamp(value + 1, 0, 100)); }}><span aria-hidden="true">↔</span></div>
        )}
      </div>

      {viewMode === "result" && resultUrl && <span className={`preview-kind-label ${showingEditPreview ? "draft" : "saved"}`}>{resultLabel}</span>}
      {viewMode === "compare" && resultUrl && <><span className="compare-label left">{t("common.original")}</span><span className="compare-label right">{resultLabel}</span></>}
      {!editing && viewMode !== "compare" && <span className="selection-mode-badge"><span aria-hidden="true">{sourceIcon}</span>{sourceLabel}</span>}
      {(editing || previewStatus === "updating" || previewStatus === "error") && <div className={`mask-preview-status ${previewStatus === "error" ? "error" : previewStatus}`} role="status" aria-live="polite" title={previewError ?? undefined}>{previewStatus === "updating" && <span className="spinner" />}{t(previewStatus === "updating" ? "editor.previewUpdating" : previewStatus === "error" ? "editor.previewError" : previewStatus === "current" ? "editor.previewCurrent" : "editor.previewReady")}</div>}

      {editing && (
        <>
          <div ref={sourceCardRef} className="editor-source-card" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <span className="editor-source-label">{t("editor.selectionSource")}</span>
            <button
              ref={sourceTriggerRef}
              type="button"
              className={`editor-source-trigger ${isSourcePickerOpen ? "open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={isSourcePickerOpen}
              onClick={() => isSourcePickerOpen ? setIsSourcePickerOpen(false) : openSourcePicker()}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  openSourcePicker(true);
                }
                if (event.key === "Escape" && isSourcePickerOpen) {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsSourcePickerOpen(false);
                }
              }}
            >
              <span className={`editor-source-icon source-${selectionSource}`} aria-hidden="true">{sourceIcon}</span>
              <span className="editor-source-trigger-copy"><strong>{sourceLabel}</strong><small>{t(sourceDescriptionKey)}</small></span>
              <span className="editor-source-chevron" aria-hidden="true">⌄</span>
            </button>
            {isSourcePickerOpen && (
              <div className="editor-source-popover" role="listbox" aria-label={t("editor.chooseSource")}>
                <div className="editor-source-popover-heading">{t("editor.chooseSource")}</div>
                {sourceOptions.map((option, index) => (
                  <button
                    key={option.source}
                    ref={(element) => { sourceOptionRefs.current[index] = element; }}
                    type="button"
                    role="option"
                    aria-selected={selectionSource === option.source}
                    data-source={option.source}
                    className={`editor-source-option ${selectionSource === option.source ? "selected" : ""}`}
                    onClick={() => selectSource(option.source)}
                    onKeyDown={(event) => handleSourceOptionKeyDown(event, index)}
                  >
                    <span className={`editor-source-icon source-${option.source}`} aria-hidden="true">{option.icon}</span>
                    <span className="editor-source-option-copy">
                      <span className="editor-source-option-title"><strong>{t(option.labelKey)}</strong>{option.recommended && <em>{t("editor.recommended")}</em>}</span>
                      <span>{t(option.descriptionKey)}</span>
                      <small>{t(option.useCaseKey)}</small>
                    </span>
                    <span className="editor-source-check" aria-hidden="true">{selectionSource === option.source ? "✓" : ""}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="editor-commit-actions" onPointerDown={(event) => event.stopPropagation()}><button className="editor-cancel" onClick={onCancel}>{t("common.cancel")}</button><button className="editor-apply" onClick={onApply} disabled={previewStatus === "updating"}>{t("editor.apply")}</button></div>
          <div className="editor-toolrail" aria-label={t("editor.tools")} onPointerDown={(event) => event.stopPropagation()}>
            <button className={tool === "keep" ? "active keep" : ""} onClick={() => selectBrush("keep")} title={t("editor.brush", { tool: keepLabel })}><span>＋</span><small>{keepLabel}</small></button>
            <button className={tool === "remove" ? "active remove" : ""} onClick={() => selectBrush("remove")} title={t("editor.brush", { tool: removeLabel })}><span>−</span><small>{removeLabel}</small></button>
            <button className={tool === "pan" ? "active" : ""} onClick={() => setTool("pan")} title={t("editor.pan")}><span>✥</span><small>{t("editor.pan")}</small></button>
          </div>
          {inactiveStrokeCount > 0 && <div className="inactive-corrections" onPointerDown={(event) => event.stopPropagation()}><span>{t("editor.inactive", { count: inactiveStrokeCount })}</span><button onClick={() => onMaskChange({ ...asset.maskRecipe, mode: "refine" })}>{t("editor.reapply")}</button><button onClick={() => onMaskChange({ mode: "automatic", strokes: [] })}>{t("editor.clear")}</button></div>}
          <div className="editor-properties" onPointerDown={(event) => event.stopPropagation()}>
            <div className="editor-mode-summary"><strong>{sourceLabel}</strong><span>{tool === "pan" ? t("editor.pan") : t("editor.brush", { tool: tool === "keep" ? keepLabel : removeLabel })}</span></div>
            <label className="brush-size-control">{t("editor.size")} <input type="range" min="4" max="240" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} disabled={tool === "pan"} /><output>{brushSize}px</output></label>
            <div className="editor-history-actions"><button className="toolbar-icon" onClick={undo} disabled={!asset.maskRecipe.strokes.length} title={t("editor.undo")}>↶</button><button className="toolbar-icon" onClick={redo} disabled={!redoStack.length} title={t("editor.redo")}>↷</button><button className="toolbar-text" onClick={() => { onMaskChange({ ...asset.maskRecipe, strokes: [] }); setRedoStack([]); }} disabled={!asset.maskRecipe.strokes.length}>{t("editor.clearRefinements")}</button></div>
          </div>
        </>
      )}

      <div className="zoom-controls" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => changeZoom(effectiveZoom / 1.2)} aria-label={t("editor.zoomOut")}>−</button><button className="zoom-value" onClick={fitToScreen} title={t("editor.fitTitle")}>{Math.round(effectiveZoom * 100)}%</button><button onClick={() => changeZoom(effectiveZoom * 1.2)} aria-label={t("editor.zoomIn")}>+</button><button className="fit-button" onClick={fitToScreen}>{t("editor.fit")}</button></div>
    </div>
  );
}
