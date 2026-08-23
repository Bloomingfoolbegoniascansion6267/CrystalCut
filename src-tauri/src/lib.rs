mod engine;
mod metadata;
mod model;
mod naming;
mod protocol;
mod sam;
pub mod worker;
mod workspace;

use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Cursor, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{GenericImageView, ImageFormat, ImageReader};
use protocol::{
    BatchItemStatus, BatchProgress, BatchResult, EdgeSettings, ExportPlan, ExportWarning, MaskMode,
    OutputLocation, OutputSettings, PlannedOutput, ProcessItem, ProcessedItemResult,
    ProcessingMode, ResizeMode, WorkerRequest, WorkerResponse, WORKER_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];
const MAX_PREVIEW_EDGE: u32 = 1600;
const MAX_THUMBNAIL_EDGE: u32 = 160;

#[derive(Clone, Default)]
struct BatchController {
    running: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
struct SamPreviewController {
    engine: Arc<Mutex<Option<sam::SamEngine>>>,
}

#[derive(Clone, Default)]
struct MaskPreviewController {
    engine: Arc<Mutex<Option<engine::InferenceEngine>>>,
}

impl BatchController {
    fn begin(&self) -> Result<(), String> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "이미 다른 batch 작업이 실행 중입니다.".to_owned())?;
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn finish(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
    }

    fn request_cancel(&self) -> bool {
        if !self.running.load(Ordering::SeqCst) {
            return false;
        }
        self.cancelled.store(true, Ordering::SeqCst);
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct WorkerClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl WorkerClient {
    fn spawn(executable: &Path) -> Result<Self, String> {
        let mut child = Command::new(executable)
            .arg("--worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("AI worker를 시작하지 못했습니다: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "AI worker 입력 채널을 열지 못했습니다.".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "AI worker 출력 채널을 열지 못했습니다.".to_owned())?;
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
        })
    }

    fn request(&mut self, request: &WorkerRequest) -> Result<WorkerResponse, String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "AI worker 입력 채널이 닫혀 있습니다.".to_owned())?;
        serde_json::to_writer(&mut *stdin, request)
            .map_err(|error| format!("AI worker 요청을 만들지 못했습니다: {error}"))?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("AI worker 요청을 보내지 못했습니다: {error}"))?;

        let mut line = String::new();
        if self
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("AI worker 응답을 읽지 못했습니다: {error}"))?
            == 0
        {
            return Err("AI worker가 응답 없이 종료되었습니다.".to_owned());
        }
        let response: WorkerResponse = serde_json::from_str(&line)
            .map_err(|error| format!("AI worker 응답이 올바르지 않습니다: {error}"))?;
        if response.protocol_version != WORKER_PROTOCOL_VERSION {
            return Err("AI worker protocol 버전이 앱과 다릅니다.".to_owned());
        }
        if response.job_id != request.job_id {
            return Err("AI worker가 다른 작업의 응답을 반환했습니다.".to_owned());
        }
        Ok(response)
    }

    fn shutdown(mut self) {
        self.stdin.take();
        let _ = self.child.wait();
    }

    fn terminate(mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for WorkerClient {
    fn drop(&mut self) {
        self.stdin.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageAsset {
    id: String,
    name: String,
    path: String,
    size_bytes: u64,
    extension: String,
    width: Option<u32>,
    height: Option<u32>,
    exif: metadata::ExifSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginalExportItem {
    id: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginalExportItemResult {
    asset_id: String,
    success: bool,
    output_path: Option<String>,
    bytes: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginalExportResult {
    exported: usize,
    failed: usize,
    bytes: u64,
    items: Vec<OriginalExportItemResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: &'static str,
    detail: String,
}

impl CommandError {
    fn new(code: &'static str, detail: impl ToString) -> Self {
        Self {
            code,
            detail: detail.to_string(),
        }
    }
}

type CommandResult<T> = Result<T, CommandError>;

#[tauri::command]
async fn inspect_paths(paths: Vec<String>) -> CommandResult<Vec<ImageAsset>> {
    let outcome = tauri::async_runtime::spawn_blocking(move || inspect_paths_blocking(paths))
        .await
        .map_err(|error| CommandError::new("files.inspect", error))?;
    outcome.map_err(|error| CommandError::new("files.inspect", error))
}

fn inspect_paths_blocking(paths: Vec<String>) -> Result<Vec<ImageAsset>, String> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();

    for raw_path in paths {
        let root = PathBuf::from(raw_path);
        if root.is_dir() {
            for entry in WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if entry.file_type().is_file() {
                    push_supported_file(entry.into_path(), &mut files, &mut seen);
                }
            }
        } else if root.is_file() {
            push_supported_file(root, &mut files, &mut seen);
        }
    }

    files.sort_by_key(|asset| asset.path.to_lowercase());
    Ok(files)
}

fn push_supported_file(path: PathBuf, files: &mut Vec<ImageAsset>, seen: &mut HashSet<String>) {
    let Some(extension) = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
    else {
        return;
    };
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return;
    }

    let canonical = path.canonicalize().unwrap_or(path);
    let path_string = canonical.to_string_lossy().into_owned();
    let dedupe_key = path_string.to_lowercase();
    if !seen.insert(dedupe_key) {
        return;
    }

    let metadata = canonical.metadata().ok();
    let dimensions = ImageReader::open(&canonical)
        .ok()
        .and_then(|reader| reader.into_dimensions().ok());
    let mut hasher = DefaultHasher::new();
    path_string.hash(&mut hasher);

    let exif = metadata::read_exif_summary(&canonical);
    let dimensions = dimensions.map(|(width, height)| {
        if matches!(exif.orientation, 5..=8) {
            (height, width)
        } else {
            (width, height)
        }
    });
    files.push(ImageAsset {
        id: format!("asset-{:016x}", hasher.finish()),
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("image")
            .to_owned(),
        path: path_string,
        size_bytes: metadata.map_or(0, |value| value.len()),
        extension,
        width: dimensions.map(|value| value.0),
        height: dimensions.map(|value| value.1),
        exif,
    });
}

#[tauri::command]
async fn load_preview(path: String) -> CommandResult<String> {
    let outcome =
        tauri::async_runtime::spawn_blocking(move || load_preview_blocking(Path::new(&path)))
            .await
            .map_err(|error| CommandError::new("preview.load", error))?;
    outcome.map_err(|error| CommandError::new("preview.load", error))
}

fn load_preview_blocking(path: &Path) -> Result<String, String> {
    load_image_data_url_blocking(path, MAX_PREVIEW_EDGE)
}

#[tauri::command]
async fn load_thumbnail(path: String) -> CommandResult<String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        load_image_data_url_blocking(Path::new(&path), MAX_THUMBNAIL_EDGE)
    })
    .await
    .map_err(|error| CommandError::new("preview.thumbnail", error))?;
    outcome.map_err(|error| CommandError::new("preview.thumbnail", error))
}

