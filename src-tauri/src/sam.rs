use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use image::{imageops::FilterType as ResizeFilter, DynamicImage, GenericImageView, GrayImage};
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use ureq::{
    config::Config,
    tls::{TlsConfig, TlsProvider},
    Agent,
};

use crate::{
    engine,
    protocol::{BrushMode, ManualMaskRecipe, OutputSettings, WorkerRequest},
};

const MODEL_ID: &str = "slimsam-77-uniform";
const ENCODER_NAME: &str = "vision_encoder_quantized.onnx";
const DECODER_NAME: &str = "prompt_encoder_mask_decoder_quantized.onnx";
const ENCODER_URL: &str = "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/7c8459c48dabad6291b384c97be46c451c25d6c4/onnx/vision_encoder_quantized.onnx?download=true";
const DECODER_URL: &str = "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/69c9d2e880cd421621781e9ded1f0bf1c20e1f74/onnx/prompt_encoder_mask_decoder_quantized.onnx?download=true";
const ENCODER_BYTES: u64 = 8_882_165;
const DECODER_BYTES: u64 = 4_903_810;
const ENCODER_SHA256: &str = "cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971";
const DECODER_SHA256: &str = "cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2";
const IMAGE_SIZE: u32 = 1024;
const MASK_SIZE: u32 = 256;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

#[derive(Debug, Clone)]
pub struct SamModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
}

pub fn ensure_models(app: &AppHandle) -> Result<SamModelPaths, String> {
    if let Some(paths) = find_verified_models(app)? {
        return Ok(paths);
    }
    let paths = installed_model_paths(app)?;
    let directory = paths
        .encoder
        .parent()
        .ok_or_else(|| "SAM 모델 저장 폴더를 계산하지 못했습니다.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("SAM 모델 저장 폴더를 만들지 못했습니다: {error}"))?;
    download_model(
        ENCODER_URL,
        &paths.encoder,
        ENCODER_BYTES,
        ENCODER_SHA256,
        "이미지 인코더",
    )?;
    download_model(
        DECODER_URL,
        &paths.decoder,
        DECODER_BYTES,
        DECODER_SHA256,
        "프롬프트 디코더",
    )?;
    Ok(paths)
}

fn find_verified_models(app: &AppHandle) -> Result<Option<SamModelPaths>, String> {
    if let (Ok(encoder), Ok(decoder)) = (
        std::env::var("CLEARCUT_SAM_ENCODER_PATH"),
        std::env::var("CLEARCUT_SAM_DECODER_PATH"),
    ) {
        let paths = SamModelPaths {
            encoder: PathBuf::from(encoder),
            decoder: PathBuf::from(decoder),
        };
        verify_model(
            &paths.encoder,
            ENCODER_BYTES,
            ENCODER_SHA256,
            "이미지 인코더",
        )?;
        verify_model(
            &paths.decoder,
            DECODER_BYTES,
            DECODER_SHA256,
            "프롬프트 디코더",
        )?;
        return Ok(Some(paths));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        let directory = current_dir.join("models").join("cache").join("slimsam");
        let paths = SamModelPaths {
            encoder: directory.join(ENCODER_NAME),
            decoder: directory.join(DECODER_NAME),
        };
        if verify_pair(&paths) {
            return Ok(Some(paths));
        }
    }
    let paths = installed_model_paths(app)?;
    Ok(verify_pair(&paths).then_some(paths))
}

fn installed_model_paths(app: &AppHandle) -> Result<SamModelPaths, String> {
    app.path()
        .app_data_dir()
        .map(|root| {
            let directory = root.join("models").join(MODEL_ID);
            SamModelPaths {
                encoder: directory.join(ENCODER_NAME),
                decoder: directory.join(DECODER_NAME),
            }
        })
        .map_err(|error| format!("앱 데이터 폴더를 찾지 못했습니다: {error}"))
}

fn verify_pair(paths: &SamModelPaths) -> bool {
    verify_model(
        &paths.encoder,
        ENCODER_BYTES,
        ENCODER_SHA256,
        "이미지 인코더",
    )
    .is_ok()
        && verify_model(
            &paths.decoder,
            DECODER_BYTES,
            DECODER_SHA256,
            "프롬프트 디코더",
        )
        .is_ok()
}

fn download_model(
    url: &str,
    path: &Path,
    expected_bytes: u64,
    expected_hash: &str,
    label: &str,
) -> Result<(), String> {
    if verify_model(path, expected_bytes, expected_hash, label).is_ok() {
        return Ok(());
    }
    if path.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("손상된 SAM {label}를 교체하지 못했습니다: {error}"))?;
    }
    let partial = path.with_extension("onnx.partial");
    let mut response = download_agent()
        .get(url)
        .call()
        .map_err(|error| format!("SAM {label}를 다운로드하지 못했습니다: {error}"))?;
    let mut reader = response.body_mut().as_reader();
    let mut file = File::create(&partial)
        .map_err(|error| format!("SAM {label} 임시 파일을 만들지 못했습니다: {error}"))?;
    io::copy(&mut reader, &mut file)
        .map_err(|error| format!("SAM {label}를 저장하지 못했습니다: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("SAM {label}를 디스크에 반영하지 못했습니다: {error}"))?;
    drop(file);
    if let Err(error) = verify_model(&partial, expected_bytes, expected_hash, label) {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, path)
        .map_err(|error| format!("검증한 SAM {label}를 설치하지 못했습니다: {error}"))
}

fn download_agent() -> Agent {
    Config::builder()
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .build(),
        )
        .build()
        .new_agent()
}

