import { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppDiagnostics, AppPreferences, BatchProgress, BatchResult, ExportPlan, ImageAsset, ManualMaskRecipe, MaskPoint, ModelStatus, OutputFormat, OutputSettings, PersistedAsset, RestoredWorkspace, WorkspaceSnapshot } from "./types";
import { formatBytes, formatDimensions } from "./lib/format";
import SettingsModal from "./SettingsModal";
import PreviewEditor from "./PreviewEditor";

const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

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
  edgeSmoothing: 2,
  edgeFeather: 1,
  edgeShift: 0,
  alphaThreshold: 2,
  maskContrast: 0,
  preserveOriginalAlpha: true,
};

const DEFAULT_MASK_RECIPE: ManualMaskRecipe = { mode: "automatic", strokes: [] };

const DEFAULT_PREFERENCES: AppPreferences = {
  defaultSettings: DEFAULT_SETTINGS,
  restoreWorkspace: true,
};

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

const STATUS_LABEL: Record<ImageAsset["status"], string> = {
  ready: "준비됨",
  queued: "대기 중",
  processing: "처리 중",
  retrying: "Worker 복구 중",
  done: "완료",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "중단됨",
};

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

function App() {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<OutputSettings>(DEFAULT_SETTINGS);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [batchCompleted, setBatchCompleted] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [viewMode, setViewMode] = useState<"original" | "result" | "compare">("original");
  const [isMaskEditing, setIsMaskEditing] = useState(false);
  const [maskPreviewBusy, setMaskPreviewBusy] = useState(false);
  const [maskPreviewError, setMaskPreviewError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [lastOutputBytes, setLastOutputBytes] = useState<number | null>(null);
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isWorkspaceLoaded, setIsWorkspaceLoaded] = useState(!isTauri());
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsBusyAction, setSettingsBusyAction] = useState<"save" | "model" | "reset" | null>(null);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; textField: HTMLInputElement | HTMLTextAreaElement | null } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const skipNextWorkspaceSave = useRef(false);
  const workspaceSaveTimer = useRef<number | null>(null);
  const workspaceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const maskPreviewRevision = useRef(0);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const totalBytes = useMemo(() => assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), [assets]);
  const hasResultView = Boolean(selected?.resultPreviewUrl || (isMaskEditing && selected?.editBasePreviewUrl));
  const effectiveViewMode = hasResultView ? viewMode : "original";
  const retryableAssets = useMemo(
    () => assets.filter((asset) => asset.status === "failed" || asset.status === "cancelled" || asset.status === "interrupted"),
    [assets],
  );
  const completedOutputBytes = useMemo(
    () => assets.reduce((sum, asset) => sum + (asset.status === "done" ? asset.outputBytes ?? 0 : 0), 0),
    [assets],
  );
  const displayOutputBytes = lastOutputBytes ?? (completedOutputBytes > 0 ? completedOutputBytes : null);
  const persistedAssets = useMemo(() => assets.map(toPersistedAsset), [assets]);
  const workspaceKey = useMemo(() => JSON.stringify({ items: persistedAssets, settings }), [persistedAssets, settings]);
  const planKey = useMemo(() => JSON.stringify({
    items: assets.map(({ path, rotation, maskRecipe }) => ({ path, rotation, maskRecipe })),
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
    setNotice(`${incoming.length}개 이미지를 불러왔습니다.`);
  }, []);

  const inspectPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const inspected = await invoke<Omit<ImageAsset, "status" | "rotation">[]>("inspect_paths", { paths });
      addAssets(inspected.map((asset) => ({ ...asset, status: "ready", rotation: 0, maskRecipe: DEFAULT_MASK_RECIPE })));
    } catch (error) {
      setNotice(`파일을 불러오지 못했습니다: ${String(error)}`);
    }
  }, [addAssets]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;

    void (async () => {
      let loadedPreferences = DEFAULT_PREFERENCES;
      try {
        loadedPreferences = await invoke<AppPreferences>("load_app_preferences");
      } catch (error) {
        if (!disposed) setNotice(`환경설정을 복구하지 못해 기본값을 사용합니다: ${String(error)}`);
      }
      if (disposed) return;
      setPreferences(loadedPreferences);

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
        setSelectedId(restored.items[0]?.id ?? null);
        if (restored.items.some((asset) => asset.status === "done")) setViewMode("result");
        if (restored.items.length || restored.missingFiles || restored.interrupted) {
          setNotice([
            `저장된 작업 ${restored.items.length}개 복구`,
            restored.interrupted ? `중단 ${restored.interrupted}개` : null,
            restored.missingFiles ? `찾을 수 없는 파일 ${restored.missingFiles}개 제외` : null,
          ].filter(Boolean).join(" · "));
        }
      } catch (error) {
        if (!disposed) setNotice(`저장된 작업을 복구하지 못했습니다: ${String(error)}`);
      }
    })().finally(() => !disposed && setIsWorkspaceLoaded(true));

    return () => { disposed = true; };
  }, []);

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
        .catch((error) => setNotice(`작업 상태를 저장하지 못했습니다: ${String(error)}`));
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
        setNotice("필요한 로컬 AI 모델을 준비하고 있습니다. 모델별로 최초 한 번만 다운로드합니다.");
        return;
      }
      setBatchCompleted(payload.completed);
      setAssets((current) => current.map((asset) => {
        if (asset.id !== payload.assetId) return asset;
        if (payload.status === "queued") return { ...asset, status: "queued", error: undefined };
        if (payload.status === "processing") return { ...asset, status: "processing", error: undefined };
        if (payload.status === "retryingWorker") return { ...asset, status: "retrying", error: payload.error ?? undefined };
        if (payload.status === "completed") {
          return { ...asset, status: "done", outputPath: payload.outputPath ?? undefined, resultPreviewUrl: undefined, editBasePreviewUrl: undefined, error: undefined };
        }
        if (payload.status === "failed") return { ...asset, status: "failed", error: payload.error ?? "처리에 실패했습니다." };
        if (payload.status === "cancelled") return { ...asset, status: "cancelled", error: payload.error ?? "사용자가 취소했습니다." };
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
  }, []);

  useEffect(() => {
    if (!isTauri() || !assets.length || isProcessing) {
      if (!assets.length) setExportPlan(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsEstimating(true);
      void invoke<ExportPlan>("prepare_export_plan", {
        items: assets.map((asset, index) => ({ id: asset.id, path: asset.path, rotation: asset.rotation, sequence: index + 1, exif: asset.exif, maskRecipe: asset.maskRecipe })),
        settings,
      })
        .then((plan) => {
          if (!cancelled) setExportPlan(plan);
        })
        .catch((error) => {
          if (!cancelled) {
            setExportPlan(null);
            setNotice(`출력 설정을 확인해주세요: ${String(error)}`);
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
      .catch((error) => !cancelled && setNotice(`미리보기를 만들지 못했습니다: ${String(error)}`));
    return () => { cancelled = true; };
  }, [selected]);

  useEffect(() => {
    const revision = ++maskPreviewRevision.current;
    if (!isTauri() || !isMaskEditing || !selected || settings.processingMode !== "removeBackground" || selected.maskRecipe.mode === "automatic") {
      setMaskPreviewBusy(false);
      setMaskPreviewError(null);
      return;
    }
    const hasKeep = selected.maskRecipe.strokes.some((stroke) => stroke.mode === "keep" && stroke.points.length > 0);
    if ((selected.maskRecipe.mode === "manual" || selected.maskRecipe.mode === "sam") && !hasKeep) {
      setMaskPreviewBusy(false);
      setMaskPreviewError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setMaskPreviewBusy(true);
      setMaskPreviewError(null);
      const command = selected.maskRecipe.mode === "sam" ? "generate_sam_preview" : "generate_mask_preview";
      void invoke<string>(command, {
        path: selected.path,
        rotation: selected.rotation,
        maskRecipe: selected.maskRecipe,
        settings,
      }).then((editBasePreviewUrl) => {
        if (maskPreviewRevision.current !== revision) return;
        setAssets((current) => current.map((asset) => asset.id === selected.id ? { ...asset, editBasePreviewUrl } : asset));
        setViewMode("result");
      }).catch((error) => {
        if (maskPreviewRevision.current !== revision) return;
        const message = String(error);
        setMaskPreviewError(message);
        setNotice(`마스크 미리보기를 갱신하지 못했습니다: ${message}`);
      }).finally(() => {
        if (maskPreviewRevision.current === revision) setMaskPreviewBusy(false);
      });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [isMaskEditing, selected?.id, selected?.path, selected?.rotation, selected?.maskRecipe, settings]);

  useEffect(() => {
    if (!selected?.outputPath || selected.resultPreviewUrl || !isTauri()) return;
    let cancelled = false;
    invoke<string>("load_preview", { path: selected.outputPath })
      .then((resultPreviewUrl) => {
        if (!cancelled) {
          setAssets((current) => current.map((asset) => asset.id === selected.id ? { ...asset, resultPreviewUrl } : asset));
        }
      })
      .catch((error) => !cancelled && setNotice(`결과 미리보기를 만들지 못했습니다: ${String(error)}`));
    return () => { cancelled = true; };
  }, [selected]);

  const addFilesFromDialog = async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const selection = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: "이미지", extensions: SUPPORTED_EXTENSIONS }],
    });
    if (selection) await inspectPaths(Array.isArray(selection) ? selection : [selection]);
  };

  const addFolderFromDialog = async () => {
    if (!isTauri()) {
      setNotice("폴더 선택은 데스크톱 앱에서 사용할 수 있습니다.");
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
        exif: { takenAt: null, camera: null, lens: null, orientation: 1 },
        status: "ready",
        previewUrl: URL.createObjectURL(file),
        rotation: 0,
        maskRecipe: DEFAULT_MASK_RECIPE,
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
    if (maskRecipe.mode === "automatic") setViewMode("original");
    else if (isMaskEditing) setViewMode("result");
  }, [isMaskEditing, selectedId]);

  useEffect(() => {
    setIsMaskEditing(false);
  }, [selectedId]);

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

  const removeSelected = () => {
    if (!selectedId) return;
    setAssets((current) => {
      const next = current.filter((asset) => asset.id !== selectedId);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
  };

  const clearWorkspace = async () => {
    if (isProcessing || !window.confirm("작업 목록과 저장된 설정을 비울까요? 원본과 결과 파일은 삭제되지 않습니다.")) return;
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
      setSettings(preferences.defaultSettings);
      setLastOutputBytes(null);
      setExportPlan(null);
      setBatchCompleted(0);
      setBatchTotal(0);
      setViewMode("original");
      setNotice("작업 공간을 비웠습니다. 원본과 결과 파일은 그대로 유지됩니다.");
    } catch (error) {
      setNotice(`작업 공간을 비우지 못했습니다: ${String(error)}`);
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
      setSelectedId(incompleteManual.id);
      setViewMode("original");
      setIsMaskEditing(true);
      setNotice(`'${incompleteManual.name}'에서 유지할 객체를 초록색 브러시로 먼저 표시해주세요.`);
      return;
    }
    if (!isTauri()) {
      setNotice(`화면 검증 모드입니다. 실제 ${settings.processingMode === "convert" ? "이미지 변환" : "배경 제거"}은 Tauri 데스크톱 앱에서 실행됩니다.`);
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
      ? { ...asset, status: "queued", outputPath: undefined, outputBytes: undefined, resultPreviewUrl: undefined, editBasePreviewUrl: undefined, error: undefined }
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
        `${result.completed}개 저장 완료`,
        result.failed ? `${result.failed}개 실패` : null,
        result.cancelled ? `${result.cancelled}개 취소` : null,
        result.workerRestarts ? `Worker ${result.workerRestarts}회 복구` : null,
        `결과 ${formatBytes(result.outputBytes)}`,
      ].filter(Boolean).join(" · "));
    } catch (error) {
      const message = String(error);
      setAssets((current) => current.map((asset) => asset.status === "queued" || asset.status === "processing" || asset.status === "retrying" ? { ...asset, status: "failed", error: message } : asset));
      setNotice(`${settings.processingMode === "convert" ? "이미지 변환" : "배경 제거"}을 완료하지 못했습니다: ${message}`);
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
      setNotice(accepted ? "현재 파일을 마친 뒤 나머지 작업을 취소합니다." : "취소할 작업이 없습니다.");
      if (!accepted) setIsCancelling(false);
    } catch (error) {
      setIsCancelling(false);
      setNotice(`취소 요청을 보내지 못했습니다: ${String(error)}`);
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
      setNotice(`진단 정보를 확인하지 못했습니다: ${String(error)}`);
    }
  };

  const openSettings = () => {
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
      if (!assets.length) setSettings(nextPreferences.defaultSettings);
      setNotice("환경설정을 저장했습니다. 새 작업부터 기본 출력 설정을 적용합니다.");
    } catch (error) {
      setNotice(`환경설정을 저장하지 못했습니다: ${String(error)}`);
      throw error;
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const resetPreferences = async () => {
    setSettingsBusyAction("reset");
    try {
      const reset = isTauri()
        ? await invoke<AppPreferences>("reset_app_preferences")
        : { ...DEFAULT_PREFERENCES, defaultSettings: { ...DEFAULT_SETTINGS } };
      setPreferences(reset);
      if (!assets.length) setSettings(reset.defaultSettings);
      setNotice("환경설정을 권장 기본값으로 초기화했습니다.");
      return reset;
    } catch (error) {
      setNotice(`환경설정을 초기화하지 못했습니다: ${String(error)}`);
      throw error;
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const installModelFromSettings = async () => {
    if (!isTauri()) {
      setNotice("모델 설치는 Tauri 데스크톱 앱에서 사용할 수 있습니다.");
      return;
    }
    setSettingsBusyAction("model");
    try {
      const status = await invoke<ModelStatus>("install_model");
      setModelStatus(status);
      setNotice("로컬 AI 모델을 설치하고 검증했습니다.");
      await refreshSettingsData();
    } catch (error) {
      setNotice(`AI 모델을 설치하지 못했습니다: ${String(error)}`);
    } finally {
      setSettingsBusyAction(null);
    }
  };

  const deleteModelFromSettings = async () => {
    if (!isTauri() || !window.confirm("설치된 AI 모델을 삭제할까요? 원본과 결과 파일은 유지되며 필요할 때 다시 내려받을 수 있습니다.")) return;
    setSettingsBusyAction("model");
    try {
      const status = await invoke<ModelStatus>("delete_model");
      setModelStatus(status);
      setNotice("설치된 AI 모델을 삭제했습니다.");
      await refreshSettingsData();
    } catch (error) {
      setNotice(`AI 모델을 삭제하지 못했습니다: ${String(error)}`);
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
    : `${formatBytes(exportPlan.estimatedOutputBytes)} 예상`;
  const savingsText = exportPlan?.estimatedSavingsPercent == null
    ? null
    : exportPlan.estimatedSavingsPercent >= 0
      ? `${Math.round(exportPlan.estimatedSavingsPercent)}% 감소 예상`
      : `${Math.round(Math.abs(exportPlan.estimatedSavingsPercent))}% 증가 예상`;

  const setFormat = (format: OutputFormat) => setSettings((current) => ({ ...current, format }));

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
      setViewMode("original");
    }
  };

  const openMaskEditor = () => {
    if (!selected || settings.processingMode === "convert") return;
    if (selected.maskRecipe.mode === "automatic") updateSelectedMask({ ...selected.maskRecipe, mode: "refine" });
    setViewMode(selected.resultPreviewUrl || selected.editBasePreviewUrl ? "result" : "original");
    setIsMaskEditing(true);
  };

  const openAppContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const element = event.target as HTMLElement;
    const textField = element.closest("input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='tel'], textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - (textField ? 188 : 230)),
      textField,
    });
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
        setNotice("클립보드 붙여넣기 권한을 확인해주세요. Ctrl/Cmd+V도 사용할 수 있습니다.");
      }
      return;
    }
    document.execCommand(action);
  };

  return (
    <div
      className="app"
      onContextMenu={openAppContextMenu}
      onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
      onDrop={handleBrowserDrop}
    >
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={addBrowserFiles} />

      <header className="topbar">
        <div className="brand" aria-label="Clearcut">
          <span className="brand-mark"><Icon name="sparkle" size={16} /></span>
          <span>Clearcut</span>
          <span className="beta">BETA</span>
        </div>
        <div className="topbar-actions">
          <span className={`model-pill ${modelStatus?.installed ? "ready" : ""}`} title={modelStatus?.purpose}>
            <span />자동 제거 AI {modelStatus?.installed ? "준비됨" : "필요 시 설치"}
          </span>
          <button className="button secondary" onClick={addFilesFromDialog} disabled={isProcessing || !isWorkspaceLoaded}><Icon name="add" />파일 추가</button>
          <button className="button secondary desktop-only" onClick={addFolderFromDialog} disabled={isProcessing || !isWorkspaceLoaded}><Icon name="folder" />폴더 추가</button>
          <button ref={settingsButtonRef} className="icon-button" aria-label="환경 설정" aria-haspopup="dialog" aria-expanded={isSettingsOpen} aria-controls="preferences-dialog" onClick={openSettings}><Icon name="settings" /></button>
        </div>
      </header>

      <main className="workspace">
        <aside className="library-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">작업 목록</span><strong>{assets.length}</strong></div>
            {assets.length > 0 && <span className="muted">{formatBytes(totalBytes)}</span>}
          </div>
          <div className="asset-list">
            {assets.length === 0 ? (
              <div className="library-empty"><Icon name="image" size={24} /><span>{isWorkspaceLoaded ? <>이미지를 추가하면<br />여기에 표시됩니다.</> : "저장된 작업 확인 중…"}</span></div>
            ) : assets.map((asset, index) => (
              <button key={asset.id} className={`asset-row ${asset.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(asset.id)}>
                <span className="asset-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="asset-thumb">{asset.previewUrl ? <img src={asset.previewUrl} alt="" /> : <Icon name="image" size={16} />}</span>
                <span className="asset-copy">
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>{formatDimensions(asset.width, asset.height)} · {formatBytes(asset.sizeBytes)}</small>
                </span>
                <span className={`status-dot ${asset.status}`} title={asset.error || STATUS_LABEL[asset.status]} />
              </button>
            ))}
          </div>
          {assets.length > 0 && (
            <div className="library-footer-actions">
              <button className="add-more" onClick={addFilesFromDialog} disabled={isProcessing}><Icon name="add" size={16} />이미지 더 추가</button>
              <button className="clear-workspace" onClick={() => void clearWorkspace()} disabled={isProcessing}><Icon name="trash" size={15} />작업 비우기</button>
            </div>
          )}
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            <div className="view-tabs" role="tablist" aria-label="미리보기 모드">
              <button className={effectiveViewMode === "original" ? "active" : ""} onClick={() => setViewMode("original")} role="tab" aria-selected={effectiveViewMode === "original"}>원본</button>
              <button className={effectiveViewMode === "result" ? "active" : ""} onClick={() => setViewMode("result")} role="tab" disabled={!hasResultView}>결과</button>
              <button className={effectiveViewMode === "compare" ? "active" : ""} onClick={() => setViewMode("compare")} role="tab" disabled={!hasResultView || isMaskEditing}>비교</button>
            </div>
            <div className="canvas-actions">
              <button className={`mask-edit-button ${isMaskEditing ? "active" : ""}`} onClick={isMaskEditing ? () => setIsMaskEditing(false) : openMaskEditor} disabled={!selected?.previewUrl || isProcessing || settings.processingMode === "convert"}><Icon name="brush" size={16} />{isMaskEditing ? "편집 완료" : "브러시 편집"}</button>
              <span className="divider" />
              <button className="icon-button" aria-label="왼쪽으로 회전" onClick={() => rotateSelected(-1)} disabled={!selected}><Icon name="rotateLeft" /></button>
              <button className="icon-button" aria-label="오른쪽으로 회전" onClick={() => rotateSelected(1)} disabled={!selected}><Icon name="rotateRight" /></button>
              <span className="divider" />
              <button className="icon-button danger-hover" aria-label="목록에서 제거" onClick={removeSelected} disabled={!selected}><Icon name="trash" /></button>
            </div>
          </div>

          <div className={`canvas ${selected ? "has-image" : ""}`}>
            {selected ? (
              selected.previewUrl ? (
                <PreviewEditor
                  asset={selected}
                  viewMode={effectiveViewMode}
                  editing={isMaskEditing}
                  onEditingChange={setIsMaskEditing}
                  onMaskChange={updateSelectedMask}
                  previewBusy={maskPreviewBusy}
                  previewError={maskPreviewError}
                />
              ) : <div className="preview-stage"><div className="preview-loading"><span className="spinner" />미리보기 만드는 중</div></div>
            ) : (
              <div className="drop-card">
                <span className="drop-icon"><Icon name="image" size={28} /></span>
                <h1>처리할 이미지를 놓으세요</h1>
                <p>배경 제거 또는 형식·크기 변환할 파일을 선택하세요.</p>
                <div className="drop-actions">
                  <button className="button primary compact" onClick={addFilesFromDialog}>이미지 선택</button>
                  <button className="button ghost compact desktop-only" onClick={addFolderFromDialog}>폴더 선택</button>
                </div>
                <small>JPEG · PNG · WebP</small>
              </div>
            )}
          </div>

          {selected && (
            <div className="file-info-bar">
              <span><strong>{selected.name}</strong></span>
              <span>{formatDimensions(selected.width, selected.height)}</span>
              <span>{selected.extension.toUpperCase()}</span>
              {selected.rotation !== 0 && <span>{selected.rotation}° 회전</span>}
              {selected.exif.takenAt && <span title="EXIF 촬영일">{selected.exif.takenAt}</span>}
              {selected.exif.camera && <span title={selected.exif.lens ?? "EXIF 카메라"}>{selected.exif.camera}</span>}
              <span className={`file-status ${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
            </div>
          )}
        </section>

        <aside className="inspector-panel">
          <div className="inspector-header">
            <span className="eyebrow">출력 설정</span>
            <button className="text-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>초기화</button>
          </div>

          <section className="setting-section">
            <label className="setting-label">처리 방식</label>
            <div className="segmented processing-mode">
              <button className={settings.processingMode === "removeBackground" ? "active" : ""} onClick={() => setProcessingMode("removeBackground")}>배경 제거</button>
              <button className={settings.processingMode === "convert" ? "active" : ""} onClick={() => setProcessingMode("convert")}>이미지만 변환</button>
            </div>
            <p className="setting-help">{settings.processingMode === "removeBackground"
              ? "AI 마스크와 브러시 보정을 적용한 뒤 저장합니다."
              : "배경은 건드리지 않고 회전·크기·형식·압축 설정만 적용합니다."}</p>
          </section>

          <section className="setting-section">
            <label className="setting-label">파일 형식</label>
            <div className="segmented">
              <button className={settings.format === "png" ? "active" : ""} onClick={() => setFormat("png")}>PNG</button>
              <button className={settings.format === "webp" ? "active" : ""} onClick={() => setFormat("webp")}>WebP</button>
            </div>
            <p className="setting-help">{settings.format === "png"
              ? settings.processingMode === "removeBackground" ? "무손실 · 투명 배경에 가장 안전" : "무손실 변환 · 원본 투명도 유지"
              : settings.processingMode === "removeBackground" ? "더 작은 파일 · 투명도 지원" : "더 작은 파일 · 화질과 압축률 조절"}</p>

            {settings.format === "webp" ? (
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="quality">화질</label><output>{settings.webpQuality}</output></div>
                <input id="quality" type="range" min="1" max="100" value={settings.webpQuality} onChange={(e) => setSettings({ ...settings, webpQuality: Number(e.target.value) })} />
                <label className="check-row"><input type="checkbox" checked={settings.webpLossless} onChange={(e) => setSettings({ ...settings, webpLossless: e.target.checked })} /><span><Icon name="check" size={13} /></span>무손실 WebP</label>
              </div>
            ) : (
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="effort">압축 강도</label><output>{settings.pngEffort}</output></div>
                <input id="effort" type="range" min="1" max="9" value={settings.pngEffort} onChange={(e) => setSettings({ ...settings, pngEffort: Number(e.target.value) })} />
                <p className="setting-help flush">화질은 유지되고 저장 시간과 용량만 달라집니다.</p>
              </div>
            )}
          </section>

          <section className="setting-section">
            <label className="setting-label" htmlFor="resize-mode">크기 변경</label>
            <select id="resize-mode" value={settings.resizeMode} onChange={(e) => setSettings({ ...settings, resizeMode: e.target.value as OutputSettings["resizeMode"] })}>
              <option value="original">원본 크기 유지</option>
              <option value="percent">비율로 변경</option>
              <option value="longEdge">긴 변 기준</option>
            </select>
            {settings.resizeMode !== "original" && (
              <div className="input-with-unit">
                <input type="number" min="1" max={settings.resizeMode === "percent" ? 1000 : 32768} value={settings.resizeValue} onChange={(e) => setSettings({ ...settings, resizeValue: Number(e.target.value) })} />
                <span>{settings.resizeMode === "percent" ? "%" : "px"}</span>
              </div>
            )}
            <label className="check-row"><input type="checkbox" checked={settings.preventUpscale} onChange={(e) => setSettings({ ...settings, preventUpscale: e.target.checked })} /><span><Icon name="check" size={13} /></span>작은 이미지는 확대하지 않기</label>
          </section>

          <section className="setting-section">
            <label className="setting-label" htmlFor="save-location">저장 위치</label>
            <select id="save-location" value={settings.outputLocation} onChange={(e) => setSettings({ ...settings, outputLocation: e.target.value as OutputSettings["outputLocation"] })}>
              <option value="subfolder">원본 폴더 안에 새 폴더</option>
              <option value="sameFolder">원본과 같은 폴더</option>
              <option value="custom">지정한 폴더</option>
            </select>
            {settings.outputLocation === "custom" && (
              <button className="path-picker" onClick={chooseOutputDirectory} title={settings.outputDirectory || "폴더를 선택하세요"}>
                <Icon name="folder" size={16} /><span>{settings.outputDirectory || "폴더 선택"}</span><Icon name="chevron" size={14} />
              </button>
            )}
          </section>

          <section className="setting-section naming-section">
            <div className="label-row"><label className="setting-label" htmlFor="name-template">파일 이름</label><span className="live-badge">동적 규칙</span></div>
            <div className="name-grid">
              <label><span>앞에 붙이기</span><input type="text" value={settings.prefix} placeholder="예: cut_" onChange={(e) => setSettings({ ...settings, prefix: e.target.value })} /></label>
              <label><span>뒤에 붙이기</span><input type="text" value={settings.suffix} placeholder={settings.processingMode === "convert" ? "예: _converted" : "예: _bg"} onChange={(e) => setSettings({ ...settings, suffix: e.target.value })} /></label>
            </div>
            <label className="template-field" htmlFor="name-template">
              <span>템플릿</span>
              <input id="name-template" type="text" value={settings.nameTemplate} spellCheck={false} onChange={(e) => setSettings({ ...settings, nameTemplate: e.target.value })} />
            </label>
            <div className="token-row" aria-label="파일 이름 토큰 추가">
              <button type="button" onClick={() => appendNameToken("{taken:yyMMdd_HHmmss}")}>촬영일</button>
              <button type="button" onClick={() => appendNameToken("{seq:03}")}>순번</button>
              <button type="button" onClick={() => appendNameToken("{camera}")}>카메라</button>
              <button type="button" onClick={() => appendNameToken("{lens}")}>렌즈</button>
            </div>
            <div className="name-preview"><span>{isEstimating ? "계산 중" : "미리보기"}</span><strong>{previewOutputName}</strong></div>
            {exportPlan?.warnings[0] && <p className="setting-warning">{exportPlan.warnings[0]}</p>}
          </section>

          {settings.processingMode === "removeBackground" && <section className="setting-section mask-summary-section">
            <div className="label-row"><span className="setting-label">객체 마스크</span><span className="live-badge">파일별</span></div>
            <p className="setting-help flush">{!selected
              ? "이미지를 선택하면 브러시로 유지할 객체와 제거할 영역을 지정할 수 있습니다."
              : selected.maskRecipe.mode === "manual"
                ? `칠한 영역만 유지 · 브러시 ${selected.maskRecipe.strokes.length}개`
                : selected.maskRecipe.mode === "sam"
                  ? `AI 객체 선택 · 프롬프트 ${selected.maskRecipe.strokes.length}개`
                : selected.maskRecipe.mode === "refine"
                  ? `AI 결과 보정 · 브러시 ${selected.maskRecipe.strokes.length}개`
                  : "AI 자동 배경 제거"}</p>
            <button className="button secondary mask-summary-button" onClick={openMaskEditor} disabled={!selected?.previewUrl || isProcessing}><Icon name="brush" size={15} />브러시로 객체 편집</button>
          </section>}

          {settings.processingMode === "removeBackground" && <button className={`advanced-row ${isAdvancedOpen ? "open" : ""}`} onClick={() => setIsAdvancedOpen((value) => !value)} aria-expanded={isAdvancedOpen} aria-controls="advanced-settings"><span>가장자리 및 고급 옵션</span><Icon name="chevron" size={15} /></button>}
          {settings.processingMode === "removeBackground" && isAdvancedOpen && (
            <section id="advanced-settings" className="setting-section advanced-settings">
              <div className="sub-setting first">
                <div className="label-row"><label htmlFor="edge-smoothing">가장자리 매끄럽게</label><output>{settings.edgeSmoothing}</output></div>
                <input id="edge-smoothing" type="range" min="0" max="10" value={settings.edgeSmoothing} onChange={(event) => setSettings({ ...settings, edgeSmoothing: Number(event.target.value) })} />
                <p className="setting-help flush">톱니 모양의 마스크 경계를 부드럽게 정리합니다.</p>
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="edge-feather">가장자리 페더</label><output>{settings.edgeFeather}px</output></div>
                <input id="edge-feather" type="range" min="0" max="20" value={settings.edgeFeather} onChange={(event) => setSettings({ ...settings, edgeFeather: Number(event.target.value) })} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="edge-shift">마스크 확장·축소</label><output>{settings.edgeShift > 0 ? "+" : ""}{settings.edgeShift}px</output></div>
                <input id="edge-shift" type="range" min="-8" max="8" value={settings.edgeShift} onChange={(event) => setSettings({ ...settings, edgeShift: Number(event.target.value) })} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="alpha-threshold">희미한 배경 제거</label><output>{settings.alphaThreshold}%</output></div>
                <input id="alpha-threshold" type="range" min="0" max="30" value={settings.alphaThreshold} onChange={(event) => setSettings({ ...settings, alphaThreshold: Number(event.target.value) })} />
              </div>
              <div className="sub-setting">
                <div className="label-row"><label htmlFor="mask-contrast">마스크 대비</label><output>{settings.maskContrast > 0 ? "+" : ""}{settings.maskContrast}</output></div>
                <input id="mask-contrast" type="range" min="-50" max="50" value={settings.maskContrast} onChange={(event) => setSettings({ ...settings, maskContrast: Number(event.target.value) })} />
              </div>
              <label className="check-row"><input type="checkbox" checked={settings.preserveOriginalAlpha} onChange={(event) => setSettings({ ...settings, preserveOriginalAlpha: event.target.checked })} /><span><Icon name="check" size={13} /></span>원본 투명도 보존</label>
              <p className="setting-help">고급 옵션은 모든 파일에 적용되며, 브러시 마스크는 선택한 파일에만 적용됩니다.</p>
            </section>
          )}
        </aside>
      </main>

      <footer className="actionbar">
        <div className="estimate">
          <span className="estimate-label">{isProcessing ? "처리 중" : displayOutputBytes === null ? "예상 결과" : "결과"}</span>
          <strong>{assets.length ? `${isProcessing ? batchCompleted : assets.filter((asset) => asset.status === "done").length} / ${isProcessing ? batchTotal : assets.length}개` : "이미지를 추가해주세요"}</strong>
          {assets.length > 0 && <span className="muted">{
            displayOutputBytes !== null
              ? `${formatBytes(totalBytes)} → ${formatBytes(displayOutputBytes)} 저장`
              : isEstimating
                ? `${formatBytes(totalBytes)} 원본 · 용량 계산 중…`
                : estimateText
                  ? `${formatBytes(totalBytes)} → ${estimateText}${savingsText ? ` · ${savingsText}` : ""}`
                  : `${formatBytes(totalBytes)} 원본 · 로컬에서만 처리`
          }</span>}
        </div>
        <div className="action-buttons">
          {!isProcessing && retryableAssets.length > 0 && (
            <button className="retry-button" onClick={() => void processAssets(retryableAssets)}>
              <Icon name="rotateRight" size={15} />미완료 {retryableAssets.length}개 재시도
            </button>
          )}
          <button
            className={`run-button ${isProcessing ? "cancel" : ""}`}
            disabled={isProcessing ? isCancelling : !assets.length || !isWorkspaceLoaded}
            onClick={() => isProcessing ? void cancelProcessing() : void processAssets(assets)}
          >
            <span className="run-icon"><Icon name={isProcessing ? "stop" : "sparkle"} /></span>
            <span>{isProcessing
              ? isCancelling ? "취소 요청됨…" : `${batchCompleted} / ${batchTotal} 처리 중 · 취소`
              : assets.length
                ? `${assets.length}개 ${settings.processingMode === "convert" ? "변환해서 저장" : "배경 지우고 저장"}`
                : "이미지를 추가해주세요"}</span>
            {!isProcessing && <Icon name="chevron" size={16} />}
          </button>
        </div>
      </footer>

      {isDragging && (
        <div className="drag-overlay">
          <div><span><Icon name="add" size={28} /></span><strong>여기에 놓아 추가</strong><small>파일과 폴더를 함께 처리할 수 있습니다.</small></div>
        </div>
      )}

      {contextMenu && (
        <div className="app-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          {contextMenu.textField ? (
            <>
              <button role="menuitem" onClick={() => void runTextMenuAction("undo")}><span>실행 취소</span><kbd>Ctrl+Z</kbd></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => void runTextMenuAction("cut")}><span>잘라내기</span><kbd>Ctrl+X</kbd></button>
              <button role="menuitem" onClick={() => void runTextMenuAction("copy")}><span>복사</span><kbd>Ctrl+C</kbd></button>
              <button role="menuitem" onClick={() => void runTextMenuAction("paste")}><span>붙여넣기</span><kbd>Ctrl+V</kbd></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => void runTextMenuAction("selectAll")}><span>모두 선택</span><kbd>Ctrl+A</kbd></button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => { setContextMenu(null); openMaskEditor(); }} disabled={!selected?.previewUrl || settings.processingMode === "convert"}><span>브러시로 객체 편집</span></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setViewMode("original"); setContextMenu(null); }} disabled={!selected}><span>원본 보기</span></button>
              <button role="menuitem" onClick={() => { setViewMode("result"); setContextMenu(null); }} disabled={!selected?.outputPath}><span>결과 보기</span></button>
              <button role="menuitem" onClick={() => { setViewMode("compare"); setContextMenu(null); }} disabled={!selected?.outputPath}><span>드래그 비교</span></button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setContextMenu(null); void addFilesFromDialog(); }}><span>이미지 추가…</span></button>
              <button role="menuitem" onClick={() => { setContextMenu(null); openSettings(); }}><span>환경설정…</span></button>
            </>
          )}
        </div>
      )}

      <SettingsModal
        open={isSettingsOpen}
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
      />

      {notice && <button className="toast" onClick={() => setNotice(null)}>{notice}<span>닫기</span></button>}
    </div>
  );
}

export default App;
