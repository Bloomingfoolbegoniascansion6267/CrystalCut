use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    imageops::FilterType as ResizeFilter,
    DynamicImage, ExtendedColorType, GenericImageView, GrayImage, ImageEncoder, RgbaImage,
};
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};

use crate::protocol::{OutputFormat, OutputSettings, ResizeMode, WorkerRequest};

const INPUT_WIDTH: u32 = 320;
const INPUT_HEIGHT: u32 = 320;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

pub struct InferenceEngine {
    session: Session,
    model_path: PathBuf,
}

impl InferenceEngine {
    pub fn new(model_path: &Path) -> Result<Self, String> {
        let _ = ort::init().with_name("Clearcut AI Worker").commit();
        let threads = std::thread::available_parallelism()
            .map(|value| value.get().clamp(1, 8))
            .unwrap_or(2);
        let session = Session::builder()
            .map_err(|error| format!("ONNX session builder를 만들지 못했습니다: {error}"))?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(|error| format!("ONNX 최적화 설정에 실패했습니다: {error}"))?
            .with_intra_threads(threads)
            .map_err(|error| format!("ONNX thread 설정에 실패했습니다: {error}"))?
            .commit_from_file(model_path)
            .map_err(|error| format!("ONNX 모델을 열지 못했습니다: {error}"))?;

        Ok(Self {
            session,
            model_path: model_path.to_owned(),
        })
    }

    pub fn uses_model(&self, model_path: &Path) -> bool {
        self.model_path == model_path
    }

    pub fn process(&mut self, request: &WorkerRequest) -> Result<u64, String> {
        let input_path = Path::new(&request.input_path);
        let output_path = Path::new(&request.output_path);
        if output_path.exists() {
            return Err("안전을 위해 기존 출력 파일을 덮어쓰지 않았습니다.".to_owned());
        }

        let source = image::open(input_path)
            .map_err(|error| format!("입력 이미지를 열지 못했습니다: {error}"))?;
        let mask = self.infer_mask(&source)?;
        let mut composed = apply_alpha(source, &mask);
        composed = rotate(composed, request.rotation)?;
        composed = resize(composed, &request.settings);
        let encoded = encode(&composed, &request.settings)?;
        atomic_write(output_path, &encoded)?;
        Ok(encoded.len() as u64)
    }

    fn infer_mask(&mut self, source: &DynamicImage) -> Result<GrayImage, String> {
        let plane = (INPUT_WIDTH * INPUT_HEIGHT) as usize;
        let input = prepare_input(source);

        let tensor = Tensor::from_array((
            [1_usize, 3, INPUT_HEIGHT as usize, INPUT_WIDTH as usize],
            input,
        ))
        .map_err(|error| format!("ONNX 입력 tensor를 만들지 못했습니다: {error}"))?;
        let outputs = self
            .session
            .run(ort::inputs![tensor])
            .map_err(|error| format!("배경 제거 추론에 실패했습니다: {error}"))?;
        let output = outputs[0]
            .try_extract_array::<f32>()
            .map_err(|error| format!("ONNX 출력 mask를 읽지 못했습니다: {error}"))?;
        let shape = output.shape();
        if shape != [1, 1, INPUT_HEIGHT as usize, INPUT_WIDTH as usize] {
            return Err(format!("지원하지 않는 ONNX mask shape입니다: {shape:?}"));
        }
        let raw = output.iter().copied().take(plane).collect::<Vec<_>>();
        if raw.len() != plane {
            return Err(format!("ONNX mask 크기가 올바르지 않습니다: {}", raw.len()));
        }

        let min = raw.iter().copied().fold(f32::INFINITY, f32::min);
        let max = raw.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let range = (max - min).max(f32::EPSILON);
        let pixels = raw
            .into_iter()
            .map(|value| (((value - min) / range).clamp(0.0, 1.0) * 255.0).round() as u8)
            .collect::<Vec<_>>();
        let small_mask = GrayImage::from_raw(INPUT_WIDTH, INPUT_HEIGHT, pixels)
            .ok_or_else(|| "ONNX mask 이미지를 만들지 못했습니다.".to_owned())?;
        Ok(image::imageops::resize(
            &small_mask,
            source.width(),
            source.height(),
            ResizeFilter::Lanczos3,
        ))
    }
}

fn prepare_input(source: &DynamicImage) -> Vec<f32> {
    let resized = source
        .resize_exact(INPUT_WIDTH, INPUT_HEIGHT, ResizeFilter::Lanczos3)
        .to_rgb8();
    let plane = (INPUT_WIDTH * INPUT_HEIGHT) as usize;
    let mut input = vec![0.0_f32; plane * 3];
    let image_max = resized
        .pixels()
        .flat_map(|pixel| pixel.0)
        .max()
        .map(f32::from)
        .unwrap_or(1.0)
        .max(f32::EPSILON);

    for (index, pixel) in resized.pixels().enumerate() {
        for channel in 0..3 {
            input[channel * plane + index] =
                (f32::from(pixel[channel]) / image_max - MEAN[channel]) / STD[channel];
        }
    }
    input
}

fn apply_alpha(source: DynamicImage, mask: &GrayImage) -> DynamicImage {
    let mut rgba = source.to_rgba8();
    for (pixel, alpha) in rgba.pixels_mut().zip(mask.pixels()) {
        pixel[3] = ((u16::from(pixel[3]) * u16::from(alpha[0])) / 255) as u8;
    }
    DynamicImage::ImageRgba8(rgba)
}