fn load_image_data_url_blocking(path: &Path, max_edge: u32) -> Result<String, String> {
    if !path.is_file() {
        return Err("파일을 찾을 수 없습니다.".to_owned());
    }

    let mut source = ImageReader::open(path)
        .map_err(|error| format!("이미지를 열 수 없습니다: {error}"))?
        .decode()
        .map_err(|error| format!("이미지를 해석할 수 없습니다: {error}"))?;
    let exif = metadata::read_exif_summary(path);
    metadata::apply_orientation(&mut source, exif.orientation);
    let (width, height) = source.dimensions();
    let preview = if width > max_edge || height > max_edge {
        source.thumbnail(max_edge, max_edge)
    } else {
        source
    };

    let mut encoded = Cursor::new(Vec::new());
    preview
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|error| format!("미리보기를 인코딩할 수 없습니다: {error}"))?;

    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}

fn encode_preview_data_url(image: image::DynamicImage) -> Result<String, String> {
    let (width, height) = image.dimensions();
    let preview = if width > MAX_PREVIEW_EDGE || height > MAX_PREVIEW_EDGE {
        image.thumbnail(MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE)
    } else {
        image
    };
    let mut encoded = Cursor::new(Vec::new());
    preview
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|error| format!("결과 미리보기를 인코딩할 수 없습니다: {error}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaskPreviewBundle {
    result_preview_url: String,
    mask_preview_url: String,
}

fn encode_mask_preview_bundle(
    result: image::DynamicImage,
    mask: image::DynamicImage,
) -> Result<MaskPreviewBundle, String> {
    Ok(MaskPreviewBundle {
        result_preview_url: encode_preview_data_url(result)?,
        mask_preview_url: encode_preview_data_url(mask)?,
    })
}

#[tauri::command]
async fn generate_mask_preview(
    app: AppHandle,
    controller: State<'_, MaskPreviewController>,
    path: String,
    rotation: u16,
    mask_recipe: protocol::ManualMaskRecipe,
    edge_settings: EdgeSettings,
    settings: OutputSettings,
) -> CommandResult<MaskPreviewBundle> {
    validate_mask_recipe(&mask_recipe)
        .map_err(|error| CommandError::new("preview.invalidMask", error))?;
    validate_edge_settings(&edge_settings)
        .map_err(|error| CommandError::new("preview.invalidEdge", error))?;
    let controller = controller.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let model_path = model::ensure_default_model(&app)?;
        let mut slot = controller
            .engine
            .lock()
            .map_err(|_| "자동 미리보기 상태 잠금이 손상되었습니다.".to_owned())?;
        if slot
            .as_ref()
            .is_none_or(|engine| !engine.uses_model(&model_path))
        {
            *slot = Some(engine::InferenceEngine::new(&model_path)?);
        }
        let (result, mask) = slot
            .as_mut()
            .ok_or_else(|| "자동 미리보기 엔진을 준비하지 못했습니다.".to_owned())?
            .render_preview_bundle(
                Path::new(&path),
                rotation,
                &mask_recipe,
                &settings,
                &edge_settings,
            )?;
        encode_mask_preview_bundle(result, mask)
    })
    .await
    .map_err(|error| CommandError::new("preview.generateMask", error))?;
    outcome.map_err(|error| CommandError::new("preview.generateMask", error))
}

#[tauri::command]
async fn generate_sam_preview(
    app: AppHandle,
    controller: State<'_, SamPreviewController>,
    path: String,
    rotation: u16,
    mask_recipe: protocol::ManualMaskRecipe,
    edge_settings: EdgeSettings,
    settings: OutputSettings,
) -> CommandResult<MaskPreviewBundle> {
    validate_mask_recipe(&mask_recipe)
        .map_err(|error| CommandError::new("preview.invalidMask", error))?;
    validate_edge_settings(&edge_settings)
        .map_err(|error| CommandError::new("preview.invalidEdge", error))?;
    let controller = controller.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let paths = sam::ensure_models(&app)?;
        let mut slot = controller
            .engine
            .lock()
            .map_err(|_| "SAM 미리보기 상태 잠금이 손상되었습니다.".to_owned())?;
        if slot
            .as_ref()
            .is_none_or(|engine| !engine.uses_models(&paths.encoder, &paths.decoder))
        {
            *slot = Some(sam::SamEngine::new(&paths)?);
        }
        let (result, mask) = slot
            .as_mut()
            .ok_or_else(|| "SAM 미리보기 엔진을 준비하지 못했습니다.".to_owned())?
            .render_preview_bundle(
                Path::new(&path),
                rotation,
                &mask_recipe,
                &settings,
                &edge_settings,
            )?;
        encode_mask_preview_bundle(result, mask)
    })
    .await
    .map_err(|error| CommandError::new("preview.generateSam", error))?;
    outcome.map_err(|error| CommandError::new("preview.generateSam", error))
}

#[tauri::command]
fn get_model_status(app: AppHandle) -> CommandResult<model::ModelStatus> {
    model::status(&app).map_err(|error| CommandError::new("model.status", error))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppDiagnostics {
    app_version: String,
    worker_protocol_version: u16,
    operating_system: &'static str,
    architecture: &'static str,
    app_data_directory: String,
    database_bytes: u64,
}

#[tauri::command]
fn get_app_diagnostics(app: AppHandle) -> CommandResult<AppDiagnostics> {
    let app_data_directory = workspace::app_data_directory(&app)
        .map_err(|error| CommandError::new("diagnostics.load", error))?;
    let database_bytes = workspace::database_size(&app)
        .map_err(|error| CommandError::new("diagnostics.load", error))?;
    Ok(AppDiagnostics {
        app_version: app.package_info().version.to_string(),
        worker_protocol_version: WORKER_PROTOCOL_VERSION,
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        app_data_directory,
        database_bytes,
    })
}

#[tauri::command]
async fn install_model(
    app: AppHandle,
    controller: State<'_, BatchController>,
) -> CommandResult<model::ModelStatus> {
    let controller = controller.inner().clone();
    controller
        .begin()
        .map_err(|error| CommandError::new("model.install", error))?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        model::ensure_default_model(&app)?;
        model::status(&app)
    })
    .await;
    controller.finish();
    let outcome = outcome.map_err(|error| CommandError::new("model.install", error))?;
    outcome.map_err(|error| CommandError::new("model.install", error))
}

