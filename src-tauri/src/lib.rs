mod engine;
mod metadata;
mod model;
mod naming;
mod protocol;
pub mod worker;

use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Cursor, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{GenericImageView, ImageFormat, ImageReader};
use protocol::{
    BatchItemStatus, BatchProgress, BatchResult, ExportPlan, OutputLocation, OutputSettings,
    PlannedOutput, ProcessItem, ProcessedItemResult, ResizeMode, WorkerRequest, WorkerResponse,
    WORKER_PROTOCOL_VERSION,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];
const MAX_PREVIEW_EDGE: u32 = 1600;

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

#[tauri::command]
async fn inspect_paths(paths: Vec<String>) -> Result<Vec<ImageAsset>, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_paths_blocking(paths))
        .await
        .map_err(|error| format!("파일 검사 작업에 실패했습니다: {error}"))?
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
async fn load_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || load_preview_blocking(Path::new(&path)))
        .await
        .map_err(|error| format!("미리보기 작업에 실패했습니다: {error}"))?
}

fn load_preview_blocking(path: &Path) -> Result<String, String> {
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
    let preview = if width > MAX_PREVIEW_EDGE || height > MAX_PREVIEW_EDGE {
        source.thumbnail(MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE)
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

#[tauri::command]
fn get_model_status(app: AppHandle) -> Result<model::ModelStatus, String> {
    model::status(&app)
}

#[tauri::command]
async fn prepare_export_plan(
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> Result<ExportPlan, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_export_plan_blocking(items, settings))
        .await
        .map_err(|error| format!("출력 예상 작업을 실행하지 못했습니다: {error}"))?
}

fn prepare_export_plan_blocking(
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> Result<ExportPlan, String> {
    validate_settings(&settings)?;
    let mut reserved = HashSet::new();
    let planned_outputs = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            plan_output_path(
                Path::new(&item.path),
                &settings,
                &mut reserved,
                index + 1,
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
        let Ok(output_bytes) = engine::estimate_output_size(path, item.rotation, &settings) else {
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

#[tauri::command]
async fn process_batch(
    app: AppHandle,
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> Result<BatchResult, String> {
    validate_settings(&settings)?;
    if items.is_empty() {
        return Err("처리할 이미지가 없습니다.".to_owned());
    }

    tauri::async_runtime::spawn_blocking(move || process_batch_blocking(app, items, settings))
        .await
        .map_err(|error| format!("batch 작업을 실행하지 못했습니다: {error}"))?
}

fn process_batch_blocking(
    app: AppHandle,
    items: Vec<ProcessItem>,
    settings: OutputSettings,
) -> Result<BatchResult, String> {
    let total = items.len();
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
    let model_path = model::ensure_default_model(&app)?;
    let model_path_string = model_path.to_string_lossy().into_owned();

    let mut reserved = HashSet::new();
    let mut requests = Vec::with_capacity(total);
    for (index, item) in items.iter().enumerate() {
        let output_path = plan_output_path(
            Path::new(&item.path),
            &settings,
            &mut reserved,
            index + 1,
            item.exif.as_ref(),
        )?;
        requests.push(WorkerRequest {
            protocol_version: WORKER_PROTOCOL_VERSION,
            job_id: item.id.clone(),
            input_path: item.path.clone(),
            output_path: output_path.to_string_lossy().into_owned(),
            model_path: model_path_string.clone(),
            rotation: item.rotation,
            settings: settings.clone(),
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
    let mut child = Command::new(executable)
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("AI worker를 시작하지 못했습니다: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "AI worker 입력 채널을 열지 못했습니다.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "AI worker 출력 채널을 열지 못했습니다.".to_owned())?;
    let mut stdout = BufReader::new(stdout);
    let mut results = Vec::with_capacity(total);
    for request in &requests {
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
        serde_json::to_writer(&mut stdin, request)
            .map_err(|error| format!("AI worker 요청을 만들지 못했습니다: {error}"))?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("AI worker 요청을 보내지 못했습니다: {error}"))?;

        let mut line = String::new();
        if stdout
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

        let completed = results.len() + 1;
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
            output_path: response.output_path,
            output_bytes: response.output_bytes,
            duration_ms: response.duration_ms,
            error: response.error,
        });
    }
    drop(stdin);
    drop(stdout);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("AI worker 종료 상태를 확인하지 못했습니다: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("AI worker가 비정상 종료되었습니다: {stderr}"));
    }
    if results.len() != total {
        return Err(format!(
            "AI worker가 일부 응답을 반환하지 않았습니다: {} / {total}",
            results.len()
        ));
    }

    Ok(BatchResult {
        completed: results.iter().filter(|item| item.success).count(),
        failed: results.iter().filter(|item| !item.success).count(),
        output_bytes: results.iter().filter_map(|item| item.output_bytes).sum(),
        items: results,
    })
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
        OutputLocation::Subfolder => parent.join("Removed Background"),
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

fn naming_warnings(items: &[ProcessItem], settings: &OutputSettings) -> Vec<String> {
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
        warnings.push(format!(
            "촬영일이 없는 {missing_taken}개 파일은 undated로 저장됩니다."
        ));
    }
    if missing_camera > 0 {
        warnings.push(format!(
            "카메라 정보가 없는 {missing_camera}개 파일은 unknown-camera로 저장됩니다."
        ));
    }
    if missing_lens > 0 {
        warnings.push(format!(
            "렌즈 정보가 없는 {missing_lens}개 파일은 unknown-lens로 저장됩니다."
        ));
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
    if matches!(settings.resize_mode, ResizeMode::LongEdge) && settings.resize_value > 32_768 {
        return Err("긴 변은 안전을 위해 32,768px 이하여야 합니다.".to_owned());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_paths,
            load_preview,
            get_model_status,
            prepare_export_plan,
            process_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clearcut");
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{OutputFormat, OutputLocation, ResizeMode};

    fn settings() -> OutputSettings {
        OutputSettings {
            format: OutputFormat::Png,
            webp_quality: 82,
            webp_lossless: false,
            png_effort: 6,
            resize_mode: ResizeMode::Original,
            resize_value: 2048,
            prevent_upscale: true,
            output_location: OutputLocation::SameFolder,
            output_directory: String::new(),
            prefix: String::new(),
            suffix: "_bg".to_owned(),
            name_template: naming::DEFAULT_NAME_TEMPLATE.to_owned(),
        }
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
        let temp_dir = std::env::temp_dir().join(format!("clearcut-plan-{}", std::process::id()));
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
    fn export_plan_estimates_bytes_without_creating_output_files() {
        let temp_dir =
            std::env::temp_dir().join(format!("clearcut-estimate-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).expect("create estimate directory");
        let source = temp_dir.join("sample.png");
        image::RgbaImage::from_pixel(64, 32, image::Rgba([120, 80, 40, 255]))
            .save(&source)
            .expect("save estimate fixture");
        let items = vec![ProcessItem {
            id: "estimate-1".to_owned(),
            path: source.to_string_lossy().into_owned(),
            rotation: 0,
            exif: None,
        }];

        let plan = prepare_export_plan_blocking(items, settings()).expect("prepare export plan");
        assert_eq!(plan.estimate_sample_count, 1);
        assert!(plan.estimated_output_bytes.is_some_and(|bytes| bytes > 0));
        assert!(!temp_dir.join("sample_bg.png").exists());

        std::fs::remove_file(source).expect("remove estimate fixture");
        std::fs::remove_dir(temp_dir).expect("remove estimate directory");
    }
}