fn rotate(image: DynamicImage, rotation: u16) -> Result<DynamicImage, String> {
    match rotation % 360 {
        0 => Ok(image),
        90 => Ok(image.rotate90()),
        180 => Ok(image.rotate180()),
        270 => Ok(image.rotate270()),
        value => Err(format!("지원하지 않는 회전 각도입니다: {value}")),
    }
}

fn resize(image: DynamicImage, settings: &OutputSettings) -> DynamicImage {
    let (width, height) = image.dimensions();
    let target = match settings.resize_mode {
        ResizeMode::Original => return image,
        ResizeMode::Percent => {
            let scale = settings.resize_value as f64 / 100.0;
            (
                (f64::from(width) * scale).round().max(1.0) as u32,
                (f64::from(height) * scale).round().max(1.0) as u32,
            )
        }
        ResizeMode::LongEdge => {
            let long_edge = width.max(height);
            if settings.prevent_upscale && long_edge <= settings.resize_value {
                return image;
            }
            let scale = settings.resize_value as f64 / f64::from(long_edge);
            (
                (f64::from(width) * scale).round().max(1.0) as u32,
                (f64::from(height) * scale).round().max(1.0) as u32,
            )
        }
    };

    if settings.prevent_upscale && (target.0 > width || target.1 > height) {
        image
    } else {
        image.resize_exact(target.0, target.1, ResizeFilter::Lanczos3)
    }
}

fn encode(image: &DynamicImage, settings: &OutputSettings) -> Result<Vec<u8>, String> {
    let rgba: RgbaImage = image.to_rgba8();
    match settings.format {
        OutputFormat::Png => {
            let compression = match settings.png_effort {
                1..=3 => CompressionType::Fast,
                8..=9 => CompressionType::Best,
                _ => CompressionType::Default,
            };
            let mut encoded = Vec::new();
            PngEncoder::new_with_quality(&mut encoded, compression, FilterType::Adaptive)
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|error| format!("PNG를 인코딩하지 못했습니다: {error}"))?;
            Ok(encoded)
        }
        OutputFormat::Webp => {
            let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
            let encoded = if settings.webp_lossless {
                encoder.encode_lossless()
            } else {
                encoder.encode(f32::from(settings.webp_quality))
            };
            Ok(encoded.to_vec())
        }
    }
}

fn atomic_write(output_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = output_path
        .parent()
        .ok_or_else(|| "출력 폴더를 계산하지 못했습니다.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("출력 폴더를 만들지 못했습니다: {error}"))?;
    let partial_path = PathBuf::from(format!("{}.partial", output_path.to_string_lossy()));

    let result = (|| {
        let mut file = File::create(&partial_path)
            .map_err(|error| format!("임시 출력 파일을 만들지 못했습니다: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("결과를 저장하지 못했습니다: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("결과를 디스크에 반영하지 못했습니다: {error}"))?;
        drop(file);
        fs::rename(&partial_path, output_path)
            .map_err(|error| format!("결과 파일을 확정하지 못했습니다: {error}"))
    })();

    if result.is_err() {
        let _ = fs::remove_file(partial_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: ResizeMode, value: u32, prevent_upscale: bool) -> OutputSettings {
        OutputSettings {
            format: OutputFormat::Png,
            webp_quality: 82,
            webp_lossless: false,
            png_effort: 6,
            resize_mode: mode,
            resize_value: value,
            prevent_upscale,
            output_location: crate::protocol::OutputLocation::SameFolder,
            output_directory: String::new(),
            prefix: String::new(),
            suffix: "_bg".to_owned(),
        }
    }

    #[test]
    fn long_edge_resize_preserves_aspect_ratio() {
        let source = DynamicImage::new_rgba8(400, 200);
        let resized = resize(source, &settings(ResizeMode::LongEdge, 100, true));
        assert_eq!(resized.dimensions(), (100, 50));
    }

    #[test]
    fn prevent_upscale_keeps_small_images_unchanged() {
        let source = DynamicImage::new_rgba8(80, 40);
        let resized = resize(source, &settings(ResizeMode::LongEdge, 100, true));
        assert_eq!(resized.dimensions(), (80, 40));
    }

    #[test]
    fn alpha_is_multiplied_instead_of_discarding_existing_transparency() {
        let mut source = RgbaImage::new(1, 1);
        source.get_pixel_mut(0, 0)[3] = 128;
        let mask = GrayImage::from_pixel(1, 1, image::Luma([128]));
        let result = apply_alpha(DynamicImage::ImageRgba8(source), &mask).to_rgba8();
        assert_eq!(result.get_pixel(0, 0)[3], 64);
    }

    #[test]
    fn model_input_uses_image_max_and_channel_first_layout() {
        let source =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([100, 50, 25])));
        let input = prepare_input(&source);
        let plane = (INPUT_WIDTH * INPUT_HEIGHT) as usize;

        let expected = [
            (1.0 - MEAN[0]) / STD[0],
            (0.5 - MEAN[1]) / STD[1],
            (0.25 - MEAN[2]) / STD[2],
        ];
        for channel in 0..3 {
            assert!((input[channel * plane] - expected[channel]).abs() < 1.0e-5);
        }
    }
}
