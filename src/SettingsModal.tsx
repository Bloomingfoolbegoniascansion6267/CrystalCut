import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AppDiagnostics, AppPreferences, ComputeProbeResult, ModelStatus, OutputSettings } from "./types";
import { formatBytes } from "./lib/format";
import { useI18n } from "./i18n/I18nProvider";
import { LOCALE_OPTIONS, type LanguagePreference } from "./i18n/locale";

export type SettingsTab = "general" | "model" | "privacy" | "diagnostics";

interface SettingsModalProps {
  open: boolean;
  initialTab: SettingsTab;
  preferences: AppPreferences;
  currentSettings: OutputSettings;
  modelStatus: ModelStatus | null;
  diagnostics: AppDiagnostics | null;
  busyAction: "save" | "model" | "cache" | "reset" | "compute" | null;
  modelDownloadProgress: number | null;
  processing: boolean;
  onClose: () => void;
  onSave: (preferences: AppPreferences) => Promise<void>;
  onReset: () => Promise<AppPreferences>;
  onInstallModel: () => Promise<void>;
  onDeleteModel: () => Promise<void>;
  onClearPreviewCache: () => Promise<void>;
  onChooseDefaultDirectory: () => Promise<string | null>;
  onRefreshDiagnostics: () => Promise<void>;
  onProbeCompute: (preference: AppPreferences["compute"]) => Promise<ComputeProbeResult>;
  onPreviewLanguage: (language: LanguagePreference) => void;
}

const clonePreferences = (preferences: AppPreferences): AppPreferences => ({
  ...preferences,
  defaultSettings: { ...preferences.defaultSettings },
  presets: preferences.presets.map((preset) => ({ ...preset, settings: { ...preset.settings } })),
});

