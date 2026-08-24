use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const CACHE_DIRECTORY: &str = "preview-cache";
const CACHE_SCHEMA_VERSION: u8 = 1;
const CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_TRIM_WRITE_INTERVAL: usize = 16;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
static CACHE_WRITES: AtomicUsize = AtomicUsize::new(0);

pub struct CachedPreviewBundle {
    pub result_png: Vec<u8>,
    pub mask_png: Vec<u8>,
}

#[derive(Serialize)]
struct FileFingerprint {
    path: String,
    bytes: u64,
    modified_nanos: u128,
}

#[derive(Serialize)]
struct CacheIdentity<'a, T> {
    schema: u8,
    source: FileFingerprint,
    models: Vec<FileFingerprint>,
    request: &'a T,
}

pub fn cache_key<T: Serialize>(
    source: &Path,
    models: &[&Path],
    request: &T,
) -> Result<String, String> {
    let identity = CacheIdentity {
        schema: CACHE_SCHEMA_VERSION,
        source: fingerprint(source)?,
        models: models
            .iter()
            .map(|path| fingerprint(path))
            .collect::<Result<Vec<_>, _>>()?,
        request,
    };
    let encoded = serde_json::to_vec(&identity)
        .map_err(|error| format!("미리보기 캐시 키를 만들지 못했습니다: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub fn load(app: &AppHandle, key: &str) -> Result<Option<CachedPreviewBundle>, String> {
    let directory = cache_directory(app)?;
    let result_path = directory.join(format!("{key}.result.png"));
    let mask_path = directory.join(format!("{key}.mask.png"));
    if !result_path.is_file() || !mask_path.is_file() {
        return Ok(None);
    }
    let result_png = fs::read(&result_path)
        .map_err(|error| format!("캐시된 결과 미리보기를 읽지 못했습니다: {error}"))?;
    let mask_png = fs::read(&mask_path)
        .map_err(|error| format!("캐시된 마스크 미리보기를 읽지 못했습니다: {error}"))?;
    if !is_png(&result_png) || !is_png(&mask_png) {
        remove_entry(&directory, key);
        return Ok(None);
    }
    touch(&directory, key)?;
    Ok(Some(CachedPreviewBundle {
        result_png,
        mask_png,
    }))
}

pub fn store(app: &AppHandle, key: &str, result_png: &[u8], mask_png: &[u8]) -> Result<(), String> {
    if !is_png(result_png) || !is_png(mask_png) {
        return Err("미리보기 캐시에 PNG가 아닌 데이터가 전달되었습니다.".to_owned());
    }
    let directory = cache_directory(app)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("미리보기 캐시 폴더를 만들지 못했습니다: {error}"))?;
    atomic_write(&directory.join(format!("{key}.result.png")), result_png)?;
    atomic_write(&directory.join(format!("{key}.mask.png")), mask_png)?;
    touch(&directory, key)?;
    trim_periodically(&directory)
}

pub fn load_image(app: &AppHandle, key: &str, variant: &str) -> Result<Option<Vec<u8>>, String> {
    let directory = cache_directory(app)?;
    let path = directory.join(format!("{key}.{variant}.png"));
    if !path.is_file() {
        return Ok(None);
    }
    let png = fs::read(&path)
        .map_err(|error| format!("캐시된 이미지 미리보기를 읽지 못했습니다: {error}"))?;
    if !is_png(&png) {
        remove_entry(&directory, key);
        return Ok(None);
    }
    touch(&directory, key)?;
    Ok(Some(png))
}

pub fn store_image(app: &AppHandle, key: &str, variant: &str, png: &[u8]) -> Result<(), String> {
    if !is_png(png) {
        return Err("미리보기 캐시에 PNG가 아닌 데이터가 전달되었습니다.".to_owned());
    }
    let directory = cache_directory(app)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("미리보기 캐시 폴더를 만들지 못했습니다: {error}"))?;
    atomic_write(&directory.join(format!("{key}.{variant}.png")), png)?;
    touch(&directory, key)?;
    trim_periodically(&directory)
}

pub fn size(app: &AppHandle) -> Result<u64, String> {
    let directory = cache_directory(app)?;
    directory_size(&directory)
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let directory = cache_directory(app)?;
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("미리보기 캐시를 삭제하지 못했습니다: {error}"))?;
    }
    Ok(())
}

