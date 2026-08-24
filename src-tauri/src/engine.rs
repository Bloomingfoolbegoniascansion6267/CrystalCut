use std::{
    collections::VecDeque,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    imageops::FilterType as ResizeFilter,
    DynamicImage, ExtendedColorType, GenericImageView, GrayImage, ImageEncoder, RgbaImage,
};
use ort::{session::Session, value::Tensor};

use crate::{
    compute::{self, ComputePreference, ComputeRuntimeStatus},
    metadata,
    protocol::{
        BrushMode, BrushStroke, EdgeSettings, ManualMaskRecipe, MaskMode, OutputFormat,
        OutputSettings, ResizeMode, WorkerRequest,
    },
};

const INPUT_WIDTH: u32 = 320;
const INPUT_HEIGHT: u32 = 320;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];
const PREVIEW_MASK_CACHE_MAX_ENTRIES: usize = 8;
const PREVIEW_MASK_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024;

pub struct InferenceEngine {
    session: Session,
    model_path: PathBuf,
    compute: ComputePreference,
    compute_status: ComputeRuntimeStatus,
    cached_preview_masks: VecDeque<CachedPreviewMask>,
    cached_preview_mask_bytes: usize,
}

struct CachedPreviewMask {
    path: PathBuf,
    width: u32,
    height: u32,
    file_bytes: u64,
    modified_nanos: u128,
    mask: GrayImage,
}

impl InferenceEngine {
    pub fn new(model_path: &Path, compute: &ComputePreference) -> Result<Self, String> {
        let outcome = compute::open_session(model_path, compute)?;

        Ok(Self {
            session: outcome.session,
            model_path: model_path.to_owned(),
            compute: compute.clone(),
            compute_status: outcome.status,
            cached_preview_masks: VecDeque::new(),
            cached_preview_mask_bytes: 0,
        })
    }

    pub fn uses_configuration(&self, model_path: &Path, compute: &ComputePreference) -> bool {
        self.model_path == model_path && self.compute == *compute
    }

    pub fn compute_status(&self) -> &ComputeRuntimeStatus {
        &self.compute_status
    }

    pub fn process(&mut self, request: &WorkerRequest) -> Result<u64, String> {
        let input_path = Path::new(&request.input_path);
        let output_path = Path::new(&request.output_path);
        validate_output_extension(output_path, request.settings.format)?;
        if output_path.exists() {
            return Err("안전을 위해 기존 출력 파일을 덮어쓰지 않았습니다.".to_owned());
        }

        let mut source = image::open(input_path)
            .map_err(|error| format!("입력 이미지를 열지 못했습니다: {error}"))?;
        let source_metadata = metadata::read_exif_summary(input_path);
        metadata::apply_orientation(&mut source, source_metadata.orientation);
        let mask = self.infer_mask(&source)?;
        let source = rotate(source, request.rotation)?;
        let mask = rotate_mask(mask, request.rotation)?;
        let mask = apply_manual_mask(mask, &request.mask_recipe);
        let mask = refine_mask(mask, &request.edge_settings);
        let mut composed =
            apply_alpha(source, &mask, request.edge_settings.preserve_original_alpha);
        composed = resize(composed, &request.settings);
        let output_metadata = request.metadata.as_ref().unwrap_or(&source_metadata);
        let encoded = encode(&composed, &request.settings, Some(output_metadata))?;
        atomic_write(output_path, &encoded)?;
        Ok(encoded.len() as u64)
    }

