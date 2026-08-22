use serde::{Deserialize, Serialize};

pub const WORKER_PROTOCOL_VERSION: u16 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessItem {
    pub id: String,
    pub path: String,
    pub rotation: u16,
    #[serde(default)]
    pub sequence: Option<usize>,
    #[serde(default)]
    pub exif: Option<crate::metadata::ExifSummary>,
    #[serde(default)]
    pub mask_recipe: ManualMaskRecipe,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ManualMaskRecipe {
    pub mode: MaskMode,
    pub strokes: Vec<BrushStroke>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    #[default]
    Automatic,
    Refine,
    Manual,
    Sam,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushStroke {
    pub mode: BrushMode,
    pub radius: f32,
    pub points: Vec<MaskPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrushMode {
    Keep,
    Remove,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct MaskPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OutputSettings {
    pub processing_mode: ProcessingMode,
    pub format: OutputFormat,
    pub webp_quality: u8,
    pub webp_lossless: bool,
    pub png_effort: u8,
    pub resize_mode: ResizeMode,
    pub resize_value: u32,
    pub prevent_upscale: bool,
    pub output_location: OutputLocation,
    pub output_directory: String,
    pub prefix: String,
    pub suffix: String,
    #[serde(default = "crate::naming::default_name_template")]
    pub name_template: String,
    pub edge_smoothing: u8,
    pub edge_feather: u8,
    pub edge_shift: i8,
    pub alpha_threshold: u8,
    pub mask_contrast: i8,
    pub preserve_original_alpha: bool,
}

impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            processing_mode: ProcessingMode::RemoveBackground,
            format: OutputFormat::Png,
            webp_quality: 82,
            webp_lossless: false,
            png_effort: 6,
            resize_mode: ResizeMode::Original,
            resize_value: 2048,
            prevent_upscale: true,
            output_location: OutputLocation::Subfolder,
            output_directory: String::new(),
            prefix: String::new(),
            suffix: "_bg".to_owned(),
            name_template: crate::naming::default_name_template(),
            edge_smoothing: 2,
            edge_feather: 1,
            edge_shift: 0,
            alpha_threshold: 2,
            mask_contrast: 0,
            preserve_original_alpha: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessingMode {
    #[default]
    RemoveBackground,
    Convert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Png,
    Webp,
}

impl OutputFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Webp => "webp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResizeMode {
    Original,
    Percent,
    LongEdge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputLocation {
    Subfolder,
    SameFolder,
    Custom,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
    pub protocol_version: u16,
    pub job_id: String,
    pub input_path: String,
    pub output_path: String,
    pub model_path: Option<String>,
    pub sam_encoder_path: Option<String>,
    pub sam_decoder_path: Option<String>,
    pub rotation: u16,
    pub settings: OutputSettings,
    pub mask_recipe: ManualMaskRecipe,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResponse {
    pub protocol_version: u16,
    pub job_id: String,
    pub success: bool,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub duration_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub asset_id: String,
    pub completed: usize,
    pub total: usize,
    pub status: BatchItemStatus,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchItemStatus {
    ModelDownloading,
    Queued,
    Processing,
    RetryingWorker,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedItemResult {
    pub asset_id: String,
    pub success: bool,
    pub cancelled: bool,
    pub attempts: u8,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub duration_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub completed: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub worker_restarts: usize,
    pub output_bytes: u64,
    pub items: Vec<ProcessedItemResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub item_count: usize,
    pub planned_outputs: Vec<PlannedOutput>,
    pub estimated_output_bytes: Option<u64>,
    pub estimated_savings_percent: Option<f64>,
    pub estimate_sample_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOutput {
    pub asset_id: String,
    pub path: String,
}