#[tauri::command]
fn delete_model(
    app: AppHandle,
    controller: State<'_, BatchController>,
) -> CommandResult<model::ModelStatus> {
    let controller = controller.inner().clone();
    controller
        .begin()
        .map_err(|error| CommandError::new("model.delete", error))?;
    let outcome = model::remove_default_model(&app);
    controller.finish();
    outcome.map_err(|error| CommandError::new("model.delete", error))
}

#[tauri::command]
async fn prepare_export_plan(
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> CommandResult<ExportPlan> {
    let outcome =
        tauri::async_runtime::spawn_blocking(move || prepare_export_plan_blocking(items, settings))
            .await
            .map_err(|error| CommandError::new("output.plan", error))?;
    outcome.map_err(|error| CommandError::new("output.plan", error))
}

fn prepare_export_plan_blocking(
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> Result<ExportPlan, String> {
    validate_settings(&settings)?;
    for item in &items {
        validate_settings(&output_settings_for_item(&settings, item))?;
    }
    let mut reserved = HashSet::new();
    let planned_outputs = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            plan_output_path(
                Path::new(&item.path),
                &settings,
                &mut reserved,
                item.sequence.unwrap_or(index + 1),
                item.exif.as_ref(),
            )
            .map(|path| PlannedOutput {
                asset_id: item.id.clone(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let total_input_bytes = items
        .iter()
        .filter_map(|item| Path::new(&item.path).metadata().ok())
        .map(|metadata| metadata.len())
        .sum::<u64>();
    let mut sampled_input_bytes = 0_u64;
    let mut sampled_output_bytes = 0_u64;
    let mut estimate_sample_count = 0_usize;
    for item in items.iter().take(3) {
        let path = Path::new(&item.path);
        let Ok(input_bytes) = path.metadata().map(|metadata| metadata.len()) else {
            continue;
        };
        let item_settings = output_settings_for_item(&settings, item);
        let Ok(output_bytes) = engine::estimate_output_size(path, item.rotation, &item_settings)
        else {
            continue;
        };
        sampled_input_bytes = sampled_input_bytes.saturating_add(input_bytes);
        sampled_output_bytes = sampled_output_bytes.saturating_add(output_bytes);
        estimate_sample_count += 1;
    }
    let estimated_output_bytes = if sampled_input_bytes > 0 {
        Some(
            ((sampled_output_bytes as f64 / sampled_input_bytes as f64) * total_input_bytes as f64)
                .round() as u64,
        )
    } else {
        None
    };
    let estimated_savings_percent = estimated_output_bytes.and_then(|estimated| {
        (total_input_bytes > 0)
            .then_some((1.0 - estimated as f64 / total_input_bytes as f64) * 100.0)
    });
    let warnings = naming_warnings(&items, &settings);

    Ok(ExportPlan {
        item_count: items.len(),
        planned_outputs,
        estimated_output_bytes,
        estimated_savings_percent,
        estimate_sample_count,
        warnings,
    })
}

fn output_settings_for_item(settings: &OutputSettings, item: &ProcessItem) -> OutputSettings {
    let mut resolved = settings.clone();
    if let Some(policy) = item.metadata_policy {
        resolved.preserve_metadata = policy.preserve_metadata;
        resolved.preserve_gps = policy.preserve_metadata && policy.preserve_gps;
        resolved.preserve_prompt = policy.preserve_metadata && policy.preserve_prompt;
    }
    if let Some(resize_override) = item.resize_override {
        resolved.resize_mode = match resize_override.axis {
            protocol::ResizeAxis::Width => ResizeMode::Width,
            protocol::ResizeAxis::Height => ResizeMode::Height,
        };
        resolved.resize_value = resize_override.value;
        resolved.prevent_upscale = resize_override.prevent_upscale;
    }
    resolved
}

#[tauri::command]
async fn process_batch(
    app: AppHandle,
    controller: State<'_, BatchController>,
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> CommandResult<BatchResult> {
    validate_settings(&settings)
        .map_err(|error| CommandError::new("batch.invalidSettings", error))?;
    if items.is_empty() {
        return Err(CommandError::new("batch.empty", "no process items"));
    }
    let controller = controller.inner().clone();
    controller
        .begin()
        .map_err(|error| CommandError::new("batch.busy", error))?;
    let blocking_controller = controller.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        process_batch_blocking(app, items, settings, blocking_controller)
    })
    .await;
    controller.finish();
    let outcome = outcome.map_err(|error| CommandError::new("batch.run", error))?;
    outcome.map_err(|error| CommandError::new("batch.run", error))
}

#[tauri::command]
fn cancel_batch(controller: State<'_, BatchController>) -> bool {
    controller.request_cancel()
}

#[tauri::command]
async fn load_workspace(app: AppHandle) -> CommandResult<Option<workspace::RestoredWorkspace>> {
    let outcome = tauri::async_runtime::spawn_blocking(move || workspace::load(&app))
        .await
        .map_err(|error| CommandError::new("workspace.load", error))?;
    outcome.map_err(|error| CommandError::new("workspace.load", error))
}

#[tauri::command]
async fn save_workspace(
    app: AppHandle,
    snapshot: workspace::WorkspaceSnapshot,
) -> CommandResult<()> {
    let outcome = tauri::async_runtime::spawn_blocking(move || workspace::save(&app, snapshot))
        .await
        .map_err(|error| CommandError::new("workspace.save", error))?;
    outcome.map_err(|error| CommandError::new("workspace.save", error))
}

#[tauri::command]
async fn clear_workspace(app: AppHandle) -> CommandResult<()> {
    let outcome = tauri::async_runtime::spawn_blocking(move || workspace::clear(&app))
        .await
        .map_err(|error| CommandError::new("workspace.clear", error))?;
    outcome.map_err(|error| CommandError::new("workspace.clear", error))
}

#[tauri::command]
async fn load_app_preferences(app: AppHandle) -> CommandResult<workspace::AppPreferences> {
    let outcome = tauri::async_runtime::spawn_blocking(move || workspace::load_preferences(&app))
        .await
        .map_err(|error| CommandError::new("preferences.load", error))?;
    outcome.map_err(|error| CommandError::new("preferences.load", error))
}

#[tauri::command]
async fn save_app_preferences(
    app: AppHandle,
    preferences: workspace::AppPreferences,
) -> CommandResult<()> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        workspace::save_preferences(&app, preferences)
    })
    .await
    .map_err(|error| CommandError::new("preferences.save", error))?;
    outcome.map_err(|error| CommandError::new("preferences.save", error))
}

#[tauri::command]
async fn reset_app_preferences(app: AppHandle) -> CommandResult<workspace::AppPreferences> {
    let outcome = tauri::async_runtime::spawn_blocking(move || workspace::reset_preferences(&app))
        .await
        .map_err(|error| CommandError::new("preferences.reset", error))?;
    outcome.map_err(|error| CommandError::new("preferences.reset", error))
}

#[tauri::command]
async fn export_originals(
    items: Vec<OriginalExportItem>,
    output_directory: String,
) -> CommandResult<OriginalExportResult> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        export_originals_blocking(items, PathBuf::from(output_directory))
    })
    .await
    .map_err(|error| CommandError::new("originals.export", error))?;
    outcome.map_err(|error| CommandError::new("originals.export", error))
}