fn verify_model(
    path: &Path,
    expected_bytes: u64,
    expected_hash: &str,
    label: &str,
) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("SAM {label} 정보를 읽지 못했습니다: {error}"))?;
    if metadata.len() != expected_bytes {
        return Err(format!(
            "SAM {label} 크기가 예상과 다릅니다: {} / {expected_bytes} bytes",
            metadata.len()
        ));
    }
    let mut file =
        File::open(path).map_err(|error| format!("SAM {label}를 열지 못했습니다: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("SAM {label}를 검증하지 못했습니다: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual != expected_hash {
        return Err(format!("SAM {label} SHA-256이 일치하지 않습니다: {actual}"));
    }
    Ok(())
}

pub struct SamEngine {
    encoder: Session,
    decoder: Session,
    paths: SamModelPaths,
    cached_embedding: Option<CachedEmbedding>,
    cached_preview_mask: Option<CachedPromptMask>,
}

struct CachedEmbedding {
    key: String,
    image: Vec<f32>,
    positional: Vec<f32>,
}

struct CachedPromptMask {
    key: String,
    mask: GrayImage,
}

impl SamEngine {
    pub fn new(paths: &SamModelPaths) -> Result<Self, String> {
        let _ = ort::init().with_name("Clearcut SAM Worker").commit();
        let threads = std::thread::available_parallelism()
            .map(|value| value.get().clamp(1, 8))
            .unwrap_or(2);
        let open = |path: &Path| {
            Session::builder()
                .map_err(|error| format!("SAM ONNX session builder를 만들지 못했습니다: {error}"))?
                .with_optimization_level(GraphOptimizationLevel::All)
                .map_err(|error| format!("SAM ONNX 최적화 설정에 실패했습니다: {error}"))?
                .with_intra_threads(threads)
                .map_err(|error| format!("SAM ONNX thread 설정에 실패했습니다: {error}"))?
                .commit_from_file(path)
                .map_err(|error| format!("SAM ONNX 모델을 열지 못했습니다: {error}"))
        };
        Ok(Self {
            encoder: open(&paths.encoder)?,
            decoder: open(&paths.decoder)?,
            paths: paths.clone(),
            cached_embedding: None,
            cached_preview_mask: None,
        })
    }

    pub fn uses_models(&self, encoder: &Path, decoder: &Path) -> bool {
        self.paths.encoder == encoder && self.paths.decoder == decoder
    }

    pub fn process(&mut self, request: &WorkerRequest) -> Result<u64, String> {
        let input_path = Path::new(&request.input_path);
        let source = engine::load_oriented_rotated(input_path, request.rotation)?;
        let mask = self.predict_mask(
            &source,
            &request.mask_recipe,
            Some(cache_key(input_path, request.rotation)),
        )?;
        engine::write_masked_output(
            source,
            mask,
            Path::new(&request.output_path),
            &request.settings,
        )
    }

    pub fn render_preview_bundle(
        &mut self,
        input_path: &Path,
        rotation: u16,
        recipe: &ManualMaskRecipe,
        settings: &OutputSettings,
    ) -> Result<(DynamicImage, DynamicImage), String> {
        let source = engine::load_oriented_rotated(input_path, rotation)?;
        let image_key = cache_key(input_path, rotation);
        let prompt_key = format!(
            "{image_key}:{}",
            serde_json::to_string(recipe)
                .map_err(|error| format!("SAM 프롬프트 키를 만들지 못했습니다: {error}"))?
        );
        let mask = if let Some(cached) = self
            .cached_preview_mask
            .as_ref()
            .filter(|cached| cached.key == prompt_key)
        {
            cached.mask.clone()
        } else {
            let mask = self.predict_mask(&source, recipe, Some(image_key))?;
            self.cached_preview_mask = Some(CachedPromptMask {
                key: prompt_key,
                mask: mask.clone(),
            });
            mask
        };
        Ok(engine::compose_preview_bundle(source, mask, settings))
    }

    fn predict_mask(
        &mut self,
        source: &DynamicImage,
        recipe: &ManualMaskRecipe,
        cache_key: Option<String>,
    ) -> Result<GrayImage, String> {
        let (pixels, resized_width, resized_height, scale) = prepare_image(source);
        let (image_embeddings, positional_embeddings) = if let Some(cached) = self
            .cached_embedding
            .as_ref()
            .filter(|cached| cache_key.as_deref() == Some(cached.key.as_str()))
        {
            (cached.image.clone(), cached.positional.clone())
        } else {
            let input = Tensor::from_array(([1_usize, 3, 1024, 1024], pixels))
                .map_err(|error| format!("SAM 이미지 tensor를 만들지 못했습니다: {error}"))?;
            let encoder_outputs = self
                .encoder
                .run(ort::inputs!["pixel_values" => input])
                .map_err(|error| format!("SAM 이미지 인코더 실행에 실패했습니다: {error}"))?;
            let image = encoder_outputs["image_embeddings"]
                .try_extract_array::<f32>()
                .map_err(|error| format!("SAM image embedding을 읽지 못했습니다: {error}"))?
                .iter()
                .copied()
                .collect::<Vec<_>>();
            let positional = encoder_outputs["image_positional_embeddings"]
                .try_extract_array::<f32>()
                .map_err(|error| format!("SAM positional embedding을 읽지 못했습니다: {error}"))?
                .iter()
                .copied()
                .collect::<Vec<_>>();
            drop(encoder_outputs);
            if let Some(key) = cache_key {
                self.cached_embedding = Some(CachedEmbedding {
                    key,
                    image: image.clone(),
                    positional: positional.clone(),
                });
            }
            (image, positional)
        };

        let (points, labels) = prompt_points(recipe, source.dimensions(), scale)?;
        let point_count = labels.len();
        let points = Tensor::from_array(([1_usize, 1, point_count, 2], points))
            .map_err(|error| format!("SAM point tensor를 만들지 못했습니다: {error}"))?;
        let labels = Tensor::from_array(([1_usize, 1, point_count], labels))
            .map_err(|error| format!("SAM label tensor를 만들지 못했습니다: {error}"))?;
        let image_embeddings = Tensor::from_array(([1_usize, 256, 64, 64], image_embeddings))
            .map_err(|error| format!("SAM embedding tensor를 만들지 못했습니다: {error}"))?;
        let positional_embeddings =
            Tensor::from_array(([1_usize, 256, 64, 64], positional_embeddings))
                .map_err(|error| format!("SAM positional tensor를 만들지 못했습니다: {error}"))?;
        let outputs = self
            .decoder
            .run(ort::inputs![
                "input_points" => points,
                "input_labels" => labels,
                "image_embeddings" => image_embeddings,
                "image_positional_embeddings" => positional_embeddings,
            ])
            .map_err(|error| format!("SAM prompt decoder 실행에 실패했습니다: {error}"))?;
        let scores = outputs["iou_scores"]
            .try_extract_array::<f32>()
            .map_err(|error| format!("SAM mask score를 읽지 못했습니다: {error}"))?;
        let best = scores
            .iter()
            .take(3)
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1))
            .map(|(index, _)| index)
            .ok_or_else(|| "SAM mask 후보가 없습니다.".to_owned())?;
        let masks = outputs["pred_masks"]
            .try_extract_array::<f32>()
            .map_err(|error| format!("SAM mask를 읽지 못했습니다: {error}"))?;
        let values = masks.iter().copied().collect::<Vec<_>>();
        let mask_offset = best * (MASK_SIZE * MASK_SIZE) as usize;
        let valid_width = ((resized_width as f32 / 4.0).ceil() as u32).clamp(1, MASK_SIZE);
        let valid_height = ((resized_height as f32 / 4.0).ceil() as u32).clamp(1, MASK_SIZE);
        let mut cropped = GrayImage::new(valid_width, valid_height);
        for y in 0..valid_height {
            for x in 0..valid_width {
                let index = mask_offset + (y * MASK_SIZE + x) as usize;
                let alpha = if values.get(index).copied().unwrap_or(-1.0) > 0.0 {
                    255
                } else {
                    0
                };
                cropped.put_pixel(x, y, image::Luma([alpha]));
            }
        }
        Ok(image::imageops::resize(
            &cropped,
            source.width(),
            source.height(),
            ResizeFilter::Lanczos3,
        ))
    }
}

