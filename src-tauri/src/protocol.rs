use serde::{Deserialize, Serialize};

pub const WORKER_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessItem {
    pub id: String,
    pub path: String,
    pub rotation: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResizeMode {
    Original,
    Percent,
    LongEdge,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
    pub model_path: String,
    pub rotation: u16,
    pub settings: OutputSettings,
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
    Completed,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedItemResult {
    pub asset_id: String,
    pub success: bool,
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
    pub output_bytes: u64,
    pub items: Vec<ProcessedItemResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub item_count: usize,
    pub sample_outputs: Vec<String>,
}