fn export_originals_blocking(
    items: Vec<OriginalExportItem>,
    output_directory: PathBuf,
) -> Result<OriginalExportResult, String> {
    if !output_directory.is_dir() {
        return Err("The selected original export folder is not available.".to_owned());
    }
    let mut results = Vec::with_capacity(items.len());
    let mut exported = 0_usize;
    let mut bytes = 0_u64;

    for item in items {
        match copy_original_without_overwrite(Path::new(&item.path), &output_directory) {
            Ok((output_path, copied_bytes)) => {
                exported += 1;
                bytes = bytes.saturating_add(copied_bytes);
                results.push(OriginalExportItemResult {
                    asset_id: item.id,
                    success: true,
                    output_path: Some(output_path.to_string_lossy().into_owned()),
                    bytes: Some(copied_bytes),
                    error: None,
                });
            }
            Err(error) => results.push(OriginalExportItemResult {
                asset_id: item.id,
                success: false,
                output_path: None,
                bytes: None,
                error: Some(error),
            }),
        }
    }

    Ok(OriginalExportResult {
        exported,
        failed: results.len().saturating_sub(exported),
        bytes,
        items: results,
    })
}

fn copy_original_without_overwrite(
    source: &Path,
    output_directory: &Path,
) -> Result<(PathBuf, u64), String> {
    if !source.is_file() {
        return Err(format!(
            "Original file is not available: {}",
            source.display()
        ));
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Original file name is invalid: {}", source.display()))?;
    let extension = source.extension().and_then(|value| value.to_str());
    let mut reader = std::fs::File::open(source)
        .map_err(|error| format!("Could not open original file {}: {error}", source.display()))?;

    for index in 1..=10_000_u32 {
        let file_name = match (index, extension) {
            (1, Some(extension)) => format!("{stem}.{extension}"),
            (1, None) => stem.to_owned(),
            (_, Some(extension)) => format!("{stem} ({index}).{extension}"),
            (_, None) => format!("{stem} ({index})"),
        };
        let candidate = output_directory.join(file_name);
        let mut writer = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create original copy {}: {error}",
                    candidate.display()
                ))
            }
        };
        let copied = match std::io::copy(&mut reader, &mut writer) {
            Ok(copied) => copied,
            Err(error) => {
                drop(writer);
                let _ = std::fs::remove_file(&candidate);
                return Err(format!(
                    "Could not copy original file to {}: {error}",
                    candidate.display()
                ));
            }
        };
        return Ok((candidate, copied));
    }

    Err(format!(
        "Could not find an unused name for {} in {}",
        source.display(),
        output_directory.display()
    ))
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("파일 또는 폴더를 찾을 수 없습니다.".to_owned());
    }

    let directory = if target.is_dir() {
        target.clone()
    } else {
        target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| "The file does not have a parent folder.".to_owned())?
            .to_path_buf()
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut explorer = Command::new("explorer.exe");
        if target.is_dir() {
            explorer.arg(&directory);
        } else {
            explorer.arg("/select,").arg(&target);
        }
        explorer
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut finder = Command::new("open");
        if target.is_dir() {
            finder.arg(&directory);
        } else {
            finder.arg("-R").arg(&target);
        }
        finder
            .spawn()
            .map_err(|error| format!("Finder를 열지 못했습니다: {error}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("파일 관리자를 열지 못했습니다: {error}"))?;

    Ok(())
}

#[tauri::command]
fn open_directories(paths: Vec<String>) -> Result<(), String> {
    let mut opened = HashSet::new();
    for path in paths {
        let directory = PathBuf::from(path);
        if !directory.is_dir() {
            return Err(format!(
                "The output folder is not available: {}",
                directory.display()
            ));
        }
        if opened.insert(directory.clone()) {
            reveal_in_file_manager(directory.to_string_lossy().into_owned())?;
        }
    }
    Ok(())
}

fn collect_output_directories(results: &[ProcessedItemResult]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut directories = Vec::new();
    for result in results.iter().filter(|result| result.success) {
        let Some(parent) = result
            .output_path
            .as_deref()
            .and_then(|path| Path::new(path).parent())
            .filter(|parent| !parent.as_os_str().is_empty())
        else {
            continue;
        };
        let directory = parent.to_path_buf();
        if seen.insert(directory.clone()) {
            directories.push(directory.to_string_lossy().into_owned());
        }
    }
    directories
}

fn process_batch_blocking(
    app: AppHandle,
    items: Vec<ProcessItem>,
    settings: OutputSettings,
    controller: BatchController,
) -> Result<BatchResult, String> {
    for item in &items {
        validate_settings(&output_settings_for_item(&settings, item))?;
    }
    if matches!(settings.processing_mode, ProcessingMode::RemoveBackground) {
        for item in &items {
            validate_mask_recipe(&item.mask_recipe)?;
            validate_edge_settings(&item.edge_settings)?;
        }
    }
    let total = items.len();
    let remove_background = matches!(settings.processing_mode, ProcessingMode::RemoveBackground);
    let needs_u2net = remove_background
        && items
            .iter()
            .any(|item| !matches!(item.mask_recipe.mode, MaskMode::Sam));
    let needs_sam = remove_background
        && items
            .iter()
            .any(|item| matches!(item.mask_recipe.mode, MaskMode::Sam));
    if needs_u2net || needs_sam {
        emit_progress(
            &app,
            BatchProgress {
                asset_id: String::new(),
                completed: 0,
                total,
                status: BatchItemStatus::ModelDownloading,
                output_path: None,
                error: None,
            },
        );
    }
    let model_path_string = needs_u2net
        .then(|| model::ensure_default_model(&app))
        .transpose()?
        .map(|path| path.to_string_lossy().into_owned());
    let sam_paths = needs_sam.then(|| sam::ensure_models(&app)).transpose()?;
    let sam_encoder_path = sam_paths
        .as_ref()
        .map(|paths| paths.encoder.to_string_lossy().into_owned());
    let sam_decoder_path = sam_paths
        .as_ref()
        .map(|paths| paths.decoder.to_string_lossy().into_owned());

    let mut reserved = HashSet::new();
    let mut requests = Vec::with_capacity(total);
    for (index, item) in items.iter().enumerate() {
        let item_settings = output_settings_for_item(&settings, item);
        let output_path = plan_output_path(
            Path::new(&item.path),
            &settings,
            &mut reserved,
            item.sequence.unwrap_or(index + 1),
            item.exif.as_ref(),
        )?;
        requests.push(WorkerRequest {
            protocol_version: WORKER_PROTOCOL_VERSION,
            job_id: item.id.clone(),
            input_path: item.path.clone(),
            output_path: output_path.to_string_lossy().into_owned(),
            model_path: model_path_string.clone(),
            sam_encoder_path: sam_encoder_path.clone(),
            sam_decoder_path: sam_decoder_path.clone(),
            rotation: item.rotation,
            settings: item_settings,
            mask_recipe: item.mask_recipe.clone(),
            edge_settings: item.edge_settings.clone(),
            metadata: item.exif.clone(),
        });
        emit_progress(
            &app,
            BatchProgress {
                asset_id: item.id.clone(),
                completed: 0,
                total,
                status: BatchItemStatus::Queued,
                output_path: None,
                error: None,
            },
        );
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("AI worker 실행 파일을 찾지 못했습니다: {error}"))?;
    let mut worker: Option<WorkerClient> = None;
    let mut worker_restarts = 0_usize;
    let mut results = Vec::with_capacity(total);
    for (request_index, request) in requests.iter().enumerate() {
        if controller.is_cancelled() {
            append_cancelled_results(&app, &requests[request_index..], total, &mut results);
            break;
        }
        emit_progress(
            &app,
            BatchProgress {
                asset_id: request.job_id.clone(),
                completed: results.len(),
                total,
                status: BatchItemStatus::Processing,
                output_path: None,
                error: None,
            },
        );
        let has_prior_results = !results.is_empty();
        let completed_before_request = results.len();
        let (response, attempts) = retry_once(
            |attempt| {
                if worker.is_none() {
                    if has_prior_results || attempt > 1 {
                        worker_restarts += 1;
                    }
                    worker = Some(WorkerClient::spawn(&executable)?);
                }
                let result = worker
                    .as_mut()
                    .ok_or_else(|| "AI worker를 준비하지 못했습니다.".to_owned())?
                    .request(request);
                if let Err(error) = result {
                    if let Some(failed_worker) = worker.take() {
                        failed_worker.terminate();
                    }
                    if let Ok(metadata) = Path::new(&request.output_path).metadata() {
                        if metadata.is_file() && metadata.len() > 0 {
                            return Ok(WorkerResponse {
                                protocol_version: WORKER_PROTOCOL_VERSION,
                                job_id: request.job_id.clone(),
                                success: true,
                                output_path: Some(request.output_path.clone()),
                                output_bytes: Some(metadata.len()),
                                duration_ms: 0,
                                error: None,
                            });
                        }
                    }
                    return Err(error);
                }
                result
            },
            |error| {
                emit_progress(
                    &app,
                    BatchProgress {
                        asset_id: request.job_id.clone(),
                        completed: completed_before_request,
                        total,
                        status: BatchItemStatus::RetryingWorker,
                        output_path: None,
                        error: Some(error.to_owned()),
                    },
                );
            },
        );
        let completed = results.len() + 1;
        let response = match response {
            Ok(response) => response,
            Err(transport_error) => {
                let error = format!(
                    "AI worker를 재시작한 뒤에도 응답하지 않았습니다: {}",
                    transport_error
                );
                emit_progress(
                    &app,
                    BatchProgress {
                        asset_id: request.job_id.clone(),
                        completed,
                        total,
                        status: BatchItemStatus::Failed,
                        output_path: None,
                        error: Some(error.clone()),
                    },
                );
                results.push(ProcessedItemResult {
                    asset_id: request.job_id.clone(),
                    success: false,
                    cancelled: false,
                    attempts,
                    output_path: None,
                    output_bytes: None,
                    duration_ms: 0,
                    error: Some(error),
                });
                continue;
            }
        };
        emit_progress(
            &app,
            BatchProgress {
                asset_id: response.job_id.clone(),
                completed,
                total,
                status: if response.success {
                    BatchItemStatus::Completed
                } else {
                    BatchItemStatus::Failed
                },
                output_path: response.output_path.clone(),
                error: response.error.clone(),
            },
        );
        results.push(ProcessedItemResult {
            asset_id: response.job_id,
            success: response.success,
            cancelled: false,
            attempts,
            output_path: response.output_path,
            output_bytes: response.output_bytes,
            duration_ms: response.duration_ms,
            error: response.error,
        });
    }
    if let Some(worker) = worker {
        worker.shutdown();
    }
    if results.len() != total {
        return Err(format!(
            "AI worker가 일부 응답을 반환하지 않았습니다: {} / {total}",
            results.len()
        ));
    }

    let output_directories = collect_output_directories(&results);
    Ok(BatchResult {
        completed: results.iter().filter(|item| item.success).count(),
        failed: results
            .iter()
            .filter(|item| !item.success && !item.cancelled)
            .count(),
        cancelled: results.iter().filter(|item| item.cancelled).count(),
        worker_restarts,
        output_bytes: results.iter().filter_map(|item| item.output_bytes).sum(),
        output_directories,
        items: results,
    })
}

fn append_cancelled_results(
    app: &AppHandle,
    requests: &[WorkerRequest],
    total: usize,
    results: &mut Vec<ProcessedItemResult>,
) {
    for request in requests {
        let completed = results.len() + 1;
        let error = "사용자가 batch 처리를 취소했습니다.".to_owned();
        emit_progress(
            app,
            BatchProgress {
                asset_id: request.job_id.clone(),
                completed,
                total,
                status: BatchItemStatus::Cancelled,
                output_path: None,
                error: Some(error.clone()),
            },
        );
        results.push(ProcessedItemResult {
            asset_id: request.job_id.clone(),
            success: false,
            cancelled: true,
            attempts: 0,
            output_path: None,
            output_bytes: None,
            duration_ms: 0,
            error: Some(error),
        });
    }
}

fn retry_once<T>(
    mut operation: impl FnMut(u8) -> Result<T, String>,
    mut on_retry: impl FnMut(&str),
) -> (Result<T, String>, u8) {
    match operation(1) {
        Ok(value) => (Ok(value), 1),
        Err(first_error) => {
            on_retry(&first_error);
            (operation(2), 2)
        }
    }
}

fn emit_progress(app: &AppHandle, progress: BatchProgress) {
    let _ = app.emit("batch-progress", progress);
}

fn plan_output_path(
    source: &Path,
    settings: &OutputSettings,
    reserved: &mut HashSet<String>,
    sequence: usize,
    cached_exif: Option<&metadata::ExifSummary>,
) -> Result<PathBuf, String> {
    let loaded_exif;
    let exif = if let Some(exif) = cached_exif {
        exif
    } else {
        loaded_exif = metadata::read_exif_summary(source);
        &loaded_exif
    };
    let base_name = naming::render_name_template(
        &settings.name_template,
        &naming::NamingContext {
            source,
            sequence,
            prefix: &settings.prefix,
            suffix: &settings.suffix,
            metadata: exif,
        },
    )?;
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    let output_dir = match settings.output_location {
        OutputLocation::Subfolder => parent.join(match settings.processing_mode {
            ProcessingMode::RemoveBackground => "Removed Background",
            ProcessingMode::Convert => "Converted Images",
        }),
        OutputLocation::SameFolder => parent.to_owned(),
        OutputLocation::Custom => PathBuf::from(&settings.output_directory),
    };
    let extension = settings.format.extension();

    for index in 1..=10_000 {
        let file_name = if index == 1 {
            format!("{base_name}.{extension}")
        } else {
            format!("{base_name} ({index}).{extension}")
        };
        let candidate = output_dir.join(file_name);
        let key = candidate.to_string_lossy().to_lowercase();
        if !candidate.exists() && reserved.insert(key) {
            return Ok(candidate);
        }
    }
    Err("사용 가능한 출력 파일명을 만들지 못했습니다.".to_owned())
}

fn naming_warnings(items: &[ProcessItem], settings: &OutputSettings) -> Vec<ExportWarning> {
    let needs_taken = settings.name_template.contains("{taken:");
    let needs_camera = settings.name_template.contains("{camera}");
    let needs_lens = settings.name_template.contains("{lens}");
    if !needs_taken && !needs_camera && !needs_lens {
        return Vec::new();
    }

    let mut missing_taken = 0;
    let mut missing_camera = 0;
    let mut missing_lens = 0;
    for item in items {
        let loaded_exif;
        let exif = if let Some(exif) = item.exif.as_ref() {
            exif
        } else {
            loaded_exif = metadata::read_exif_summary(Path::new(&item.path));
            &loaded_exif
        };
        missing_taken += usize::from(needs_taken && exif.taken_at.is_none());
        missing_camera += usize::from(needs_camera && exif.camera.is_none());
        missing_lens += usize::from(needs_lens && exif.lens.is_none());
    }

    let mut warnings = Vec::new();
    if missing_taken > 0 {
        warnings.push(ExportWarning {
            code: "missingTakenAt",
            count: missing_taken,
        });
    }
    if missing_camera > 0 {
        warnings.push(ExportWarning {
            code: "missingCamera",
            count: missing_camera,
        });
    }
    if missing_lens > 0 {
        warnings.push(ExportWarning {
            code: "missingLens",
            count: missing_lens,
        });
    }
    warnings
}

fn validate_settings(settings: &OutputSettings) -> Result<(), String> {
    if !(1..=100).contains(&settings.webp_quality) {
        return Err("WebP 화질은 1에서 100 사이여야 합니다.".to_owned());
    }
    if !(1..=9).contains(&settings.png_effort) {
        return Err("PNG 압축 강도는 1에서 9 사이여야 합니다.".to_owned());
    }
    if !matches!(settings.resize_mode, ResizeMode::Original) && settings.resize_value == 0 {
        return Err("변경할 이미지 크기는 0보다 커야 합니다.".to_owned());
    }
    if matches!(settings.resize_mode, ResizeMode::Percent) && settings.resize_value > 1_000 {
        return Err("비율은 안전을 위해 1,000% 이하여야 합니다.".to_owned());
    }
    if matches!(
        settings.resize_mode,
        ResizeMode::LongEdge | ResizeMode::Width | ResizeMode::Height
    ) && settings.resize_value > 32_768
    {
        return Err("출력 크기는 안전을 위해 32,768px 이하여야 합니다.".to_owned());
    }
    if matches!(settings.output_location, OutputLocation::Custom)
        && settings.output_directory.trim().is_empty()
    {
        return Err("저장할 폴더를 선택해주세요.".to_owned());
    }
    let sample_metadata = metadata::ExifSummary::default();
    naming::render_name_template(
        &settings.name_template,
        &naming::NamingContext {
            source: Path::new("image.jpg"),
            sequence: 1,
            prefix: &settings.prefix,
            suffix: &settings.suffix,
            metadata: &sample_metadata,
        },
    )?;
    Ok(())
}

fn validate_edge_settings(settings: &EdgeSettings) -> Result<(), String> {
    if settings.edge_smoothing > 10 {
        return Err("가장자리 매끄럽게 값은 0에서 10 사이여야 합니다.".to_owned());
    }
    if settings.edge_feather > 20 {
        return Err("가장자리 페더는 0에서 20px 사이여야 합니다.".to_owned());
    }
    if !(-8..=8).contains(&settings.edge_shift) {
        return Err("마스크 확장·축소는 -8에서 8px 사이여야 합니다.".to_owned());
    }
    if settings.alpha_threshold > 100 {
        return Err("희미한 배경 제거 값은 0에서 100% 사이여야 합니다.".to_owned());
    }
    if !(-50..=50).contains(&settings.mask_contrast) {
        return Err("마스크 대비는 -50에서 50 사이여야 합니다.".to_owned());
    }
    Ok(())
}

fn validate_mask_recipe(recipe: &protocol::ManualMaskRecipe) -> Result<(), String> {
    if recipe.strokes.len() > 2_048 {
        return Err("파일 하나에는 브러시 획을 최대 2,048개까지 저장할 수 있습니다.".to_owned());
    }
    let mut point_count = 0_usize;
    let mut has_keep = false;
    for stroke in &recipe.strokes {
        if !(0.000_1..=0.5).contains(&stroke.radius) || !stroke.radius.is_finite() {
            return Err("브러시 크기 정보가 올바르지 않습니다.".to_owned());
        }
        point_count = point_count.saturating_add(stroke.points.len());
        has_keep |= matches!(stroke.mode, protocol::BrushMode::Keep) && !stroke.points.is_empty();
        if stroke.points.iter().any(|point| {
            !point.x.is_finite()
                || !point.y.is_finite()
                || !(0.0..=1.0).contains(&point.x)
                || !(0.0..=1.0).contains(&point.y)
        }) {
            return Err("브러시 좌표 정보가 올바르지 않습니다.".to_owned());
        }
    }
    if point_count > 100_000 {
        return Err(
            "파일 하나에는 브러시 좌표를 최대 100,000개까지 저장할 수 있습니다.".to_owned(),
        );
    }
    if matches!(
        recipe.mode,
        protocol::MaskMode::Manual | protocol::MaskMode::Sam
    ) && !has_keep
    {
        return Err(match recipe.mode {
            protocol::MaskMode::Sam => {
                "AI 객체 선택에서는 유지할 객체를 먼저 표시해주세요.".to_owned()
            }
            _ => "칠한 영역만 유지 모드에서는 유지할 객체를 먼저 칠해주세요.".to_owned(),
        });
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BatchController::default())
        .manage(MaskPreviewController::default())
        .manage(SamPreviewController::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            inspect_paths,
            load_preview,
            load_thumbnail,
            generate_mask_preview,
            generate_sam_preview,
            get_model_status,
            get_app_diagnostics,
            install_model,
            delete_model,
            prepare_export_plan,
            process_batch,
            cancel_batch,
            load_workspace,
            save_workspace,
            clear_workspace,
            load_app_preferences,
            save_app_preferences,
            reset_app_preferences,
            export_originals,
            reveal_in_file_manager,
            open_directories
        ])
        .run(tauri::generate_context!())
        .expect("error while running CrystalCut");
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::OutputLocation;

    fn settings() -> OutputSettings {
        OutputSettings {
            output_location: OutputLocation::SameFolder,
            ..OutputSettings::default()
        }
    }

    #[test]
    fn batch_result_lists_each_successful_output_folder_once() {
        let root = std::env::temp_dir().join("crystalcut-output-folders");
        let first_directory = root.join("first");
        let second_directory = root.join("second");
        let make_result = |asset_id: &str, path: PathBuf, success: bool| ProcessedItemResult {
            asset_id: asset_id.to_owned(),
            success,
            cancelled: false,
            attempts: 1,
            output_path: Some(path.to_string_lossy().into_owned()),
            output_bytes: Some(10),
            duration_ms: 1,
            error: None,
        };
        let results = vec![
            make_result("one", first_directory.join("one.png"), true),
            make_result("two", first_directory.join("two.png"), true),
            make_result("three", second_directory.join("three.png"), true),
            make_result("failed", root.join("ignored.png"), false),
        ];

        assert_eq!(
            collect_output_directories(&results),
            vec![
                first_directory.to_string_lossy().into_owned(),
                second_directory.to_string_lossy().into_owned(),
            ]
        );
    }

    #[test]
    fn filename_fragments_replace_cross_platform_forbidden_characters() {
        assert_eq!(
            naming::sanitize_filename_fragment("2026:08/22*"),
            "2026_08_22_"
        );
    }

    #[test]
    fn filename_fragments_remove_trailing_dots_and_spaces() {
        assert_eq!(
            naming::sanitize_filename_fragment("portrait...  "),
            "portrait"
        );
    }

    #[test]
    fn custom_output_requires_a_directory() {
        let invalid = OutputSettings {
            output_location: OutputLocation::Custom,
            ..settings()
        };
        assert!(validate_settings(&invalid).is_err());
    }

    #[test]
    fn output_planning_never_overwrites_an_existing_file() {
        let temp_dir = std::env::temp_dir().join(format!("crystalcut-plan-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).expect("create test directory");
        let source = temp_dir.join("portrait.jpg");
        let existing = temp_dir.join("portrait_bg.png");
        std::fs::write(&existing, b"existing").expect("create collision fixture");

        let output = plan_output_path(&source, &settings(), &mut HashSet::new(), 1, None)
            .expect("plan output");
        assert_eq!(
            output.file_name().and_then(|value| value.to_str()),
            Some("portrait_bg (2).png")
        );

        std::fs::remove_file(existing).expect("remove fixture");
        std::fs::remove_dir(temp_dir).expect("remove test directory");
    }

    #[test]
    fn original_export_copies_bytes_and_never_overwrites() {
        let temp_dir =
            std::env::temp_dir().join(format!("crystalcut-original-export-{}", std::process::id()));
        let source_dir = temp_dir.join("source");
        let output_dir = temp_dir.join("output");
        std::fs::create_dir_all(&source_dir).expect("create source directory");
        std::fs::create_dir_all(&output_dir).expect("create output directory");
        let source = source_dir.join("portrait.jpg");
        std::fs::write(&source, b"original-image-bytes").expect("create original fixture");
        std::fs::write(output_dir.join("portrait.jpg"), b"existing").expect("create collision");

        let (copied, bytes) = copy_original_without_overwrite(&source, &output_dir)
            .expect("copy original without overwrite");
        assert_eq!(
            copied.file_name().and_then(|value| value.to_str()),
            Some("portrait (2).jpg")
        );
        assert_eq!(bytes, 20);
        assert_eq!(
            std::fs::read(copied).expect("read copied bytes"),
            b"original-image-bytes"
        );
        assert_eq!(
            std::fs::read(output_dir.join("portrait.jpg")).expect("read collision"),
            b"existing"
        );

        std::fs::remove_dir_all(temp_dir).expect("remove original export fixture");
    }

    #[test]
    fn output_planning_applies_sequence_template_before_collision_suffix() {
        let mut dynamic = settings();
        dynamic.name_template = "{seq:03}_{name}{suffix}".to_owned();
        let output = plan_output_path(
            Path::new("portrait.jpg"),
            &dynamic,
            &mut HashSet::new(),
            7,
            None,
        )
        .expect("plan templated output");
        assert_eq!(
            output.file_name().and_then(|value| value.to_str()),
            Some("007_portrait_bg.png")
        );
    }

    #[test]
    fn invalid_name_template_is_rejected_before_processing() {
        let mut invalid = settings();
        invalid.name_template = "{unknown}".to_owned();
        assert!(validate_settings(&invalid).is_err());
    }

    #[test]
    fn list_thumbnail_is_bounded_without_waiting_for_full_preview() {
        let temp_dir =
            std::env::temp_dir().join(format!("crystalcut-thumbnail-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).expect("create thumbnail directory");
        let source = temp_dir.join("wide.png");
        image::RgbaImage::from_pixel(640, 320, image::Rgba([90, 120, 180, 255]))
            .save(&source)
            .expect("save thumbnail fixture");

        let data_url = load_image_data_url_blocking(&source, MAX_THUMBNAIL_EDGE)
            .expect("create list thumbnail");
        let payload = data_url
            .split_once(',')
            .map(|(_, payload)| payload)
            .expect("thumbnail data URL payload");
        let decoded = STANDARD.decode(payload).expect("decode thumbnail payload");
        let thumbnail = image::load_from_memory(&decoded).expect("open thumbnail payload");
        assert_eq!(thumbnail.dimensions(), (160, 80));

        std::fs::remove_file(source).expect("remove thumbnail fixture");
        std::fs::remove_dir(temp_dir).expect("remove thumbnail directory");
    }

    #[test]
    fn manual_mask_requires_a_keep_stroke_before_processing() {
        let recipe = protocol::ManualMaskRecipe {
            mode: protocol::MaskMode::Manual,
            strokes: vec![protocol::BrushStroke {
                mode: protocol::BrushMode::Remove,
                radius: 0.02,
                points: vec![protocol::MaskPoint { x: 0.5, y: 0.5 }],
            }],
        };
        assert!(validate_mask_recipe(&recipe).is_err());
    }

    #[test]
    fn export_plan_estimates_bytes_without_creating_output_files() {
        let temp_dir =
            std::env::temp_dir().join(format!("crystalcut-estimate-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).expect("create estimate directory");
        let source = temp_dir.join("sample.png");
        image::RgbaImage::from_pixel(64, 32, image::Rgba([120, 80, 40, 255]))
            .save(&source)
            .expect("save estimate fixture");
        let items = vec![ProcessItem {
            id: "estimate-1".to_owned(),
            path: source.to_string_lossy().into_owned(),
            rotation: 0,
            sequence: None,
            exif: None,
            mask_recipe: protocol::ManualMaskRecipe::default(),
            edge_settings: EdgeSettings::default(),
            metadata_policy: None,
            resize_override: None,
        }];

        let plan = prepare_export_plan_blocking(items, settings()).expect("prepare export plan");
        assert_eq!(plan.estimate_sample_count, 1);
        assert!(plan.estimated_output_bytes.is_some_and(|bytes| bytes > 0));
        assert!(!temp_dir.join("sample_bg.png").exists());

        std::fs::remove_file(source).expect("remove estimate fixture");
        std::fs::remove_dir(temp_dir).expect("remove estimate directory");
    }

    #[test]
    fn per_file_metadata_policy_overrides_global_output_settings() {
        let mut global = settings();
        global.preserve_metadata = false;
        global.preserve_gps = false;
        global.preserve_prompt = false;
        let item = ProcessItem {
            id: "metadata-policy".to_owned(),
            path: "photo.jpg".to_owned(),
            rotation: 0,
            sequence: None,
            exif: None,
            mask_recipe: protocol::ManualMaskRecipe::default(),
            edge_settings: EdgeSettings::default(),
            metadata_policy: Some(protocol::MetadataOutputPolicy {
                preserve_metadata: true,
                preserve_gps: true,
                preserve_prompt: false,
            }),
            resize_override: None,
        };

        let resolved = output_settings_for_item(&global, &item);
        assert!(resolved.preserve_metadata);
        assert!(resolved.preserve_gps);
        assert!(!resolved.preserve_prompt);
        assert!(!global.preserve_metadata);
    }

    #[test]
    fn disabled_file_metadata_policy_clears_sensitive_children() {
        let mut global = settings();
        global.preserve_metadata = true;
        global.preserve_gps = true;
        global.preserve_prompt = true;
        let item = ProcessItem {
            id: "metadata-disabled".to_owned(),
            path: "photo.jpg".to_owned(),
            rotation: 0,
            sequence: None,
            exif: None,
            mask_recipe: protocol::ManualMaskRecipe::default(),
            edge_settings: EdgeSettings::default(),
            metadata_policy: Some(protocol::MetadataOutputPolicy {
                preserve_metadata: false,
                preserve_gps: true,
                preserve_prompt: true,
            }),
            resize_override: None,
        };

        let resolved = output_settings_for_item(&global, &item);
        assert!(!resolved.preserve_metadata);
        assert!(!resolved.preserve_gps);
        assert!(!resolved.preserve_prompt);
    }

    #[test]
    fn per_file_resize_override_replaces_only_global_resize_fields() {
        let mut global = settings();
        global.resize_mode = ResizeMode::Percent;
        global.resize_value = 50;
        global.prevent_upscale = false;
        global.format = protocol::OutputFormat::Webp;
        let item = ProcessItem {
            id: "resize-override".to_owned(),
            path: "photo.jpg".to_owned(),
            rotation: 0,
            sequence: None,
            exif: None,
            mask_recipe: protocol::ManualMaskRecipe::default(),
            edge_settings: EdgeSettings::default(),
            metadata_policy: None,
            resize_override: Some(protocol::ResizeOverride {
                axis: protocol::ResizeAxis::Height,
                value: 1_080,
                prevent_upscale: true,
            }),
        };

        let resolved = output_settings_for_item(&global, &item);
        assert_eq!(resolved.resize_mode, ResizeMode::Height);
        assert_eq!(resolved.resize_value, 1_080);
        assert!(resolved.prevent_upscale);
        assert_eq!(resolved.format, protocol::OutputFormat::Webp);
        assert_eq!(global.resize_mode, ResizeMode::Percent);
    }

    #[test]
    fn batch_controller_rejects_overlap_and_resets_after_finish() {
        let controller = BatchController::default();
        assert!(controller.begin().is_ok());
        assert!(controller.begin().is_err());
        assert!(controller.request_cancel());
        assert!(controller.is_cancelled());

        controller.finish();
        assert!(!controller.request_cancel());
        assert!(!controller.is_cancelled());
        assert!(controller.begin().is_ok());
        controller.finish();
    }

    #[test]
    fn worker_transport_is_retried_exactly_once() {
        let mut calls = Vec::new();
        let mut retry_errors = Vec::new();
        let (result, attempts) = retry_once(
            |attempt| {
                calls.push(attempt);
                if attempt == 1 {
                    Err("worker exited".to_owned())
                } else {
                    Ok("recovered")
                }
            },
            |error| retry_errors.push(error.to_owned()),
        );
        assert_eq!(result, Ok("recovered"));
        assert_eq!(attempts, 2);
        assert_eq!(calls, vec![1, 2]);
        assert_eq!(retry_errors, vec!["worker exited"]);
    }

    #[test]
    fn permanent_worker_transport_failure_stops_after_second_attempt() {
        let mut calls = 0;
        let (result, attempts) = retry_once(
            |_| {
                calls += 1;
                Err::<(), _>(format!("failure {calls}"))
            },
            |_| {},
        );
        assert_eq!(result, Err("failure 2".to_owned()));
        assert_eq!(attempts, 2);
        assert_eq!(calls, 2);
    }
}