fn cache_key(path: &Path, rotation: u16) -> String {
    let metadata = path.metadata().ok();
    let length = metadata
        .as_ref()
        .map(|value| value.len())
        .unwrap_or_default();
    let modified = metadata
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    format!("{}|{rotation}|{length}|{modified}", path.to_string_lossy())
}

fn prepare_image(source: &DynamicImage) -> (Vec<f32>, u32, u32, f32) {
    let (width, height) = source.dimensions();
    let scale = IMAGE_SIZE as f32 / width.max(height).max(1) as f32;
    let resized_width = (width as f32 * scale).round().clamp(1.0, IMAGE_SIZE as f32) as u32;
    let resized_height = (height as f32 * scale)
        .round()
        .clamp(1.0, IMAGE_SIZE as f32) as u32;
    let resized = source
        .resize_exact(resized_width, resized_height, ResizeFilter::CatmullRom)
        .to_rgb8();
    let plane = (IMAGE_SIZE * IMAGE_SIZE) as usize;
    let mut pixels = vec![0.0_f32; plane * 3];
    for (x, y, pixel) in resized.enumerate_pixels() {
        let index = (y * IMAGE_SIZE + x) as usize;
        for channel in 0..3 {
            pixels[channel * plane + index] =
                (f32::from(pixel[channel]) / 255.0 - MEAN[channel]) / STD[channel];
        }
    }
    (pixels, resized_width, resized_height, scale)
}

