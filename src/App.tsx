import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ExportPlan, ImageAsset, OutputFormat, OutputSettings } from "./types";
import { formatBytes, formatDimensions } from "./lib/format";

const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

const DEFAULT_SETTINGS: OutputSettings = {
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
};

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

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
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></>,
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
  const [isPlanning, setIsPlanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const totalBytes = useMemo(() => assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), [assets]);

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
      addAssets(inspected.map((asset) => ({ ...asset, status: "ready", rotation: 0 })));
    } catch (error) {
      setNotice(`파일을 불러오지 못했습니다: ${String(error)}`);
    }
  }, [addAssets]);

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
          void inspectPaths(event.payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [inspectPaths]);

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
        status: "ready",
        previewUrl: URL.createObjectURL(file),
        rotation: 0,
      }));
    addAssets(incoming);
    event.target.value = "";
  };

  const handleBrowserDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isTauri()) return;
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
      return { ...asset, rotation: ((asset.rotation + direction * 90 + 360) % 360) as ImageAsset["rotation"] };
    }));
  };

  const removeSelected = () => {
    if (!selectedId) return;
    setAssets((current) => {
      const next = current.filter((asset) => asset.id !== selectedId);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
  };

  const chooseOutputDirectory = async () => {
    if (!isTauri()) return;
    const selection = await openDialog({ directory: true, multiple: false });
    if (selection) setSettings((current) => ({ ...current, outputDirectory: selection }));
  };

  const preparePlan = async () => {
    if (!assets.length) return;
    setIsPlanning(true);
    try {
      if (isTauri()) {
        const plan = await invoke<ExportPlan>("prepare_export_plan", {
          paths: assets.map((asset) => asset.path),
          settings,
        });
        setNotice(`${plan.itemCount}개 출력 계획을 준비했습니다. AI worker 연결이 다음 구현 단계입니다.`);
      } else {
        setNotice("화면 검증 모드입니다. 데스크톱 앱에서 Rust 처리 엔진과 연결됩니다.");
      }
    } catch (error) {
      setNotice(`출력 설정을 확인해주세요: ${String(error)}`);
    } finally {
      setIsPlanning(false);
    }
  };

  const setFormat = (format: OutputFormat) => setSettings((current) => ({ ...current, format }));

  return (
    <div
      className="app"
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
          <button className="button secondary" onClick={addFilesFromDialog}><Icon name="add" />파일 추가</button>
          <button className="button secondary desktop-only" onClick={addFolderFromDialog}><Icon name="folder" />폴더 추가</button>
          <button className="icon-button" aria-label="환경 설정"><Icon name="settings" /></button>
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
              <div className="library-empty"><Icon name="image" size={24} /><span>이미지를 추가하면<br />여기에 표시됩니다.</span></div>
            ) : assets.map((asset, index) => (
              <button key={asset.id} className={`asset-row ${asset.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(asset.id)}>
                <span className="asset-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="asset-thumb">{asset.previewUrl ? <img src={asset.previewUrl} alt="" /> : <Icon name="image" size={16} />}</span>
                <span className="asset-copy">
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>{formatDimensions(asset.width, asset.height)} · {formatBytes(asset.sizeBytes)}</small>
                </span>
                <span className="status-dot" title="준비됨" />
              </button>
            ))}
          </div>
          {assets.length > 0 && (
            <button className="add-more" onClick={addFilesFromDialog}><Icon name="add" size={16} />이미지 더 추가</button>
          )}
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            <div className="view-tabs" role="tablist" aria-label="미리보기 모드">
              <button className="active" role="tab" aria-selected="true">원본</button>
              <button role="tab" disabled title="AI 엔진 연결 후 활성화">결과</button>
              <button role="tab" disabled title="AI 엔진 연결 후 활성화">비교</button>
            </div>
            <div className="canvas-actions">
              <button className="icon-button" aria-label="왼쪽으로 회전" onClick={() => rotateSelected(-1)} disabled={!selected}><Icon name="rotateLeft" /></button>
              <button className="icon-button" aria-label="오른쪽으로 회전" onClick={() => rotateSelected(1)} disabled={!selected}><Icon name="rotateRight" /></button>
              <span className="divider" />
              <button className="icon-button danger-hover" aria-label="목록에서 제거" onClick={removeSelected} disabled={!selected}><Icon name="trash" /></button>
            </div>
          </div>

          <div className={`canvas ${selected ? "has-image" : ""}`}>
            {selected ? (
              <div className="preview-stage">
                {selected.previewUrl ? (
                  <img
                    className="preview-image"
                    src={selected.previewUrl}
                    alt={`${selected.name} 미리보기`}
                    style={{ transform: `rotate(${selected.rotation}deg)` }}
                  />
                ) : <div className="preview-loading"><span className="spinner" />미리보기 만드는 중</div>}
              </div>
            ) : (
              <div className="drop-card">
                <span className="drop-icon"><Icon name="image" size={28} /></span>
                <h1>배경을 지울 이미지를 놓으세요</h1>
                <p>파일이나 폴더를 드래그하거나 직접 선택하세요.</p>
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
            </div>
          )}
        </section>

        <aside className="inspector-panel">
          <div className="inspector-header">
            <span className="eyebrow">출력 설정</span>
            <button className="text-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>초기화</button>
          </div>

          <section className="setting-section">
            <label className="setting-label">파일 형식</label>
            <div className="segmented">
              <button className={settings.format === "png" ? "active" : ""} onClick={() => setFormat("png")}>PNG</button>
              <button className={settings.format === "webp" ? "active" : ""} onClick={() => setFormat("webp")}>WebP</button>
            </div>
            <p className="setting-help">{settings.format === "png" ? "무손실 · 투명 배경에 가장 안전" : "더 작은 파일 · 투명도 지원"}</p>

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
                <input type="number" min="1" value={settings.resizeValue} onChange={(e) => setSettings({ ...settings, resizeValue: Number(e.target.value) })} />
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
            <div className="label-row"><label className="setting-label">파일 이름</label><button className="text-button" disabled>EXIF 규칙</button></div>
            <div className="name-grid">
              <label><span>앞에 붙이기</span><input type="text" value={settings.prefix} placeholder="예: cut_" onChange={(e) => setSettings({ ...settings, prefix: e.target.value })} /></label>
              <label><span>뒤에 붙이기</span><input type="text" value={settings.suffix} placeholder="예: _bg" onChange={(e) => setSettings({ ...settings, suffix: e.target.value })} /></label>
            </div>
            <div className="name-preview"><span>미리보기</span><strong>{settings.prefix}{selected?.name.replace(/\.[^.]+$/, "") || "image"}{settings.suffix}.{settings.format}</strong></div>
          </section>

          <button className="advanced-row" disabled><span>가장자리 및 고급 옵션</span><span className="coming-soon">다음 단계</span></button>
        </aside>
      </main>

      <footer className="actionbar">
        <div className="estimate">
          <span className="estimate-label">예상 결과</span>
          <strong>{assets.length ? `${assets.length}개 · 계산 대기` : "이미지를 추가해주세요"}</strong>
          {assets.length > 0 && <span className="muted">실제 인코딩 기반 예상은 AI 연결 후 활성화됩니다.</span>}
        </div>
        <button className="run-button" disabled={!assets.length || isPlanning} onClick={preparePlan}>
          <span className="run-icon"><Icon name="sparkle" /></span>
          <span>{isPlanning ? "출력 계획 확인 중…" : `${assets.length || ""}개 배경 지우고 저장`}</span>
          <Icon name="chevron" size={16} />
        </button>
      </footer>

      {isDragging && (
        <div className="drag-overlay">
          <div><span><Icon name="add" size={28} /></span><strong>여기에 놓아 추가</strong><small>파일과 폴더를 함께 처리할 수 있습니다.</small></div>
        </div>
      )}

      {notice && <button className="toast" onClick={() => setNotice(null)}>{notice}<span>닫기</span></button>}
    </div>
  );
}

export default App;
