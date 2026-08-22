use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{GenericImageView, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputSettings {
    format: OutputFormat,
    webp_quality: u8,
    webp_lossless: bool,
    png_effort: u8,
    resize_mode: ResizeMode,
    resize_value: u32,
    prevent_upscale: bool,
    output_location: OutputLocation,
    output_directory: String,
    prefix: String,
    suffix: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Png,
    Webp,
}

impl OutputFormat {
    fn extension(&self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Webp => "webp",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResizeMode {
    Original,
    Percent,
    LongEdge,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OutputLocation {
    Subfolder,
    SameFolder,
    Custom,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportPlan {
    item_count: usize,
    sample_outputs: Vec<String>,
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

    let source = ImageReader::open(path)
        .map_err(|error| format!("이미지를 열 수 없습니다: {error}"))?
        .decode()
        .map_err(|error| format!("이미지를 해석할 수 없습니다: {error}"))?;
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
fn prepare_export_plan(paths: Vec<String>, settings: OutputSettings) -> Result<ExportPlan, String> {
    validate_settings(&settings)?;

    let mut outputs = Vec::with_capacity(paths.len().min(5));
    for raw_path in paths.iter().take(5) {
        let source = Path::new(raw_path);
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image");
        let file_name = format!(
            "{}{}{}.{}",
            sanitize_filename_fragment(&settings.prefix),
            sanitize_filename_fragment(stem),
            sanitize_filename_fragment(&settings.suffix),
            settings.format.extension()
        );

        let parent = source.parent().unwrap_or_else(|| Path::new("."));
        let output = match settings.output_location {
            OutputLocation::Subfolder => parent.join("Removed Background").join(file_name),
            OutputLocation::SameFolder => parent.join(file_name),
            OutputLocation::Custom => Path::new(&settings.output_directory).join(file_name),
        };
        outputs.push(output.to_string_lossy().into_owned());
    }

    Ok(ExportPlan {
        item_count: paths.len(),
        sample_outputs: outputs,
    })
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
    if matches!(settings.output_location, OutputLocation::Custom)
        && settings.output_directory.trim().is_empty()
    {
        return Err("저장할 폴더를 선택해주세요.".to_owned());
    }

    // These values are deliberately parsed and validated now so the contract does not drift
    // when the encoder worker is connected in the next implementation stage.
    let _encoder_contract = (settings.webp_lossless, settings.prevent_upscale);
    Ok(())
}

fn sanitize_filename_fragment(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ if character.is_control() => '_',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .to_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_paths,
            load_preview,
            prepare_export_plan
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clearcut");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_fragments_replace_cross_platform_forbidden_characters() {
        assert_eq!(sanitize_filename_fragment("2026:08/22*"), "2026_08_22_");
    }

    #[test]
    fn filename_fragments_remove_trailing_dots_and_spaces() {
        assert_eq!(sanitize_filename_fragment("portrait...  "), "portrait");
    }

    #[test]
    fn custom_output_requires_a_directory() {
        let settings = OutputSettings {
            format: OutputFormat::Png,
            webp_quality: 82,
            webp_lossless: false,
            png_effort: 6,
            resize_mode: ResizeMode::Original,
            resize_value: 2048,
            prevent_upscale: true,
            output_location: OutputLocation::Custom,
            output_directory: String::new(),
            prefix: String::new(),
            suffix: "_bg".to_owned(),
        };

        assert!(validate_settings(&settings).is_err());
    }
}
