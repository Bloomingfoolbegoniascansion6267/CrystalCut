export type AssetStatus = "ready" | "queued" | "processing" | "done" | "failed";

export interface ImageAsset {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  extension: string;
  width: number | null;
  height: number | null;
  status: AssetStatus;
  previewUrl?: string;
  resultPreviewUrl?: string;
  outputPath?: string;
  error?: string;
  rotation: 0 | 90 | 180 | 270;
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
}

export interface ExportPlan {
  itemCount: number;
  sampleOutputs: string[];
}

export interface ProcessItem {
  id: string;
  path: string;
  rotation: number;
}

export type BatchProgressStatus = "modelDownloading" | "queued" | "processing" | "completed" | "failed";

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
  outputPath: string | null;
  outputBytes: number | null;
  durationMs: number;
  error: string | null;
}

export interface BatchResult {
  completed: number;
  failed: number;
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
