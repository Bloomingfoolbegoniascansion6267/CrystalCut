export type AssetStatus = "ready" | "queued" | "processing" | "retrying" | "done" | "failed" | "cancelled" | "interrupted";

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
  thumbnailUrl?: string;
  previewUrl?: string;
  resultPreviewUrl?: string;
  editBasePreviewUrl?: string;
  maskPreviewUrl?: string;
  editPreviewKey?: string;
  previewCacheKey?: string;
  outputPath?: string;
  outputBytes?: number;
  outputPreviewKey?: string;
  error?: string;
  rotation: 0 | 90 | 180 | 270;
  maskRecipe: ManualMaskRecipe;
  edgeSettings: EdgeSettings;
  metadataPolicy: MetadataOutputPolicy | null;
  resizeOverride: ResizeOverride | null;
}

export type MaskMode = "automatic" | "refine" | "manual" | "sam";
export type BrushMode = "keep" | "remove";

export interface MaskPoint {
  x: number;
  y: number;
}

export interface BrushStroke {
  mode: BrushMode;
  radius: number;
  points: MaskPoint[];
}

export interface ManualMaskRecipe {
  mode: MaskMode;
  strokes: BrushStroke[];
}

export interface EdgeSettings {
  edgeSmoothing: number;
  edgeFeather: number;
  edgeShift: number;
  alphaThreshold: number;
  maskContrast: number;
  preserveOriginalAlpha: boolean;
}

export interface ExifSummary {
  takenAt: string | null;
  camera: string | null;
  lens: string | null;
  description: string | null;
  prompt: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  orientation: number;
}

export type OutputFormat = "png" | "webp";
export type ResizeMode = "original" | "percent" | "longEdge";
export type ResizeAxis = "width" | "height";
export type OutputLocation = "subfolder" | "sameFolder" | "custom";
export type ProcessingMode = "removeBackground" | "convert";

export interface OutputSettings {
  processingMode: ProcessingMode;
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
  preserveMetadata: boolean;
  preserveGps: boolean;
  preservePrompt: boolean;
}

export interface MetadataOutputPolicy {
  preserveMetadata: boolean;
  preserveGps: boolean;
  preservePrompt: boolean;
}

export interface ResizeOverride {
  axis: ResizeAxis;
  value: number;
  preventUpscale: boolean;
}

export type PersistedAsset = Omit<ImageAsset, "thumbnailUrl" | "previewUrl" | "resultPreviewUrl" | "editBasePreviewUrl" | "maskPreviewUrl">;

export interface WorkspaceSnapshot {
  items: PersistedAsset[];
  settings: OutputSettings;
}

export interface RestoredWorkspace extends WorkspaceSnapshot {
  interrupted: number;
  missingFiles: number;
  savedAtMs: number;
}

export interface ExportPlan {
  itemCount: number;
  plannedOutputs: PlannedOutput[];
  estimatedOutputBytes: number | null;
  estimatedSavingsPercent: number | null;
  estimateSampleCount: number;
  warnings: ExportWarning[];
}

export interface ExportWarning {
  code: "missingTakenAt" | "missingCamera" | "missingLens";
  count: number;
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
  maskRecipe: ManualMaskRecipe;
  edgeSettings: EdgeSettings;
  metadataPolicy?: MetadataOutputPolicy | null;
  resizeOverride?: ResizeOverride | null;
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
  outputDirectories: string[];
  items: ProcessedItemResult[];
}

export interface OriginalExportItemResult {
  assetId: string;
  success: boolean;
  outputPath: string | null;
  bytes: number | null;
  error: string | null;
}

export interface OriginalExportResult {
  exported: number;
  failed: number;
  bytes: number;
  items: OriginalExportItemResult[];
}

export interface ModelStatus {
  id: string;
  installed: boolean;
  expectedBytes: number;
  path: string | null;
  installedBytes: number | null;
  canDelete: boolean;
  purpose: string;
}

export interface AppPreferences {
  defaultSettings: OutputSettings;
  restoreWorkspace: boolean;
  presets: OutputPreset[];
  language: LanguagePreference;
  compute: ComputePreference;
}

export type ComputeMode = "auto" | "cpu" | "directMl" | "coreMlAll" | "coreMlCpuAndGpu" | "coreMlCpuAndNeuralEngine";

export interface ComputePreference {
  mode: ComputeMode;
  deviceId: number | null;
}

export interface ComputeDevice {
  mode: ComputeMode;
  deviceId: number | null;
  label: string;
  dedicatedMemoryBytes: number | null;
  recommended: boolean;
}

export interface ComputeRuntimeStatus {
  requested: ComputePreference;
  effectiveMode: ComputeMode;
  effectiveDeviceId: number | null;
  effectiveLabel: string;
  fallbackReason: string | null;
}

export interface OutputPreset {
  id: string;
  name: string;
  settings: OutputSettings;
}

export interface AppDiagnostics {
  appVersion: string;
  workerProtocolVersion: number;
  operatingSystem: string;
  architecture: string;
  appDataDirectory: string;
  databaseBytes: number;
  previewCacheBytes: number;
  previewCacheHits: number;
  previewCacheMisses: number;
  previewInferenceRuns: number;
  previewInferenceMs: number;
  computeCapabilities: {
    platformBackend: string;
    devices: ComputeDevice[];
  };
  computeRuntime: ComputeRuntimeStatus;
}
import type { LanguagePreference } from "./i18n/locale";
