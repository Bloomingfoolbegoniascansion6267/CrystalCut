use std::{
    io::{self, BufRead, Write},
    path::Path,
    time::Instant,
};

use crate::{
    engine::InferenceEngine,
    protocol::{MaskMode, ProcessingMode, WorkerRequest, WorkerResponse, WORKER_PROTOCOL_VERSION},
    sam::SamEngine,
};

pub fn run_stdio() -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut engine: Option<InferenceEngine> = None;
    let mut sam_engine: Option<SamEngine> = None;

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("worker 요청을 읽지 못했습니다: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let request: WorkerRequest = serde_json::from_str(&line)
            .map_err(|error| format!("worker 요청 JSON이 올바르지 않습니다: {error}"))?;
        let started = Instant::now();
        let result = process_request(&mut engine, &mut sam_engine, &request);
        let response = match result {
            Ok(output_bytes) => WorkerResponse {
                protocol_version: WORKER_PROTOCOL_VERSION,
                job_id: request.job_id,
                success: true,
                output_path: Some(request.output_path),
                output_bytes: Some(output_bytes),
                duration_ms: started.elapsed().as_millis(),
                error: None,
            },
            Err(error) => WorkerResponse {
                protocol_version: WORKER_PROTOCOL_VERSION,
                job_id: request.job_id,
                success: false,
                output_path: None,
                output_bytes: None,
                duration_ms: started.elapsed().as_millis(),
                error: Some(error),
            },
        };
        serde_json::to_writer(&mut stdout, &response)
            .map_err(|error| format!("worker 응답을 만들지 못했습니다: {error}"))?;
        stdout
            .write_all(b"\n")
            .and_then(|_| stdout.flush())
            .map_err(|error| format!("worker 응답을 전송하지 못했습니다: {error}"))?;
    }
    Ok(())
}

fn process_request(
    engine: &mut Option<InferenceEngine>,
    sam_engine: &mut Option<SamEngine>,
    request: &WorkerRequest,
) -> Result<u64, String> {
    if request.protocol_version != WORKER_PROTOCOL_VERSION {
        return Err(format!(
            "worker protocol이 호환되지 않습니다: 앱={}, worker={WORKER_PROTOCOL_VERSION}",
            request.protocol_version
        ));
    }

    if matches!(request.settings.processing_mode, ProcessingMode::Convert) {
        return crate::engine::process_conversion(request);
    }
    if matches!(request.mask_recipe.mode, MaskMode::Sam) {
        let encoder = request
            .sam_encoder_path
            .as_deref()
            .ok_or_else(|| "SAM 이미지 인코더 경로가 없습니다.".to_owned())?;
        let decoder = request
            .sam_decoder_path
            .as_deref()
            .ok_or_else(|| "SAM 프롬프트 디코더 경로가 없습니다.".to_owned())?;
        let encoder = Path::new(encoder);
        let decoder = Path::new(decoder);
        if sam_engine
            .as_ref()
            .is_none_or(|current| !current.uses_models(encoder, decoder))
        {
            *sam_engine = Some(SamEngine::new(&crate::sam::SamModelPaths {
                encoder: encoder.to_owned(),
                decoder: decoder.to_owned(),
            })?);
        }
        return sam_engine
            .as_mut()
            .ok_or_else(|| "SAM worker를 초기화하지 못했습니다.".to_owned())?
            .process(request);
    }
    let model_path = Path::new(
        request
            .model_path
            .as_deref()
            .ok_or_else(|| "배경 제거 모델 경로가 없습니다.".to_owned())?,
    );
    if engine
        .as_ref()
        .is_none_or(|current| !current.uses_model(model_path))
    {
        *engine = Some(InferenceEngine::new(model_path)?);
    }
    engine
        .as_mut()
        .ok_or_else(|| "AI worker를 초기화하지 못했습니다.".to_owned())?
        .process(request)
}