export default function SettingsModal({
  open,
  initialTab,
  preferences,
  currentSettings,
  modelStatus,
  diagnostics,
  busyAction,
  modelDownloadProgress,
  processing,
  onClose,
  onSave,
  onReset,
  onInstallModel,
  onDeleteModel,
  onClearPreviewCache,
  onChooseDefaultDirectory,
  onRefreshDiagnostics,
  onProbeCompute,
  onPreviewLanguage,
}: SettingsModalProps) {
  const { t, formatLocale, systemLocale } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState(() => clonePreferences(preferences));
  const [computeProbe, setComputeProbe] = useState<ComputeProbeResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabLabels = useMemo<Array<{ id: SettingsTab; label: string; description: string }>>(() => [
    { id: "general", label: t("settings.tab.general"), description: t("settings.tab.generalHelp") },
    { id: "model", label: t("settings.tab.model"), description: t("settings.tab.modelHelp") },
    { id: "privacy", label: t("settings.tab.privacy"), description: t("settings.tab.privacyHelp") },
    { id: "diagnostics", label: t("settings.tab.diagnostics"), description: t("settings.tab.diagnosticsHelp") },
  ], [t]);
  const systemLanguageName = useMemo(() => {
    try {
      return new Intl.DisplayNames([formatLocale], { type: "language" }).of(systemLocale) ?? systemLocale;
    } catch {
      return systemLocale;
    }
  }, [formatLocale, systemLocale]);
  const computeKey = (mode: AppPreferences["compute"]["mode"], deviceId: number | null) => `${mode}:${deviceId ?? ""}`;
  const computeDevices = diagnostics?.computeCapabilities.devices ?? [
    { mode: "auto" as const, deviceId: null, label: "Automatic", dedicatedMemoryBytes: null, recommended: true },
    { mode: "cpu" as const, deviceId: null, label: "CPU", dedicatedMemoryBytes: null, recommended: false },
  ];
  const computeLabel = (device: (typeof computeDevices)[number]) => {
    const memory = device.dedicatedMemoryBytes ? ` · ${formatBytes(device.dedicatedMemoryBytes, formatLocale)}` : "";
    if (device.mode === "auto") return t("settings.compute.auto", { backend: diagnostics?.computeCapabilities.platformBackend ?? "GPU" });
    if (device.mode === "cpu") return t("settings.compute.cpu");
    if (device.mode === "directMl") return `${device.label} · DirectML${memory}`;
    if (device.mode === "coreMlCpuAndGpu") return t("settings.compute.coreMlGpu");
    if (device.mode === "coreMlCpuAndNeuralEngine") return t("settings.compute.coreMlNeural");
    return t("settings.compute.coreMlAll");
  };
  const effectiveComputeLabel = diagnostics?.computeRuntime.initialized
    ? computeDevices.find((device) => device.mode === diagnostics.computeRuntime.effectiveMode && device.deviceId === diagnostics.computeRuntime.effectiveDeviceId)
    : null;
  const lastComputeLabel = effectiveComputeLabel ? computeLabel(effectiveComputeLabel) : diagnostics?.computeRuntime.effectiveLabel;

  useEffect(() => {
    if (!open) return;
    setDraft(clonePreferences(preferences));
    setComputeProbe(null);
    setTab(initialTab);
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialTab, open, preferences]);

  if (!open) return null;

  const updateDefaultSettings = (patch: Partial<OutputSettings>) => {
    setDraft((current) => ({ ...current, defaultSettings: { ...current.defaultSettings, ...patch } }));
  };

  const cancelAndClose = () => {
    onPreviewLanguage(preferences.language);
    onClose();
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busyAction) {
      event.preventDefault();
      cancelAndClose();
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
    if (!window.confirm(t("dialog.resetSettings"))) return;
    try {
      const reset = await onReset();
      setDraft(clonePreferences(reset));
      onPreviewLanguage(reset.language);
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

  const selectLanguage = (language: LanguagePreference) => {
    setDraft((current) => ({ ...current, language }));
    onPreviewLanguage(language);
  };

  const probeCompute = async () => {
    try {
      setComputeProbe(await onProbeCompute(draft.compute));
    } catch {
      setComputeProbe({ success: false, durationMs: 0, status: null, error: "probe failed" });
    }
  };

  const renderGeneral = () => (
    <div className="preferences-sections">
      <section className="preferences-card language-card">
        <div className="preferences-card-heading stacked">
          <div><strong>{t("settings.language.title")}</strong><span>{t("settings.language.help")}</span></div>
        </div>
        <label className="preferences-wide-field">
          <select aria-label={t("settings.language.title")} value={draft.language} onChange={(event) => selectLanguage(event.target.value as LanguagePreference)}>
            <option value="system">{t("settings.language.system", { language: systemLanguageName })}</option>
            {LOCALE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.nativeName}</option>)}
          </select>
        </label>
      </section>

      <section className="preferences-card">
        <div className="preferences-card-heading">
          <div><strong>{t("settings.restore.title")}</strong><span>{t("settings.restore.help")}</span></div>
          <label className="switch-control">
            <input type="checkbox" checked={draft.restoreWorkspace} onChange={(event) => setDraft((current) => ({ ...current, restoreWorkspace: event.target.checked }))} />
            <span aria-hidden="true" />
          </label>
        </div>
        {!draft.restoreWorkspace && <p className="preferences-note warning">{t("settings.restore.off")}</p>}
      </section>

      <section className="preferences-card">
        <div className="preferences-card-heading stacked">
          <div><strong>{t("settings.defaults.title")}</strong><span>{t("settings.defaults.help")}</span></div>
          <button className="small-action" type="button" onClick={() => setDraft((current) => ({ ...current, defaultSettings: { ...currentSettings } }))}>{t("settings.defaults.import")}</button>
        </div>
        <div className="preferences-form-grid">
          <label><span>{t("settings.format")}</span><select value={draft.defaultSettings.format} onChange={(event) => updateDefaultSettings({ format: event.target.value as OutputSettings["format"] })}><option value="png">{t("settings.format.png")}</option><option value="webp">{t("settings.format.webp")}</option></select></label>
          <label><span>{t("settings.defaultLocation")}</span><select value={draft.defaultSettings.outputLocation} onChange={(event) => updateDefaultSettings({ outputLocation: event.target.value as OutputSettings["outputLocation"] })}><option value="subfolder">{t("settings.defaultLocation.subfolder")}</option><option value="sameFolder">{t("settings.defaultLocation.sameFolder")}</option><option value="custom">{t("settings.defaultLocation.custom")}</option></select></label>
          <label><span>{t("output.prefix")}</span><input value={draft.defaultSettings.prefix} onChange={(event) => updateDefaultSettings({ prefix: event.target.value })} placeholder="cut_" /></label>
          <label><span>{t("output.suffix")}</span><input value={draft.defaultSettings.suffix} onChange={(event) => updateDefaultSettings({ suffix: event.target.value })} placeholder="_bg" /></label>
        </div>
        {draft.defaultSettings.outputLocation === "custom" && <button className="preferences-path-picker" type="button" onClick={() => void handleChooseDirectory()}><span>{draft.defaultSettings.outputDirectory || t("settings.defaultFolder")}</span><b>{t("common.browse")}</b></button>}
        <label className="preferences-wide-field"><span>{t("settings.nameTemplate")}</span><input value={draft.defaultSettings.nameTemplate} spellCheck={false} onChange={(event) => updateDefaultSettings({ nameTemplate: event.target.value })} /></label>
        <label className="check-row preferences-metadata-check"><input type="checkbox" checked={draft.defaultSettings.preserveMetadata} onChange={(event) => updateDefaultSettings(event.target.checked ? { preserveMetadata: true } : { preserveMetadata: false, preserveGps: false, preservePrompt: false })} /><span aria-hidden="true">✓</span>{t("settings.keepMetadata")}</label>
        <p className="preferences-note preferences-metadata-help">{t("metadata.safeHelp")}</p>
        <div className={`preferences-metadata-options ${draft.defaultSettings.preserveMetadata ? "" : "is-disabled"}`}>
          <label className={`check-row ${draft.defaultSettings.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={draft.defaultSettings.preserveGps} onChange={(event) => updateDefaultSettings({ preserveGps: event.target.checked })} disabled={!draft.defaultSettings.preserveMetadata} /><span aria-hidden="true">✓</span>{t("metadata.keepGps")}</label>
          <p className="preferences-note warning flush">{t("metadata.gpsWarning")}</p>
          <label className={`check-row ${draft.defaultSettings.preserveMetadata ? "" : "disabled"}`}><input type="checkbox" checked={draft.defaultSettings.preservePrompt} onChange={(event) => updateDefaultSettings({ preservePrompt: event.target.checked })} disabled={!draft.defaultSettings.preserveMetadata} /><span aria-hidden="true">✓</span>{t("metadata.keepPrompt")}</label>
        </div>
        <p className="preferences-note">{t("settings.defaults.note")}</p>
      </section>
    </div>
  );

  const renderModel = () => (
    <div className="preferences-sections">
      <section className="preferences-card model-card">
        <div className="model-status-large">
          <span className={`model-orb ${modelStatus?.installed ? "ready" : ""}`} />
          <div><strong>{t(modelStatus?.installed ? "settings.model.ready" : "settings.model.missing")}</strong><span>U2NetP · {formatBytes(modelStatus?.expectedBytes ?? 0, formatLocale)}</span></div>
          <span className={`state-badge ${modelStatus?.installed ? "success" : ""}`}>{t(modelStatus?.installed ? "settings.model.installed" : "settings.model.notInstalled")}</span>
        </div>
        <p className="preferences-note">{t("settings.model.localHelp")}</p>
        <div className="preferences-actions left">
          {!modelStatus?.installed && <button className="button primary compact" type="button" disabled={busyAction !== null || processing} onClick={() => void onInstallModel()}>{busyAction === "model" ? t("common.installing") : t("settings.model.install")}</button>}
          {modelStatus?.installed && modelStatus.canDelete && <button className="button danger compact" type="button" disabled={busyAction !== null || processing} onClick={() => void onDeleteModel()}>{busyAction === "model" ? t("common.processing") : t("settings.model.delete")}</button>}
        </div>
        {!modelStatus?.installed && busyAction === "model" && modelDownloadProgress !== null && <div className="model-download-progress" role="progressbar" aria-label={t("common.installing")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={modelDownloadProgress}>
          <span><i style={{ width: `${modelDownloadProgress}%` }} /></span><output>{modelDownloadProgress}%</output>
        </div>}
        {modelStatus?.path && <code className="path-code" title={modelStatus.path}>{modelStatus.path}</code>}
        <p className="preferences-note">{t("settings.model.samHelp")}</p>
      </section>
      <section className="preferences-card">
        <div className="preferences-card-heading"><div><strong>{t("settings.storage.title")}</strong><span>{t("settings.storage.help")}</span></div></div>
        <dl className="metric-list"><div><dt>{t("settings.storage.database")}</dt><dd>{formatBytes(diagnostics?.databaseBytes ?? 0, formatLocale)}</dd></div><div><dt>{t("settings.storage.previewCache")}</dt><dd>{formatBytes(diagnostics?.previewCacheBytes ?? 0, formatLocale)}</dd></div><div><dt>{t("settings.storage.model")}</dt><dd>{formatBytes(modelStatus?.installedBytes ?? 0, formatLocale)}</dd></div></dl>
        <div className="preferences-actions left"><button className="button secondary compact" type="button" disabled={busyAction !== null || processing || !diagnostics?.previewCacheBytes} onClick={() => void onClearPreviewCache()}>{busyAction === "cache" ? t("common.processing") : t("settings.storage.clearPreviewCache")}</button></div>
      </section>
      <section className="preferences-card compute-card">
        <div className="preferences-card-heading"><div><strong>{t("settings.compute.title")}</strong><span>{t("settings.compute.help")}</span></div></div>
        <label className="preferences-wide-field"><span>{t("settings.compute.selected")}</span><select value={computeKey(draft.compute.mode, draft.compute.deviceId)} disabled={processing || busyAction !== null} onChange={(event) => {
          const selected = computeDevices.find((device) => computeKey(device.mode, device.deviceId) === event.target.value);
          if (selected) setDraft((current) => ({ ...current, compute: { mode: selected.mode, deviceId: selected.deviceId } }));
        }}>{computeDevices.map((device) => <option key={computeKey(device.mode, device.deviceId)} value={computeKey(device.mode, device.deviceId)}>{computeLabel(device)}{device.recommended ? ` · ${t("editor.recommended")}` : ""}</option>)}</select></label>
        <dl className="metric-list"><div><dt>{t("settings.compute.effective")}</dt><dd>{diagnostics?.computeRuntime.initialized ? lastComputeLabel : t("settings.compute.notRun")}</dd></div></dl>
        <div className="preferences-actions left"><button className="button secondary compact" type="button" disabled={processing || busyAction !== null || !modelStatus?.installed} onClick={() => void probeCompute()}>{busyAction === "compute" ? t("settings.compute.testing") : t("settings.compute.test")}</button></div>
        {computeProbe && <p className={`preferences-note ${computeProbe.success && !computeProbe.status?.fallbackReason ? "success" : "warning"}`}>{computeProbe.success ? t(computeProbe.status?.fallbackReason ? "settings.compute.testFallback" : "settings.compute.testSuccess", { device: computeProbe.status?.effectiveLabel ?? t("settings.compute.cpu"), duration: computeProbe.durationMs }) : t("settings.compute.testFailed")}</p>}
        {diagnostics?.computeRuntime.fallbackReason && <p className="preferences-note warning">{t("settings.compute.fallback")}</p>}
        <p className="preferences-note">{t(processing ? "settings.storage.locked" : "settings.compute.applyHelp")}</p>
        <p className="preferences-note">{t("settings.compute.samCpu")}</p>
      </section>
    </div>
  );

  const renderPrivacy = () => (
    <div className="preferences-sections">
      <section className="preferences-card policy-card"><span className="policy-icon" aria-hidden="true">✓</span><div><strong>{t("settings.privacy.localTitle")}</strong><p>{t("settings.privacy.localHelp")}</p></div></section>
      <section className="preferences-card">
        <div className="preferences-card-heading"><div><strong>{t("settings.privacy.policy")}</strong><span>{t("settings.privacy.policyHelp")}</span></div></div>
        <ul className="policy-list">
          {["summary", "gpsOptional", "promptOptional", "originalSafe"].map((item) => <li key={item}><span className="policy-check">✓</span><div><strong>{t(`settings.privacy.${item}`)}</strong><small>{t(`settings.privacy.${item}Help`)}</small></div></li>)}
        </ul>
      </section>
    </div>
  );

  const renderDiagnostics = () => (
    <div className="preferences-sections">
      <section className="preferences-card">
        <div className="preferences-card-heading stacked"><div><strong>{t("settings.diagnostics.app")}</strong><span>{t("settings.diagnostics.appHelp")}</span></div><button className="small-action" type="button" onClick={() => void onRefreshDiagnostics()}>{t("common.refresh")}</button></div>
        <dl className="metric-list diagnostics-list"><div><dt>CrystalCut</dt><dd>v{diagnostics?.appVersion ?? "-"}</dd></div><div><dt>{t("settings.diagnostics.engine")}</dt><dd>v{diagnostics?.workerProtocolVersion ?? "-"}</dd></div><div><dt>{t("settings.diagnostics.os")}</dt><dd>{diagnostics ? `${diagnostics.operatingSystem} · ${diagnostics.architecture}` : "-"}</dd></div><div><dt>{t("settings.diagnostics.model")}</dt><dd>{modelStatus ? `${modelStatus.id} · ${t(modelStatus.installed ? "settings.model.installed" : "settings.model.notInstalled")}` : "-"}</dd></div><div><dt>{t("settings.diagnostics.compute")}</dt><dd>{diagnostics?.computeRuntime.initialized ? lastComputeLabel : t("settings.compute.notRun")}</dd></div><div><dt>{t("settings.diagnostics.previewCacheActivity")}</dt><dd>{diagnostics ? `${diagnostics.previewCacheHits.toLocaleString(formatLocale)} / ${diagnostics.previewCacheMisses.toLocaleString(formatLocale)}` : "-"}</dd></div><div><dt>{t("settings.diagnostics.previewInference")}</dt><dd>{diagnostics ? `${diagnostics.previewInferenceRuns.toLocaleString(formatLocale)} · ${diagnostics.previewInferenceMs.toLocaleString(formatLocale)} ms` : "-"}</dd></div></dl>
      </section>
      <section className="preferences-card"><div className="preferences-card-heading"><div><strong>{t("settings.diagnostics.dataFolder")}</strong><span>{t("settings.diagnostics.dataFolderHelp")}</span></div></div><code className="path-code">{diagnostics?.appDataDirectory ?? t("common.checking")}</code></section>
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyAction) cancelAndClose(); }}>
      <div id="preferences-dialog" ref={dialogRef} className="preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="preferences-title" onKeyDown={handleDialogKeyDown}>
        <header className="preferences-header"><div><h2 id="preferences-title" ref={headingRef} tabIndex={-1}>{t("settings.title")}</h2><p>{t("settings.subtitle")}</p></div><button className="modal-close" type="button" aria-label={t("settings.close")} onClick={cancelAndClose} disabled={busyAction !== null}>×</button></header>
        <div className="preferences-layout">
          <nav className="preferences-nav" aria-label={t("settings.navigation")}>{tabLabels.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><strong>{item.label}</strong><span>{item.description}</span></button>)}</nav>
          <main className="preferences-content">{tab === "general" && renderGeneral()}{tab === "model" && renderModel()}{tab === "privacy" && renderPrivacy()}{tab === "diagnostics" && renderDiagnostics()}</main>
        </div>
        <footer className="preferences-footer"><button className="reset-preferences" type="button" disabled={busyAction !== null} onClick={() => void handleReset()}>{busyAction === "reset" ? t("settings.resetting") : t("settings.resetAll")}</button><div className="preferences-actions"><button className="button ghost compact" type="button" onClick={cancelAndClose} disabled={busyAction !== null}>{t("common.cancel")}</button><button className="button primary compact" type="button" disabled={busyAction !== null} onClick={() => void handleSave()}>{busyAction === "save" ? t("settings.saving") : t("settings.save")}</button></div></footer>
      </div>
    </div>
  );
}
