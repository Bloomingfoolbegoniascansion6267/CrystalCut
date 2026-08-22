import { KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AppDiagnostics, AppPreferences, ModelStatus, OutputSettings } from "./types";
import { formatBytes } from "./lib/format";

type SettingsTab = "general" | "model" | "privacy" | "diagnostics";

interface SettingsModalProps {
  open: boolean;
  preferences: AppPreferences;
  currentSettings: OutputSettings;
  modelStatus: ModelStatus | null;
  diagnostics: AppDiagnostics | null;
  busyAction: "save" | "model" | "reset" | null;
  processing: boolean;
  onClose: () => void;
  onSave: (preferences: AppPreferences) => Promise<void>;
  onReset: () => Promise<AppPreferences>;
  onInstallModel: () => Promise<void>;
  onDeleteModel: () => Promise<void>;
  onChooseDefaultDirectory: () => Promise<string | null>;
  onRefreshDiagnostics: () => Promise<void>;
}

const TAB_LABELS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: "general", label: "일반", description: "새 작업 기본값과 복구" },
  { id: "model", label: "AI 모델", description: "로컬 모델과 저장 공간" },
  { id: "privacy", label: "개인정보", description: "메타데이터 처리 정책" },
  { id: "diagnostics", label: "진단", description: "버전과 데이터 경로" },
];

const clonePreferences = (preferences: AppPreferences): AppPreferences => ({
  ...preferences,
  defaultSettings: { ...preferences.defaultSettings },
});

