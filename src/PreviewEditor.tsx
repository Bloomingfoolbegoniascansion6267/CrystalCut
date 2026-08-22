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
  const stageRef = useRef<HTMLDivElement>(null);
  const imageGroupRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [sourceSize, setSourceSize] = useState<Size>({ width: asset.width ?? 1, height: asset.height ?? 1 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [comparePosition, setComparePosition] = useState(50);
  const [tool, setTool] = useState<EditorTool>("pan");
  const [brushSize, setBrushSize] = useState(48);
  const [activeStroke, setActiveStroke] = useState<BrushStroke | null>(null);
  const activeStrokeRef = useRef<BrushStroke | null>(null);
  const [redoStack, setRedoStack] = useState<BrushStroke[]>([]);
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
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setComparePosition(50);
    setRedoStack([]);
    setActiveStroke(null);
    setTool("pan");
    activeStrokeRef.current = null;
  }, [asset.id]);

  const rotated = asset.rotation === 90 || asset.rotation === 270;
  const orientedSize = useMemo<Size>(() => rotated
    ? { width: sourceSize.height, height: sourceSize.width }
    : sourceSize, [rotated, sourceSize]);
  const fitScale = Math.min(
    Math.max(1, stageSize.width - (editing ? 112 : 40)) / Math.max(1, orientedSize.width),
    Math.max(1, stageSize.height - (editing ? 136 : 40)) / Math.max(1, orientedSize.height),
  );
  const displaySize = {
    width: Math.max(1, orientedSize.width * fitScale),
    height: Math.max(1, orientedSize.height * fitScale),
  };
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
  const resultLabel = showingEditPreview ? "저장 전 미리보기" : "저장된 결과";
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

  const changeZoom = useCallback((next: number) => setZoom(clamp(next, 0.25, 8)), []);
  const fitToScreen = useCallback(() => {
    setZoom(1);
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
    setRedoStack([]);
    setTool("pan");
    if (source === "automatic") {
      onMaskChange({ ...asset.maskRecipe, mode: "automatic" });
      return;
    }
    const nextMode: MaskMode = source === "sam" ? "sam" : "manual";
    const sourceChanged = sourceForMode(asset.maskRecipe.mode) !== source;
    onMaskChange({ mode: nextMode, strokes: sourceChanged ? [] : asset.maskRecipe.strokes });
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
    changeZoom(zoom * (event.deltaY < 0 ? 1.12 : 0.89));
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

  const sourceLabel = selectionSource === "automatic" ? "자동 감지" : selectionSource === "sam" ? "AI 객체 선택" : "빈 마스크";
  const keepLabel = selectionSource === "sam" ? "포함" : "복원";
  const removeLabel = selectionSource === "sam" ? "제외" : "지우기";

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
      aria-label={editing ? "객체 마스크 편집 캔버스" : "이미지 미리보기. 드래그하여 이동하고 휠로 확대하거나 축소할 수 있습니다."}
    >
      <div
        ref={imageGroupRef}
        className="preview-transform"
        style={{ width: displaySize.width, height: displaySize.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        {(viewMode === "original" || viewMode === "compare" || (!resultUrl && viewMode === "result")) && asset.previewUrl && (
          <img className="editor-source-image" src={asset.previewUrl} alt={`${asset.name} 원본`} style={imageStyle} onLoad={(event) => setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} draggable={false} />
        )}
        {viewMode === "result" && resultUrl && <img className="editor-result-image" src={resultUrl} alt={`${asset.name} ${resultLabel}`} draggable={false} />}
        {viewMode === "mask" && asset.maskPreviewUrl && <img className="editor-result-image mask-image" src={asset.maskPreviewUrl} alt={`${asset.name} 흑백 마스크`} draggable={false} />}
        {viewMode === "compare" && resultUrl && (
          <div className="compare-result-clip" style={{ clipPath: `inset(0 0 0 ${comparePosition}%)` }}>
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
          <div className="compare-control" style={{ left: `${comparePosition}%` }} role="slider" tabIndex={0} aria-label="원본과 수정본 비교 위치" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(comparePosition)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); updateComparePosition(event.clientX); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateComparePosition(event.clientX); }} onKeyDown={(event) => { if (event.key === "ArrowLeft") setComparePosition((value) => clamp(value - 1, 0, 100)); if (event.key === "ArrowRight") setComparePosition((value) => clamp(value + 1, 0, 100)); }}><span aria-hidden="true">↔</span></div>
        )}
      </div>

      {viewMode === "result" && resultUrl && <span className={`preview-kind-label ${showingEditPreview ? "draft" : "saved"}`}>{resultLabel}</span>}
      {viewMode === "compare" && resultUrl && <><span className="compare-label left">원본</span><span className="compare-label right">{resultLabel}</span></>}
      {(editing || previewStatus !== "idle") && <div className={`mask-preview-status ${previewStatus === "error" ? "error" : previewStatus}`} role="status" aria-live="polite" title={previewError ?? undefined}>{previewStatus === "updating" && <span className="spinner" />}{previewStatus === "updating" ? "미리보기 갱신 중" : previewStatus === "error" ? "미리보기 오류" : previewStatus === "current" ? "현재 설정 반영됨" : "미리보기 준비"}</div>}

      {editing && (
        <>
          <div className="editor-source-card" onPointerDown={(event) => event.stopPropagation()}>
            <label htmlFor="mask-selection-source">선택 기준</label>
            <select id="mask-selection-source" value={selectionSource} onChange={(event) => selectSource(event.target.value as SelectionSource)}>
              <option value="automatic">자동 감지</option><option value="sam">AI 객체 선택</option><option value="manual">빈 마스크에서 시작</option>
            </select>
            <small>{selectionSource === "sam" ? "포함·제외 표시로 객체를 찾습니다." : selectionSource === "manual" ? "복원 브러시로 유지할 부분을 칠합니다." : "AI 결과 위에서 복원·지우기로 보정합니다."}</small>
          </div>
          <div className="editor-commit-actions" onPointerDown={(event) => event.stopPropagation()}><button className="editor-cancel" onClick={onCancel}>취소</button><button className="editor-apply" onClick={onApply} disabled={previewStatus === "updating"}>적용하고 닫기</button></div>
          <div className="editor-toolrail" aria-label="보정 도구" onPointerDown={(event) => event.stopPropagation()}>
            <button className={tool === "keep" ? "active keep" : ""} onClick={() => selectBrush("keep")} title={`${keepLabel} 브러시`}><span>＋</span><small>{keepLabel}</small></button>
            <button className={tool === "remove" ? "active remove" : ""} onClick={() => selectBrush("remove")} title={`${removeLabel} 브러시`}><span>−</span><small>{removeLabel}</small></button>
            <button className={tool === "pan" ? "active" : ""} onClick={() => setTool("pan")} title="화면 이동"><span>✥</span><small>이동</small></button>
          </div>
          {inactiveStrokeCount > 0 && <div className="inactive-corrections" onPointerDown={(event) => event.stopPropagation()}><span>저장된 보정 {inactiveStrokeCount}개가 현재 자동 결과에는 적용되지 않습니다.</span><button onClick={() => onMaskChange({ ...asset.maskRecipe, mode: "refine" })}>보정 다시 적용</button><button onClick={() => onMaskChange({ mode: "automatic", strokes: [] })}>삭제</button></div>}
          <div className="editor-properties" onPointerDown={(event) => event.stopPropagation()}>
            <div className="editor-mode-summary"><strong>{sourceLabel}</strong><span>{tool === "pan" ? "화면 이동" : `${tool === "keep" ? keepLabel : removeLabel} 브러시`}</span></div>
            <label className="brush-size-control">크기 <input type="range" min="4" max="240" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} disabled={tool === "pan"} /><output>{brushSize}px</output></label>
            <div className="editor-history-actions"><button className="toolbar-icon" onClick={undo} disabled={!asset.maskRecipe.strokes.length} title="실행 취소 (Ctrl/Cmd+Z)">↶</button><button className="toolbar-icon" onClick={redo} disabled={!redoStack.length} title="다시 실행">↷</button><button className="toolbar-text" onClick={() => { onMaskChange({ ...asset.maskRecipe, strokes: [] }); setRedoStack([]); }} disabled={!asset.maskRecipe.strokes.length}>보정 지우기</button></div>
          </div>
        </>
      )}

      <div className="zoom-controls" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => changeZoom(zoom / 1.2)} aria-label="축소">−</button><button className="zoom-value" onClick={fitToScreen} title="화면에 맞춤">{Math.round(zoom * 100)}%</button><button onClick={() => changeZoom(zoom * 1.2)} aria-label="확대">+</button><button className="fit-button" onClick={fitToScreen}>맞춤</button></div>
    </div>
  );
}