    pub fn render_preview_bundle(
        &mut self,
        input_path: &Path,
        rotation: u16,
        recipe: &ManualMaskRecipe,
        settings: &OutputSettings,
        edge_settings: &EdgeSettings,
    ) -> Result<(DynamicImage, DynamicImage), String> {
        let mut source = image::open(input_path)
            .map_err(|error| format!("입력 이미지를 열지 못했습니다: {error}"))?;
        let exif = metadata::read_exif_summary(input_path);
        metadata::apply_orientation(&mut source, exif.orientation);
        let file_metadata = fs::metadata(input_path).ok();
        let file_bytes = file_metadata.as_ref().map_or(0, std::fs::Metadata::len);
        let modified_nanos = file_metadata
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_nanos());
        let cached_index = self.cached_preview_masks.iter().position(|cached| {
            cached.path == input_path
                && cached.width == source.width()
                && cached.height == source.height()
                && cached.file_bytes == file_bytes
                && cached.modified_nanos == modified_nanos
        });
        let mask = if let Some(index) = cached_index {
            let cached = self
                .cached_preview_masks
                .remove(index)
                .expect("preview mask cache index must remain valid");
            let mask = cached.mask.clone();
            self.cached_preview_masks.push_back(cached);
            mask
        } else {
            let mask = self.infer_mask(&source)?;
            self.cache_preview_mask(CachedPreviewMask {
                path: input_path.to_owned(),
                width: source.width(),
                height: source.height(),
                file_bytes,
                modified_nanos,
                mask: mask.clone(),
            });
            mask
        };
        let source = rotate(source, rotation)?;
        let mask = rotate_mask(mask, rotation)?;
        let mask = apply_manual_mask(mask, recipe);
        Ok(compose_preview_bundle(
            source,
            mask,
            settings,
            edge_settings,
        ))
    }

    fn cache_preview_mask(&mut self, cached: CachedPreviewMask) {
        let bytes = cached.mask.as_raw().len();
        if bytes > PREVIEW_MASK_CACHE_MAX_BYTES {
            return;
        }
        while self.cached_preview_masks.len() >= PREVIEW_MASK_CACHE_MAX_ENTRIES
            || self.cached_preview_mask_bytes.saturating_add(bytes) > PREVIEW_MASK_CACHE_MAX_BYTES
        {
            let Some(evicted) = self.cached_preview_masks.pop_front() else {
                break;
            };
            self.cached_preview_mask_bytes = self
                .cached_preview_mask_bytes
                .saturating_sub(evicted.mask.as_raw().len());
        }
        self.cached_preview_mask_bytes = self.cached_preview_mask_bytes.saturating_add(bytes);
        self.cached_preview_masks.push_back(cached);
    }

    fn infer_mask(&mut self, source: &DynamicImage) -> Result<GrayImage, String> {
        let plane = (INPUT_WIDTH * INPUT_HEIGHT) as usize;
        let raw = match Self::run_mask_session(&mut self.session, prepare_input(source), plane) {
            Ok(raw) => raw,
            Err(accelerator_error)
                if !matches!(
                    self.compute_status.effective_mode,
                    crate::compute::ComputeMode::Cpu
                ) =>
            {
                let outcome = compute::open_cpu_fallback(
                    &self.model_path,
                    &self.compute,
                    format!("accelerated inference failed: {accelerator_error}"),
                )?;
                self.session = outcome.session;
                self.compute_status = outcome.status;
                Self::run_mask_session(&mut self.session, prepare_input(source), plane)?
            }
            Err(error) => return Err(error),
        };

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

    fn run_mask_session(
        session: &mut Session,
        input: Vec<f32>,
        plane: usize,
    ) -> Result<Vec<f32>, String> {
        let tensor = Tensor::from_array((
            [1_usize, 3, INPUT_HEIGHT as usize, INPUT_WIDTH as usize],
            input,
        ))
        .map_err(|error| format!("ONNX 입력 tensor를 만들지 못했습니다: {error}"))?;
        let outputs = session
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
        Ok(raw)
    }
}

pub(crate) fn process_conversion(request: &WorkerRequest) -> Result<u64, String> {
    let input_path = Path::new(&request.input_path);
    let output_path = Path::new(&request.output_path);
    validate_output_extension(output_path, request.settings.format)?;
    if output_path.exists() {
        return Err("안전을 위해 기존 출력 파일을 덮어쓰지 않았습니다.".to_owned());
    }
    let source_metadata = metadata::read_exif_summary(input_path);
    let source = load_oriented_rotated(input_path, request.rotation)?;
    let converted = resize(source, &request.settings);
    let output_metadata = request.metadata.as_ref().unwrap_or(&source_metadata);
    let encoded = encode(&converted, &request.settings, Some(output_metadata))?;
    atomic_write(output_path, &encoded)?;
    Ok(encoded.len() as u64)
}

pub(crate) fn load_oriented_rotated(
    input_path: &Path,
    rotation: u16,
) -> Result<DynamicImage, String> {
    let mut source = image::open(input_path)
        .map_err(|error| format!("입력 이미지를 열지 못했습니다: {error}"))?;
    let exif = metadata::read_exif_summary(input_path);
    metadata::apply_orientation(&mut source, exif.orientation);
    rotate(source, rotation)
}