export default function SettingsModal({
  open,
  preferences,
  currentSettings,
  modelStatus,
  diagnostics,
  busyAction,
  processing,
  onClose,
  onSave,
  onReset,
  onInstallModel,
  onDeleteModel,
  onChooseDefaultDirectory,
  onRefreshDiagnostics,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState(() => clonePreferences(preferences));
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(clonePreferences(preferences));
    setTab("general");
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, preferences]);

  if (!open) return null;

  const updateDefaultSettings = (patch: Partial<OutputSettings>) => {
    setDraft((current) => ({
      ...current,
      defaultSettings: { ...current.defaultSettings, ...patch },
    }));
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busyAction) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ) ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleReset = async () => {
    if (!window.confirm("환경설정을 권장 기본값으로 초기화할까요? 현재 작업 목록과 파일은 유지됩니다.")) return;
    try {
      const reset = await onReset();
      setDraft(clonePreferences(reset));
    } catch {
      // The parent presents the error and the current draft remains intact.
    }
  };

  const handleChooseDirectory = async () => {
    const directory = await onChooseDefaultDirectory();
    if (directory) updateDefaultSettings({ outputDirectory: directory });
  };

  const handleSave = async () => {
    try {
      await onSave(draft);
      onClose();
    } catch {
      // The parent keeps the dialog open and presents the actionable error.
    }
  };

  const renderGeneral = () => (
    <div className="preferences-sections">
      <section className="preferences-card">
        <div className="preferences-card-heading">
          <div><strong>작업 복구</strong><span>앱을 다시 열었을 때 마지막 목록과 진행 상태를 복원합니다.</span></div>
          <label className="switch-control">
            <input
              type="checkbox"
              checked={draft.restoreWorkspace}
              onChange={(event) => setDraft((current) => ({ ...current, restoreWorkspace: event.target.checked }))}
            />
            <span aria-hidden="true" />
          </label>
        </div>
        {!draft.restoreWorkspace && <p className="preferences-note warning">저장된 작업은 삭제하지 않지만 다음 실행에서 자동으로 불러오지 않습니다.</p>}
      </section>

      <section className="preferences-card">
        <div className="preferences-card-heading stacked">
          <div><strong>새 작업 기본값</strong><span>작업 목록이 비어 있을 때 사용할 출력 recipe입니다.</span></div>
          <button className="small-action" type="button" onClick={() => setDraft((current) => ({ ...current, defaultSettings: { ...currentSettings } }))}>현재 작업 설정 가져오기</button>
        </div>
        <div className="preferences-form-grid">
          <label>
            <span>이미지 형식</span>
            <select value={draft.defaultSettings.format} onChange={(event) => updateDefaultSettings({ format: event.target.value as OutputSettings["format"] })}>
              <option value="png">PNG · 무손실 투명도</option>
              <option value="webp">WebP · 작은 용량</option>
            </select>
          </label>
          <label>
            <span>기본 저장 위치</span>
            <select value={draft.defaultSettings.outputLocation} onChange={(event) => updateDefaultSettings({ outputLocation: event.target.value as OutputSettings["outputLocation"] })}>
              <option value="subfolder">원본 아래 새 폴더</option>
              <option value="sameFolder">원본과 같은 폴더</option>
              <option value="custom">지정한 한 폴더</option>
            </select>
          </label>
          <label>
            <span>앞에 붙이기</span>
            <input value={draft.defaultSettings.prefix} onChange={(event) => updateDefaultSettings({ prefix: event.target.value })} placeholder="예: cut_" />
          </label>
          <label>
            <span>뒤에 붙이기</span>
            <input value={draft.defaultSettings.suffix} onChange={(event) => updateDefaultSettings({ suffix: event.target.value })} placeholder="예: _bg" />
          </label>
        </div>
        {draft.defaultSettings.outputLocation === "custom" && (
          <button className="preferences-path-picker" type="button" onClick={() => void handleChooseDirectory()}>
            <span>{draft.defaultSettings.outputDirectory || "기본 저장 폴더를 선택하세요"}</span><b>찾아보기</b>
          </button>
        )}
        <label className="preferences-wide-field">
          <span>파일 이름 템플릿</span>
          <input value={draft.defaultSettings.nameTemplate} spellCheck={false} onChange={(event) => updateDefaultSettings({ nameTemplate: event.target.value })} />
        </label>
        <p className="preferences-note">품질·압축·크기 변경 값도 함께 저장됩니다. 세부 값은 현재 작업 설정을 가져온 뒤 저장할 수 있습니다.</p>
      </section>
    </div>
  );

  const renderModel = () => (
    <div className="preferences-sections">
      <section className="preferences-card model-card">
        <div className="model-status-large">
          <span className={`model-orb ${modelStatus?.installed ? "ready" : ""}`} />
          <div>
            <strong>{modelStatus?.installed ? "로컬 AI 모델 준비됨" : "로컬 AI 모델 설치 필요"}</strong>
            <span>U2NetP · {formatBytes(modelStatus?.expectedBytes ?? 0)}</span>
          </div>
          {modelStatus?.installed ? <span className="state-badge success">설치됨</span> : <span className="state-badge">미설치</span>}
        </div>
        <p className="preferences-note">모든 추론은 이 컴퓨터에서 실행됩니다. 최초 설치 때만 검증된 모델 파일을 내려받습니다.</p>
        <div className="preferences-actions left">
          {!modelStatus?.installed && <button className="button primary compact" type="button" disabled={busyAction !== null || processing} onClick={() => void onInstallModel()}>{busyAction === "model" ? "설치 중…" : "모델 설치"}</button>}
          {modelStatus?.installed && modelStatus.canDelete && <button className="button danger compact" type="button" disabled={busyAction !== null || processing} onClick={() => void onDeleteModel()}>{busyAction === "model" ? "처리 중…" : "모델 삭제"}</button>}
        </div>
        {modelStatus?.path && <code className="path-code" title={modelStatus.path}>{modelStatus.path}</code>}
      </section>

      <section className="preferences-card">
        <div className="preferences-card-heading"><div><strong>저장 공간</strong><span>작업 DB와 모델은 앱 데이터 폴더에 저장됩니다.</span></div></div>
        <dl className="metric-list">
          <div><dt>작업 데이터베이스</dt><dd>{formatBytes(diagnostics?.databaseBytes ?? 0)}</dd></div>
          <div><dt>설치된 모델</dt><dd>{formatBytes(modelStatus?.installedBytes ?? 0)}</dd></div>
          <div><dt>현재 처리 장치</dt><dd>CPU · 자동 fallback</dd></div>
        </dl>
        <p className="preferences-note">{processing ? "현재 batch 처리 중이므로 모델 변경은 잠겨 있습니다." : "GPU provider 선택은 실제 DirectML/CoreML 검증을 마친 뒤 활성화합니다."}</p>
      </section>
    </div>
  );

  const renderPrivacy = () => (
    <div className="preferences-sections">
      <section className="preferences-card policy-card">
        <span className="policy-icon">LOCAL</span>
        <div><strong>이미지는 외부 서버로 전송되지 않습니다.</strong><p>배경 제거, 미리보기, 크기 변경과 인코딩은 모두 로컬 worker에서 처리합니다.</p></div>
      </section>
      <section className="preferences-card">
        <div className="preferences-card-heading"><div><strong>메타데이터 정책</strong><span>현재 구현에 실제 적용되는 범위입니다.</span></div></div>
        <ul className="policy-list">
          <li><span className="policy-check">✓</span><div><strong>GPS 비수집</strong><small>위치 EXIF는 읽거나 작업 DB에 저장하지 않습니다.</small></div></li>
          <li><span className="policy-check">✓</span><div><strong>필요한 EXIF만 요약</strong><small>촬영일, 카메라, 렌즈, orientation만 파일명과 회전에 사용합니다.</small></div></li>
          <li><span className="policy-pending">–</span><div><strong>출력 메타데이터</strong><small>현재 결과 파일에는 EXIF와 ICC를 복사하지 않습니다. 보존 정책은 후속 구현에서 명시적으로 선택하게 합니다.</small></div></li>
        </ul>
      </section>
    </div>
  );

  const renderDiagnostics = () => (
    <div className="preferences-sections">
      <section className="preferences-card">
        <div className="preferences-card-heading stacked">
          <div><strong>앱 정보</strong><span>오류를 제보할 때 함께 확인할 수 있는 정보입니다.</span></div>
          <button className="small-action" type="button" onClick={() => void onRefreshDiagnostics()}>새로 고침</button>
        </div>
        <dl className="metric-list diagnostics-list">
          <div><dt>Clearcut</dt><dd>v{diagnostics?.appVersion ?? "-"}</dd></div>
          <div><dt>Worker protocol</dt><dd>v{diagnostics?.workerProtocolVersion ?? "-"}</dd></div>
          <div><dt>운영체제</dt><dd>{diagnostics ? `${diagnostics.operatingSystem} · ${diagnostics.architecture}` : "-"}</dd></div>
          <div><dt>모델</dt><dd>{modelStatus ? `${modelStatus.id} · ${modelStatus.installed ? "ready" : "not installed"}` : "-"}</dd></div>
        </dl>
      </section>
      <section className="preferences-card">
        <div className="preferences-card-heading"><div><strong>앱 데이터 폴더</strong><span>작업 DB와 설치 모델이 저장되는 위치입니다.</span></div></div>
        <code className="path-code">{diagnostics?.appDataDirectory ?? "확인 중…"}</code>
      </section>
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyAction) onClose(); }}>
      <div id="preferences-dialog" ref={dialogRef} className="preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="preferences-title" onKeyDown={handleDialogKeyDown}>
        <header className="preferences-header">
          <div><h2 id="preferences-title" ref={headingRef} tabIndex={-1}>환경 설정</h2><p>Clearcut의 기본 동작과 로컬 데이터를 관리합니다.</p></div>
          <button className="modal-close" type="button" aria-label="환경 설정 닫기" onClick={onClose} disabled={busyAction !== null}>×</button>
        </header>
        <div className="preferences-layout">
          <nav className="preferences-nav" aria-label="환경 설정 영역">
            {TAB_LABELS.map((item) => (
              <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
                <strong>{item.label}</strong><span>{item.description}</span>
              </button>
            ))}
          </nav>
          <main className="preferences-content">
            {tab === "general" && renderGeneral()}
            {tab === "model" && renderModel()}
            {tab === "privacy" && renderPrivacy()}
            {tab === "diagnostics" && renderDiagnostics()}
          </main>
        </div>
        <footer className="preferences-footer">
          <button className="reset-preferences" type="button" disabled={busyAction !== null} onClick={() => void handleReset()}>{busyAction === "reset" ? "초기화 중…" : "기본값으로 초기화"}</button>
          <div className="preferences-actions">
            <button className="button ghost compact" type="button" onClick={onClose} disabled={busyAction !== null}>취소</button>
            <button className="button primary compact" type="button" disabled={busyAction !== null} onClick={() => void handleSave()}>{busyAction === "save" ? "저장 중…" : "설정 저장"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
