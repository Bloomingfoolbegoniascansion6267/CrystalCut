use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use ureq::{
    config::Config,
    tls::{TlsConfig, TlsProvider},
    Agent,
};

pub const MODEL_ID: &str = "u2netp";
pub const MODEL_URL: &str =
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
pub const MODEL_SHA256: &str = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
pub const MODEL_BYTES: u64 = 4_574_861;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub installed: bool,
    pub expected_bytes: u64,
    pub path: Option<String>,
    pub installed_bytes: Option<u64>,
    pub can_delete: bool,
    pub purpose: &'static str,
}

pub fn status(app: &AppHandle) -> Result<ModelStatus, String> {
    let path = find_verified_model(app)?;
    let managed_path = installed_model_path(app)?;
    Ok(ModelStatus {
        id: MODEL_ID,
        installed: path.is_some(),
        expected_bytes: MODEL_BYTES,
        installed_bytes: path
            .as_ref()
            .and_then(|value| value.metadata().ok())
            .map(|metadata| metadata.len()),
        can_delete: path.as_ref().is_some_and(|value| value == &managed_path),
        path: path.map(|value| value.to_string_lossy().into_owned()),
        purpose: "빠른 로컬 처리 및 end-to-end 검증",
    })
}

pub fn remove_default_model(app: &AppHandle) -> Result<ModelStatus, String> {
    let model_path = installed_model_path(app)?;
    let partial_path = model_path.with_extension("onnx.partial");
    for path in [&model_path, &partial_path] {
        if path.is_file() {
            fs::remove_file(path)
                .map_err(|error| format!("설치된 모델을 삭제하지 못했습니다: {error}"))?;
        }
    }
    if let Some(directory) = model_path.parent() {
        let _ = fs::remove_dir(directory);
    }
    status(app)
}

pub fn ensure_default_model(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_default_model_with_progress(app, |_, _| {})
}

pub fn ensure_default_model_with_progress(
    app: &AppHandle,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<PathBuf, String> {
    if let Some(path) = find_verified_model(app)? {
        on_progress(MODEL_BYTES, MODEL_BYTES);
        return Ok(path);
    }

    let model_path = installed_model_path(app)?;
    if model_path.is_file() {
        fs::remove_file(&model_path)
            .map_err(|error| format!("손상된 모델 파일을 교체하지 못했습니다: {error}"))?;
    }
    let model_dir = model_path
        .parent()
        .ok_or_else(|| "모델 저장 폴더를 계산하지 못했습니다.".to_owned())?;
    fs::create_dir_all(model_dir)
        .map_err(|error| format!("모델 저장 폴더를 만들지 못했습니다: {error}"))?;

    let partial_path = model_path.with_extension("onnx.partial");
    let download_agent = model_download_agent();
    let mut response = download_agent
        .get(MODEL_URL)
        .call()
        .map_err(|error| format!("모델을 다운로드하지 못했습니다: {error}"))?;
    let mut reader = response.body_mut().as_reader();
    let mut partial = File::create(&partial_path)
        .map_err(|error| format!("임시 모델 파일을 만들지 못했습니다: {error}"))?;
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    on_progress(0, MODEL_BYTES);
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("모델을 다운로드하지 못했습니다: {error}"))?;
        if read == 0 {
            break;
        }
        partial
            .write_all(&buffer[..read])
            .map_err(|error| format!("모델 파일을 저장하지 못했습니다: {error}"))?;
        downloaded = downloaded.saturating_add(read as u64);
        on_progress(downloaded.min(MODEL_BYTES), MODEL_BYTES);
    }
    partial
        .sync_all()
        .map_err(|error| format!("모델 파일을 디스크에 반영하지 못했습니다: {error}"))?;
    drop(partial);

    if let Err(error) = verify_model(&partial_path) {
        let _ = fs::remove_file(&partial_path);
        return Err(error);
    }

    fs::rename(&partial_path, &model_path)
        .map_err(|error| format!("검증한 모델을 설치하지 못했습니다: {error}"))?;
    Ok(model_path)
}

fn model_download_agent() -> Agent {
    Config::builder()
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .build(),
        )
        .build()
        .new_agent()
}

fn find_verified_model(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    if let Ok(explicit) =
        std::env::var("CRYSTALCUT_MODEL_PATH").or_else(|_| std::env::var("CLEARCUT_MODEL_PATH"))
    {
        let path = PathBuf::from(explicit);
        verify_model(&path)?;
        return Ok(Some(path));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        let development_cache = current_dir.join("models").join("cache").join("u2netp.onnx");
        if development_cache.is_file() && verify_model(&development_cache).is_ok() {
            return Ok(Some(development_cache));
        }
    }

    let installed = installed_model_path(app)?;
    if installed.is_file() && verify_model(&installed).is_ok() {
        return Ok(Some(installed));
    }

    Ok(None)
}

fn installed_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("models").join(MODEL_ID).join("u2netp.onnx"))
        .map_err(|error| format!("앱 데이터 폴더를 찾지 못했습니다: {error}"))
}

pub fn verify_model(path: &Path) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("모델 파일 정보를 읽지 못했습니다: {error}"))?;
    if metadata.len() != MODEL_BYTES {
        return Err(format!(
            "모델 크기가 예상과 다릅니다: {} / {MODEL_BYTES} bytes",
            metadata.len()
        ));
    }

    let mut file = File::open(path).map_err(|error| format!("모델을 열지 못했습니다: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("모델을 검증하지 못했습니다: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual != MODEL_SHA256 {
        return Err(format!("모델 SHA-256이 일치하지 않습니다: {actual}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_model_is_never_accidentally_changed() {
        let workspace_model = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("models")
            .join("cache")
            .join("u2netp.onnx");
        if workspace_model.is_file() {
            verify_model(&workspace_model).expect("cached smoke-test model must match manifest");
        }
    }

    #[test]
    fn model_download_agent_explicitly_uses_enabled_native_tls() {
        let agent = model_download_agent();
        assert_eq!(
            agent.config().tls_config().provider(),
            TlsProvider::NativeTls
        );
    }

    #[test]
    #[ignore = "requires access to the model download endpoint"]
    fn model_download_endpoint_works_over_https() {
        model_download_agent()
            .get(MODEL_URL)
            .call()
            .expect("model endpoint must be reachable over Native TLS");
    }
}