fn prompt_points(
    recipe: &ManualMaskRecipe,
    source_size: (u32, u32),
    scale: f32,
) -> Result<(Vec<f32>, Vec<i64>), String> {
    let mut points = Vec::new();
    let mut labels = Vec::new();
    for stroke in &recipe.strokes {
        if stroke.points.is_empty() {
            continue;
        }
        let stride = stroke.points.len().div_ceil(8).max(1);
        for point in stroke.points.iter().step_by(stride) {
            if labels.len() >= 64 {
                break;
            }
            points.push(point.x * source_size.0.saturating_sub(1) as f32 * scale);
            points.push(point.y * source_size.1.saturating_sub(1) as f32 * scale);
            labels.push(if matches!(stroke.mode, BrushMode::Keep) {
                1
            } else {
                0
            });
        }
    }
    if !labels.iter().any(|label| *label == 1) {
        return Err("AI 객체 선택에서는 유지할 객체를 초록색으로 먼저 표시해주세요.".to_owned());
    }
    Ok((points, labels))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BrushStroke, MaskMode, MaskPoint};

    #[test]
    fn cached_slimsam_models_match_the_pinned_manifest() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("models")
            .join("cache")
            .join("slimsam");
        if directory.is_dir() {
            verify_model(
                &directory.join(ENCODER_NAME),
                ENCODER_BYTES,
                ENCODER_SHA256,
                "이미지 인코더",
            )
            .expect("cached SlimSAM encoder must match manifest");
            verify_model(
                &directory.join(DECODER_NAME),
                DECODER_BYTES,
                DECODER_SHA256,
                "프롬프트 디코더",
            )
            .expect("cached SlimSAM decoder must match manifest");
        }
    }

    #[test]
    fn cached_slimsam_runs_a_prompted_mask_smoke_test() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("models")
            .join("cache")
            .join("slimsam");
        if !directory.is_dir() {
            return;
        }
        let paths = SamModelPaths {
            encoder: directory.join(ENCODER_NAME),
            decoder: directory.join(DECODER_NAME),
        };
        let source = image::open(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("icons")
                .join("icon.png"),
        )
        .expect("open icon fixture");
        let recipe = ManualMaskRecipe {
            mode: MaskMode::Sam,
            strokes: vec![BrushStroke {
                mode: BrushMode::Keep,
                radius: 0.03,
                points: vec![MaskPoint { x: 0.5, y: 0.5 }],
            }],
        };
        let mut engine = SamEngine::new(&paths).expect("open cached SlimSAM");
        let mask = engine
            .predict_mask(&source, &recipe, Some("icon-fixture".to_owned()))
            .expect("run SlimSAM prompt");
        let cached_mask = engine
            .predict_mask(&source, &recipe, Some("icon-fixture".to_owned()))
            .expect("reuse SlimSAM image embedding");
        assert_eq!(mask.dimensions(), source.dimensions());
        assert_eq!(mask, cached_mask);
        assert!(
            mask.pixels().any(|pixel| pixel[0] > 0),
            "prompted mask must contain foreground"
        );
    }
}
