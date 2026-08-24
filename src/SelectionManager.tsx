import type { ImageAsset } from "./types";
import { formatBytes, formatDimensions } from "./lib/format";
import { useI18n } from "./i18n/I18nProvider";
import Tooltip from "./Tooltip";
import { ariaShortcut, formatShortcut } from "./lib/shortcuts";

interface SelectionManagerProps {
  assets: ImageAsset[];
  onOpenSingle: (assetId: string) => void;
  onClearSelection: () => void;
  onRemoveSelected: () => void;
  onExportOriginals: () => void;
  onExportResults: () => void;
  disabled?: boolean;
  exportingOriginals?: boolean;
}

export default function SelectionManager({
  assets,
  onOpenSingle,
  onClearSelection,
  onRemoveSelected,
  onExportOriginals,
  onExportResults,
  disabled = false,
  exportingOriginals = false,
}: SelectionManagerProps) {
  const { t, formatLocale } = useI18n();
  const totalBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  const resultBytes = assets.reduce((sum, asset) => sum + (asset.outputBytes ?? 0), 0);
  const completed = assets.filter((asset) => asset.status === "done" && asset.outputPath).length;
  const failed = assets.filter((asset) => asset.status === "failed").length;
  const pending = assets.length - completed - failed;

  return (
    <section className="selection-manager" aria-labelledby="selection-manager-title">
      <header className="selection-manager-header">
        <div>
          <span className="eyebrow">{t("management.eyebrow")}</span>
          <h1 id="selection-manager-title">{t("management.selected", { count: assets.length })}</h1>
          <p>{t("management.help")}</p>
        </div>
        <button className="button secondary compact" type="button" onClick={onClearSelection}>{t("management.clear")}</button>
      </header>

      <div className="selection-manager-stats">
        <div><span>{t("management.files")}</span><strong>{assets.length}</strong></div>
        <div><span>{t("common.original")}</span><strong>{formatBytes(totalBytes, formatLocale)}</strong></div>
        <div><span>{t("common.result")}</span><strong>{resultBytes ? formatBytes(resultBytes, formatLocale) : "—"}</strong></div>
        <div><span>{t("status.done")}</span><strong>{completed}</strong></div>
        <div><span>{t("management.pending")}</span><strong>{pending}</strong></div>
        <div><span>{t("status.failed")}</span><strong>{failed}</strong></div>
      </div>

      <div className="selection-manager-actions">
        <button className="button secondary compact" type="button" onClick={onExportOriginals} disabled={disabled || exportingOriginals}>{t(exportingOriginals ? "management.exportingOriginals" : "management.exportOriginals")}</button>
        <button className="button primary compact" type="button" onClick={onExportResults} disabled={disabled}>{t("management.exportResults")}</button>
        <button className="button danger-outline compact tooltip-host" type="button" onClick={onRemoveSelected} disabled={disabled} aria-keyshortcuts={ariaShortcut("remove")}>{t("management.remove")}<Tooltip shortcut={formatShortcut("remove")}>{t("preview.removeFromList")}</Tooltip></button>
      </div>

      <div className="selection-manager-list" role="list">
        {assets.map((asset) => (
          <article className="selection-manager-row" key={asset.id} role="listitem">
            <span className="selection-manager-thumb">
              {asset.thumbnailUrl || asset.previewUrl
                ? <img src={asset.thumbnailUrl ?? asset.previewUrl} alt="" style={{ transform: `rotate(${asset.rotation}deg)` }} />
                : <span aria-hidden="true">◇</span>}
            </span>
            <span className="selection-manager-copy">
              <strong title={asset.name}>{asset.name}</strong>
              <small>{formatDimensions(asset.width, asset.height, formatLocale, t("format.unknownDimensions"))} · {formatBytes(asset.sizeBytes, formatLocale)}</small>
            </span>
            <span className={`asset-status-badge ${asset.status}`}>{t(`status.short.${asset.status}`)}</span>
            <span className="selection-manager-result">{asset.outputPath ? t("management.resultReady") : t("management.resultNeeded")}</span>
            <button type="button" onClick={() => onOpenSingle(asset.id)}>{t("management.open")}</button>
          </article>
        ))}
      </div>
    </section>
  );
}