pub(crate) fn compose_with_mask(
    source: DynamicImage,
    mask: GrayImage,
    settings: &OutputSettings,
    edge_settings: &EdgeSettings,
) -> DynamicImage {
    let mask = refine_mask(mask, edge_settings);
    let composed = apply_alpha(source, &mask, edge_settings.preserve_original_alpha);
    resize(composed, settings)
}

pub(crate) fn compose_preview_bundle(
    source: DynamicImage,
    mask: GrayImage,
    settings: &OutputSettings,
    edge_settings: &EdgeSettings,
) -> (DynamicImage, DynamicImage) {
    let mask = refine_mask(mask, edge_settings);
    let composed = resize(
        apply_alpha(source, &mask, edge_settings.preserve_original_alpha),
        settings,
    );
    let mask_preview = resize(DynamicImage::ImageLuma8(mask), settings);
    (composed, mask_preview)
}

pub(crate) fn write_masked_output(
    source: DynamicImage,
    mask: GrayImage,
    output_path: &Path,
    settings: &OutputSettings,
    edge_settings: &EdgeSettings,
    source_metadata: Option<&metadata::ExifSummary>,
) -> Result<u64, String> {
    validate_output_extension(output_path, settings.format)?;
    if output_path.exists() {
        return Err("안전을 위해 기존 출력 파일을 덮어쓰지 않았습니다.".to_owned());
    }
    let composed = compose_with_mask(source, mask, settings, edge_settings);
    let encoded = encode(&composed, settings, source_metadata)?;
    atomic_write(output_path, &encoded)?;
    Ok(encoded.len() as u64)
}

