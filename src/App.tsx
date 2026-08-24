import { ChangeEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppDiagnostics, AppPreferences, BatchProgress, BatchResult, EdgeSettings, ExportPlan, ImageAsset, ManualMaskRecipe, MaskPoint, MetadataOutputPolicy, ModelStatus, OriginalExportResult, OutputFormat, OutputPreset, OutputSettings, PersistedAsset, ResizeOverride, RestoredWorkspace, WorkspaceSnapshot } from "./types";
import { formatBytes, formatDimensions } from "./lib/format";
import SettingsModal, { type SettingsTab } from "./SettingsModal";
import PreviewEditor, { type PreviewBackground, type PreviewStatus, type PreviewViewMode } from "./PreviewEditor";
import SelectionManager from "./SelectionManager";
import Tooltip from "./Tooltip";
import appIconUrl from "../assets/app-icon.svg";
import { useI18n } from "./i18n/I18nProvider";
import type { LanguagePreference } from "./i18n/locale";
import { localizeCommandError } from "./i18n/errors";
import SelectionSourceIcon from "./SelectionSourceIcon";
import { isMaskRecipeReady, selectionSourceForMode } from "./lib/mask";

const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const TOAST_DURATION_MS = 5000;
const AUTO_OPEN_OUTPUT_FOLDER_LIMIT = 3;
const THUMBNAIL_PRELOAD_LIMIT = 32;
const FULL_PREVIEW_MEMORY_LIMIT = 3;
const ASSET_ROW_STRIDE = 59;
const ASSET_LIST_OVERSCAN_ROWS = 8;

const DEFAULT_SETTINGS: OutputSettings = {
  processingMode: "removeBackground",
  format: "png",
  webpQuality: 82,
  webpLossless: false,
  pngEffort: 6,
  resizeMode: "original",
  resizeValue: 2048,
  preventUpscale: true,
  outputLocation: "subfolder",
  outputDirectory: "",
  prefix: "",
  suffix: "_bg",
  nameTemplate: "{prefix}{name}{suffix}",
  preserveMetadata: false,
  preserveGps: false,
  preservePrompt: false,
};

const DEFAULT_EDGE_SETTINGS: EdgeSettings = {
  edgeSmoothing: 2,
  edgeFeather: 1,
  edgeShift: 0,
  alphaThreshold: 2,
  maskContrast: 0,
  preserveOriginalAlpha: true,
};

const DEFAULT_MASK_RECIPE: ManualMaskRecipe = { mode: "automatic", strokes: [] };

interface MaskPreviewBundle {
  resultPreviewUrl: string;
  maskPreviewUrl: string;
  cacheHit?: boolean;
}

interface ModelDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  kind: "text" | "asset" | "canvas";
  textField?: HTMLInputElement | HTMLTextAreaElement | null;
  assetId?: string;
}

type InspectorMode = "current" | "output";
type LibraryMoveTarget = "up" | "down" | "top" | "bottom";

interface LibraryDragSession {
  pointerId: number;
  pointerType: string;
  assetId: string;
  startX: number;
  startY: number;
  lastY: number;
  draggedIds: string[];
  dropIndex: number;
  active: boolean;
  hasMoved: boolean;
  holdTimer: number | null;
}

interface LibraryDragVisual {
  draggedIds: string[];
  dropIndex: number;
  clientX: number;
  clientY: number;
}

const DEFAULT_PREFERENCES: AppPreferences = {
  defaultSettings: DEFAULT_SETTINGS,
  restoreWorkspace: true,
  presets: [],
  language: "system",
};

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

