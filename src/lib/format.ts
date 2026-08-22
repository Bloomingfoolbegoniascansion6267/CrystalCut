export function formatBytes(bytes: number, locale?: string): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toLocaleString(locale, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  })} ${units[unitIndex]}`;
}

export function formatDimensions(width: number | null, height: number | null, locale?: string, fallback = "Checking size"): string {
  return width && height ? `${width.toLocaleString(locale)} × ${height.toLocaleString(locale)}` : fallback;
}
