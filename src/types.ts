export type AssetStatus = "ready" | "queued" | "processing" | "retrying" | "done" | "failed" | "cancelled";

export interface ImageAsset {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  extension: string;
  width: number | null;
  height: number | null;
  exif: ExifSummary;
  status: AssetStatus;
  previewUrl?: string;
  resultPreviewUrl?: string;
  outputPath?: string;
  outputBytes?: number;
  error?: string;
  rotation: 0 | 90 | 180 | 270;
}

export interface ExifSummary {
  takenAt: string | null;
  camera: string | null;
  lens: string | null;
  orientation: number;
}

export type OutputFormat = "png" | "webp";
export type ResizeMode = "original" | "percent" | "longEdge";
export type OutputLocation = "subfolder" | "sameFolder" | "custom";

export interface OutputSettings {
  format: OutputFormat;
  webpQuality: number;
  webpLossless: boolean;
  pngEffort: number;
  resizeMode: ResizeMode;
  resizeValue: number;
  preventUpscale: boolean;
  outputLocation: OutputLocation;
  outputDirectory: string;
  prefix: string;
  suffix: string;
  nameTemplate: string;
}

export interface ExportPlan {
  itemCount: number;
  plannedOutputs: PlannedOutput[];
  estimatedOutputBytes: number | null;
  estimatedSavingsPercent: number | null;
  estimateSampleCount: number;
  warnings: string[];
}

export interface PlannedOutput {
  assetId: string;
  path: string;
}

export interface ProcessItem {
  id: string;
  path: string;
  rotation: number;
  sequence?: number;
  exif?: ExifSummary;
}

export type BatchProgressStatus = "modelDownloading" | "queued" | "processing" | "retryingWorker" | "completed" | "failed" | "cancelled";

export interface BatchProgress {
  assetId: string;
  completed: number;
  total: number;
  status: BatchProgressStatus;
  outputPath: string | null;
  error: string | null;
}

export interface ProcessedItemResult {
  assetId: string;
  success: boolean;
  cancelled: boolean;
  attempts: number;
  outputPath: string | null;
  outputBytes: number | null;
  durationMs: number;
  error: string | null;
}

export interface BatchResult {
  completed: number;
  failed: number;
  cancelled: number;
  workerRestarts: number;
  outputBytes: number;
  items: ProcessedItemResult[];
}

export interface ModelStatus {
  id: string;
  installed: boolean;
  expectedBytes: number;
  path: string | null;
  purpose: string;
}