fn validate_output_extension(path: &Path, format: OutputFormat) -> Result<(), String> {
    let actual = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if actual.as_deref() != Some(format.extension()) {
        return Err(format!(
            "출력 형식과 파일 확장자가 다릅니다: 형식={}, 경로={}",
            format.extension(),
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn estimate_output_size(
    input_path: &Path,
    rotation: u16,
    settings: &OutputSettings,
) -> Result<u64, String> {
    const MAX_ESTIMATE_EDGE: u32 = 1200;

    let mut source = image::open(input_path)
        .map_err(|error| format!("예상 용량용 이미지를 열지 못했습니다: {error}"))?;
    let exif = metadata::read_exif_summary(input_path);
    metadata::apply_orientation(&mut source, exif.orientation);
    let source = rotate(source, rotation)?;
    let (width, height) = source.dimensions();
    let (target_width, target_height) = target_dimensions(width, height, settings);
    let target_long_edge = target_width.max(target_height);
    let sample_scale = if target_long_edge > MAX_ESTIMATE_EDGE {
        f64::from(MAX_ESTIMATE_EDGE) / f64::from(target_long_edge)
    } else {
        1.0
    };
    let sample_width = (f64::from(target_width) * sample_scale).round().max(1.0) as u32;
    let sample_height = (f64::from(target_height) * sample_scale).round().max(1.0) as u32;
    let sample = source.resize_exact(sample_width, sample_height, ResizeFilter::Lanczos3);
    let mut sample_settings = settings.clone();
    sample_settings.resize_mode = ResizeMode::Original;
    let sample_metadata = metadata::read_exif_summary(input_path);
    let sample_bytes = encode(&sample, &sample_settings, Some(&sample_metadata))?.len() as f64;
    let sample_pixels = f64::from(sample_width) * f64::from(sample_height);
    let target_pixels = f64::from(target_width) * f64::from(target_height);
    Ok((sample_bytes * target_pixels / sample_pixels).round() as u64)
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

fn apply_alpha(
    source: DynamicImage,
    mask: &GrayImage,
    preserve_original_alpha: bool,
) -> DynamicImage {
    let mut rgba = source.to_rgba8();
    for (pixel, alpha) in rgba.pixels_mut().zip(mask.pixels()) {
        pixel[3] = if preserve_original_alpha {
            ((u16::from(pixel[3]) * u16::from(alpha[0])) / 255) as u8
        } else {
            alpha[0]
        };
    }
    DynamicImage::ImageRgba8(rgba)
}

fn rotate_mask(mask: GrayImage, rotation: u16) -> Result<GrayImage, String> {
    match rotation % 360 {
        0 => Ok(mask),
        90 => Ok(image::imageops::rotate90(&mask)),
        180 => Ok(image::imageops::rotate180(&mask)),
        270 => Ok(image::imageops::rotate270(&mask)),
        value => Err(format!("지원하지 않는 회전 각도입니다: {value}")),
    }
}

fn apply_manual_mask(mut inferred: GrayImage, recipe: &ManualMaskRecipe) -> GrayImage {
    if matches!(recipe.mode, MaskMode::Automatic) {
        return inferred;
    }
    if matches!(recipe.mode, MaskMode::Manual) {
        inferred.fill(0);
    }
    for stroke in &recipe.strokes {
        paint_stroke(&mut inferred, stroke);
    }
    inferred
}

fn paint_stroke(mask: &mut GrayImage, stroke: &BrushStroke) {
    if stroke.points.is_empty() {
        return;
    }
    let width = mask.width();
    let height = mask.height();
    let minimum_edge = width.min(height).max(1) as f32;
    let radius = (stroke.radius * minimum_edge)
        .round()
        .clamp(1.0, minimum_edge * 0.5) as i32;
    let value = if matches!(stroke.mode, BrushMode::Keep) {
        255
    } else {
        0
    };
    let to_pixel = |point: crate::protocol::MaskPoint| {
        (
            point.x.clamp(0.0, 1.0) * width.saturating_sub(1) as f32,
            point.y.clamp(0.0, 1.0) * height.saturating_sub(1) as f32,
        )
    };
    let mut previous = to_pixel(stroke.points[0]);
    draw_disc(
        mask,
        previous.0.round() as i32,
        previous.1.round() as i32,
        radius,
        value,
    );
    for point in stroke.points.iter().copied().skip(1) {
        let current = to_pixel(point);
        let distance = (current.0 - previous.0).hypot(current.1 - previous.1);
        let steps = (distance / (radius as f32 * 0.45).max(1.0)).ceil().max(1.0) as usize;
        for step in 1..=steps {
            let ratio = step as f32 / steps as f32;
            let x = previous.0 + (current.0 - previous.0) * ratio;
            let y = previous.1 + (current.1 - previous.1) * ratio;
            draw_disc(mask, x.round() as i32, y.round() as i32, radius, value);
        }
        previous = current;
    }
}

fn draw_disc(mask: &mut GrayImage, center_x: i32, center_y: i32, radius: i32, value: u8) {
    let radius_squared = radius * radius;
    let minimum_x = (center_x - radius).max(0);
    let maximum_x = (center_x + radius).min(mask.width() as i32 - 1);
    let minimum_y = (center_y - radius).max(0);
    let maximum_y = (center_y + radius).min(mask.height() as i32 - 1);
    for y in minimum_y..=maximum_y {
        for x in minimum_x..=maximum_x {
            let dx = x - center_x;
            let dy = y - center_y;
            if dx * dx + dy * dy <= radius_squared {
                mask.get_pixel_mut(x as u32, y as u32)[0] = value;
            }
        }
    }
}

fn refine_mask(mut mask: GrayImage, settings: &EdgeSettings) -> GrayImage {
    if settings.edge_shift != 0 {
        mask = shift_mask(mask, settings.edge_shift);
    }
    if settings.edge_smoothing > 0 {
        mask = image::imageops::blur(&mask, f32::from(settings.edge_smoothing) * 0.38);
        for alpha in mask.pixels_mut() {
            let value = f32::from(alpha[0]) / 255.0;
            alpha[0] = (value * value * (3.0 - 2.0 * value) * 255.0).round() as u8;
        }
    }
    if settings.alpha_threshold > 0 {
        let cutoff = u16::from(settings.alpha_threshold) * 255 / 100;
        for alpha in mask.pixels_mut() {
            let value = u16::from(alpha[0]);
            alpha[0] = if value <= cutoff {
                0
            } else {
                (((value - cutoff) * 255) / (255 - cutoff).max(1)) as u8
            };
        }
    }
    if settings.mask_contrast != 0 {
        let contrast = f32::from(settings.mask_contrast);
        let factor = (100.0 + contrast) / (100.0 - contrast);
        for alpha in mask.pixels_mut() {
            alpha[0] = ((f32::from(alpha[0]) - 127.5) * factor + 127.5)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }
    if settings.edge_feather > 0 {
        mask = image::imageops::blur(&mask, f32::from(settings.edge_feather) * 0.55);
    }
    mask
}

fn shift_mask(mask: GrayImage, amount: i8) -> GrayImage {
    let radius = amount.unsigned_abs() as usize;
    if radius == 0 {
        return mask;
    }
    let dilate = amount > 0;
    let width = mask.width() as usize;
    let height = mask.height() as usize;
    let source = mask.into_raw();
    let mut horizontal = vec![0_u8; source.len()];
    for y in 0..height {
        let row = &source[y * width..(y + 1) * width];
        let filtered = sliding_extreme(row, radius, dilate);
        horizontal[y * width..(y + 1) * width].copy_from_slice(&filtered);
    }
    let mut output = vec![0_u8; source.len()];
    let mut column = vec![0_u8; height];
    for x in 0..width {
        for y in 0..height {
            column[y] = horizontal[y * width + x];
        }
        let filtered = sliding_extreme(&column, radius, dilate);
        for y in 0..height {
            output[y * width + x] = filtered[y];
        }
    }
    GrayImage::from_raw(width as u32, height as u32, output).expect("mask dimensions are preserved")
}

fn sliding_extreme(values: &[u8], radius: usize, maximum: bool) -> Vec<u8> {
    let mut output = vec![0_u8; values.len()];
    let mut deque = VecDeque::<usize>::new();
    for cursor in 0..values.len().saturating_add(radius) {
        if cursor < values.len() {
            while let Some(&index) = deque.back() {
                let ordered = if maximum {
                    values[index] <= values[cursor]
                } else {
                    values[index] >= values[cursor]
                };
                if !ordered {
                    break;
                }
                deque.pop_back();
            }
            deque.push_back(cursor);
        }
        if cursor >= radius {
            let output_index = cursor - radius;
            if output_index >= values.len() {
                break;
            }
            let minimum_index = output_index.saturating_sub(radius);
            while deque.front().is_some_and(|index| *index < minimum_index) {
                deque.pop_front();
            }
            if let Some(&index) = deque.front() {
                output[output_index] = values[index];
            }
        }
    }
    output
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
    let target = target_dimensions(width, height, settings);
    if target == (width, height) {
        return image;
    }
    image.resize_exact(target.0, target.1, ResizeFilter::Lanczos3)
}

fn target_dimensions(width: u32, height: u32, settings: &OutputSettings) -> (u32, u32) {
    match settings.resize_mode {
        ResizeMode::Original => (width, height),
        ResizeMode::Percent => {
            let scale = settings.resize_value as f64 / 100.0;
            let target = (
                (f64::from(width) * scale).round().max(1.0) as u32,
                (f64::from(height) * scale).round().max(1.0) as u32,
            );
            if settings.prevent_upscale && (target.0 > width || target.1 > height) {
                (width, height)
            } else {
                target
            }
        }
        ResizeMode::LongEdge => {
            let long_edge = width.max(height);
            if settings.prevent_upscale && long_edge <= settings.resize_value {
                return (width, height);
            }
            scaled_dimensions(width, height, settings.resize_value, long_edge)
        }
        ResizeMode::Width => {
            if settings.prevent_upscale && width <= settings.resize_value {
                return (width, height);
            }
            scaled_dimensions(width, height, settings.resize_value, width)
        }
        ResizeMode::Height => {
            if settings.prevent_upscale && height <= settings.resize_value {
                return (width, height);
            }
            scaled_dimensions(width, height, settings.resize_value, height)
        }
    }
}

fn scaled_dimensions(width: u32, height: u32, target: u32, source_axis: u32) -> (u32, u32) {
    let requested_scale = f64::from(target) / f64::from(source_axis.max(1));
    let safe_scale = 32_768.0 / f64::from(width.max(height).max(1));
    let scale = requested_scale.min(safe_scale);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn encode(
    image: &DynamicImage,
    settings: &OutputSettings,
    source_metadata: Option<&metadata::ExifSummary>,
) -> Result<Vec<u8>, String> {
    let rgba: RgbaImage = image.to_rgba8();
    let has_alpha = rgba.pixels().any(|pixel| pixel[3] < 255);
    let mut encoded = match settings.format {
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
            encoded
        }
        OutputFormat::Webp => {
            let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
            let encoded = if settings.webp_lossless {
                encoder.encode_lossless()
            } else {
                encoder.encode(f32::from(settings.webp_quality))
            };
            encoded.to_vec()
        }
    };
    if settings.preserve_metadata {
        if let Some(profile) = source_metadata
            .map(|summary| {
                metadata::safe_exif_profile(
                    summary,
                    settings.preserve_gps,
                    settings.preserve_prompt,
                )
            })
            .transpose()?
            .flatten()
        {
            encoded = match settings.format {
                OutputFormat::Png => embed_png_exif(encoded, &profile)?,
                OutputFormat::Webp => {
                    embed_webp_exif(encoded, &profile, rgba.width(), rgba.height(), has_alpha)?
                }
            };
        }
    }
    Ok(encoded)
}

fn embed_png_exif(mut png: Vec<u8>, profile: &[u8]) -> Result<Vec<u8>, String> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !png.starts_with(SIGNATURE) || png.len() < 33 || &png[12..16] != b"IHDR" {
        return Err("PNG 메타데이터를 기록할 수 없는 파일 구조입니다.".to_owned());
    }
    let ihdr_length = u32::from_be_bytes(png[8..12].try_into().unwrap()) as usize;
    let insert_at = 8_usize
        .checked_add(12)
        .and_then(|value| value.checked_add(ihdr_length))
        .filter(|position| *position <= png.len())
        .ok_or_else(|| "PNG IHDR 크기가 올바르지 않습니다.".to_owned())?;
    let chunk = png_chunk(*b"eXIf", profile)?;
    png.splice(insert_at..insert_at, chunk);
    Ok(png)
}

fn png_chunk(kind: [u8; 4], data: &[u8]) -> Result<Vec<u8>, String> {
    let length = u32::try_from(data.len())
        .map_err(|_| "출력 EXIF가 PNG 청크 제한을 초과했습니다.".to_owned())?;
    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(&length.to_be_bytes());
    chunk.extend_from_slice(&kind);
    chunk.extend_from_slice(data);
    chunk.extend_from_slice(&png_crc32(&chunk[4..]).to_be_bytes());
    Ok(chunk)
}

fn png_crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn embed_webp_exif(
    webp: Vec<u8>,
    profile: &[u8],
    width: u32,
    height: u32,
    has_alpha: bool,
) -> Result<Vec<u8>, String> {
    if webp.len() < 12 || &webp[0..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
        return Err("WebP 메타데이터를 기록할 수 없는 파일 구조입니다.".to_owned());
    }
    let mut output = if webp.get(12..16) == Some(b"VP8X") {
        if webp.len() < 30 || u32::from_le_bytes(webp[16..20].try_into().unwrap()) < 10 {
            return Err("WebP VP8X 청크가 올바르지 않습니다.".to_owned());
        }
        let mut extended = webp;
        extended[20] |= 0x08;
        extended
    } else {
        let mut extended = Vec::with_capacity(webp.len() + profile.len() + 32);
        extended.extend_from_slice(b"RIFF\0\0\0\0WEBP");
        let mut vp8x = [0_u8; 10];
        vp8x[0] = 0x08 | if has_alpha { 0x10 } else { 0 };
        write_u24(&mut vp8x[4..7], width.saturating_sub(1));
        write_u24(&mut vp8x[7..10], height.saturating_sub(1));
        append_riff_chunk(&mut extended, *b"VP8X", &vp8x)?;
        extended.extend_from_slice(&webp[12..]);
        extended
    };
    append_riff_chunk(&mut output, *b"EXIF", profile)?;
    let riff_size = u32::try_from(output.len().saturating_sub(8))
        .map_err(|_| "메타데이터를 포함한 WebP가 RIFF 크기 제한을 초과했습니다.".to_owned())?;
    output[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(output)
}

fn append_riff_chunk(target: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) -> Result<(), String> {
    let length = u32::try_from(data.len())
        .map_err(|_| "출력 EXIF가 WebP 청크 제한을 초과했습니다.".to_owned())?;
    target.extend_from_slice(&kind);
    target.extend_from_slice(&length.to_le_bytes());
    target.extend_from_slice(data);
    if data.len() % 2 == 1 {
        target.push(0);
    }
    Ok(())
}

fn write_u24(target: &mut [u8], value: u32) {
    target[0] = value as u8;
    target[1] = (value >> 8) as u8;
    target[2] = (value >> 16) as u8;
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

    #[test]
    #[ignore = "requires the checked-in model and a working platform accelerator"]
    fn accelerated_u2net_inference_smoke_test() {
        let model = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("models")
            .join("cache")
            .join("u2netp.onnx");
        assert!(
            model.is_file(),
            "missing smoke-test model: {}",
            model.display()
        );
        let mut engine = InferenceEngine::new(&model, &ComputePreference::default())
            .expect("open accelerated U2NetP");
        assert!(!matches!(
            engine.compute_status().effective_mode,
            crate::compute::ComputeMode::Cpu
        ));
        let source = DynamicImage::new_rgb8(64, 48);
        let mask = engine.infer_mask(&source).expect("run accelerated U2NetP");
        assert_eq!(mask.dimensions(), source.dimensions());
    }

    fn settings(mode: ResizeMode, value: u32, prevent_upscale: bool) -> OutputSettings {
        OutputSettings {
            resize_mode: mode,
            resize_value: value,
            prevent_upscale,
            output_location: crate::protocol::OutputLocation::SameFolder,
            ..OutputSettings::default()
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
    fn width_resize_preserves_aspect_ratio() {
        assert_eq!(
            target_dimensions(4_000, 3_000, &settings(ResizeMode::Width, 1_200, true)),
            (1_200, 900)
        );
    }

    #[test]
    fn height_resize_preserves_aspect_ratio() {
        assert_eq!(
            target_dimensions(4_000, 3_000, &settings(ResizeMode::Height, 600, true)),
            (800, 600)
        );
    }

    #[test]
    fn axis_resize_respects_prevent_upscale() {
        assert_eq!(
            target_dimensions(800, 600, &settings(ResizeMode::Width, 1_200, true)),
            (800, 600)
        );
        assert_eq!(
            target_dimensions(800, 600, &settings(ResizeMode::Height, 900, false)),
            (1_200, 900)
        );
    }

    #[test]
    fn alpha_is_multiplied_instead_of_discarding_existing_transparency() {
        let mut source = RgbaImage::new(1, 1);
        source.get_pixel_mut(0, 0)[3] = 128;
        let mask = GrayImage::from_pixel(1, 1, image::Luma([128]));
        let result = apply_alpha(DynamicImage::ImageRgba8(source), &mask, true).to_rgba8();
        assert_eq!(result.get_pixel(0, 0)[3], 64);
    }

    #[test]
    fn replacing_alpha_is_available_for_advanced_workflows() {
        let mut source = RgbaImage::new(1, 1);
        source.get_pixel_mut(0, 0)[3] = 32;
        let mask = GrayImage::from_pixel(1, 1, image::Luma([192]));
        let result = apply_alpha(DynamicImage::ImageRgba8(source), &mask, false).to_rgba8();
        assert_eq!(result.get_pixel(0, 0)[3], 192);
    }

    #[test]
    fn preview_bundle_keeps_result_and_mask_at_matching_dimensions() {
        let source =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(8, 4, image::Rgba([120, 80, 40, 255])));
        let mask = GrayImage::from_pixel(8, 4, image::Luma([192]));
        let preview_settings = settings(ResizeMode::LongEdge, 4, true);
        let (result, mask_preview) =
            compose_preview_bundle(source, mask, &preview_settings, &EdgeSettings::default());

        assert_eq!(result.dimensions(), (4, 2));
        assert_eq!(mask_preview.dimensions(), result.dimensions());
        let result_alpha = result.to_rgba8().get_pixel(0, 0)[3];
        let mask_alpha = mask_preview.to_luma8().get_pixel(0, 0)[0];
        assert_eq!(result_alpha, mask_alpha);
        assert!(result_alpha > 0 && result_alpha < 255);
    }

    #[test]
    fn manual_keep_and_remove_strokes_override_the_mask() {
        let mask = GrayImage::from_pixel(20, 20, image::Luma([0]));
        let recipe = ManualMaskRecipe {
            mode: MaskMode::Manual,
            strokes: vec![
                BrushStroke {
                    mode: BrushMode::Keep,
                    radius: 0.2,
                    points: vec![crate::protocol::MaskPoint { x: 0.5, y: 0.5 }],
                },
                BrushStroke {
                    mode: BrushMode::Remove,
                    radius: 0.05,
                    points: vec![crate::protocol::MaskPoint { x: 0.5, y: 0.5 }],
                },
            ],
        };
        let result = apply_manual_mask(mask, &recipe);
        assert_eq!(result.get_pixel(10, 10)[0], 0);
        assert_eq!(result.get_pixel(8, 10)[0], 255);
        assert_eq!(result.get_pixel(0, 0)[0], 0);
    }

    #[test]
    fn positive_edge_shift_expands_the_foreground() {
        let mut mask = GrayImage::from_pixel(5, 5, image::Luma([0]));
        mask.get_pixel_mut(2, 2)[0] = 255;
        let shifted = shift_mask(mask, 1);
        assert_eq!(shifted.get_pixel(1, 1)[0], 255);
        assert_eq!(shifted.get_pixel(3, 3)[0], 255);
        assert_eq!(shifted.get_pixel(0, 0)[0], 0);
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

    #[test]
    fn output_extension_must_match_the_selected_encoder() {
        assert!(validate_output_extension(Path::new("result.webp"), OutputFormat::Webp).is_ok());
        assert!(validate_output_extension(Path::new("result.png"), OutputFormat::Webp).is_err());
    }

    #[test]
    fn png_and_webp_outputs_embed_only_safe_metadata_when_enabled() {
        let directory =
            std::env::temp_dir().join(format!("crystalcut-output-exif-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create metadata fixture directory");
        let source = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            8,
            4,
            image::Rgba([80, 120, 160, 192]),
        ));
        let summary = metadata::ExifSummary {
            taken_at: Some("2026-08-22 15:04:09".to_owned()),
            camera: Some("CrystalCut Camera One".to_owned()),
            lens: Some("Prime 35mm".to_owned()),
            description: Some("Edited in CrystalCut".to_owned()),
            prompt: Some("portrait, soft light".to_owned()),
            gps_latitude: Some(37.5665),
            gps_longitude: Some(126.9780),
            orientation: 6,
        };

        for format in [OutputFormat::Png, OutputFormat::Webp] {
            let mut output_settings = settings(ResizeMode::Original, 1, true);
            output_settings.format = format;
            output_settings.preserve_metadata = true;
            output_settings.preserve_gps = true;
            output_settings.preserve_prompt = true;
            output_settings.webp_lossless = true;
            let encoded = encode(&source, &output_settings, Some(&summary))
                .expect("encode output with safe metadata");
            let output = directory.join(format!("result.{}", format.extension()));
            std::fs::write(&output, encoded).expect("write metadata output");
            image::open(&output).expect("metadata output remains decodable");
            let restored = metadata::read_exif_summary(&output);
            assert_eq!(restored.taken_at, summary.taken_at);
            assert_eq!(restored.camera, summary.camera);
            assert_eq!(restored.lens, summary.lens);
            assert_eq!(restored.description, summary.description);
            assert_eq!(restored.prompt, summary.prompt);
            assert!(
                (restored.gps_latitude.unwrap() - summary.gps_latitude.unwrap()).abs() < 0.000_01
            );
            assert!(
                (restored.gps_longitude.unwrap() - summary.gps_longitude.unwrap()).abs() < 0.000_01
            );
            assert_eq!(restored.orientation, 1);
        }

        std::fs::remove_dir_all(directory).expect("remove metadata fixture directory");
    }

    #[test]
    fn conversion_path_resizes_and_encodes_without_any_ai_model() {
        let directory =
            std::env::temp_dir().join(format!("crystalcut-convert-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create conversion fixture directory");
        let input = directory.join("source.png");
        let output = directory.join("converted.webp");
        DynamicImage::new_rgba8(80, 40)
            .save(&input)
            .expect("save conversion fixture");
        let mut output_settings = settings(ResizeMode::LongEdge, 40, true);
        output_settings.processing_mode = crate::protocol::ProcessingMode::Convert;
        output_settings.format = OutputFormat::Webp;
        let request = WorkerRequest {
            protocol_version: crate::protocol::WORKER_PROTOCOL_VERSION,
            job_id: "convert-test".to_owned(),
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            model_path: None,
            sam_encoder_path: None,
            sam_decoder_path: None,
            compute: ComputePreference::default(),
            rotation: 0,
            settings: output_settings,
            mask_recipe: ManualMaskRecipe::default(),
            edge_settings: EdgeSettings::default(),
            metadata: None,
        };
        assert!(process_conversion(&request).expect("run conversion") > 0);
        assert_eq!(
            image::open(&output)
                .expect("open converted output")
                .dimensions(),
            (40, 20)
        );
        std::fs::remove_dir_all(directory).expect("remove conversion fixture directory");
    }
}
