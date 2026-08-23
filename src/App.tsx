import { ChangeEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppDiagnostics, AppPreferences, BatchProgress, BatchResult, EdgeSettings, ExportPlan, ImageAsset, ManualMaskRecipe, MaskPoint, ModelStatus, OriginalExportResult, OutputFormat, OutputPreset, OutputSettings, PersistedAsset, RestoredWorkspace, WorkspaceSnapshot } from "./types";
import { formatBytes, formatDimensions } from "./lib/format";
import SettingsModal, { type SettingsTab } from "./SettingsModal";
import PreviewEditor, { type PreviewBackground, type PreviewStatus, type PreviewViewMode } from "./PreviewEditor";
import SelectionManager from "./SelectionManager";
import appIconUrl from "../assets/app-icon.svg";
import { useI18n } from "./i18n/I18nProvider";
import type { LanguagePreference } from "./i18n/locale";
import { localizeCommandError } from "./i18n/errors";

const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const TOAST_DURATION_MS = 5000;

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
}

interface ContextMenuState {
  x: number;
  y: number;
  kind: "text" | "asset" | "canvas";
  textField?: HTMLInputElement | HTMLTextAreaElement | null;
  assetId?: string;
}

type InspectorMode = "current" | "output";

const DEFAULT_PREFERENCES: AppPreferences = {
  defaultSettings: DEFAULT_SETTINGS,
  restoreWorkspace: true,
  presets: [],
  language: "system",
};

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

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
  error: asset.error,
  maskRecipe: asset.maskRecipe,
  edgeSettings: asset.edgeSettings,
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
  };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function InspectorAccordion({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
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
  const [viewMode, setViewMode] = useState<PreviewViewMode>("original");
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>("checker");
  const [isMaskEditing, setIsMaskEditing] = useState(false);
  const [maskDraft, setMaskDraft] = useState<ManualMaskRecipe | null>(null);
  const [pendingMaskEditId, setPendingMaskEditId] = useState<string | null>(null);
  const [maskPreviewStatus, setMaskPreviewStatus] = useState<PreviewStatus>("idle");
  const [maskPreviewError, setMaskPreviewError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [lastOutputBytes, setLastOutputBytes] = useState<number | null>(null);
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isExportingOriginals, setIsExportingOriginals] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isWorkspaceLoaded, setIsWorkspaceLoaded] = useState(!isTauri());
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [isLibraryCollapsed, setIsLibraryCollapsed] = useState(false);
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("output");
  const [settingsBusyAction, setSettingsBusyAction] = useState<"save" | "model" | "reset" | null>(null);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isPresetNaming, setIsPresetNaming] = useState(false);
  const [presetName, setPresetName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const skipNextWorkspaceSave = useRef(false);
  const workspaceSaveTimer = useRef<number | null>(null);
  const workspaceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const maskPreviewRevision = useRef(0);
  const maskPreviewSnapshot = useRef<{ editBasePreviewUrl?: string; maskPreviewUrl?: string } | null>(null);
  const thumbnailLoads = useRef(new Set<string>());
  const selectionAnchorId = useRef<string | null>(null);
  const hadSingleInspectorSelection = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedAssets = useMemo(() => assets.filter((asset) => selectedIdSet.has(asset.id)), [assets, selectedIdSet]);
  const isMultiSelection = selectedAssets.length > 1;
  const contextAsset = contextMenu?.assetId ? assets.find((asset) => asset.id === contextMenu.assetId) ?? null : null;
  const totalBytes = useMemo(() => assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), [assets]);
  const previewRecipe = isMaskEditing ? maskDraft ?? selected?.maskRecipe : selected?.maskRecipe;
  const previewRecipeReady = !previewRecipe || !((previewRecipe.mode === "manual" || previewRecipe.mode === "sam")
    && !previewRecipe.strokes.some((stroke) => stroke.mode === "keep" && stroke.points.length > 0));
  const hasResultView = previewRecipeReady && Boolean(selected?.resultPreviewUrl || selected?.editBasePreviewUrl);
  const hasMaskView = previewRecipeReady && Boolean(selected?.maskPreviewUrl);
  const effectiveViewMode: PreviewViewMode = viewMode === "mask" && !hasMaskView
    ? hasResultView ? "result" : "original"
    : (viewMode === "result" || viewMode === "compare") && !hasResultView
      ? "original"
      : viewMode;
  const previewAsset = selected && previewRecipe ? { ...selected, maskRecipe: previewRecipe } : selected;

  useEffect(() => {
    const canInspectCurrent = Boolean(selected && !isMultiSelection);
    if (!canInspectCurrent) {
      hadSingleInspectorSelection.current = false;
      setInspectorMode("output");
    } else if (!hadSingleInspectorSelection.current) {
      hadSingleInspectorSelection.current = true;
      setInspectorMode("current");
    }
  }, [isMultiSelection, selected?.id]);
  const previewRenderKey = useMemo(() => JSON.stringify({
    processingMode: settings.processingMode,
    resizeMode: settings.resizeMode,
    resizeValue: settings.resizeValue,
    preventUpscale: settings.preventUpscale,
    edgeSettings: selected?.edgeSettings,
  }), [
    settings.processingMode,
    settings.resizeMode,
    settings.resizeValue,
    settings.preventUpscale,
    selected?.edgeSettings,
  ]);
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
  const planKey = useMemo(() => JSON.stringify({
    items: assets.map(({ path, rotation, maskRecipe, edgeSettings }) => ({ path, rotation, maskRecipe, edgeSettings })),
    settings,
  }), [assets, settings]);

  const addAssets = useCallback((incoming: ImageAsset[]) => {
    if (!incoming.length) return;
    setAssets((current) => {
      const known = new Set(current.map((asset) => asset.path.toLocaleLowerCase()));
      const unique = incoming.filter((asset) => !known.has(asset.path.toLocaleLowerCase()));
      return [...current, ...unique];
    });
    setSelectedId((current) => current ?? incoming[0].id);
    setSelectedIds((current) => current.length ? current : [incoming[0].id]);
    if (!selectionAnchorId.current) selectionAnchorId.current = incoming[0].id;
    setNotice(t("notice.filesLoaded", { count: incoming.length }));
  }, [t]);

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

  const inspectPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const inspected = await invoke<Omit<ImageAsset, "status" | "rotation">[]>("inspect_paths", { paths });
      const incoming: ImageAsset[] = inspected.map((asset) => ({ ...asset, status: "ready", rotation: 0, maskRecipe: DEFAULT_MASK_RECIPE, edgeSettings: { ...DEFAULT_EDGE_SETTINGS } }));
      addAssets(incoming);
      preloadThumbnails(incoming);
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
        setAssets(restored.items);
        preloadThumbnails(restored.items);
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
  }, [preloadThumbnails, setLanguagePreference]);

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
          return { ...asset, status: "done", outputPath: payload.outputPath ?? undefined, resultPreviewUrl: undefined, editBasePreviewUrl: undefined, maskPreviewUrl: undefined, error: undefined };
        }
        if (payload.status === "failed") return { ...asset, status: "failed", error: t("notice.processingFailed") };
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
        items: assets.map((asset, index) => ({ id: asset.id, path: asset.path, rotation: asset.rotation, sequence: index + 1, exif: asset.exif, maskRecipe: asset.maskRecipe, edgeSettings: asset.edgeSettings })),
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
  }, [planKey]);

  useEffect(() => {
    if (!selected || selected.previewUrl || !isTauri()) return;
    let cancelled = false;
    invoke<string>("load_preview", { path: selected.path })
      .then((previewUrl) => {
        if (!cancelled) {
          setAssets((current) => current.map((asset) => asset.id === selected.id ? { ...asset, previewUrl } : asset));
        }
      })
      .catch(() => !cancelled && setNotice(t("notice.previewFailed")));
    return () => { cancelled = true; };
  }, [selected?.id, selected?.path, selected?.previewUrl]);

  useEffect(() => {
    const revision = ++maskPreviewRevision.current;
    if (!isTauri() || !selected || !previewRecipe || settings.processingMode !== "removeBackground") {
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
    setMaskPreviewStatus("updating");
    setMaskPreviewError(null);
    const timer = window.setTimeout(() => {
      const command = previewRecipe.mode === "sam" ? "generate_sam_preview" : "generate_mask_preview";
      void invoke<MaskPreviewBundle>(command, {
        path: selected.path,
        rotation: selected.rotation,
        maskRecipe: previewRecipe,
        edgeSettings: selected.edgeSettings,
        settings,
      }).then(({ resultPreviewUrl: editBasePreviewUrl, maskPreviewUrl }) => {
        if (maskPreviewRevision.current !== revision) return;
        setAssets((current) => current.map((asset) => asset.id === selected.id ? { ...asset, editBasePreviewUrl, maskPreviewUrl } : asset));
        setMaskPreviewStatus("current");
        setViewMode((current) => current === "mask" ? "mask" : "result");
      }).catch((error) => {
        if (maskPreviewRevision.current !== revision) return;
        const message = String(error);
        setMaskPreviewStatus("error");
        setMaskPreviewError(message);
        setNotice(t("notice.maskPreviewFailed"));
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [isMaskEditing, selected?.id, selected?.path, selected?.rotation, previewRecipe, previewRenderKey]);

  useEffect(() => {
    if (!selected?.outputPath || selected.resultPreviewUrl || !isTauri()) return;
    let cancelled = false;
    invoke<string>("load_preview", { path: selected.outputPath })
      .then((resultPreviewUrl) => {
        if (!cancelled) {
          setAssets((current) => current.map((asset) => asset.id === selected.id ? { ...asset, resultPreviewUrl } : asset));
        }
      })
      .catch(() => !cancelled && setNotice(t("notice.resultPreviewFailed")));
    return () => { cancelled = true; };
  }, [selected?.id, selected?.outputPath, selected?.resultPreviewUrl]);

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
    if (isMaskEditing) setViewMode((current) => current === "mask" ? "mask" : "result");
  }, [isMaskEditing, selectedId]);

  const updateSelectedEdgeSettings = useCallback((patch: Partial<EdgeSettings>) => {
    if (!selectedId || !selected) return;
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
  }, [selected, selectedId]);

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
  }, [selectedId]);

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
    setAssets((current) => current.map((asset) => targetIds.has(asset.id)
      ? { ...asset, status: "queued", outputPath: undefined, outputBytes: undefined, resultPreviewUrl: undefined, editBasePreviewUrl: undefined, maskPreviewUrl: undefined, error: undefined }
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
        })),
        settings,
      });
      const resultById = new Map(result.items.map((item) => [item.assetId, item]));
      setAssets((current) => current.map((asset) => {
        const item = resultById.get(asset.id);
        return item?.success ? { ...asset, outputBytes: item.outputBytes ?? undefined } : asset;
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
    } catch (error) {
      const message = localizeCommandError(error, t, "error.batch.run");
      setAssets((current) => current.map((asset) => asset.status === "queued" || asset.status === "processing" || asset.status === "retrying" ? { ...asset, status: "failed", error: message } : asset));
      setNotice(message);
    } finally {
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
    try {
      const status = await invoke<ModelStatus>("install_model");
      setModelStatus(status);
      setNotice(t("notice.modelInstalled"));
      await refreshSettingsData();
    } catch (error) {
      setNotice(t("notice.modelInstallFailed"));
    } finally {
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
    }
  };

  const openMaskEditor = () => {
    if (!selected || settings.processingMode === "convert") return;
    setPendingMaskEditId(null);
    maskPreviewSnapshot.current = {
      editBasePreviewUrl: selected.editBasePreviewUrl,
      maskPreviewUrl: selected.maskPreviewUrl,
    };
    setMaskDraft({
      ...selected.maskRecipe,
      strokes: selected.maskRecipe.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })),
    });
    setViewMode("result");
    setIsMaskEditing(true);
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
      y: Math.min(event.clientY, window.innerHeight - 300),
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

  const selectAssetFromList = (event: ReactMouseEvent<HTMLButtonElement>, assetId: string) => {
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
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    const allIds = assets.map((asset) => asset.id);
    setSelectedIds(allIds);
    setSelectedId((current) => current ?? allIds[0] ?? null);
    selectionAnchorId.current = selectedId ?? allIds[0] ?? null;
  };

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
            <button className="panel-toggle" onClick={() => setIsLibraryCollapsed((value) => !value)} aria-expanded={!isLibraryCollapsed} aria-label={t(isLibraryCollapsed ? "library.expand" : "library.collapse")} title={t(isLibraryCollapsed ? "library.expand" : "library.collapse")}><Icon name="chevron" size={15} /></button>
          </div>
          <div className="asset-list" role="listbox" aria-multiselectable="true" tabIndex={assets.length ? 0 : undefined} onKeyDown={handleLibraryKeyDown}>
            {assets.length === 0 ? (
              <div className="library-empty"><Icon name="image" size={24} /><span>{t(isWorkspaceLoaded ? "library.empty" : "library.loading")}</span></div>
            ) : assets.map((asset, index) => (
              <button key={asset.id} className={`asset-row ${selectedIdSet.has(asset.id) ? "selected" : ""} ${asset.id === selectedId ? "active" : ""}`} role="option" aria-selected={selectedIdSet.has(asset.id)} onClick={(event) => selectAssetFromList(event, asset.id)} onContextMenu={(event) => openAssetContextMenu(event, asset.id)}>
                <span className="asset-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="asset-thumb">{asset.thumbnailUrl || asset.previewUrl ? <img src={asset.thumbnailUrl ?? asset.previewUrl} alt="" /> : <Icon name="image" size={16} />}</span>
                <span className="asset-copy">
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>{formatDimensions(asset.width, asset.height, formatLocale, t("format.unknownDimensions"))} · {formatBytes(asset.sizeBytes, formatLocale)}</small>
                </span>
                <span className={`asset-status-badge ${asset.status}`} title={asset.error || t(`status.${asset.status}`)}>{t(`status.short.${asset.status}`)}</span>
              </button>
            ))}
          </div>
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
              <button className={effectiveViewMode === "result" ? "active" : ""} onClick={() => hasResultView ? setViewMode("result") : setNotice(t("notice.previewNeeded"))} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "result"} aria-disabled={!hasResultView}>{t("common.preview")}</button>
              <button className={effectiveViewMode === "mask" ? "active" : ""} onClick={() => hasMaskView ? setViewMode("mask") : setNotice(t("notice.maskNeeded"))} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "mask"} aria-disabled={!hasMaskView}>{t("common.mask")}</button>
              <button className={effectiveViewMode === "compare" ? "active" : ""} onClick={() => hasResultView ? setViewMode("compare") : setNotice(t("notice.compareNeeded"))} onKeyDown={handleViewTabKeyDown} role="tab" aria-selected={effectiveViewMode === "compare"} aria-disabled={!hasResultView}>{t("common.compare")}</button>
            </div>
            <div className="canvas-actions">
              <div className="preview-backgrounds" aria-label={t("preview.background")}>
                <button className={`background-swatch checker ${previewBackground === "checker" ? "active" : ""}`} onClick={() => setPreviewBackground("checker")} title={t("preview.background.checker")} aria-label={t("preview.background.checker")} />
                <button className={`background-swatch light ${previewBackground === "light" ? "active" : ""}`} onClick={() => setPreviewBackground("light")} title={t("preview.background.light")} aria-label={t("preview.background.light")} />
                <button className={`background-swatch dark ${previewBackground === "dark" ? "active" : ""}`} onClick={() => setPreviewBackground("dark")} title={t("preview.background.dark")} aria-label={t("preview.background.dark")} />
              </div>
              <span className="divider" />
              <button className={`mask-edit-button ${isMaskEditing ? "active" : ""}`} onClick={isMaskEditing ? applyMaskEditor : openMaskEditor} disabled={!selected?.previewUrl || isProcessing || settings.processingMode === "convert"}><Icon name="brush" size={16} />{t(isMaskEditing ? "preview.editing" : "selection.editObject")}</button>
              <span className="divider" />
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
              {selected.exif.takenAt && <span title={t("preview.exifDate")}>{selected.exif.takenAt}</span>}
              {selected.exif.camera && <span title={selected.exif.lens ?? t("preview.exifCamera")}>{selected.exif.camera}</span>}
              <span className={`file-status ${selected.status}`}>{t(`status.${selected.status}`)}</span>
            </div>
          )}
        </section>

        <aside className={`inspector-panel ${isInspectorCollapsed ? "collapsed" : ""}`}>
          <div className="inspector-header">
            <span className="eyebrow">{t(inspectorMode === "current" ? "common.currentFile" : "output.title")}</span>
            {inspectorMode === "output" && <button className="text-button" onClick={resetOutputSettings}>{t("output.reset")}</button>}
            <button className="panel-toggle inspector-toggle" onClick={() => setIsInspectorCollapsed((value) => !value)} aria-expanded={!isInspectorCollapsed} aria-label={t(isInspectorCollapsed ? "output.expand" : "output.collapse")} title={t(isInspectorCollapsed ? "output.expand" : "output.collapse")}><Icon name="chevron" size={15} /></button>
          </div>

          <div className="inspector-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={inspectorMode === "current"} aria-controls="current-file-inspector" className={inspectorMode === "current" ? "active" : ""} onClick={() => setInspectorMode("current")} disabled={!selected || isMultiSelection}>{t("common.currentFile")}</button>
            <button type="button" role="tab" aria-selected={inspectorMode === "output"} aria-controls="output-inspector" className={inspectorMode === "output" ? "active" : ""} onClick={() => setInspectorMode("output")}>{t("output.title")}</button>
          </div>

          {inspectorMode === "output" && <div id="output-inspector" className="inspector-tab-panel" role="tabpanel">
          <div className="inspector-group-heading output-control"><span>{t("common.allFiles")}</span><strong>{t("output.outputAndSave")}</strong></div>

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

          <InspectorAccordion title={t("output.processingMode")} summary={processingSummary}>
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

          <InspectorAccordion title={t("metadata.title")} summary={metadataSummary}>
          <section className="setting-section metadata-section">
            <label className="check-row"><input type="checkbox" checked={settings.preserveMetadata} onChange={(event) => setMetadataPreservation(event.target.checked)} /><span><Icon name="check" size={13} /></span>{t("output.keepMetadata")}</label>
            <p className="setting-help flush">{t("metadata.safeHelp")}</p>
            <div className={`metadata-policy-options ${settings.preserveMetadata ? "" : "is-disabled"}`}>
              <label className={`check-row ${settings.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={settings.preserveGps} onChange={(event) => setSettings({ ...settings, preserveGps: event.target.checked })} disabled={!settings.preserveMetadata} /><span><Icon name="check" size={13} /></span>{t("metadata.keepGps")}</label>
              <p className="setting-help flush warning-text">{t("metadata.gpsWarning")}</p>
              <label className={`check-row ${settings.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={settings.preservePrompt} onChange={(event) => setSettings({ ...settings, preservePrompt: event.target.checked })} disabled={!settings.preserveMetadata} /><span><Icon name="check" size={13} /></span>{t("metadata.keepPrompt")}</label>
            </div>
            {!isMultiSelection && selected && <div className="metadata-editor">
              <div className="metadata-editor-heading"><strong>{t("metadata.fileValues")}</strong></div>
              <label><span>{t("metadata.takenAt")}</span><input type="text" value={selected.exif.takenAt ?? ""} placeholder="YYYY-MM-DD HH:MM:SS" onChange={(event) => updateSelectedMetadata({ takenAt: event.target.value || null })} /></label>
              <label><span>{t("metadata.camera")}</span><input type="text" value={selected.exif.camera ?? ""} onChange={(event) => updateSelectedMetadata({ camera: event.target.value || null })} /></label>
              <label><span>{t("metadata.lens")}</span><input type="text" value={selected.exif.lens ?? ""} onChange={(event) => updateSelectedMetadata({ lens: event.target.value || null })} /></label>
              <label><span>{t("metadata.description")}</span><textarea rows={2} value={selected.exif.description ?? ""} onChange={(event) => updateSelectedMetadata({ description: event.target.value || null })} /></label>
              <label><span>{t("metadata.prompt")}</span><textarea rows={4} value={selected.exif.prompt ?? ""} placeholder={t("metadata.promptEmpty")} onChange={(event) => updateSelectedMetadata({ prompt: event.target.value || null })} /></label>
              <div className="metadata-coordinate-grid">
                <label><span>{t("metadata.latitude")}</span><input type="number" min="-90" max="90" step="any" value={selected.exif.gpsLatitude ?? ""} onChange={(event) => updateSelectedMetadata({ gpsLatitude: event.target.value === "" ? null : Number(event.target.value) })} /></label>
                <label><span>{t("metadata.longitude")}</span><input type="number" min="-180" max="180" step="any" value={selected.exif.gpsLongitude ?? ""} onChange={(event) => updateSelectedMetadata({ gpsLongitude: event.target.value === "" ? null : Number(event.target.value) })} /></label>
              </div>
              <p className="setting-help flush">{t("metadata.editHelp")}</p>
            </div>}
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

          </div>}

          {inspectorMode === "current" && <div id="current-file-inspector" className="inspector-tab-panel" role="tabpanel">
          {settings.processingMode === "removeBackground" && !isMultiSelection && <div className="inspector-group-heading edit current-file-control"><span>{t("common.currentFile")}</span><strong>{t("selection.title")}</strong></div>}

          {settings.processingMode === "removeBackground" && !isMultiSelection && <section className="setting-section mask-summary-section current-file-control">
            <div className="label-row"><span className="setting-label">{t("selection.object")}</span><span className="state-badge-small">{t("selection.livePreview")}</span></div>
            <p className="setting-help flush">{!selected
              ? t("selection.emptyHelp")
              : selected.maskRecipe.mode === "manual"
                ? t("selection.manualSummary", { count: selected.maskRecipe.strokes.length })
                : selected.maskRecipe.mode === "sam"
                  ? t("selection.samSummary", { count: selected.maskRecipe.strokes.length })
                  : selected.maskRecipe.mode === "refine"
                    ? t("selection.refineSummary", { count: selected.maskRecipe.strokes.length })
                    : t("editor.source.auto")}</p>
            <button className="button secondary mask-summary-button" onClick={openMaskEditor} disabled={!selected?.previewUrl || isProcessing}><Icon name="brush" size={15} />{t("selection.editObject")}</button>
          </section>}

          {settings.processingMode === "removeBackground" && !isMultiSelection && <button className={`advanced-row current-file-control ${isAdvancedOpen ? "open" : ""}`} onClick={() => setIsAdvancedOpen((value) => !value)} aria-expanded={isAdvancedOpen} aria-controls="advanced-settings">
            <span className="advanced-row-copy">
              <span>{t("edge.title")}</span>
              {selected && <small className={`edge-preview-state ${maskPreviewStatus}`}>
                {maskPreviewStatus === "updating"
                  ? <span className="spinner" />
                  : maskPreviewStatus !== "error" && hasResultView
                    ? <Icon name="check" size={11} />
                    : null}
                {t(maskPreviewStatus === "updating"
                  ? "preview.updating"
                  : maskPreviewStatus === "error"
                    ? "editor.previewError"
                    : hasResultView
                      ? "preview.current"
                      : "preview.selectedBasis")}
              </small>}
            </span>
            <Icon name="chevron" size={15} />
          </button>}
          {settings.processingMode === "removeBackground" && !isMultiSelection && (
            <div id="advanced-settings" className={`advanced-settings-collapse current-file-control ${isAdvancedOpen ? "open" : ""}`} aria-hidden={!isAdvancedOpen} inert={!isAdvancedOpen}>
            <div>
            <section className="setting-section advanced-settings">
              <div className="advanced-section-title"><div><strong title={selected?.name}>{selected?.name ?? t("output.addImages")}</strong><span>{selected ? `${formatDimensions(selected.width, selected.height, formatLocale, t("format.unknownDimensions"))} · ${selected.extension.toUpperCase()}` : t("edge.fileOnlyHelp")}</span></div><button type="button" onClick={() => updateSelectedEdgeSettings({ ...DEFAULT_EDGE_SETTINGS })} disabled={!selected}>{t("common.default")}</button></div>
              <div className="sub-setting first">
                <div className="label-row"><label htmlFor="edge-smoothing">{t("edge.smoothing")}</label><output>{selected?.edgeSettings.edgeSmoothing ?? DEFAULT_EDGE_SETTINGS.edgeSmoothing}</output></div>
                <input id="edge-smoothing" type="range" min="0" max="10" value={selected?.edgeSettings.edgeSmoothing ?? DEFAULT_EDGE_SETTINGS.edgeSmoothing} onChange={(event) => updateSelectedEdgeSettings({ edgeSmoothing: Number(event.target.value) })} disabled={!selected} />
                <p className="setting-help flush">{t("edge.smoothingHelp")}</p>
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="edge-feather">{t("edge.feather")}</label><output>{selected?.edgeSettings.edgeFeather ?? DEFAULT_EDGE_SETTINGS.edgeFeather}px</output></div>
                <input id="edge-feather" type="range" min="0" max="20" value={selected?.edgeSettings.edgeFeather ?? DEFAULT_EDGE_SETTINGS.edgeFeather} onChange={(event) => updateSelectedEdgeSettings({ edgeFeather: Number(event.target.value) })} disabled={!selected} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="edge-shift">{t("edge.shift")}</label><output>{(selected?.edgeSettings.edgeShift ?? DEFAULT_EDGE_SETTINGS.edgeShift) > 0 ? "+" : ""}{selected?.edgeSettings.edgeShift ?? DEFAULT_EDGE_SETTINGS.edgeShift}px</output></div>
                <input id="edge-shift" type="range" min="-8" max="8" value={selected?.edgeSettings.edgeShift ?? DEFAULT_EDGE_SETTINGS.edgeShift} onChange={(event) => updateSelectedEdgeSettings({ edgeShift: Number(event.target.value) })} disabled={!selected} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="alpha-threshold">{t("edge.alphaThreshold")}</label><output>{selected?.edgeSettings.alphaThreshold ?? DEFAULT_EDGE_SETTINGS.alphaThreshold}%</output></div>
                <input id="alpha-threshold" type="range" min="0" max="30" value={selected?.edgeSettings.alphaThreshold ?? DEFAULT_EDGE_SETTINGS.alphaThreshold} onChange={(event) => updateSelectedEdgeSettings({ alphaThreshold: Number(event.target.value) })} disabled={!selected} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="mask-contrast">{t("edge.contrast")}</label><output>{(selected?.edgeSettings.maskContrast ?? DEFAULT_EDGE_SETTINGS.maskContrast) > 0 ? "+" : ""}{selected?.edgeSettings.maskContrast ?? DEFAULT_EDGE_SETTINGS.maskContrast}</output></div>
                <input id="mask-contrast" type="range" min="-50" max="50" value={selected?.edgeSettings.maskContrast ?? DEFAULT_EDGE_SETTINGS.maskContrast} onChange={(event) => updateSelectedEdgeSettings({ maskContrast: Number(event.target.value) })} disabled={!selected} />
              </div>
              <label className="check-row"><input type="checkbox" checked={selected?.edgeSettings.preserveOriginalAlpha ?? DEFAULT_EDGE_SETTINGS.preserveOriginalAlpha} onChange={(event) => updateSelectedEdgeSettings({ preserveOriginalAlpha: event.target.checked })} disabled={!selected} /><span><Icon name="check" size={13} /></span>{t("edge.keepOriginalAlpha")}</label>
              <p className="setting-help">{t("edge.fileOnlyHelp")}</p>
            </section>
            </div>
            </div>
          )}
          </div>}
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
        processing={isProcessing}
        onClose={closeSettings}
        onSave={savePreferences}
        onReset={resetPreferences}
        onInstallModel={installModelFromSettings}
        onDeleteModel={deleteModelFromSettings}
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