const compactPreviewKey = (value: string) => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `preview-v1-${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
};

const previewRenderIdentity = (asset: ImageAsset, settings: OutputSettings) => ({
  processingMode: settings.processingMode,
  resizeMode: asset.resizeOverride?.axis ?? settings.resizeMode,
  resizeValue: asset.resizeOverride?.value ?? settings.resizeValue,
  preventUpscale: asset.resizeOverride?.preventUpscale ?? settings.preventUpscale,
  edgeSettings: asset.edgeSettings,
});

const createPreviewRequestKey = (asset: ImageAsset, recipe: ManualMaskRecipe, settings: OutputSettings) => compactPreviewKey(JSON.stringify({
  assetId: asset.id,
  path: asset.path,
  sizeBytes: asset.sizeBytes,
  rotation: asset.rotation,
  recipe,
  render: previewRenderIdentity(asset, settings),
}));

const toPersistedAsset = (asset: ImageAsset): PersistedAsset => ({
  id: asset.id,
  name: asset.name,
  path: asset.path,
  sizeBytes: asset.sizeBytes,
  extension: asset.extension,
  width: asset.width,
  height: asset.height,
  exif: asset.exif,
  status: asset.status,
  rotation: asset.rotation,
  outputPath: asset.outputPath,
  outputBytes: asset.outputBytes,
  outputPreviewKey: asset.outputPreviewKey,
  error: asset.error,
  maskRecipe: asset.maskRecipe,
  edgeSettings: asset.edgeSettings,
  metadataPolicy: asset.metadataPolicy,
  resizeOverride: asset.resizeOverride,
});

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    add: <><path d="M12 5v14M5 12h14" /></>,
    folder: <><path d="M3 7.5h6l2 2h10v9.5H3z" /><path d="M3 7.5V5h6l2 2h8v2.5" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m4 17 4.5-4 3.5 3 3.5-4 4.5 5" /></>,
    rotateLeft: <><path d="M4 4v6h6" /><path d="M5.6 16a8 8 0 1 0 .5-8.5L4 10" /></>,
    rotateRight: <><path d="M20 4v6h-6" /><path d="M18.4 16a8 8 0 1 1-.5-8.5L20 10" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" /><path d="M10 11v5M14 11v5" /></>,
    sparkle: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z" /><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    check: <path d="m5 12 4 4L19 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></>,
    brush: <><path d="m14.5 4.5 5 5L10 19H5v-5z" /><path d="m12.5 6.5 5 5" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
  };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function InspectorAccordion({ title, summary, children, defaultOpen = false }: { title: string; summary: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`inspector-accordion output-control ${open ? "open" : ""}`}>
      <button type="button" className="inspector-accordion-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><strong>{title}</strong><small>{summary}</small></span>
        <Icon name="chevron" size={15} />
      </button>
      <div className="inspector-accordion-content" aria-hidden={!open} inert={!open}>
        <div>{children}</div>
      </div>
    </section>
  );
}

function App() {
  const { t, formatLocale, setLanguagePreference } = useI18n();
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [settings, setSettings] = useState<OutputSettings>(DEFAULT_SETTINGS);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [batchCompleted, setBatchCompleted] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<PreviewViewMode>("original");
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>("checker");
  const [isMaskEditing, setIsMaskEditing] = useState(false);
  const [maskDraft, setMaskDraft] = useState<ManualMaskRecipe | null>(null);
  const [pendingMaskEditId, setPendingMaskEditId] = useState<string | null>(null);
  const [maskPreviewStatus, setMaskPreviewStatus] = useState<PreviewStatus>("idle");
  const [maskPreviewError, setMaskPreviewError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(true);
  const [lastOutputBytes, setLastOutputBytes] = useState<number | null>(null);
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [exportPlanRevision, setExportPlanRevision] = useState(0);
  const [savedOutputRevision, setSavedOutputRevision] = useState(0);
  const [isExportingOriginals, setIsExportingOriginals] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isWorkspaceLoaded, setIsWorkspaceLoaded] = useState(!isTauri());
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [isLibraryCollapsed, setIsLibraryCollapsed] = useState(false);
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("output");
  const [settingsBusyAction, setSettingsBusyAction] = useState<"save" | "model" | "cache" | "reset" | null>(null);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isPresetNaming, setIsPresetNaming] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [libraryDragVisual, setLibraryDragVisual] = useState<LibraryDragVisual | null>(null);
  const [libraryAnnouncement, setLibraryAnnouncement] = useState("");
  const [libraryViewport, setLibraryViewport] = useState({ scrollTop: 0, height: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const assetListRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const inspectorPanelRef = useRef<HTMLElement>(null);
  const inspectorScrollPositions = useRef<Record<InspectorMode, number>>({ current: 0, output: 0 });
  const skipNextWorkspaceSave = useRef(false);
  const workspaceSaveTimer = useRef<number | null>(null);
  const workspaceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const maskPreviewRevision = useRef(0);
  const maskPreviewSnapshot = useRef<{ editBasePreviewUrl?: string; maskPreviewUrl?: string; editPreviewKey?: string } | null>(null);
  const latestPreviewKeys = useRef(new Map<string, string>());
  const batchPreviewKeys = useRef(new Map<string, string>());
  const fullPreviewLru = useRef<string[]>([]);
  const assetsRef = useRef<ImageAsset[]>([]);
  const thumbnailLoads = useRef(new Set<string>());
  const thumbnailViewportFrame = useRef<number | null>(null);
  const selectionAnchorId = useRef<string | null>(null);
  const hadSingleInspectorSelection = useRef(false);
  const libraryDragSession = useRef<LibraryDragSession | null>(null);
  const libraryAutoScrollFrame = useRef<number | null>(null);
  const suppressNextAssetClick = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedAssets = useMemo(() => assets.filter((asset) => selectedIdSet.has(asset.id)), [assets, selectedIdSet]);
  const isMultiSelection = selectedAssets.length > 1;
  const contextAsset = contextMenu?.assetId ? assets.find((asset) => asset.id === contextMenu.assetId) ?? null : null;
  const totalBytes = useMemo(() => assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), [assets]);
  const previewRecipe = isMaskEditing ? maskDraft ?? selected?.maskRecipe : selected?.maskRecipe;
  const previewRecipeKey = useMemo(() => previewRecipe ? JSON.stringify(previewRecipe) : "", [previewRecipe]);
  const previewRecipeReady = isMaskRecipeReady(previewRecipe);
  const selectionSource = selectionSourceForMode(previewRecipe?.mode ?? "automatic");
  const edgeNeedsSelection = Boolean(selected && settings.processingMode !== "convert" && !previewRecipeReady);
  const edgeControlsDisabled = !selected || settings.processingMode === "convert" || !previewRecipeReady || isProcessing;
  const hasResultView = previewRecipeReady && Boolean(selected?.resultPreviewUrl || selected?.editBasePreviewUrl);
  const hasMaskView = previewRecipeReady && Boolean(selected?.maskPreviewUrl);
  const effectiveViewMode: PreviewViewMode = settings.processingMode === "convert"
    ? "original"
    : viewMode === "mask" && !hasMaskView
      ? hasResultView ? "result" : "original"
      : (viewMode === "result" || viewMode === "compare") && !hasResultView
        ? "original"
        : viewMode;
  const previewAsset = selected && previewRecipe ? { ...selected, maskRecipe: previewRecipe } : selected;
  const selectedPreviewSettings = useMemo(() => {
    const resizeOverride = selected?.resizeOverride;
    return resizeOverride ? {
      ...settings,
      resizeMode: resizeOverride.axis,
      resizeValue: resizeOverride.value,
      preventUpscale: resizeOverride.preventUpscale,
    } : settings;
  }, [
    selected?.resizeOverride,
    settings.processingMode,
    settings.resizeMode,
    settings.resizeValue,
    settings.preventUpscale,
  ]);
  const switchInspectorMode = useCallback((nextMode: InspectorMode) => {
    if (nextMode === inspectorMode) return;
    const panel = inspectorPanelRef.current;
    if (panel) inspectorScrollPositions.current[inspectorMode] = panel.scrollTop;
    setInspectorMode(nextMode);
    window.requestAnimationFrame(() => {
      if (inspectorPanelRef.current) inspectorPanelRef.current.scrollTop = inspectorScrollPositions.current[nextMode];
    });
  }, [inspectorMode]);

  useEffect(() => {
    const canInspectCurrent = Boolean(selected && !isMultiSelection);
    if (!canInspectCurrent) {
      hadSingleInspectorSelection.current = false;
      switchInspectorMode("output");
    } else if (!hadSingleInspectorSelection.current) {
      hadSingleInspectorSelection.current = true;
      switchInspectorMode("current");
    }
  }, [isMultiSelection, selected?.id, switchInspectorMode]);
  useEffect(() => {
    if (settings.processingMode !== "convert") return;
    setIsMaskEditing(false);
    setMaskDraft(null);
    setViewMode("original");
    setIsAdvancedOpen(false);
    switchInspectorMode("output");
  }, [settings.processingMode]);
  const previewRenderKey = useMemo(() => selected ? JSON.stringify(previewRenderIdentity(selected, settings)) : "", [
    settings.processingMode,
    selectedPreviewSettings.resizeMode,
    selectedPreviewSettings.resizeValue,
    selectedPreviewSettings.preventUpscale,
    selected?.edgeSettings,
  ]);
  const previewRequestKey = useMemo(() => selected && previewRecipe
    ? createPreviewRequestKey(selected, previewRecipe, settings)
    : "", [selected?.id, selected?.path, selected?.sizeBytes, selected?.rotation, previewRecipeKey, previewRenderKey]);
  const retryableAssets = useMemo(
    () => assets.filter((asset) => asset.status === "failed" || asset.status === "cancelled" || asset.status === "interrupted"),
    [assets],
  );
  const completedOutputBytes = useMemo(
    () => assets.reduce((sum, asset) => sum + (asset.status === "done" ? asset.outputBytes ?? 0 : 0), 0),
    [assets],
  );
  const displayOutputBytes = lastOutputBytes ?? (completedOutputBytes > 0 ? completedOutputBytes : null);
  const activePresetId = preferences.presets.find((preset) => JSON.stringify(preset.settings) === JSON.stringify(settings))?.id ?? "";
  const persistedAssets = useMemo(() => assets.map(toPersistedAsset), [assets]);
  const workspaceKey = useMemo(() => JSON.stringify({ items: persistedAssets, settings }), [persistedAssets, settings]);
  const planKey = useMemo(() => JSON.stringify({ revision: exportPlanRevision, settings }), [exportPlanRevision, settings]);

  const invalidateExportPlan = useCallback(() => setExportPlanRevision((revision) => revision + 1), []);
  const invalidateSavedOutput = useCallback(() => setSavedOutputRevision((revision) => revision + 1), []);
  const retainFullPreview = useCallback((assetId: string, patch: Partial<ImageAsset>) => {
    const retainedIds = [
      assetId,
      ...fullPreviewLru.current.filter((id) => id !== assetId),
    ].slice(0, FULL_PREVIEW_MEMORY_LIMIT);
    fullPreviewLru.current = retainedIds;
    const retained = new Set(retainedIds);
    setAssets((current) => current.map((asset) => {
      if (asset.id === assetId) return { ...asset, ...patch };
      if (retained.has(asset.id) || (!asset.previewUrl && !asset.resultPreviewUrl && !asset.editBasePreviewUrl && !asset.maskPreviewUrl)) return asset;
      return {
        ...asset,
        previewUrl: undefined,
        resultPreviewUrl: undefined,
        editBasePreviewUrl: undefined,
        maskPreviewUrl: undefined,
        editPreviewKey: undefined,
      };
    }));
  }, []);

  const addAssets = useCallback((incoming: ImageAsset[]) => {
    if (!incoming.length) return;
    setAssets((current) => {
      const known = new Set(current.map((asset) => asset.path.toLocaleLowerCase()));
      const unique = incoming.filter((asset) => !known.has(asset.path.toLocaleLowerCase()));
      return [...current, ...unique];
    });
    invalidateExportPlan();
    setSelectedId((current) => current ?? incoming[0].id);
    setSelectedIds((current) => current.length ? current : [incoming[0].id]);
    if (!selectionAnchorId.current) selectionAnchorId.current = incoming[0].id;
    setNotice(t("notice.filesLoaded", { count: incoming.length }));
  }, [invalidateExportPlan, t]);

  const preloadThumbnails = useCallback((incoming: ImageAsset[]) => {
    if (!isTauri()) return;
    const queue = incoming.filter((asset) => !asset.thumbnailUrl && !thumbnailLoads.current.has(asset.id));
    if (!queue.length) return;
    for (const asset of queue) thumbnailLoads.current.add(asset.id);
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const asset = queue[cursor++];
        try {
          const thumbnailUrl = await invoke<string>("load_thumbnail", { path: asset.path });
          setAssets((current) => current.map((candidate) => candidate.id === asset.id && !candidate.thumbnailUrl
            ? { ...candidate, thumbnailUrl }
            : candidate));
        } catch {
          // A failed list thumbnail must not block the full preview or batch processing.
        } finally {
          thumbnailLoads.current.delete(asset.id);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  }, []);

  const updateLibraryViewport = useCallback(() => {
    if (thumbnailViewportFrame.current !== null) return;
    thumbnailViewportFrame.current = window.requestAnimationFrame(() => {
      thumbnailViewportFrame.current = null;
      const list = assetListRef.current;
      if (!list) return;
      const nextViewport = { scrollTop: list.scrollTop, height: list.clientHeight };
      setLibraryViewport((current) => current.scrollTop === nextViewport.scrollTop && current.height === nextViewport.height ? current : nextViewport);
      const currentAssets = assetsRef.current;
      const visibleRows = Math.ceil(list.clientHeight / ASSET_ROW_STRIDE);
      const start = Math.max(0, Math.floor(list.scrollTop / ASSET_ROW_STRIDE) - visibleRows);
      const end = Math.min(currentAssets.length, start + visibleRows * 3);
      preloadThumbnails(currentAssets.slice(start, end));
    });
  }, [preloadThumbnails]);

  useEffect(() => {
    const list = assetListRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateLibraryViewport);
    observer.observe(list);
    updateLibraryViewport();
    return () => {
      observer.disconnect();
      if (thumbnailViewportFrame.current !== null) window.cancelAnimationFrame(thumbnailViewportFrame.current);
      thumbnailViewportFrame.current = null;
    };
  }, [updateLibraryViewport]);

  const inspectPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const inspected = await invoke<Omit<ImageAsset, "status" | "rotation">[]>("inspect_paths", { paths });
      const incoming: ImageAsset[] = inspected.map((asset) => ({ ...asset, status: "ready", rotation: 0, maskRecipe: DEFAULT_MASK_RECIPE, edgeSettings: { ...DEFAULT_EDGE_SETTINGS }, metadataPolicy: null, resizeOverride: null }));
      addAssets(incoming);
      preloadThumbnails(incoming.slice(0, THUMBNAIL_PRELOAD_LIMIT));
    } catch (error) {
      setNotice(localizeCommandError(error, t, "error.files.inspect"));
    }
  }, [addAssets, preloadThumbnails]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;

    void (async () => {
      let loadedPreferences = DEFAULT_PREFERENCES;
      try {
        loadedPreferences = await invoke<AppPreferences>("load_app_preferences");
      } catch (error) {
        if (!disposed) setNotice(t("notice.preferencesFallback"));
      }
      if (disposed) return;
      loadedPreferences = { ...loadedPreferences, language: loadedPreferences.language ?? "system" };
      setPreferences(loadedPreferences);
      setLanguagePreference(loadedPreferences.language);

      if (!loadedPreferences.restoreWorkspace) {
        setSettings(loadedPreferences.defaultSettings);
        return;
      }
      try {
        const restored = await invoke<RestoredWorkspace | null>("load_workspace");
        if (disposed) return;
        if (!restored) {
          setSettings(loadedPreferences.defaultSettings);
          return;
        }
        setSettings(restored.settings);
        const restoredItems = restored.items.map((asset) => ({ ...asset, metadataPolicy: asset.metadataPolicy ?? null, resizeOverride: asset.resizeOverride ?? null }));
        setAssets(restoredItems);
        invalidateExportPlan();
        preloadThumbnails(restoredItems.slice(0, THUMBNAIL_PRELOAD_LIMIT));
        setSelectedId(restored.items[0]?.id ?? null);
        setSelectedIds(restored.items[0] ? [restored.items[0].id] : []);
        selectionAnchorId.current = restored.items[0]?.id ?? null;
        if (restored.items.some((asset) => asset.status === "done")) setViewMode("result");
        if (restored.items.length || restored.missingFiles || restored.interrupted) {
          setNotice([
            t("notice.workspaceRestored", { count: restored.items.length }),
            restored.interrupted ? t("notice.workspaceInterrupted", { count: restored.interrupted }) : null,
            restored.missingFiles ? t("notice.workspaceMissing", { count: restored.missingFiles }) : null,
          ].filter(Boolean).join(" · "));
        }
      } catch (error) {
        if (!disposed) setNotice(t("notice.workspaceRestoreFailed"));
      }
    })().finally(() => !disposed && setIsWorkspaceLoaded(true));

    return () => { disposed = true; };
  }, [invalidateExportPlan, preloadThumbnails, setLanguagePreference]);

  useEffect(() => {
    if (!isTauri() || !isWorkspaceLoaded || !preferences.restoreWorkspace) return;
    if (skipNextWorkspaceSave.current) {
      skipNextWorkspaceSave.current = false;
      return;
    }
    const snapshot: WorkspaceSnapshot = { items: persistedAssets, settings };
    const timer = window.setTimeout(() => {
      workspaceSaveTimer.current = null;
      workspaceSaveQueue.current = workspaceSaveQueue.current
        .catch(() => undefined)
        .then(() => invoke<void>("save_workspace", { snapshot }))
        .catch(() => setNotice(t("notice.workspaceSaveFailed")));
    }, 120);
    workspaceSaveTimer.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (workspaceSaveTimer.current === timer) workspaceSaveTimer.current = null;
    };
  }, [workspaceKey, isWorkspaceLoaded, preferences.restoreWorkspace]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over") setIsDragging(true);
        if (event.payload.type === "leave") setIsDragging(false);
        if (event.payload.type === "drop") {
          setIsDragging(false);
          if (isWorkspaceLoaded) void inspectPaths(event.payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [inspectPaths, isWorkspaceLoaded]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;

    void invoke<ModelStatus>("get_model_status")
      .then((status) => !disposed && setModelStatus(status))
      .catch(() => undefined);
    void listen<BatchProgress>("batch-progress", ({ payload }) => {
      if (payload.status === "modelDownloading") {
        setBatchTotal(payload.total);
        setNotice(t("notice.modelsPreparing"));
        return;
      }
      setBatchCompleted(payload.completed);
      setAssets((current) => current.map((asset) => {
        if (asset.id !== payload.assetId) return asset;
        if (payload.status === "queued") return { ...asset, status: "queued", error: undefined };
        if (payload.status === "processing") return { ...asset, status: "processing", error: undefined };
        if (payload.status === "retryingWorker") return { ...asset, status: "retrying", error: t("status.retrying") };
        if (payload.status === "completed") {
          return { ...asset, status: "done", outputPath: payload.outputPath ?? undefined, outputPreviewKey: batchPreviewKeys.current.get(asset.id), resultPreviewUrl: undefined, editBasePreviewUrl: undefined, maskPreviewUrl: undefined, editPreviewKey: undefined, error: undefined };
        }
        if (payload.status === "failed") return { ...asset, status: "failed", error: payload.error || t("notice.processingFailed") };
        if (payload.status === "cancelled") return { ...asset, status: "cancelled", error: t("notice.userCancelled") };
        return asset;
      }));
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });

    return () => {
      disposed = true;
      stop?.();
    };
  }, [t]);

  useEffect(() => {
    if (!isTauri() || !assets.length || isProcessing) {
      if (!assets.length) setExportPlan(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsEstimating(true);
      void invoke<ExportPlan>("prepare_export_plan", {
        items: assets.map((asset, index) => ({ id: asset.id, path: asset.path, rotation: asset.rotation, sequence: index + 1, exif: asset.exif, maskRecipe: asset.maskRecipe, edgeSettings: asset.edgeSettings, metadataPolicy: asset.metadataPolicy, resizeOverride: asset.resizeOverride })),
        settings,
      })
        .then((plan) => {
          if (!cancelled) setExportPlan(plan);
        })
        .catch((error) => {
          if (!cancelled) {
            setExportPlan(null);
            setNotice(localizeCommandError(error, t, "error.output.plan"));
          }
        })
        .finally(() => {
          if (!cancelled) setIsEstimating(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [planKey, isProcessing]);

  useEffect(() => {
    setLastOutputBytes(null);
  }, [planKey, savedOutputRevision]);

  useEffect(() => {
    if (!selected || selected.previewUrl || !isTauri()) return;
    let cancelled = false;
    invoke<string>("load_preview", { path: selected.path })
      .then((previewUrl) => {
        if (!cancelled) {
          retainFullPreview(selected.id, { previewUrl });
        }
      })
      .catch(() => !cancelled && setNotice(t("notice.previewFailed")));
    return () => { cancelled = true; };
  }, [retainFullPreview, selected?.id, selected?.path, selected?.previewUrl]);

  useEffect(() => {
    const revision = ++maskPreviewRevision.current;
    if (!isTauri() || !selected || !previewRecipe || settings.processingMode !== "removeBackground" || isProcessing) {
      setMaskPreviewStatus("idle");
      setMaskPreviewError(null);
      return;
    }
    const hasKeep = previewRecipe.strokes.some((stroke) => stroke.mode === "keep" && stroke.points.length > 0);
    if ((previewRecipe.mode === "manual" || previewRecipe.mode === "sam") && !hasKeep) {
      setMaskPreviewStatus("idle");
      setMaskPreviewError(null);
      return;
    }
    latestPreviewKeys.current.set(selected.id, previewRequestKey);
    if (selected.status === "done" && selected.outputPath && selected.outputPreviewKey === previewRequestKey && !isMaskEditing) {
      setMaskPreviewStatus("idle");
      setMaskPreviewError(null);
      return;
    }
    if (selected.editPreviewKey === previewRequestKey && selected.editBasePreviewUrl && selected.maskPreviewUrl) {
      setMaskPreviewStatus("current");
      setMaskPreviewError(null);
      return;
    }
    setMaskPreviewStatus("idle");
    setMaskPreviewError(null);
    let statusTimer: number | null = null;
    const timer = window.setTimeout(() => {
      const command = previewRecipe.mode === "sam" ? "generate_sam_preview" : "generate_mask_preview";
      const request = invoke<MaskPreviewBundle>(command, {
        request: {
          path: selected.path,
          rotation: selected.rotation,
          maskRecipe: previewRecipe,
          edgeSettings: selected.edgeSettings,
          settings: selectedPreviewSettings,
          requestKey: previewRequestKey,
        },
      });
      statusTimer = window.setTimeout(() => {
        if (maskPreviewRevision.current === revision) setMaskPreviewStatus("updating");
      }, 200);
      void request.then(({ resultPreviewUrl: editBasePreviewUrl, maskPreviewUrl }) => {
        if (statusTimer !== null) window.clearTimeout(statusTimer);
        if (maskPreviewRevision.current !== revision) return;
        if (latestPreviewKeys.current.get(selected.id) === previewRequestKey) {
          retainFullPreview(selected.id, { editBasePreviewUrl, maskPreviewUrl, editPreviewKey: previewRequestKey });
        }
        setMaskPreviewStatus("current");
        setViewMode((current) => current === "mask" ? "mask" : "result");
      }).catch((error) => {
        if (statusTimer !== null) window.clearTimeout(statusTimer);
        if (maskPreviewRevision.current !== revision) return;
        const message = String(error);
        setMaskPreviewStatus("error");
        setMaskPreviewError(message);
        setNotice(t("notice.maskPreviewFailed"));
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (statusTimer !== null) window.clearTimeout(statusTimer);
    };
  }, [retainFullPreview, selected?.id, selected?.path, selected?.rotation, selected?.status, selected?.outputPath, selected?.outputPreviewKey, selected?.editPreviewKey, selected?.editBasePreviewUrl, selected?.maskPreviewUrl, previewRecipeKey, previewRenderKey, previewRequestKey, isMaskEditing, isProcessing]);

  useEffect(() => {
    if (!selected?.outputPath || selected.resultPreviewUrl || !isTauri()) return;
    let cancelled = false;
    invoke<string>("load_preview", { path: selected.outputPath })
      .then((resultPreviewUrl) => {
        if (!cancelled) {
          retainFullPreview(selected.id, { resultPreviewUrl });
        }
      })
      .catch(() => !cancelled && setNotice(t("notice.resultPreviewFailed")));
    return () => { cancelled = true; };
  }, [retainFullPreview, selected?.id, selected?.outputPath, selected?.resultPreviewUrl]);

  const addFilesFromDialog = async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const selection = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: t("filter.images"), extensions: SUPPORTED_EXTENSIONS }],
    });
    if (selection) await inspectPaths(Array.isArray(selection) ? selection : [selection]);
  };

  const addFolderFromDialog = async () => {
    if (!isTauri()) {
      setNotice(t("notice.folderDesktopOnly"));
      return;
    }
    const selection = await openDialog({ multiple: false, directory: true });
    if (selection) await inspectPaths([selection]);
  };

  const addBrowserFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const incoming = files
      .filter((file) => SUPPORTED_EXTENSIONS.includes(file.name.split(".").pop()?.toLowerCase() ?? ""))
      .map((file, index): ImageAsset => ({
        id: `${file.name}-${file.lastModified}-${index}`,
        name: file.name,
        path: file.name,
        sizeBytes: file.size,
        extension: file.name.split(".").pop()?.toLowerCase() ?? "",
        width: null,
        height: null,
        exif: { takenAt: null, camera: null, lens: null, description: null, prompt: null, gpsLatitude: null, gpsLongitude: null, orientation: 1 },
        status: "ready",
        previewUrl: URL.createObjectURL(file),
        rotation: 0,
        maskRecipe: DEFAULT_MASK_RECIPE,
        edgeSettings: { ...DEFAULT_EDGE_SETTINGS },
        metadataPolicy: null,
        resizeOverride: null,
      }));
    addAssets(incoming);
    event.target.value = "";
  };

  const handleBrowserDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isTauri() || !isWorkspaceLoaded) return;
    const files = Array.from(event.dataTransfer.files);
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    if (fileInputRef.current) {
      fileInputRef.current.files = transfer.files;
      fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const rotateSelected = (direction: -1 | 1) => {
    if (!selectedId) return;
    setAssets((current) => current.map((asset) => {
      if (asset.id !== selectedId) return asset;
      const rotatePoint = (point: MaskPoint): MaskPoint => direction === 1
        ? { x: 1 - point.y, y: point.x }
        : { x: point.y, y: 1 - point.x };
      return {
        ...asset,
        rotation: ((asset.rotation + direction * 90 + 360) % 360) as ImageAsset["rotation"],
        maskRecipe: {
          ...asset.maskRecipe,
          strokes: asset.maskRecipe.strokes.map((stroke) => ({
            ...stroke,
            points: stroke.points.map(rotatePoint),
          })),
        },
        status: "ready",
        outputPath: undefined,
        outputBytes: undefined,
        resultPreviewUrl: undefined,
        editBasePreviewUrl: undefined,
        maskPreviewUrl: undefined,
      };
    }));
    invalidateExportPlan();
  };

  const updateSelectedMask = useCallback((maskRecipe: ManualMaskRecipe) => {
    if (!selectedId) return;
    setAssets((current) => current.map((asset) => {
      if (asset.id !== selectedId) return asset;
      const effectiveKey = (recipe: ManualMaskRecipe) => recipe.mode === "automatic" || (recipe.mode === "refine" && recipe.strokes.length === 0)
        ? "automatic"
        : JSON.stringify(recipe);
      const invalidatesResult = effectiveKey(asset.maskRecipe) !== effectiveKey(maskRecipe);
      return {
        ...asset,
        maskRecipe,
        status: invalidatesResult ? "ready" : asset.status,
        outputPath: invalidatesResult ? undefined : asset.outputPath,
        outputBytes: invalidatesResult ? undefined : asset.outputBytes,
        editBasePreviewUrl: invalidatesResult ? asset.editBasePreviewUrl ?? asset.resultPreviewUrl : asset.editBasePreviewUrl,
        resultPreviewUrl: invalidatesResult ? undefined : asset.resultPreviewUrl,
        error: invalidatesResult ? undefined : asset.error,
      };
    }));
    invalidateSavedOutput();
    if (isMaskEditing) setViewMode((current) => current === "mask" ? "mask" : "result");
  }, [invalidateSavedOutput, isMaskEditing, selectedId]);

  const updateSelectedEdgeSettings = useCallback((patch: Partial<EdgeSettings>) => {
    if (!selectedId || !selected || settings.processingMode === "convert" || !isMaskRecipeReady(previewRecipe) || isProcessing) return;
    const edgeSettings = { ...selected.edgeSettings, ...patch };
    if (JSON.stringify(edgeSettings) === JSON.stringify(selected.edgeSettings)) return;
    setMaskPreviewStatus("updating");
    setAssets((current) => current.map((asset) => asset.id === selectedId ? {
      ...asset,
      edgeSettings,
      status: "ready",
      outputPath: undefined,
      outputBytes: undefined,
      resultPreviewUrl: undefined,
      error: undefined,
    } : asset));
    invalidateSavedOutput();
  }, [invalidateSavedOutput, isProcessing, previewRecipe, selected, selectedId, settings.processingMode]);

  const updateSelectedResizeOverride = useCallback((patch: Partial<ResizeOverride>) => {
    if (!selectedId || !selected) return;
    const rotated = selected.rotation === 90 || selected.rotation === 270;
    const sourceWidth = (rotated ? selected.height : selected.width) ?? DEFAULT_SETTINGS.resizeValue;
    const sourceHeight = (rotated ? selected.width : selected.height) ?? DEFAULT_SETTINGS.resizeValue;
    const base = selected.resizeOverride ?? {
      axis: "width" as const,
      value: sourceWidth,
      preventUpscale: settings.preventUpscale,
    };
    let resizeOverride = { ...base, ...patch };
    if (patch.axis && patch.axis !== base.axis) {
      const scale = base.value / Math.max(1, base.axis === "width" ? sourceWidth : sourceHeight);
      resizeOverride = {
        ...resizeOverride,
        value: Math.max(1, Math.min(32_768, Math.round((patch.axis === "width" ? sourceWidth : sourceHeight) * scale))),
      };
    }
    resizeOverride.value = Math.max(1, Math.min(32_768, Math.round(resizeOverride.value)));
    setAssets((current) => current.map((asset) => asset.id === selectedId ? {
      ...asset,
      resizeOverride,
      status: "ready",
      outputPath: undefined,
      outputBytes: undefined,
      resultPreviewUrl: undefined,
      editBasePreviewUrl: undefined,
      maskPreviewUrl: undefined,
      error: undefined,
    } : asset));
    invalidateExportPlan();
    if (settings.processingMode === "removeBackground") setMaskPreviewStatus("updating");
  }, [invalidateExportPlan, selected, selectedId, settings.preventUpscale, settings.processingMode]);

  const resetSelectedResizeOverride = useCallback(() => {
    if (!selectedId) return;
    setAssets((current) => current.map((asset) => asset.id === selectedId ? {
      ...asset,
      resizeOverride: null,
      status: "ready",
      outputPath: undefined,
      outputBytes: undefined,
      resultPreviewUrl: undefined,
      editBasePreviewUrl: undefined,
      maskPreviewUrl: undefined,
      error: undefined,
    } : asset));
    invalidateExportPlan();
    if (settings.processingMode === "removeBackground") setMaskPreviewStatus("updating");
  }, [invalidateExportPlan, selectedId, settings.processingMode]);

  const updateSelectedMetadata = useCallback((patch: Partial<ImageAsset["exif"]>) => {
    if (!selectedId) return;
    setAssets((current) => current.map((asset) => asset.id === selectedId ? {
      ...asset,
      exif: { ...asset.exif, ...patch },
      status: "ready",
      outputPath: undefined,
      outputBytes: undefined,
      resultPreviewUrl: undefined,
      error: undefined,
    } : asset));
    invalidateExportPlan();
  }, [invalidateExportPlan, selectedId]);

  const updateSelectedMetadataPolicy = useCallback((patch: Partial<MetadataOutputPolicy>) => {
    if (!selectedId) return;
    setAssets((current) => current.map((asset) => {
      if (asset.id !== selectedId) return asset;
      const base = asset.metadataPolicy ?? {
        preserveMetadata: settings.preserveMetadata,
        preserveGps: settings.preserveGps,
        preservePrompt: settings.preservePrompt,
      };
      const metadataPolicy = { ...base, ...patch };
      if (!metadataPolicy.preserveMetadata) {
        metadataPolicy.preserveGps = false;
        metadataPolicy.preservePrompt = false;
      }
      return {
        ...asset,
        metadataPolicy,
        status: "ready",
        outputPath: undefined,
        outputBytes: undefined,
        error: undefined,
      };
    }));
    invalidateExportPlan();
  }, [invalidateExportPlan, selectedId, settings.preserveGps, settings.preserveMetadata, settings.preservePrompt]);

  const resetSelectedMetadataPolicy = useCallback(() => {
    if (!selectedId) return;
    setAssets((current) => current.map((asset) => asset.id === selectedId ? {
      ...asset,
      metadataPolicy: null,
      status: "ready",
      outputPath: undefined,
      outputBytes: undefined,
      error: undefined,
    } : asset));
    invalidateExportPlan();
  }, [invalidateExportPlan, selectedId]);

  useEffect(() => {
    setIsMaskEditing(false);
    setMaskDraft(null);
    maskPreviewSnapshot.current = null;
  }, [selectedId]);

  useEffect(() => {
    if (!pendingMaskEditId || selected?.id !== pendingMaskEditId || !selected.previewUrl) return;
    maskPreviewSnapshot.current = {
      editBasePreviewUrl: selected.editBasePreviewUrl,
      maskPreviewUrl: selected.maskPreviewUrl,
      editPreviewKey: selected.editPreviewKey,
    };
    setMaskDraft({
      ...selected.maskRecipe,
      strokes: selected.maskRecipe.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })),
    });
    setViewMode("original");
    setIsMaskEditing(true);
    setPendingMaskEditId(null);
  }, [pendingMaskEditId, selected]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [contextMenu]);

  const removeAssets = (assetIds: string[]) => {
    const removing = new Set(assetIds);
    const removedIndex = assets.findIndex((asset) => removing.has(asset.id));
    const next = assets.filter((asset) => !removing.has(asset.id));
    const retainedSelection = selectedIds.filter((id) => !removing.has(id));
    const adjacent = next[Math.min(Math.max(removedIndex, 0), Math.max(0, next.length - 1))] ?? null;
    const nextActiveId = selectedId && !removing.has(selectedId)
      ? selectedId
      : retainedSelection.at(-1) ?? adjacent?.id ?? null;
    const nextSelection = retainedSelection.length ? retainedSelection : nextActiveId ? [nextActiveId] : [];
    setAssets(next);
    invalidateExportPlan();
    setSelectedIds(nextSelection);
    setSelectedId(nextActiveId);
    if (!selectionAnchorId.current || removing.has(selectionAnchorId.current)) selectionAnchorId.current = nextActiveId;
  };

  const removeAsset = (assetId: string) => removeAssets([assetId]);

  const removeSelected = () => {
    if (selectedId) removeAsset(selectedId);
  };

  const clearWorkspace = async () => {
    if (isProcessing || !window.confirm(t("notice.clearConfirm"))) return;
    if (workspaceSaveTimer.current !== null) {
      window.clearTimeout(workspaceSaveTimer.current);
      workspaceSaveTimer.current = null;
    }
    try {
      if (isTauri()) {
        await workspaceSaveQueue.current.catch(() => undefined);
        await invoke<void>("clear_workspace");
      }
      skipNextWorkspaceSave.current = true;
      setAssets([]);
      setSelectedId(null);
      setSelectedIds([]);
      selectionAnchorId.current = null;
      setSettings(preferences.defaultSettings);
      setLastOutputBytes(null);
      setExportPlan(null);
      setBatchCompleted(0);
      setBatchTotal(0);
      setViewMode("original");
      setMaskDraft(null);
      setNotice(t("notice.workspaceCleared"));
    } catch (error) {
      setNotice(t("notice.workspaceClearFailed"));
    }
  };

  const chooseOutputDirectory = async () => {
    if (!isTauri()) return;
    const selection = await openDialog({ directory: true, multiple: false });
    if (selection) setSettings((current) => ({ ...current, outputDirectory: selection }));
  };

  const openSavedOutputDirectories = async (directories: string[]) => {
    if (!directories.length || !isTauri()) return;
    try {
      let shouldOpen = true;
      if (directories.length > AUTO_OPEN_OUTPUT_FOLDER_LIMIT) {
        shouldOpen = await confirmDialog(t("dialog.openManyOutputFolders", { count: directories.length }), {
          title: t("dialog.openOutputFoldersTitle"),
          kind: "warning",
          okLabel: t("dialog.openOutputFolders"),
          cancelLabel: t("common.cancel"),
        });
      }
      if (!shouldOpen) return;
      await invoke<void>("open_directories", { paths: directories });
    } catch {
      setNotice(t("notice.openOutputFoldersFailed"));
    }
  };

  const processAssets = async (targets: ImageAsset[]) => {
    if (!targets.length) return;
    const incompleteManual = settings.processingMode === "removeBackground" && targets.find((asset) => (asset.maskRecipe.mode === "manual" || asset.maskRecipe.mode === "sam")
      && !asset.maskRecipe.strokes.some((stroke) => stroke.mode === "keep" && stroke.points.length));
    if (incompleteManual) {
      setPendingMaskEditId(incompleteManual.id);
      setSelectedIds([incompleteManual.id]);
      setSelectedId(incompleteManual.id);
      selectionAnchorId.current = incompleteManual.id;
      setNotice(t("notice.paintKeepFirst", { name: incompleteManual.name }));
      return;
    }
    if (!isTauri()) {
      setNotice(t("notice.desktopPreview", { operation: t(settings.processingMode === "convert" ? "operation.convert" : "operation.remove") }));
      return;
    }
    const targetIds = new Set(targets.map((asset) => asset.id));
    const retainedOutputBytes = assets
      .filter((asset) => !targetIds.has(asset.id))
      .reduce((sum, asset) => sum + (asset.outputBytes ?? 0), 0);
    setIsProcessing(true);
    setIsCancelling(false);
    setBatchCompleted(0);
    setBatchTotal(targets.length);
    batchPreviewKeys.current = new Map(targets.map((asset) => [asset.id, createPreviewRequestKey(asset, asset.maskRecipe, settings)]));
    setAssets((current) => current.map((asset) => targetIds.has(asset.id)
      ? { ...asset, status: "queued", outputPath: undefined, outputBytes: undefined, outputPreviewKey: undefined, resultPreviewUrl: undefined, editBasePreviewUrl: undefined, maskPreviewUrl: undefined, editPreviewKey: undefined, error: undefined }
      : asset));
    try {
      const result = await invoke<BatchResult>("process_batch", {
        items: targets.map((asset) => ({
          id: asset.id,
          path: asset.path,
          rotation: asset.rotation,
          sequence: assets.findIndex((candidate) => candidate.id === asset.id) + 1,
          exif: asset.exif,
          maskRecipe: asset.maskRecipe,
          edgeSettings: asset.edgeSettings,
          metadataPolicy: asset.metadataPolicy,
          resizeOverride: asset.resizeOverride,
        })),
        settings,
      });
      const resultById = new Map(result.items.map((item) => [item.assetId, item]));
      setAssets((current) => current.map((asset) => {
        const item = resultById.get(asset.id);
        if (!item) return asset;
        if (item.success) return { ...asset, outputBytes: item.outputBytes ?? undefined, error: undefined };
        return { ...asset, status: item.cancelled ? "cancelled" : "failed", error: item.error || t(item.cancelled ? "notice.userCancelled" : "notice.processingFailed") };
      }));
      void invoke<ModelStatus>("get_model_status").then(setModelStatus).catch(() => undefined);
      setLastOutputBytes(retainedOutputBytes + result.outputBytes);
      if (result.completed > 0) setViewMode("result");
      setNotice([
        t("notice.batchSaved", { count: result.completed }),
        result.failed ? t("notice.batchFailed", { count: result.failed }) : null,
        result.cancelled ? t("notice.batchCancelled", { count: result.cancelled }) : null,
        result.workerRestarts ? t("notice.workerRecovered", { count: result.workerRestarts }) : null,
        t("notice.outputResult", { size: formatBytes(result.outputBytes, formatLocale) }),
      ].filter(Boolean).join(" · "));
      await openSavedOutputDirectories(result.outputDirectories);
    } catch (error) {
      const message = localizeCommandError(error, t, "error.batch.run");
      setAssets((current) => current.map((asset) => asset.status === "queued" || asset.status === "processing" || asset.status === "retrying" ? { ...asset, status: "failed", error: message } : asset));
      setNotice(message);
    } finally {
      batchPreviewKeys.current.clear();
      setIsProcessing(false);
      setIsCancelling(false);
    }
  };

  const cancelProcessing = async () => {
    if (!isProcessing || isCancelling || !isTauri()) return;
    setIsCancelling(true);
    try {
      const accepted = await invoke<boolean>("cancel_batch");
      setNotice(t(accepted ? "notice.cancelPending" : "notice.nothingToCancel"));
      if (!accepted) setIsCancelling(false);
    } catch (error) {
      setIsCancelling(false);
      setNotice(t("notice.cancelFailed"));
    }
  };

  const refreshSettingsData = async () => {
    if (!isTauri()) return;
    try {
      const [nextDiagnostics, nextModelStatus] = await Promise.all([
        invoke<AppDiagnostics>("get_app_diagnostics"),
        invoke<ModelStatus>("get_model_status"),
      ]);
      setDiagnostics(nextDiagnostics);
      setModelStatus(nextModelStatus);
    } catch (error) {
      setNotice(t("notice.diagnosticsFailed"));
    }
  };

  const clearPreviewCacheFromSettings = async () => {
    if (!isTauri() || isProcessing) return;
    setSettingsBusyAction("cache");
    try {
      await invoke<void>("clear_preview_cache");
      await refreshSettingsData();
      setNotice(t("notice.previewCacheCleared"));
    } catch (error) {
      setNotice(localizeCommandError(error, t, "error.preview.cacheClear"));
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const openSettings = (tab: SettingsTab = "general") => {
    setSettingsInitialTab(tab);
    setIsSettingsOpen(true);
    void refreshSettingsData();
  };

  const closeSettings = () => {
    setIsSettingsOpen(false);
    window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  const savePreferences = async (nextPreferences: AppPreferences) => {
    setSettingsBusyAction("save");
    try {
      if (isTauri()) await invoke<void>("save_app_preferences", { preferences: nextPreferences });
      setPreferences(nextPreferences);
      setLanguagePreference(nextPreferences.language);
      if (!assets.length) setSettings(nextPreferences.defaultSettings);
      setNotice(t("notice.preferencesSaved"));
    } catch (error) {
      setNotice(t("notice.preferencesSaveFailed"));
      throw error;
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const persistPresetPreferences = async (nextPreferences: AppPreferences, message: string) => {
    try {
      if (isTauri()) await invoke<void>("save_app_preferences", { preferences: nextPreferences });
      setPreferences(nextPreferences);
      setNotice(message);
    } catch (error) {
      setNotice(t("notice.presetSaveFailed"));
    }
  };

  const applyOutputPreset = (presetId: string) => {
    const preset = preferences.presets.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setSettings({ ...preset.settings });
    setNotice(t("notice.presetLoaded", { name: preset.name }));
  };

  const saveOutputPreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    const existing = preferences.presets.find((preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const preset: OutputPreset = {
      id: existing?.id ?? (crypto.randomUUID?.() ?? `preset-${Date.now()}`),
      name,
      settings: { ...settings },
    };
    const presets = existing
      ? preferences.presets.map((candidate) => candidate.id === existing.id ? preset : candidate)
      : [...preferences.presets, preset];
    await persistPresetPreferences({ ...preferences, presets }, t(existing ? "notice.presetUpdated" : "notice.presetSaved", { name }));
    setPresetName("");
    setIsPresetNaming(false);
  };

  const deleteOutputPreset = async () => {
    if (!activePresetId) return;
    const preset = preferences.presets.find((candidate) => candidate.id === activePresetId);
    if (!preset || !window.confirm(t("notice.presetDeleteConfirm", { name: preset.name }))) return;
    await persistPresetPreferences(
      { ...preferences, presets: preferences.presets.filter((candidate) => candidate.id !== activePresetId) },
      t("notice.presetDeleted", { name: preset.name }),
    );
  };

  const resetPreferences = async () => {
    setSettingsBusyAction("reset");
    try {
      const reset = isTauri()
        ? await invoke<AppPreferences>("reset_app_preferences")
        : { ...DEFAULT_PREFERENCES, defaultSettings: { ...DEFAULT_SETTINGS }, language: "system" as LanguagePreference };
      setPreferences(reset);
      setLanguagePreference(reset.language);
      if (!assets.length) setSettings(reset.defaultSettings);
      setNotice(t("notice.preferencesReset"));
      return reset;
    } catch (error) {
      setNotice(t("notice.preferencesResetFailed"));
      throw error;
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const installModelFromSettings = async () => {
    if (!isTauri()) {
      setNotice(t("notice.modelDesktopOnly"));
      return;
    }
    setSettingsBusyAction("model");
    setModelDownloadProgress(0);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<ModelDownloadProgress>("model-download-progress", ({ payload }) => {
        const percentage = payload.totalBytes > 0 ? Math.round((payload.downloadedBytes / payload.totalBytes) * 100) : 0;
        setModelDownloadProgress(Math.max(0, Math.min(100, percentage)));
      });
      const status = await invoke<ModelStatus>("install_model");
      setModelStatus(status);
      setNotice(t("notice.modelInstalled"));
      await refreshSettingsData();
    } catch (error) {
      setNotice(localizeCommandError(error, t, "error.model.install"));
    } finally {
      unlisten?.();
      setModelDownloadProgress(null);
      setSettingsBusyAction(null);
    }
  };

  const deleteModelFromSettings = async () => {
    if (!isTauri() || !window.confirm(t("notice.modelDeleteConfirm"))) return;
    setSettingsBusyAction("model");
    try {
      const status = await invoke<ModelStatus>("delete_model");
      setModelStatus(status);
      setNotice(t("notice.modelDeleted"));
      await refreshSettingsData();
    } catch (error) {
      setNotice(t("notice.modelDeleteFailed"));
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const chooseDefaultOutputDirectory = async () => {
    if (!isTauri()) return null;
    const selection = await openDialog({ directory: true, multiple: false });
    return typeof selection === "string" ? selection : null;
  };

  const appendNameToken = (token: string) => {
    setSettings((current) => ({ ...current, nameTemplate: `${current.nameTemplate}${token}` }));
  };
  const previewOutputName = exportPlan?.plannedOutputs.find((output) => output.assetId === selectedId)?.path.split(/[\\/]/).pop()
    ?? `${settings.prefix}${selected?.name.replace(/\.[^.]+$/, "") || "image"}${settings.suffix}.${settings.format}`;
  const estimateText = exportPlan?.estimatedOutputBytes == null
    ? null
    : t("estimate.expected", { size: formatBytes(exportPlan.estimatedOutputBytes, formatLocale) });
  const savingsText = exportPlan?.estimatedSavingsPercent == null
    ? null
    : exportPlan.estimatedSavingsPercent >= 0
      ? t("estimate.decrease", { percent: Math.round(exportPlan.estimatedSavingsPercent) })
      : t("estimate.increase", { percent: Math.round(Math.abs(exportPlan.estimatedSavingsPercent)) });
  const processingSummary = t(settings.processingMode === "removeBackground" ? "output.removeBackground" : "output.convertOnly");
  const formatSummary = settings.format === "png"
    ? `PNG · ${t("output.compression")} ${settings.pngEffort}`
    : `WebP · ${settings.webpLossless ? t("output.losslessWebp") : `${t("output.quality")} ${settings.webpQuality}`}`;
  const resizeSummary = settings.resizeMode === "original"
    ? t("output.resize.original")
    : `${t(settings.resizeMode === "percent" ? "output.resize.percent" : "output.resize.longEdge")} · ${settings.resizeValue}${settings.resizeMode === "percent" ? "%" : "px"}`;
  const locationSummary = t(`output.location.${settings.outputLocation}`);
  const presetSummary = preferences.presets.find((preset) => preset.id === activePresetId)?.name
    ?? t(preferences.presets.length ? "output.currentCustom" : "output.noPresets");
  const metadataSummary = !settings.preserveMetadata
    ? t("metadata.none")
    : settings.preserveGps && settings.preservePrompt
      ? t("metadata.gpsAndPrompt")
      : settings.preserveGps
        ? t("metadata.withGps")
        : settings.preservePrompt
          ? t("metadata.withPrompt")
          : t("metadata.safe");
  const selectedMetadataPolicy: MetadataOutputPolicy = selected?.metadataPolicy ?? {
    preserveMetadata: settings.preserveMetadata,
    preserveGps: settings.preserveGps,
    preservePrompt: settings.preservePrompt,
  };
  const selectedMetadataSummary = !selectedMetadataPolicy.preserveMetadata
    ? t("metadata.none")
    : selectedMetadataPolicy.preserveGps && selectedMetadataPolicy.preservePrompt
      ? t("metadata.gpsAndPrompt")
      : selectedMetadataPolicy.preserveGps
        ? t("metadata.withGps")
        : selectedMetadataPolicy.preservePrompt
          ? t("metadata.withPrompt")
          : t("metadata.safe");
  const selectedRotated = selected?.rotation === 90 || selected?.rotation === 270;
  const selectedSourceWidth = selected ? (selectedRotated ? selected.height : selected.width) : null;
  const selectedSourceHeight = selected ? (selectedRotated ? selected.width : selected.height) : null;
  const selectedResizeOverride = selected?.resizeOverride ?? null;
  const selectedOutputDimensions = selected && selectedSourceWidth && selectedSourceHeight && selectedResizeOverride
    ? (() => {
        const sourceAxis = selectedResizeOverride.axis === "width" ? selectedSourceWidth : selectedSourceHeight;
        const requestedScale = selectedResizeOverride.value / sourceAxis;
        const scale = selectedResizeOverride.preventUpscale && requestedScale > 1
          ? 1
          : Math.min(requestedScale, 32_768 / Math.max(selectedSourceWidth, selectedSourceHeight));
        return {
          width: Math.max(1, Math.round(selectedSourceWidth * scale)),
          height: Math.max(1, Math.round(selectedSourceHeight * scale)),
        };
      })()
    : null;
  const selectedResizeSummary = selectedResizeOverride
    ? `${t(selectedResizeOverride.axis === "width" ? "resize.width" : "resize.height")} · ${selectedResizeOverride.value.toLocaleString(formatLocale)}px`
    : `${t("resize.usingGlobal")} · ${resizeSummary}`;
  const selectedEstimatedOutputBytes = selected?.outputBytes
    ?? (selected && exportPlan?.estimatedOutputBytes != null && totalBytes > 0
      ? Math.max(1, Math.round(selected.sizeBytes * exportPlan.estimatedOutputBytes / totalBytes))
      : null);
  const selectedSizeChangePercent = selected && selectedEstimatedOutputBytes != null && selected.sizeBytes > 0
    ? Math.round((selectedEstimatedOutputBytes / selected.sizeBytes - 1) * 100)
    : null;

  const setFormat = (format: OutputFormat) => setSettings((current) => ({ ...current, format }));
  const setMetadataPreservation = (preserveMetadata: boolean) => setSettings((current) => ({
    ...current,
    preserveMetadata,
    preserveGps: preserveMetadata ? current.preserveGps : false,
    preservePrompt: preserveMetadata ? current.preservePrompt : false,
  }));

  const resetFormatSettings = () => {
    setSettings((current) => ({
      ...current,
      format: DEFAULT_SETTINGS.format,
      webpQuality: DEFAULT_SETTINGS.webpQuality,
      webpLossless: DEFAULT_SETTINGS.webpLossless,
      pngEffort: DEFAULT_SETTINGS.pngEffort,
    }));
    setNotice(t("notice.formatReset"));
  };

  const setResizeMode = (resizeMode: OutputSettings["resizeMode"]) => {
    const selectedLongEdge = selected?.width && selected?.height
      ? Math.max(selected.width, selected.height)
      : null;
    setSettings((current) => ({
      ...current,
      resizeMode,
      resizeValue: resizeMode === "percent"
        ? 100
        : resizeMode === "longEdge"
          ? selectedLongEdge ?? DEFAULT_SETTINGS.resizeValue
          : current.resizeValue,
    }));
  };

  const resetOutputSettings = () => {
    setSettings({ ...preferences.defaultSettings });
    setNotice(t("notice.outputReset"));
  };

  const setProcessingMode = (processingMode: OutputSettings["processingMode"]) => {
    setSettings((current) => ({
      ...current,
      processingMode,
      suffix: current.suffix === (processingMode === "convert" ? "_bg" : "_converted")
        ? (processingMode === "convert" ? "_converted" : "_bg")
        : current.suffix,
    }));
    if (processingMode === "convert") {
      setIsMaskEditing(false);
      setMaskDraft(null);
      setViewMode("original");
      switchInspectorMode("output");
    }
  };

  const openMaskEditor = () => {
    if (!selected || settings.processingMode === "convert") return;
    setPendingMaskEditId(null);
    maskPreviewSnapshot.current = {
      editBasePreviewUrl: selected.editBasePreviewUrl,
      maskPreviewUrl: selected.maskPreviewUrl,
      editPreviewKey: selected.editPreviewKey,
    };
    setMaskDraft({
      ...selected.maskRecipe,
      strokes: selected.maskRecipe.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })),
    });
    setViewMode("result");
    setIsMaskEditing(true);
  };

  const openMaskEditorFromToolbar = () => {
    setIsInspectorCollapsed(false);
    switchInspectorMode("current");
    openMaskEditor();
  };

  const toggleAdvancedSettings = () => {
    if (settings.processingMode === "convert") return;
    setIsAdvancedOpen((value) => !value);
  };

  const applyMaskEditor = () => {
    if (maskDraft) updateSelectedMask(maskDraft);
    maskPreviewSnapshot.current = null;
    setMaskDraft(null);
    setIsMaskEditing(false);
    setViewMode("result");
  };

  const cancelMaskEditor = () => {
    const snapshot = maskPreviewSnapshot.current;
    if (snapshot && selectedId) {
      setAssets((current) => current.map((asset) => asset.id === selectedId ? {
        ...asset,
        editBasePreviewUrl: snapshot.editBasePreviewUrl,
        maskPreviewUrl: snapshot.maskPreviewUrl,
        editPreviewKey: snapshot.editPreviewKey,
      } : asset));
    }
    maskPreviewSnapshot.current = null;
    setMaskDraft(null);
    setIsMaskEditing(false);
    setMaskPreviewError(null);
    setMaskPreviewStatus("idle");
    setViewMode(selected?.resultPreviewUrl ? "result" : "original");
  };

  const openAppContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const element = event.target as HTMLElement;
    const textField = element.closest("input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='tel'], textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - (textField ? 188 : 230)),
      kind: textField ? "text" : "canvas",
      textField,
    });
  };

  const openAssetContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, assetId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIdSet.has(assetId)) setSelectedIds([assetId]);
    setSelectedId(assetId);
    selectionAnchorId.current = assetId;
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 470)),
      kind: "asset",
      assetId,
    });
  };

  const revealAssetPath = async (path: string) => {
    setContextMenu(null);
    if (!isTauri()) return;
    try {
      await invoke<void>("reveal_in_file_manager", { path });
    } catch (error) {
      setNotice(t("notice.revealFailed"));
    }
  };

  const runTextMenuAction = async (action: "undo" | "cut" | "copy" | "paste" | "selectAll") => {
    const field = contextMenu?.textField;
    setContextMenu(null);
    if (!field) return;
    field.focus();
    if (action === "selectAll") {
      field.select();
      return;
    }
    if (action === "paste") {
      try {
        const text = await navigator.clipboard.readText();
        if (!document.execCommand("insertText", false, text)) {
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          field.setRangeText(text, start, end, "end");
          field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
        }
      } catch {
        setNotice(t("notice.clipboardPermission"));
      }
      return;
    }
    document.execCommand(action);
  };

  const handleViewTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button[role='tab']:not([aria-disabled='true'])") ?? []);
    if (!tabs.length) return;
    const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  };

  const calculateLibraryDropIndex = (clientY: number, draggedIds: string[]) => {
    const list = assetListRef.current;
    if (!list) return 0;
    const dragged = new Set(draggedIds);
    const contentY = clientY - list.getBoundingClientRect().top + list.scrollTop - 8;
    let remainingIndex = 0;
    for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
      if (dragged.has(assets[assetIndex].id)) continue;
      if (contentY < assetIndex * ASSET_ROW_STRIDE + ASSET_ROW_STRIDE / 2) return remainingIndex;
      remainingIndex += 1;
    }
    return remainingIndex;
  };

  const announceLibraryMove = (count: number, position: number) => {
    setLibraryAnnouncement("");
    window.requestAnimationFrame(() => setLibraryAnnouncement(t("library.reorderMoved", { count, position })));
  };

  const applyLibraryOrder = (draggedIds: string[], dropIndex: number) => {
    const dragged = new Set(draggedIds);
    setAssets((current) => {
      const moving = current.filter((asset) => dragged.has(asset.id));
      const remaining = current.filter((asset) => !dragged.has(asset.id));
      const insertion = Math.max(0, Math.min(dropIndex, remaining.length));
      return [...remaining.slice(0, insertion), ...moving, ...remaining.slice(insertion)];
    });
    invalidateExportPlan();
    announceLibraryMove(draggedIds.length, dropIndex + 1);
  };

  const moveLibraryAssets = (target: LibraryMoveTarget, anchorId: string) => {
    if (isProcessing) return;
    const selectedForMove = selectedIdSet.has(anchorId) ? assets.filter((asset) => selectedIdSet.has(asset.id)).map((asset) => asset.id) : [anchorId];
    const moving = new Set(selectedForMove);
    const firstIndex = assets.findIndex((asset) => moving.has(asset.id));
    const currentDropIndex = assets.slice(0, Math.max(0, firstIndex)).filter((asset) => !moving.has(asset.id)).length;
    const remainingCount = assets.length - selectedForMove.length;
    const nextDropIndex = target === "top" ? 0
      : target === "bottom" ? remainingCount
        : target === "up" ? Math.max(0, currentDropIndex - 1)
          : Math.min(remainingCount, currentDropIndex + 1);
    if (nextDropIndex === currentDropIndex) return;
    applyLibraryOrder(selectedForMove, nextDropIndex);
  };

  const updateLibraryDragPosition = (clientY: number) => {
    const session = libraryDragSession.current;
    if (!session?.active) return;
    session.lastY = clientY;
    session.dropIndex = calculateLibraryDropIndex(clientY, session.draggedIds);
    setLibraryDragVisual({ draggedIds: session.draggedIds, dropIndex: session.dropIndex, clientX: session.startX, clientY });
  };

  const stopLibraryAutoScroll = () => {
    if (libraryAutoScrollFrame.current !== null) window.cancelAnimationFrame(libraryAutoScrollFrame.current);
    libraryAutoScrollFrame.current = null;
  };

  const startLibraryAutoScroll = () => {
    if (libraryAutoScrollFrame.current !== null) return;
    const tick = () => {
      const session = libraryDragSession.current;
      const list = assetListRef.current;
      if (!session?.active || !list) {
        libraryAutoScrollFrame.current = null;
        return;
      }
      const bounds = list.getBoundingClientRect();
      const edge = 42;
      const topPressure = Math.max(0, edge - (session.lastY - bounds.top));
      const bottomPressure = Math.max(0, edge - (bounds.bottom - session.lastY));
      const delta = bottomPressure > 0 ? Math.min(12, bottomPressure * 0.32) : topPressure > 0 ? -Math.min(12, topPressure * 0.32) : 0;
      if (delta !== 0) {
        const before = list.scrollTop;
        list.scrollTop += delta;
        if (list.scrollTop !== before) updateLibraryDragPosition(session.lastY);
      }
      libraryAutoScrollFrame.current = window.requestAnimationFrame(tick);
    };
    libraryAutoScrollFrame.current = window.requestAnimationFrame(tick);
  };

  const activateLibraryDrag = (session: LibraryDragSession) => {
    if (libraryDragSession.current !== session || session.active) return;
    session.active = true;
    session.dropIndex = calculateLibraryDropIndex(session.lastY, session.draggedIds);
    if (!selectedIdSet.has(session.assetId)) {
      setSelectedIds([session.assetId]);
      setSelectedId(session.assetId);
      selectionAnchorId.current = session.assetId;
    }
    document.body.classList.add("library-reordering");
    setLibraryDragVisual({ draggedIds: session.draggedIds, dropIndex: session.dropIndex, clientX: session.startX, clientY: session.lastY });
    startLibraryAutoScroll();
  };

  const handleAssetPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, assetId: string) => {
    if (isProcessing || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const draggedIds = selectedIdSet.has(assetId) && selectedIds.length > 1
      ? assets.filter((asset) => selectedIdSet.has(asset.id)).map((asset) => asset.id)
      : [assetId];
    const session: LibraryDragSession = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      assetId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      draggedIds,
      dropIndex: 0,
      active: false,
      hasMoved: false,
      holdTimer: null,
    };
    libraryDragSession.current = session;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType !== "mouse") {
      session.holdTimer = window.setTimeout(() => activateLibraryDrag(session), 200);
    }
  };

  const handleAssetPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = libraryDragSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.lastY = event.clientY;
    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (!session.active) {
      if (session.pointerType === "mouse" && distance >= 5) activateLibraryDrag(session);
      else if (session.pointerType !== "mouse" && distance >= 9) {
        if (session.holdTimer !== null) window.clearTimeout(session.holdTimer);
        libraryDragSession.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        return;
      }
    }
    if (!session.active) return;
    if (distance >= 3) session.hasMoved = true;
    event.preventDefault();
    updateLibraryDragPosition(event.clientY);
  };

  const finishLibraryDrag = (event: ReactPointerEvent<HTMLButtonElement>, apply: boolean) => {
    const session = libraryDragSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.holdTimer !== null) window.clearTimeout(session.holdTimer);
    if (session.active) {
      suppressNextAssetClick.current = true;
      if (apply && session.hasMoved) applyLibraryOrder(session.draggedIds, session.dropIndex);
      window.setTimeout(() => { suppressNextAssetClick.current = false; }, 0);
    }
    stopLibraryAutoScroll();
    document.body.classList.remove("library-reordering");
    setLibraryDragVisual(null);
    libraryDragSession.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const cancelLibraryDrag = () => {
    const session = libraryDragSession.current;
    if (session?.holdTimer !== null && session?.holdTimer !== undefined) window.clearTimeout(session.holdTimer);
    stopLibraryAutoScroll();
    document.body.classList.remove("library-reordering");
    setLibraryDragVisual(null);
    libraryDragSession.current = null;
  };

  useEffect(() => () => {
    const session = libraryDragSession.current;
    if (session?.holdTimer !== null && session?.holdTimer !== undefined) window.clearTimeout(session.holdTimer);
    if (libraryAutoScrollFrame.current !== null) window.cancelAnimationFrame(libraryAutoScrollFrame.current);
    document.body.classList.remove("library-reordering");
  }, []);

  const selectAssetFromList = (event: ReactMouseEvent<HTMLButtonElement>, assetId: string) => {
    if (suppressNextAssetClick.current) {
      event.preventDefault();
      return;
    }
    const toggle = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;
    const anchorId = selectionAnchorId.current ?? selectedId ?? assetId;
    let nextSelection: string[];

    if (range) {
      const anchorIndex = assets.findIndex((asset) => asset.id === anchorId);
      const targetIndex = assets.findIndex((asset) => asset.id === assetId);
      const start = Math.min(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
      const end = Math.max(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
      const rangeIds = assets.slice(start, end + 1).map((asset) => asset.id);
      nextSelection = toggle ? [...new Set([...selectedIds, ...rangeIds])] : rangeIds;
    } else if (toggle) {
      nextSelection = selectedIdSet.has(assetId)
        ? selectedIds.filter((id) => id !== assetId)
        : [...selectedIds, assetId];
      selectionAnchorId.current = assetId;
    } else {
      nextSelection = [assetId];
      selectionAnchorId.current = assetId;
    }

    setSelectedIds(nextSelection);
    setSelectedId(nextSelection.includes(assetId) ? assetId : nextSelection.at(-1) ?? null);
  };

  const openSingleAsset = (assetId: string) => {
    setSelectedIds([assetId]);
    setSelectedId(assetId);
    selectionAnchorId.current = assetId;
  };

  const clearMultiSelection = () => {
    const retained = selectedId ?? selectedAssets.at(-1)?.id ?? null;
    setSelectedIds(retained ? [retained] : []);
    setSelectedId(retained);
    selectionAnchorId.current = retained;
  };

  const removeMultiSelection = () => {
    if (!selectedAssets.length || isProcessing || !window.confirm(t("management.removeConfirm", { count: selectedAssets.length }))) return;
    removeAssets(selectedAssets.map((asset) => asset.id));
  };

  const exportSelectedOriginals = async () => {
    if (!selectedAssets.length) return;
    if (!isTauri()) {
      setNotice(t("management.desktopOnly"));
      return;
    }
    const outputDirectory = await openDialog({ directory: true, multiple: false, title: t("management.chooseOriginalFolder") });
    if (typeof outputDirectory !== "string") return;
    setIsExportingOriginals(true);
    try {
      const result = await invoke<OriginalExportResult>("export_originals", {
        items: selectedAssets.map((asset) => ({ id: asset.id, path: asset.path })),
        outputDirectory,
      });
      setNotice([
        t("management.originalsExported", { count: result.exported, size: formatBytes(result.bytes, formatLocale) }),
        result.failed ? t("management.exportFailed", { count: result.failed }) : null,
      ].filter(Boolean).join(" · "));
    } catch (error) {
      setNotice(localizeCommandError(error, t, "error.originals.export"));
    } finally {
      setIsExportingOriginals(false);
    }
  };

  const handleLibraryKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && libraryDragSession.current?.active) {
      event.preventDefault();
      cancelLibraryDrag();
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]");
    if (event.altKey && row?.dataset.assetId && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const target: LibraryMoveTarget = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === "Home" ? "top" : "bottom";
      moveLibraryAssets(target, row.dataset.assetId);
      return;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const currentId = row?.dataset.assetId ?? selectedId ?? assets[0]?.id;
      const currentIndex = Math.max(0, assets.findIndex((asset) => asset.id === currentId));
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? Math.max(0, assets.length - 1)
          : Math.max(0, Math.min(assets.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const nextAsset = assets[nextIndex];
      if (!nextAsset) return;
      if (event.shiftKey) {
        const anchorId = selectionAnchorId.current ?? currentId ?? nextAsset.id;
        const anchorIndex = Math.max(0, assets.findIndex((asset) => asset.id === anchorId));
        const start = Math.min(anchorIndex, nextIndex);
        const end = Math.max(anchorIndex, nextIndex);
        setSelectedIds(assets.slice(start, end + 1).map((asset) => asset.id));
      } else {
        setSelectedIds([nextAsset.id]);
        selectionAnchorId.current = nextAsset.id;
      }
      setSelectedId(nextAsset.id);
      const list = assetListRef.current;
      if (list) {
        const rowTop = nextIndex * ASSET_ROW_STRIDE;
        const rowBottom = rowTop + ASSET_ROW_STRIDE;
        if (rowTop < list.scrollTop) list.scrollTop = rowTop;
        else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
        updateLibraryViewport();
      }
      window.requestAnimationFrame(() => assetListRef.current?.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(nextAsset.id)}"]`)?.focus());
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const allIds = assets.map((asset) => asset.id);
      setSelectedIds(allIds);
      setSelectedId((current) => current ?? allIds[0] ?? null);
      selectionAnchorId.current = selectedId ?? allIds[0] ?? null;
    }
  };

  const handleInspectorTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentAvailable = Boolean(selected && !isMultiSelection);
    const nextMode: InspectorMode = event.key === 'ArrowLeft' || event.key === 'Home'
      ? currentAvailable ? 'current' : 'output'
      : 'output';
    switchInspectorMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`inspector-tab-${nextMode}`)?.focus());
  };

  const libraryDraggedIdSet = new Set(libraryDragVisual?.draggedIds ?? []);
  const libraryRemainingAssets = libraryDragVisual ? assets.filter((asset) => !libraryDraggedIdSet.has(asset.id)) : [];
  const libraryDropBeforeId = libraryDragVisual ? libraryRemainingAssets[libraryDragVisual.dropIndex]?.id ?? null : null;
  const libraryDropAtEnd = Boolean(libraryDragVisual && libraryDragVisual.dropIndex >= libraryRemainingAssets.length);
  const libraryDragLead = libraryDragVisual ? assets.find((asset) => asset.id === libraryDragVisual.draggedIds[0]) ?? null : null;
  const visibleRowCount = Math.max(1, Math.ceil(libraryViewport.height / ASSET_ROW_STRIDE));
  const visibleAssetStart = Math.max(0, Math.floor(libraryViewport.scrollTop / ASSET_ROW_STRIDE) - ASSET_LIST_OVERSCAN_ROWS);
  const visibleAssetEnd = Math.min(assets.length, visibleAssetStart + visibleRowCount + ASSET_LIST_OVERSCAN_ROWS * 2);
  const visibleAssets = assets.slice(visibleAssetStart, visibleAssetEnd);
  const librarySpacerBefore = visibleAssetStart * ASSET_ROW_STRIDE;
  const librarySpacerAfter = Math.max(0, (assets.length - visibleAssetEnd) * ASSET_ROW_STRIDE);

  return (
    <div
      className={`app ${isLibraryCollapsed ? "library-collapsed" : ""} ${isInspectorCollapsed ? "inspector-collapsed" : ""}`}
      onContextMenu={openAppContextMenu}
      onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
      onDrop={handleBrowserDrop}
    >
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={addBrowserFiles} />

      <header className="topbar">
        <div className="brand" aria-label="CrystalCut">
          <span className="brand-mark"><img src={appIconUrl} alt="" /></span>
          <span>CrystalCut</span>
        </div>
        <div className="top-processing-mode" role="group" aria-label={t("output.processingMode")}>
          <button type="button" className={`tooltip-host ${settings.processingMode === "removeBackground" ? "active" : ""}`} aria-pressed={settings.processingMode === "removeBackground"} onClick={() => setProcessingMode("removeBackground")}><span>{t("output.removeBackground")}</span><Tooltip side="bottom" align="start">{t("output.removeHelp")}</Tooltip></button>
          <button type="button" className={`tooltip-host ${settings.processingMode === "convert" ? "active" : ""}`} aria-pressed={settings.processingMode === "convert"} onClick={() => setProcessingMode("convert")}><span>{t("output.convertOnly")}</span><Tooltip side="bottom" align="end">{t("output.convertHelp")}</Tooltip></button>
        </div>
        <div className="topbar-actions">
          <button className={`model-pill ${modelStatus?.installed ? "ready" : ""}`} title={t("model.openSettings")} onClick={() => openSettings("model")}>
            <span />{t("model.autoRemove")} {t(modelStatus?.installed ? "status.ready" : "model.installWhenNeeded")}
          </button>
          <button className="button secondary" onClick={addFilesFromDialog} disabled={isProcessing || !isWorkspaceLoaded}><Icon name="add" />{t("app.addFiles")}</button>
          <button className="button secondary desktop-only" onClick={addFolderFromDialog} disabled={isProcessing || !isWorkspaceLoaded}><Icon name="folder" />{t("app.addFolder")}</button>
          <button ref={settingsButtonRef} className="icon-button" aria-label={t("app.settings")} title={t("app.settings")} aria-haspopup="dialog" aria-expanded={isSettingsOpen} aria-controls="preferences-dialog" onClick={() => openSettings("general")}><Icon name="settings" /></button>
        </div>
      </header>

      <main className="workspace">
        <aside className={`library-panel ${isLibraryCollapsed ? "collapsed" : ""}`}>
          <div className="panel-heading">
            <div><span className="eyebrow">{t("library.title")}</span><strong>{assets.length}</strong></div>
            {assets.length > 0 && <span className="muted">{formatBytes(totalBytes, formatLocale)}</span>}
            <button className="panel-toggle tooltip-host" onClick={() => setIsLibraryCollapsed((value) => !value)} aria-expanded={!isLibraryCollapsed} aria-label={t(isLibraryCollapsed ? "library.expand" : "library.collapse")}><Icon name="chevron" size={15} /><Tooltip side="right">{t(isLibraryCollapsed ? "library.expand" : "library.collapse")}</Tooltip></button>
          </div>
          <div ref={assetListRef} className={`asset-list ${libraryDragVisual ? "reordering" : ""}`} role="listbox" aria-multiselectable="true" aria-describedby="library-reorder-help" tabIndex={assets.length && !selectedId ? 0 : undefined} onKeyDown={handleLibraryKeyDown} onScroll={updateLibraryViewport}>
            <span id="library-reorder-help" className="sr-only">{t("library.reorderHint")}</span>
            {assets.length === 0 ? (
              <div className="library-empty"><Icon name="image" size={24} /><span>{t(isWorkspaceLoaded ? "library.empty" : "library.loading")}</span></div>
            ) : <>
              {librarySpacerBefore > 0 && <div className="asset-list-spacer" style={{ height: librarySpacerBefore }} aria-hidden="true" />}
              {visibleAssets.map((asset, visibleIndex) => {
                const index = visibleAssetStart + visibleIndex;
                return (
              <button
                key={asset.id}
                data-asset-id={asset.id}
                className={`asset-row ${selectedIdSet.has(asset.id) ? "selected" : ""} ${asset.id === selectedId ? "active" : ""} ${libraryDraggedIdSet.has(asset.id) ? "dragging" : ""} ${libraryDropBeforeId === asset.id ? "drop-before" : ""}`}
                role="option"
                aria-selected={selectedIdSet.has(asset.id)}
                aria-posinset={index + 1}
                aria-setsize={assets.length}
                tabIndex={asset.id === selectedId ? 0 : -1}
                onClick={(event) => selectAssetFromList(event, asset.id)}
                onContextMenu={(event) => openAssetContextMenu(event, asset.id)}
                onPointerDown={(event) => handleAssetPointerDown(event, asset.id)}
                onPointerMove={handleAssetPointerMove}
                onPointerUp={(event) => finishLibraryDrag(event, true)}
                onPointerCancel={(event) => finishLibraryDrag(event, false)}
              >
                <span className="asset-order-cell"><span className="asset-index">{String(index + 1).padStart(2, "0")}</span><span className="asset-reorder-grip" title={t("library.dragHandle")} aria-hidden="true"><i /><i /><i /><i /><i /><i /></span></span>
                <span className="asset-thumb">{asset.thumbnailUrl || asset.previewUrl ? <img src={asset.thumbnailUrl ?? asset.previewUrl} alt="" draggable={false} style={{ transform: `rotate(${asset.rotation}deg)` }} /> : <Icon name="image" size={16} />}</span>
                <span className="asset-copy">
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>{formatDimensions(asset.width, asset.height, formatLocale, t("format.unknownDimensions"))} · {formatBytes(asset.sizeBytes, formatLocale)}</small>
                </span>
                <span className={`asset-status-badge ${asset.status}`} title={asset.error || t(`status.${asset.status}`)}>{t(`status.short.${asset.status}`)}</span>
              </button>
                );
              })}
              {librarySpacerAfter > 0 && <div className="asset-list-spacer" style={{ height: librarySpacerAfter }} aria-hidden="true" />}
              {libraryDropAtEnd && <div className="library-drop-marker end" aria-hidden="true" />}
            </>}
          </div>
          <div className="sr-only" role="status" aria-live="polite">{libraryAnnouncement}</div>
          {libraryDragVisual && libraryDragLead && <div className="library-drag-ghost" style={{ left: libraryDragVisual.clientX + 12, top: libraryDragVisual.clientY + 12 }} aria-hidden="true"><span className="asset-thumb">{libraryDragLead.thumbnailUrl || libraryDragLead.previewUrl ? <img src={libraryDragLead.thumbnailUrl ?? libraryDragLead.previewUrl} alt="" draggable={false} style={{ transform: `rotate(${libraryDragLead.rotation}deg)` }} /> : <Icon name="image" size={16} />}</span><strong>{libraryDragVisual.draggedIds.length > 1 ? t("library.draggingMany", { count: libraryDragVisual.draggedIds.length }) : libraryDragLead.name}</strong></div>}
          {assets.length > 0 && (
            <div className="library-footer-actions">
              <button className="add-more" onClick={addFilesFromDialog} disabled={isProcessing}><Icon name="add" size={16} />{t("app.addMore")}</button>
              <button className="clear-workspace" onClick={() => void clearWorkspace()} disabled={isProcessing}><Icon name="trash" size={15} />{t("app.clearList")}</button>
            </div>
          )}
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            {isMultiSelection ? <div className="multi-selection-toolbar"><strong>{t("management.selected", { count: selectedAssets.length })}</strong><span>{t("management.toolbarHelp")}</span></div> : <>
            <div className="view-tabs" role="tablist" aria-label={t("preview.mode")}>
              <button className={effectiveViewMode === "original" ? "active" : ""} onClick={() => setViewMode("original")} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "original"}>{t("common.original")}</button>
              {settings.processingMode === "removeBackground" && <>
              <button className={effectiveViewMode === "result" ? "active" : ""} onClick={() => hasResultView ? setViewMode("result") : setNotice(t("notice.previewNeeded"))} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "result"} aria-disabled={!hasResultView}>{t("common.preview")}</button>
              <button className={effectiveViewMode === "mask" ? "active" : ""} onClick={() => hasMaskView ? setViewMode("mask") : setNotice(t("notice.maskNeeded"))} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "mask"} aria-disabled={!hasMaskView}>{t("common.mask")}</button>
              <button className={effectiveViewMode === "compare" ? "active" : ""} onClick={() => hasResultView ? setViewMode("compare") : setNotice(t("notice.compareNeeded"))} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "compare"} aria-disabled={!hasResultView}>{t("common.compare")}</button>
              </>}
            </div>
            <div className="canvas-actions">
              <div className="preview-backgrounds" aria-label={t("preview.background")}>
                <button className={`background-swatch checker ${previewBackground === "checker" ? "active" : ""}`} onClick={() => setPreviewBackground("checker")} title={t("preview.background.checker")} aria-label={t("preview.background.checker")} />
                <button className={`background-swatch light ${previewBackground === "light" ? "active" : ""}`} onClick={() => setPreviewBackground("light")} title={t("preview.background.light")} aria-label={t("preview.background.light")} />
                <button className={`background-swatch dark ${previewBackground === "dark" ? "active" : ""}`} onClick={() => setPreviewBackground("dark")} title={t("preview.background.dark")} aria-label={t("preview.background.dark")} />
              </div>
              {settings.processingMode === "removeBackground" && <><span className="divider" /><button className={`mask-edit-button ${isMaskEditing ? "active" : ""}`} onClick={isMaskEditing ? applyMaskEditor : openMaskEditorFromToolbar} disabled={!selected?.previewUrl || isProcessing}><Icon name="brush" size={16} />{t(isMaskEditing ? "preview.editing" : "selection.editObject")}</button><span className="divider" /></>}
              <button className="icon-button" aria-label={t("preview.rotateLeft")} title={t("preview.rotateLeft")} onClick={() => rotateSelected(-1)} disabled={!selected}><Icon name="rotateLeft" /></button>
              <button className="icon-button" aria-label={t("preview.rotateRight")} title={t("preview.rotateRight")} onClick={() => rotateSelected(1)} disabled={!selected}><Icon name="rotateRight" /></button>
              <span className="divider" />
              <button className="icon-button danger-hover" aria-label={t("preview.removeFromList")} title={t("preview.removeFromList")} onClick={removeSelected} disabled={!selected}><Icon name="trash" /></button>
            </div>
            </>}
          </div>

          <div className={`canvas ${selected ? "has-image" : ""} ${isMultiSelection ? "has-selection-manager" : ""}`}>
            {isMultiSelection ? (
              <SelectionManager assets={selectedAssets} onOpenSingle={openSingleAsset} onClearSelection={clearMultiSelection} onRemoveSelected={removeMultiSelection} onExportOriginals={() => void exportSelectedOriginals()} onExportResults={() => void processAssets(selectedAssets)} disabled={isProcessing || isExportingOriginals} exportingOriginals={isExportingOriginals} />
            ) : selected ? (
              selected.previewUrl ? (
                <PreviewEditor
                  asset={previewAsset ?? selected}
                  viewMode={effectiveViewMode}
                  background={previewBackground}
                  editing={isMaskEditing}
                  onMaskChange={(recipe) => { setMaskDraft(recipe); setMaskPreviewStatus("updating"); }}
                  onApply={applyMaskEditor}
                  onCancel={cancelMaskEditor}
                  previewStatus={maskPreviewStatus}
                  previewError={maskPreviewError}
                />
              ) : <div className="preview-stage"><div className="preview-loading"><span className="spinner" />{t("preview.loading")}</div></div>
            ) : (
              <div className="drop-card">
                <span className="drop-icon"><Icon name="image" size={28} /></span>
                <h1>{t("app.dropTitle")}</h1>
                <p>{t("app.dropDescription")}</p>
                <div className="drop-actions">
                  <button className="button primary compact" onClick={addFilesFromDialog}>{t("app.selectImages")}</button>
                  <button className="button ghost compact desktop-only" onClick={addFolderFromDialog}>{t("app.selectFolder")}</button>
                </div>
                <small>JPEG · PNG · WebP</small>
              </div>
            )}
          </div>

          {selected && !isMultiSelection && (
            <div className="file-info-bar">
              <span><strong>{selected.name}</strong></span>
              <span>{formatDimensions(selected.width, selected.height, formatLocale, t("format.unknownDimensions"))}</span>
              <span>{selected.extension.toUpperCase()}</span>
              {selected.rotation !== 0 && <span>{t("preview.rotation", { degrees: selected.rotation })}</span>}
              {selected.exif.takenAt && <span className="file-exif" title={t("preview.exifDate")}>{selected.exif.takenAt}</span>}
              {selected.exif.camera && <span className="file-exif" title={selected.exif.lens ?? t("preview.exifCamera")}>{selected.exif.camera}</span>}
              <span className={`file-status ${selected.status}`}>{t(`status.${selected.status}`)}</span>
              <span className="file-size-change" title={selected.outputBytes != null ? t("output.actualSize") : t("output.estimatedSize")}><span>{formatBytes(selected.sizeBytes, formatLocale)}</span><b aria-hidden="true">→</b><span>{selectedEstimatedOutputBytes != null ? `${selected.outputBytes == null ? "≈" : ""}${formatBytes(selectedEstimatedOutputBytes, formatLocale)}` : isEstimating ? t("output.calculating") : "—"}</span>{selectedSizeChangePercent != null && <em className={selectedSizeChangePercent <= 0 ? "decrease" : "increase"}>{selectedSizeChangePercent > 0 ? "+" : ""}{selectedSizeChangePercent}%</em>}</span>
            </div>
          )}
        </section>

        <aside ref={inspectorPanelRef} className={`inspector-panel ${isInspectorCollapsed ? "collapsed" : ""}`}>
          <div className="inspector-header">
            <span className="eyebrow">{t(inspectorMode === "current" ? "common.currentFile" : "output.title")}</span>
            {inspectorMode === "output" && <button className="text-button" onClick={resetOutputSettings}>{t("output.reset")}</button>}
            <button className="panel-toggle inspector-toggle tooltip-host" onClick={() => setIsInspectorCollapsed((value) => !value)} aria-expanded={!isInspectorCollapsed} aria-label={t(isInspectorCollapsed ? "output.expand" : "output.collapse")}><Icon name="chevron" size={15} /><Tooltip side="left">{t(isInspectorCollapsed ? "output.expand" : "output.collapse")}</Tooltip></button>
          </div>

          <div className="inspector-tabs" role="tablist" aria-label={t("output.title")} onKeyDown={handleInspectorTabKeyDown}>
            <button id="inspector-tab-current" type="button" role="tab" aria-selected={inspectorMode === "current"} aria-controls="current-file-inspector" aria-disabled={!selected || isMultiSelection} tabIndex={inspectorMode === "current" ? 0 : -1} className={`tooltip-host ${inspectorMode === "current" ? "active" : ""}`} onClick={() => { if (selected && !isMultiSelection) switchInspectorMode("current"); }}><span className="inspector-tab-label">{t("common.currentFile")}</span><Tooltip side="bottom" align="start">{t(!selected || isMultiSelection ? "selection.emptyHelp" : "inspector.currentScope")}</Tooltip></button>
            <button id="inspector-tab-output" type="button" role="tab" aria-selected={inspectorMode === "output"} aria-controls="output-inspector" tabIndex={inspectorMode === "output" ? 0 : -1} className={`tooltip-host ${inspectorMode === "output" ? "active" : ""}`} onClick={() => switchInspectorMode("output")}><span className="inspector-tab-label">{t("output.title")}</span><Tooltip side="bottom" align="end">{t("inspector.outputScope")}</Tooltip></button>
          </div>

          <div id="output-inspector" className={`inspector-tab-panel ${inspectorMode === "output" ? "active" : ""}`} role="tabpanel" aria-labelledby="inspector-tab-output" hidden={inspectorMode !== "output"} inert={inspectorMode !== "output"}>
          <InspectorAccordion title={t("output.preset")} summary={presetSummary}>
          <section className="setting-section preset-section">
            <div className="label-row"><label className="setting-label" htmlFor="output-preset">{t("output.preset")}</label><span className="scope-badge">{t("common.allFiles")}</span></div>
            <div className="preset-controls">
              <select id="output-preset" value={activePresetId} onChange={(event) => applyOutputPreset(event.target.value)}>
                <option value="">{t(preferences.presets.length ? "output.currentCustom" : "output.noPresets")}</option>
                {preferences.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </div>
            <div className="preset-actions"><button type="button" onClick={() => { setPresetName(preferences.presets.find((preset) => preset.id === activePresetId)?.name ?? ""); setIsPresetNaming(true); }}>{t("output.savePreset")}</button><button type="button" className="danger" onClick={() => void deleteOutputPreset()} disabled={!activePresetId}>{t("output.deletePreset")}</button></div>
            {isPresetNaming && <div className="preset-name-row"><input autoFocus type="text" value={presetName} maxLength={40} placeholder={t("output.presetPlaceholder")} onChange={(event) => setPresetName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveOutputPreset(); if (event.key === "Escape") setIsPresetNaming(false); }} /><button type="button" onClick={() => void saveOutputPreset()} disabled={!presetName.trim()}>{t("common.save")}</button><button type="button" onClick={() => setIsPresetNaming(false)}>{t("common.cancel")}</button></div>}
            <p className="setting-help">{t("output.presetHelp")}</p>
          </section>
          </InspectorAccordion>

          <InspectorAccordion title={t("output.processingMode")} summary={processingSummary} defaultOpen>
          <section className="setting-section">
            <label className="setting-label">{t("output.processingMode")}</label>
            <div className="segmented processing-mode">
              <button className={settings.processingMode === "removeBackground" ? "active" : ""} onClick={() => setProcessingMode("removeBackground")}>{t("output.removeBackground")}</button>
              <button className={settings.processingMode === "convert" ? "active" : ""} onClick={() => setProcessingMode("convert")}>{t("output.convertOnly")}</button>
            </div>
            <p className="setting-help">{settings.processingMode === "removeBackground"
              ? t("output.removeHelp")
              : t("output.convertHelp")}</p>
          </section>
          </InspectorAccordion>

          <InspectorAccordion title={t("output.format")} summary={formatSummary}>
          <section className="setting-section">
            <div className="setting-title-row"><span className="setting-label">{t("output.format")}</span><button type="button" onClick={resetFormatSettings}>{t("common.default")}</button></div>
            <div className="segmented">
              <button className={settings.format === "png" ? "active" : ""} onClick={() => setFormat("png")}>PNG</button>
              <button className={settings.format === "webp" ? "active" : ""} onClick={() => setFormat("webp")}>WebP</button>
            </div>
            <p className="setting-help">{settings.format === "png"
              ? t(settings.processingMode === "removeBackground" ? "output.pngRemoveHelp" : "output.pngConvertHelp")
              : t(settings.processingMode === "removeBackground" ? "output.webpRemoveHelp" : "output.webpConvertHelp")}</p>

            {settings.format === "webp" ? (
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="quality">{t("output.quality")}</label><output>{settings.webpQuality}</output></div>
                <input id="quality" type="range" min="1" max="100" value={settings.webpQuality} onChange={(e) => setSettings({ ...settings, webpQuality: Number(e.target.value) })} />
                <label className="check-row"><input type="checkbox" checked={settings.webpLossless} onChange={(e) => setSettings({ ...settings, webpLossless: e.target.checked })} /><span><Icon name="check" size={13} /></span>{t("output.losslessWebp")}</label>
              </div>
            ) : (
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="effort">{t("output.compression")}</label><output>{settings.pngEffort}</output></div>
                <input id="effort" type="range" min="1" max="9" value={settings.pngEffort} onChange={(e) => setSettings({ ...settings, pngEffort: Number(e.target.value) })} />
                <p className="setting-help flush">{t("output.pngCompressionHelp")}</p>
              </div>
            )}
          </section>
          </InspectorAccordion>

          <InspectorAccordion title={t("metadata.title")} summary={metadataSummary} defaultOpen>
          <section className="setting-section metadata-section">
            <div className="setting-title-row"><span className="setting-label">{t("metadata.title")}</span></div>
            <label className="check-row"><input type="checkbox" checked={settings.preserveMetadata} onChange={(event) => setMetadataPreservation(event.target.checked)} /><span><Icon name="check" size={13} /></span>{t("output.keepMetadata")}</label>
            <p className="setting-help flush">{t("metadata.safeHelp")}</p>
            <div className={`metadata-policy-options ${settings.preserveMetadata ? "" : "is-disabled"}`}>
              <label className={`check-row ${settings.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={settings.preserveGps} onChange={(event) => setSettings({ ...settings, preserveGps: event.target.checked })} disabled={!settings.preserveMetadata} /><span><Icon name="check" size={13} /></span>{t("metadata.keepGps")}</label>
              <p className="setting-help flush warning-text">{t("metadata.gpsWarning")}</p>
              <label className={`check-row ${settings.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={settings.preservePrompt} onChange={(event) => setSettings({ ...settings, preservePrompt: event.target.checked })} disabled={!settings.preserveMetadata} /><span><Icon name="check" size={13} /></span>{t("metadata.keepPrompt")}</label>
            </div>
          </section>
          </InspectorAccordion>

          <InspectorAccordion title={t("output.resize")} summary={resizeSummary}>
          <section className="setting-section">
            <label className="setting-label" htmlFor="resize-mode">{t("output.resize")}</label>
            <select id="resize-mode" value={settings.resizeMode} onChange={(e) => setResizeMode(e.target.value as OutputSettings["resizeMode"])}>
              <option value="original">{t("output.resize.original")}</option>
              <option value="percent">{t("output.resize.percent")}</option>
              <option value="longEdge">{t("output.resize.longEdge")}</option>
            </select>
            {settings.resizeMode !== "original" && (
              <div className="input-with-unit">
                <input type="number" min="1" max={settings.resizeMode === "percent" ? 1000 : 32768} value={settings.resizeValue} onChange={(e) => setSettings({ ...settings, resizeValue: Number(e.target.value) })} />
                <span>{settings.resizeMode === "percent" ? "%" : "px"}</span>
              </div>
            )}
            <label className="check-row"><input type="checkbox" checked={settings.preventUpscale} onChange={(e) => setSettings({ ...settings, preventUpscale: e.target.checked })} /><span><Icon name="check" size={13} /></span>{t("output.noUpscale")}</label>
          </section>
          </InspectorAccordion>

          <InspectorAccordion title={t("output.location")} summary={locationSummary}>
          <section className="setting-section">
            <label className="setting-label" htmlFor="save-location">{t("output.location")}</label>
            <select id="save-location" value={settings.outputLocation} onChange={(e) => setSettings({ ...settings, outputLocation: e.target.value as OutputSettings["outputLocation"] })}>
              <option value="subfolder">{t("output.location.subfolder")}</option>
              <option value="sameFolder">{t("output.location.sameFolder")}</option>
              <option value="custom">{t("output.location.custom")}</option>
            </select>
            {settings.outputLocation === "custom" && (
              <button className="path-picker" onClick={chooseOutputDirectory} title={settings.outputDirectory || t("output.chooseFolder")}>
                <Icon name="folder" size={16} /><span>{settings.outputDirectory || t("output.chooseFolder")}</span><Icon name="chevron" size={14} />
              </button>
            )}
          </section>
          </InspectorAccordion>

          <InspectorAccordion title={t("output.fileName")} summary={previewOutputName}>
          <section className="setting-section naming-section">
            <div className="label-row"><label className="setting-label" htmlFor="name-template">{t("output.fileName")}</label><span className="scope-badge neutral">{t("output.namingRule")}</span></div>
            <div className="name-grid">
              <label><span>{t("output.prefix")}</span><input type="text" value={settings.prefix} placeholder="cut_" onChange={(e) => setSettings({ ...settings, prefix: e.target.value })} /></label>
              <label><span>{t("output.suffix")}</span><input type="text" value={settings.suffix} placeholder={settings.processingMode === "convert" ? "_converted" : "_bg"} onChange={(e) => setSettings({ ...settings, suffix: e.target.value })} /></label>
            </div>
            <label className="template-field" htmlFor="name-template">
              <span>{t("output.template")}</span>
              <input id="name-template" type="text" value={settings.nameTemplate} spellCheck={false} onChange={(e) => setSettings({ ...settings, nameTemplate: e.target.value })} />
            </label>
            <div className="token-row" aria-label={t("output.tokens")}>
              <button type="button" onClick={() => appendNameToken("{taken:yyMMdd_HHmmss}")}>{t("output.token.date")}</button>
              <button type="button" onClick={() => appendNameToken("{seq:03}")}>{t("output.token.sequence")}</button>
              <button type="button" onClick={() => appendNameToken("{camera}")}>{t("output.token.camera")}</button>
              <button type="button" onClick={() => appendNameToken("{lens}")}>{t("output.token.lens")}</button>
            </div>
            <div className="name-preview"><span>{t(isEstimating ? "output.calculating" : "common.preview")}</span><strong>{previewOutputName}</strong></div>
            {exportPlan?.warnings[0] && <p className="setting-warning">{t(`warning.${exportPlan.warnings[0].code}`, { count: exportPlan.warnings[0].count })}</p>}
          </section>
          </InspectorAccordion>

          </div>

          <div id="current-file-inspector" className={`inspector-tab-panel ${inspectorMode === "current" ? "active" : ""}`} role="tabpanel" aria-labelledby="inspector-tab-current" hidden={inspectorMode !== "current"} inert={inspectorMode !== "current"}>
          {selected?.error && <div className="current-file-error" role="alert"><strong>{t(`status.${selected.status}`)}</strong><span>{selected.error}</span></div>}
          {!isMultiSelection && <section className={`setting-section mask-summary-section current-file-control current-removal-control ${settings.processingMode === "convert" ? "is-disabled" : ""}`} aria-disabled={settings.processingMode === "convert"}>
            <div className="label-row"><span className="setting-label">{t("selection.object")}</span>{selected && settings.processingMode !== "convert"
              ? <span className={`state-badge-small selection-source-badge source-${selectionSource}`}><SelectionSourceIcon source={selectionSource} size={16} />{t(selectionSource === "automatic" ? "editor.source.auto" : selectionSource === "sam" ? "editor.source.sam" : "editor.source.manualLabel")}</span>
              : <span className="state-badge-small">{t(settings.processingMode === "convert" ? "selection.removeModeOnly" : "selection.livePreview")}</span>}</div>
            <p className="setting-help flush">{settings.processingMode === "convert"
              ? t("selection.removeModeOnly")
              : !selected
              ? t("selection.emptyHelp")
              : selected.maskRecipe.mode === "manual"
                ? t("selection.manualSummary", { count: selected.maskRecipe.strokes.length })
                : selected.maskRecipe.mode === "sam"
                  ? t("selection.samSummary", { count: selected.maskRecipe.strokes.length })
                  : selected.maskRecipe.mode === "refine"
                    ? t("selection.refineSummary", { count: selected.maskRecipe.strokes.length })
                    : t("editor.source.auto")}</p>
            <button className={`button secondary mask-summary-button ${isMaskEditing ? "active" : ""}`} onClick={isMaskEditing ? applyMaskEditor : openMaskEditor} disabled={!selected?.previewUrl || isProcessing || settings.processingMode === "convert"}><Icon name="brush" size={15} />{t(isMaskEditing ? "preview.editing" : "selection.editObject")}</button>
          </section>}

          {!isMultiSelection && <button className={`advanced-row current-file-control current-removal-control ${isAdvancedOpen ? "open" : ""}`} onClick={toggleAdvancedSettings} aria-expanded={isAdvancedOpen} aria-controls="advanced-settings" disabled={settings.processingMode === "convert"}>
            <span className="advanced-row-copy">
              <span>{t("edge.selectedTitle")}</span>
              {settings.processingMode === "convert" ? <small className="edge-preview-state">{t("selection.removeModeOnly")}</small> : selected && <small className={`edge-preview-state ${edgeNeedsSelection ? "selection-required" : maskPreviewStatus}`}>
                {edgeNeedsSelection
                  ? <Icon name="brush" size={11} />
                  : maskPreviewStatus === "updating"
                  ? <span className="spinner" />
                  : maskPreviewStatus !== "error" && hasResultView
                    ? <Icon name="check" size={11} />
                    : null}
                {t(edgeNeedsSelection
                  ? "edge.selectionRequired"
                  : maskPreviewStatus === "updating"
                  ? "preview.updating"
                  : maskPreviewStatus === "error"
                    ? "editor.previewError"
                    : hasResultView
                      ? "preview.current"
                      : "preview.preparing")}
              </small>}
            </span>
            <Icon name="chevron" size={15} />
          </button>}
          {!isMultiSelection && (
            <div id="advanced-settings" className={`advanced-settings-collapse current-file-control ${isAdvancedOpen ? "open" : ""}`} aria-hidden={!isAdvancedOpen} inert={!isAdvancedOpen}>
            <div>
            <section className={`setting-section advanced-settings current-removal-control ${settings.processingMode === "convert" ? "is-disabled" : ""}`} aria-disabled={edgeControlsDisabled}>
              <div className="advanced-section-title"><div><strong>{t("edge.selectedTitle")}</strong></div><button type="button" onClick={() => updateSelectedEdgeSettings({ ...DEFAULT_EDGE_SETTINGS })} disabled={edgeControlsDisabled}>{t("common.default")}</button></div>
              {edgeNeedsSelection && <div id="edge-selection-required" className="edge-selection-required" role="note">
                <SelectionSourceIcon source={selectionSource} size={22} />
                <div><strong>{t("edge.selectionRequired")}</strong><span>{t("edge.selectionRequiredHelp")}</span></div>
                <button type="button" onClick={openMaskEditor} disabled={!selected?.previewUrl || isProcessing}>{t("selection.editObject")}</button>
              </div>}
              <div className={`edge-control-fields ${edgeControlsDisabled ? "is-disabled" : ""}`}>
              <div className="sub-setting first">
                <div className="label-row"><label htmlFor="edge-smoothing">{t("edge.smoothing")}</label><output>{selected?.edgeSettings.edgeSmoothing ?? DEFAULT_EDGE_SETTINGS.edgeSmoothing}</output></div>
                <input id="edge-smoothing" type="range" min="0" max="10" value={selected?.edgeSettings.edgeSmoothing ?? DEFAULT_EDGE_SETTINGS.edgeSmoothing} onChange={(event) => updateSelectedEdgeSettings({ edgeSmoothing: Number(event.target.value) })} disabled={edgeControlsDisabled} aria-describedby={edgeNeedsSelection ? "edge-selection-required" : undefined} />
                <p className="setting-help flush">{t("edge.smoothingHelp")}</p>
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="edge-feather">{t("edge.feather")}</label><output>{selected?.edgeSettings.edgeFeather ?? DEFAULT_EDGE_SETTINGS.edgeFeather}px</output></div>
                <input id="edge-feather" type="range" min="0" max="20" value={selected?.edgeSettings.edgeFeather ?? DEFAULT_EDGE_SETTINGS.edgeFeather} onChange={(event) => updateSelectedEdgeSettings({ edgeFeather: Number(event.target.value) })} disabled={edgeControlsDisabled} aria-describedby={edgeNeedsSelection ? "edge-selection-required" : undefined} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="edge-shift">{t("edge.shift")}</label><output>{(selected?.edgeSettings.edgeShift ?? DEFAULT_EDGE_SETTINGS.edgeShift) > 0 ? "+" : ""}{selected?.edgeSettings.edgeShift ?? DEFAULT_EDGE_SETTINGS.edgeShift}px</output></div>
                <input id="edge-shift" type="range" min="-8" max="8" value={selected?.edgeSettings.edgeShift ?? DEFAULT_EDGE_SETTINGS.edgeShift} onChange={(event) => updateSelectedEdgeSettings({ edgeShift: Number(event.target.value) })} disabled={edgeControlsDisabled} aria-describedby={edgeNeedsSelection ? "edge-selection-required" : undefined} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="alpha-threshold">{t("edge.alphaThreshold")}</label><output>{selected?.edgeSettings.alphaThreshold ?? DEFAULT_EDGE_SETTINGS.alphaThreshold}%</output></div>
                <input id="alpha-threshold" type="range" min="0" max="30" value={selected?.edgeSettings.alphaThreshold ?? DEFAULT_EDGE_SETTINGS.alphaThreshold} onChange={(event) => updateSelectedEdgeSettings({ alphaThreshold: Number(event.target.value) })} disabled={edgeControlsDisabled} aria-describedby={edgeNeedsSelection ? "edge-selection-required" : undefined} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="mask-contrast">{t("edge.contrast")}</label><output>{(selected?.edgeSettings.maskContrast ?? DEFAULT_EDGE_SETTINGS.maskContrast) > 0 ? "+" : ""}{selected?.edgeSettings.maskContrast ?? DEFAULT_EDGE_SETTINGS.maskContrast}</output></div>
                <input id="mask-contrast" type="range" min="-50" max="50" value={selected?.edgeSettings.maskContrast ?? DEFAULT_EDGE_SETTINGS.maskContrast} onChange={(event) => updateSelectedEdgeSettings({ maskContrast: Number(event.target.value) })} disabled={edgeControlsDisabled} aria-describedby={edgeNeedsSelection ? "edge-selection-required" : undefined} />
              </div>
              <label className="check-row"><input type="checkbox" checked={selected?.edgeSettings.preserveOriginalAlpha ?? DEFAULT_EDGE_SETTINGS.preserveOriginalAlpha} onChange={(event) => updateSelectedEdgeSettings({ preserveOriginalAlpha: event.target.checked })} disabled={edgeControlsDisabled} aria-describedby={edgeNeedsSelection ? "edge-selection-required" : undefined} /><span><Icon name="check" size={13} /></span>{t("edge.keepOriginalAlpha")}</label>
              <p className="setting-help">{t("edge.fileOnlyHelp")}</p>
              </div>
            </section>
            </div>
            </div>
          )}

          {selected && <InspectorAccordion title={t("resize.fileTitle")} summary={selectedResizeSummary} defaultOpen>
            <section className="setting-section file-resize-section">
              <div className="label-row file-resize-heading">
                <span className="setting-label">{t("resize.fileTitle")}</span>
                <span className={`scope-badge ${selectedResizeOverride ? "" : "neutral"}`}>{t(selectedResizeOverride ? "resize.fileOverride" : "resize.usingGlobal")}</span>
              </div>
              <label className="check-row file-resize-master"><input type="checkbox" checked={Boolean(selectedResizeOverride)} onChange={(event) => event.target.checked ? updateSelectedResizeOverride({}) : resetSelectedResizeOverride()} /><span><Icon name="check" size={13} /></span>{t("resize.enableOverride")}</label>
              <div className={`file-resize-controls ${selectedResizeOverride ? "" : "is-disabled"}`} aria-disabled={!selectedResizeOverride}>
                <div className="segmented resize-axis-picker" aria-label={t("resize.fileTitle")}>
                  <button type="button" className={selectedResizeOverride?.axis === "width" ? "active" : ""} onClick={() => updateSelectedResizeOverride({ axis: "width" })} disabled={!selectedResizeOverride}>{t("resize.width")}</button>
                  <button type="button" className={selectedResizeOverride?.axis === "height" ? "active" : ""} onClick={() => updateSelectedResizeOverride({ axis: "height" })} disabled={!selectedResizeOverride}>{t("resize.height")}</button>
                </div>
                <div className="file-resize-value-row">
                  <div className="input-with-unit">
                    <input type="number" min="1" max="32768" inputMode="numeric" value={selectedResizeOverride?.value ?? ""} onChange={(event) => updateSelectedResizeOverride({ value: Number(event.target.value) || 1 })} disabled={!selectedResizeOverride} aria-label={t(selectedResizeOverride?.axis === "height" ? "resize.height" : "resize.width")} />
                    <span>px</span>
                  </div>
                  <span className="ratio-lock"><Icon name="link" size={13} />{t("resize.ratioLocked")}</span>
                </div>
                {selectedOutputDimensions && <div className="file-resize-result"><span>{t("resize.outputEstimate")}</span><strong>{formatDimensions(selectedOutputDimensions.width, selectedOutputDimensions.height, formatLocale, t("format.unknownDimensions"))}</strong></div>}
                <label className={`check-row ${selectedResizeOverride ? "" : "disabled"}`}><input type="checkbox" checked={selectedResizeOverride?.preventUpscale ?? settings.preventUpscale} onChange={(event) => updateSelectedResizeOverride({ preventUpscale: event.target.checked })} disabled={!selectedResizeOverride} /><span><Icon name="check" size={13} /></span>{t("resize.noUpscale")}</label>
              </div>
              <p className="setting-help">{t("resize.help")}</p>
              <button type="button" className="file-resize-reset" onClick={resetSelectedResizeOverride} disabled={!selectedResizeOverride}>{t("resize.useGlobal")}</button>
            </section>
          </InspectorAccordion>}

          {selected && <InspectorAccordion title={t("metadata.fileValues")} summary={selectedMetadataSummary}>
            <section className="setting-section metadata-section current-metadata-section">
              <div className="setting-title-row"><span className="setting-label">{t("metadata.fileValues")}</span></div>
              <div className={`metadata-output-bridge ${selectedMetadataPolicy.preserveMetadata ? "active" : "inactive"}`}>
                <div className="label-row">
                  <strong className="metadata-policy-title">{t("metadata.filePolicy")}</strong>
                  <span className={`scope-badge ${selected.metadataPolicy ? "" : "neutral"}`}>{t(selected.metadataPolicy ? "metadata.fileOverride" : "metadata.usingGlobal")}</span>
                </div>
                <p>{t("metadata.filePolicyHelp")}</p>
                <label className="check-row metadata-file-master"><input type="checkbox" checked={selectedMetadataPolicy.preserveMetadata} onChange={(event) => updateSelectedMetadataPolicy({ preserveMetadata: event.target.checked })} /><span><Icon name="check" size={13} /></span>{t("output.keepMetadata")}</label>
                <div className={`metadata-policy-options ${selectedMetadataPolicy.preserveMetadata ? "" : "is-disabled"}`}>
                  <label className={`check-row ${selectedMetadataPolicy.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={selectedMetadataPolicy.preserveGps} onChange={(event) => updateSelectedMetadataPolicy({ preserveGps: event.target.checked })} disabled={!selectedMetadataPolicy.preserveMetadata} /><span><Icon name="check" size={13} /></span>{t("metadata.keepGps")}</label>
                  <p className="setting-help flush warning-text">{t("metadata.gpsWarning")}</p>
                  <label className={`check-row ${selectedMetadataPolicy.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={selectedMetadataPolicy.preservePrompt} onChange={(event) => updateSelectedMetadataPolicy({ preservePrompt: event.target.checked })} disabled={!selectedMetadataPolicy.preserveMetadata} /><span><Icon name="check" size={13} /></span>{t("metadata.keepPrompt")}</label>
                </div>
                <p className="metadata-export-state">{t(selectedMetadataPolicy.preserveMetadata ? "metadata.editsExported" : "metadata.editsNotExported")}</p>
                <div className="metadata-policy-actions"><button type="button" onClick={resetSelectedMetadataPolicy} disabled={!selected.metadataPolicy}>{t("metadata.useGlobal")}</button><button type="button" onClick={() => switchInspectorMode("output")}>{t("metadata.reviewPolicy")}</button></div>
              </div>
              <div className={`metadata-editor ${selectedMetadataPolicy.preserveMetadata ? "" : "is-disabled"}`} aria-disabled={!selectedMetadataPolicy.preserveMetadata}>
                <label><span>{t("metadata.takenAt")}</span><input type="text" value={selected.exif.takenAt ?? ""} placeholder="YYYY-MM-DD HH:MM:SS" onChange={(event) => updateSelectedMetadata({ takenAt: event.target.value || null })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                <label><span>{t("metadata.camera")}</span><input type="text" value={selected.exif.camera ?? ""} onChange={(event) => updateSelectedMetadata({ camera: event.target.value || null })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                <label><span>{t("metadata.lens")}</span><input type="text" value={selected.exif.lens ?? ""} onChange={(event) => updateSelectedMetadata({ lens: event.target.value || null })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                <label><span>{t("metadata.description")}</span><textarea rows={2} value={selected.exif.description ?? ""} onChange={(event) => updateSelectedMetadata({ description: event.target.value || null })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                <label><span>{t("metadata.prompt")}</span><textarea rows={4} value={selected.exif.prompt ?? ""} placeholder={t("metadata.promptEmpty")} onChange={(event) => updateSelectedMetadata({ prompt: event.target.value || null })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                <div className="metadata-coordinate-grid">
                  <label><span>{t("metadata.latitude")}</span><input type="number" min="-90" max="90" step="any" value={selected.exif.gpsLatitude ?? ""} onChange={(event) => updateSelectedMetadata({ gpsLatitude: event.target.value === "" ? null : Number(event.target.value) })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                  <label><span>{t("metadata.longitude")}</span><input type="number" min="-180" max="180" step="any" value={selected.exif.gpsLongitude ?? ""} onChange={(event) => updateSelectedMetadata({ gpsLongitude: event.target.value === "" ? null : Number(event.target.value) })} disabled={!selectedMetadataPolicy.preserveMetadata} /></label>
                </div>
                <p className="setting-help flush">{t("metadata.editHelp")}</p>
              </div>
            </section>
          </InspectorAccordion>}
          </div>
        </aside>
      </main>

      <footer className="actionbar">
        <div className="estimate" role="status" aria-live="polite">
          <span className="estimate-label">{t(isProcessing ? "status.processing" : displayOutputBytes === null ? "output.estimatedSize" : "output.actualSize")}</span>
          <strong>{assets.length ? t("output.savedProgress", { done: isProcessing ? batchCompleted : assets.filter((asset) => asset.status === "done").length, total: isProcessing ? batchTotal : assets.length }) : t("output.addImages")}</strong>
          {assets.length > 0 && <span className="muted">{
            displayOutputBytes !== null
              ? `${formatBytes(totalBytes, formatLocale)} → ${formatBytes(displayOutputBytes, formatLocale)}`
              : isEstimating
                ? `${formatBytes(totalBytes, formatLocale)} · ${t("output.calculating")}`
                : estimateText
                  ? `${formatBytes(totalBytes, formatLocale)} → ${estimateText}${savingsText ? ` · ${savingsText}` : ""}`
                  : formatBytes(totalBytes, formatLocale)
          }</span>}
        </div>
        <div className="action-buttons">
          {!isProcessing && retryableAssets.length > 0 && (
            <button className="retry-button" onClick={() => void processAssets(retryableAssets)}>
              <Icon name="rotateRight" size={15} />{t("output.retry", { count: retryableAssets.length })}
            </button>
          )}
          <button
            className={`run-button ${isProcessing ? "cancel" : ""}`}
            disabled={isProcessing ? isCancelling : !(isMultiSelection ? selectedAssets.length : assets.length) || !isWorkspaceLoaded}
            onClick={() => isProcessing ? void cancelProcessing() : void processAssets(isMultiSelection ? selectedAssets : assets)}
          >
            <span className="run-icon"><Icon name={isProcessing ? "stop" : "sparkle"} /></span>
            <span>{isProcessing
              ? isCancelling ? t("output.cancelRequest") : t("output.batchProgress", { done: batchCompleted, total: batchTotal })
              : (isMultiSelection ? selectedAssets.length : assets.length)
                ? t(settings.processingMode === "convert" ? "output.runConvert" : "output.runRemove", { count: isMultiSelection ? selectedAssets.length : assets.length })
                : t("output.addImages")}</span>
            {!isProcessing && <Icon name="chevron" size={16} />}
          </button>
        </div>
      </footer>

      {isDragging && (
        <div className="drag-overlay">
          <div><span><Icon name="add" size={28} /></span><strong>{t("app.dropOverlay")}</strong><small>{t("app.dropOverlayHelp")}</small></div>
        </div>
      )}

      {contextMenu && (
        <div className="app-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          {contextMenu.kind === "text" ? (
            <>
              <button role="menuitem" onClick={() => void runTextMenuAction("undo")}><span>{t("context.undo")}</span><kbd>Ctrl+Z</kbd></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => void runTextMenuAction("cut")}><span>{t("context.cut")}</span><kbd>Ctrl+X</kbd></button>
              <button role="menuitem" onClick={() => void runTextMenuAction("copy")}><span>{t("context.copy")}</span><kbd>Ctrl+C</kbd></button>
              <button role="menuitem" onClick={() => void runTextMenuAction("paste")}><span>{t("context.paste")}</span><kbd>Ctrl+V</kbd></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => void runTextMenuAction("selectAll")}><span>{t("context.selectAll")}</span><kbd>Ctrl+A</kbd></button>
            </>
          ) : contextMenu.kind === "asset" && contextAsset ? (
            <>
              <div className="context-file-heading"><strong title={contextAsset.name}>{contextAsset.name}</strong><span>{formatDimensions(contextAsset.width, contextAsset.height, formatLocale, t("format.unknownDimensions"))} · {contextAsset.extension.toUpperCase()}</span></div>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setContextMenu(null); setViewMode("original"); }}><span>{t("context.openOriginal")}</span></button>
              <button role="menuitem" onClick={() => { setContextMenu(null); openMaskEditor(); }} disabled={!contextAsset.previewUrl || settings.processingMode === "convert"}><span>{t("selection.editObject")}</span></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setContextMenu(null); rotateSelected(-1); }}><span>{t("preview.rotateLeft")}</span></button>
              <button role="menuitem" onClick={() => { setContextMenu(null); rotateSelected(1); }}><span>{t("preview.rotateRight")}</span></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { moveLibraryAssets("up", contextAsset.id); setContextMenu(null); }} disabled={isProcessing}><span>{t("library.moveUp")}</span><kbd>Alt+↑</kbd></button>
              <button role="menuitem" onClick={() => { moveLibraryAssets("down", contextAsset.id); setContextMenu(null); }} disabled={isProcessing}><span>{t("library.moveDown")}</span><kbd>Alt+↓</kbd></button>
              <button role="menuitem" onClick={() => { moveLibraryAssets("top", contextAsset.id); setContextMenu(null); }} disabled={isProcessing}><span>{t("library.moveTop")}</span><kbd>Alt+Home</kbd></button>
              <button role="menuitem" onClick={() => { moveLibraryAssets("bottom", contextAsset.id); setContextMenu(null); }} disabled={isProcessing}><span>{t("library.moveBottom")}</span><kbd>Alt+End</kbd></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => void revealAssetPath(contextAsset.path)}><span>{t("context.openOriginalLocation")}</span></button>
              <button role="menuitem" onClick={() => void revealAssetPath(contextAsset.outputPath!)} disabled={!contextAsset.outputPath}><span>{t("context.openResultLocation")}</span></button>
              <span className="context-separator" />
              <button className="danger" role="menuitem" onClick={() => { setContextMenu(null); removeAsset(contextAsset.id); }} disabled={isProcessing}><span>{t("preview.removeFromList")}</span></button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => { setContextMenu(null); openMaskEditor(); }} disabled={!selected?.previewUrl || settings.processingMode === "convert"}><span>{t("selection.editObject")}</span></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setViewMode("original"); setContextMenu(null); }} disabled={!selected}><span>{t("context.openOriginal")}</span></button>
              <button role="menuitem" onClick={() => { setViewMode("result"); setContextMenu(null); }} disabled={!selected?.outputPath}><span>{t("context.openSavedResult")}</span></button>
              <button role="menuitem" onClick={() => { setViewMode("compare"); setContextMenu(null); }} disabled={!selected?.outputPath}><span>{t("context.dragCompare")}</span></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setContextMenu(null); void addFilesFromDialog(); }}><span>{t("context.addImages")}</span></button>
              <button role="menuitem" onClick={() => { setContextMenu(null); openSettings("general"); }}><span>{t("context.settings")}</span></button>
            </>
          )}
        </div>
      )}

      <SettingsModal
        open={isSettingsOpen}
        initialTab={settingsInitialTab}
        preferences={preferences}
        currentSettings={settings}
        modelStatus={modelStatus}
        diagnostics={diagnostics}
        busyAction={settingsBusyAction}
        modelDownloadProgress={modelDownloadProgress}
        processing={isProcessing}
        onClose={closeSettings}
        onSave={savePreferences}
        onReset={resetPreferences}
        onInstallModel={installModelFromSettings}
        onDeleteModel={deleteModelFromSettings}
        onClearPreviewCache={clearPreviewCacheFromSettings}
        onChooseDefaultDirectory={chooseDefaultOutputDirectory}
        onRefreshDiagnostics={refreshSettingsData}
        onPreviewLanguage={setLanguagePreference}
      />

      {notice && (
        <div className="toast" role="alert" aria-live="assertive">
          <span className="toast-message">{notice}</span>
          <button type="button" className="toast-close" onClick={() => setNotice(null)} aria-label={t("toast.dismiss")}>{t("toast.dismiss")}</button>
          <span className="toast-progress" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export default App;
