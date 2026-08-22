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