fn fingerprint(path: &Path) -> Result<FileFingerprint, String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_owned());
    let metadata = canonical
        .metadata()
        .map_err(|error| format!("캐시 대상 파일 정보를 읽지 못했습니다: {error}"))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_nanos());
    Ok(FileFingerprint {
        path: canonical.to_string_lossy().into_owned(),
        bytes: metadata.len(),
        modified_nanos,
    })
}

fn cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CACHE_DIRECTORY))
        .map_err(|error| format!("앱 데이터 폴더를 찾지 못했습니다: {error}"))
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos())
}

fn touch(directory: &Path, key: &str) -> Result<(), String> {
    fs::write(
        directory.join(format!("{key}.access")),
        now_nanos().to_string(),
    )
    .map_err(|error| format!("미리보기 캐시 사용 시각을 기록하지 못했습니다: {error}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("preview");
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_nanos()
    ));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("임시 미리보기 캐시를 쓰지 못했습니다: {error}"))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("미리보기 캐시를 확정하지 못했습니다: {error}")
    })
}

fn trim_periodically(directory: &Path) -> Result<(), String> {
    let write = CACHE_WRITES.fetch_add(1, Ordering::Relaxed);
    if write.is_multiple_of(CACHE_TRIM_WRITE_INTERVAL) {
        trim(directory, CACHE_MAX_BYTES)?;
    }
    Ok(())
}

fn trim(directory: &Path, max_bytes: u64) -> Result<(), String> {
    let mut entries = Vec::new();
    let mut total = 0_u64;
    let read = match fs::read_dir(directory) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("미리보기 캐시 목록을 읽지 못했습니다: {error}")),
    };
    for item in read.flatten() {
        let path = item.path();
        total = total.saturating_add(item.metadata().map_or(0, |metadata| metadata.len()));
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(key) = name.strip_suffix(".access") else {
            continue;
        };
        let accessed = fs::read_to_string(&path)
            .ok()
            .and_then(|value| value.parse::<u128>().ok())
            .unwrap_or_default();
        entries.push((accessed, key.to_owned()));
    }
    if total <= max_bytes {
        return Ok(());
    }
    entries.sort_by_key(|entry| entry.0);
    for (_, key) in entries {
        let before = entry_size(directory, &key);
        remove_entry(directory, &key);
        total = total.saturating_sub(before);
        if total <= max_bytes {
            break;
        }
    }
    Ok(())
}

fn entry_size(directory: &Path, key: &str) -> u64 {
    [
        "result.png",
        "mask.png",
        "preview.png",
        "thumbnail.png",
        "access",
    ]
    .iter()
    .map(|suffix| {
        directory
            .join(format!("{key}.{suffix}"))
            .metadata()
            .map_or(0, |metadata| metadata.len())
    })
    .sum()
}

fn remove_entry(directory: &Path, key: &str) {
    for suffix in [
        "result.png",
        "mask.png",
        "preview.png",
        "thumbnail.png",
        "access",
    ] {
        let _ = fs::remove_file(directory.join(format!("{key}.{suffix}")));
    }
}

fn directory_size(directory: &Path) -> Result<u64, String> {
    if !directory.exists() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for item in fs::read_dir(directory)
        .map_err(|error| format!("미리보기 캐시 크기를 확인하지 못했습니다: {error}"))?
        .flatten()
    {
        total = total.saturating_add(item.metadata().map_or(0, |metadata| metadata.len()));
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_signature_validation_rejects_incomplete_data() {
        assert!(is_png(b"\x89PNG\r\n\x1a\ncontent"));
        assert!(!is_png(b"not a png"));
    }

    #[test]
    fn cache_key_is_stable_until_the_source_changes() {
        let path = std::env::temp_dir().join(format!(
            "crystalcut-preview-cache-key-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        fs::write(&path, b"first").expect("write source fixture");
        let request = serde_json::json!({ "rotation": 0, "recipe": "automatic" });
        let first = cache_key(&path, &[], &request).expect("build first cache key");
        let same = cache_key(&path, &[], &request).expect("build repeated cache key");
        assert_eq!(first, same);

        fs::write(&path, b"changed-source").expect("change source fixture");
        let changed = cache_key(&path, &[], &request).expect("build changed cache key");
        assert_ne!(first, changed);
        fs::remove_file(path).expect("remove source fixture");
    }
}
