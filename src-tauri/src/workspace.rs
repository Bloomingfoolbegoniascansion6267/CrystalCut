use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{metadata::ExifSummary, protocol::OutputSettings};

const SCHEMA_VERSION: i64 = 1;
const DATABASE_FILE: &str = "workspace.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub items: Vec<PersistedAsset>,
    pub settings: OutputSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAsset {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub extension: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub exif: ExifSummary,
    pub status: PersistedStatus,
    pub rotation: u16,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistedStatus {
    Ready,
    Queued,
    Processing,
    Retrying,
    Done,
    Failed,
    Cancelled,
    Interrupted,
}

impl PersistedStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Queued => "queued",
            Self::Processing => "processing",
            Self::Retrying => "retrying",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "ready" => Ok(Self::Ready),
            "queued" => Ok(Self::Queued),
            "processing" => Ok(Self::Processing),
            "retrying" => Ok(Self::Retrying),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!("알 수 없는 저장 상태입니다: {value}")),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredWorkspace {
    pub items: Vec<PersistedAsset>,
    pub settings: OutputSettings,
    pub interrupted: usize,
    pub missing_files: usize,
    pub saved_at_ms: i64,
}

pub fn save(app: &AppHandle, snapshot: WorkspaceSnapshot) -> Result<(), String> {
    let mut connection = open(app)?;
    save_to_connection(&mut connection, &snapshot)
}

pub fn load(app: &AppHandle) -> Result<Option<RestoredWorkspace>, String> {
    let connection = open(app)?;
    load_from_connection(&connection)
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let mut connection = open(app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("작업 목록 삭제 transaction을 시작하지 못했습니다: {error}"))?;
    transaction
        .execute("DELETE FROM workspace_items", [])
        .and_then(|_| transaction.execute("DELETE FROM workspace_state", []))
        .map_err(|error| format!("저장된 작업 목록을 삭제하지 못했습니다: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("작업 목록 삭제를 확정하지 못했습니다: {error}"))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("앱 데이터 폴더를 찾지 못했습니다: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("앱 데이터 폴더를 만들지 못했습니다: {error}"))?;
    let connection = Connection::open(directory.join(DATABASE_FILE))
        .map_err(|error| format!("작업 목록 데이터베이스를 열지 못했습니다: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("SQLite 대기 시간을 설정하지 못했습니다: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|error| format!("SQLite 실행 옵션을 설정하지 못했습니다: {error}"))?;
    migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("작업 목록 schema 버전을 읽지 못했습니다: {error}"))?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "이 앱보다 새로운 작업 목록 schema입니다: {version}"
        ));
    }
    if version == 0 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS workspace_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    settings_json TEXT NOT NULL,
                    saved_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS workspace_items (
                    id TEXT PRIMARY KEY NOT NULL,
                    position INTEGER NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    modified_at_ms INTEGER,
                    extension TEXT NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    exif_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    rotation INTEGER NOT NULL,
                    output_path TEXT,
                    output_bytes INTEGER,
                    error TEXT
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(|error| format!("작업 목록 schema를 만들지 못했습니다: {error}"))?;
    }
    Ok(())
}

fn save_to_connection(
    connection: &mut Connection,
    snapshot: &WorkspaceSnapshot,
) -> Result<(), String> {
    for item in &snapshot.items {
        validate_asset(item)?;
    }
    let settings_json = serde_json::to_string(&snapshot.settings)
        .map_err(|error| format!("출력 설정을 직렬화하지 못했습니다: {error}"))?;
    let saved_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("작업 목록 저장 transaction을 시작하지 못했습니다: {error}"))?;
    transaction
        .execute("DELETE FROM workspace_items", [])
        .map_err(|error| format!("이전 작업 항목을 정리하지 못했습니다: {error}"))?;
    transaction
        .execute(
            "INSERT INTO workspace_state(singleton, settings_json, saved_at_ms)
             VALUES(1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET
                settings_json = excluded.settings_json,
                saved_at_ms = excluded.saved_at_ms",
            params![settings_json, saved_at_ms],
        )
        .map_err(|error| format!("작업 설정을 저장하지 못했습니다: {error}"))?;
    for (position, item) in snapshot.items.iter().enumerate() {
        insert_asset(&transaction, position, item)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("작업 목록 저장을 확정하지 못했습니다: {error}"))
}

fn insert_asset(
    transaction: &Transaction<'_>,
    position: usize,
    item: &PersistedAsset,
) -> Result<(), String> {
    let exif_json = serde_json::to_string(&item.exif)
        .map_err(|error| format!("EXIF 요약을 직렬화하지 못했습니다: {error}"))?;
    let modified_at_ms = file_modified_ms(Path::new(&item.path));
    transaction
        .execute(
            "INSERT INTO workspace_items(
                id, position, name, path, size_bytes, modified_at_ms, extension, width, height,
                exif_json, status, rotation, output_path, output_bytes, error
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                item.id,
                to_i64(position as u64),
                item.name,
                item.path,
                to_i64(item.size_bytes),
                modified_at_ms,
                item.extension,
                item.width.map(i64::from),
                item.height.map(i64::from),
                exif_json,
                item.status.as_str(),
                i64::from(item.rotation),
                item.output_path,
                item.output_bytes.map(to_i64),
                item.error,
            ],
        )
        .map_err(|error| format!("작업 항목을 저장하지 못했습니다: {error}"))?;
    Ok(())
}

fn load_from_connection(connection: &Connection) -> Result<Option<RestoredWorkspace>, String> {
    let state = connection
        .query_row(
            "SELECT settings_json, saved_at_ms FROM workspace_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("저장된 작업 설정을 읽지 못했습니다: {error}"))?;
    let Some((settings_json, saved_at_ms)) = state else {
        return Ok(None);
    };
    let settings: OutputSettings = serde_json::from_str(&settings_json)
        .map_err(|error| format!("저장된 출력 설정이 올바르지 않습니다: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, path, size_bytes, modified_at_ms, extension, width, height, exif_json,
                    status, rotation, output_path, output_bytes, error
             FROM workspace_items ORDER BY position",
        )
        .map_err(|error| format!("저장된 작업 항목 query를 준비하지 못했습니다: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<String>>(13)?,
            ))
        })
        .map_err(|error| format!("저장된 작업 항목을 읽지 못했습니다: {error}"))?;

    let mut items = Vec::new();
    let mut interrupted = 0;
    let mut missing_files = 0;
    for row in rows {
        let (
            id,
            name,
            path,
            size_bytes,
            modified_at_ms,
            extension,
            width,
            height,
            exif_json,
            status,
            rotation,
            output_path,
            output_bytes,
            error,
        ) = row.map_err(|error| format!("저장된 작업 항목이 올바르지 않습니다: {error}"))?;
        if !Path::new(&path).is_file() {
            missing_files += 1;
            continue;
        }
        let exif = serde_json::from_str(&exif_json)
            .map_err(|error| format!("저장된 EXIF 요약이 올바르지 않습니다: {error}"))?;
        let mut item = PersistedAsset {
            id,
            name,
            path,
            size_bytes: to_u64(size_bytes),
            extension,
            width: width.and_then(to_u32),
            height: height.and_then(to_u32),
            exif,
            status: PersistedStatus::from_str(&status)?,
            rotation: u16::try_from(rotation).unwrap_or(0),
            output_path,
            output_bytes: output_bytes.map(to_u64),
            error,
        };
        if normalize_restored_asset(&mut item, modified_at_ms) {
            interrupted += 1;
        }
        items.push(item);
    }
    Ok(Some(RestoredWorkspace {
        items,
        settings,
        interrupted,
        missing_files,
        saved_at_ms,
    }))
}

fn normalize_restored_asset(item: &mut PersistedAsset, saved_modified_at_ms: Option<i64>) -> bool {
    let source_metadata = Path::new(&item.path).metadata().ok();
    let source_changed = source_metadata.as_ref().is_some_and(|metadata| {
        metadata.len() != item.size_bytes
            || saved_modified_at_ms
                .zip(metadata.modified().ok().and_then(system_time_ms))
                .is_some_and(|(saved, current)| saved != current)
    });
    let was_in_flight = matches!(
        item.status,
        PersistedStatus::Queued | PersistedStatus::Processing | PersistedStatus::Retrying
    );
    let output_missing = item.status == PersistedStatus::Done
        && item
            .output_path
            .as_deref()
            .is_none_or(|path| !Path::new(path).is_file());
    if source_changed || was_in_flight || output_missing {
        item.status = PersistedStatus::Interrupted;
        item.output_path = None;
        item.output_bytes = None;
        item.error = Some(if source_changed {
            "원본 파일이 변경되어 다시 처리가 필요합니다.".to_owned()
        } else if output_missing {
            "저장된 결과 파일을 찾을 수 없어 다시 처리가 필요합니다.".to_owned()
        } else {
            "이전 실행 중 작업이 중단되었습니다.".to_owned()
        });
        return true;
    }
    false
}

fn validate_asset(item: &PersistedAsset) -> Result<(), String> {
    if item.id.trim().is_empty() || item.path.trim().is_empty() {
        return Err("저장할 작업 항목의 ID와 경로는 비워둘 수 없습니다.".to_owned());
    }
    if !matches!(item.rotation, 0 | 90 | 180 | 270) {
        return Err(format!(
            "저장할 회전 각도가 올바르지 않습니다: {}",
            item.rotation
        ));
    }
    Ok(())
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn to_u32(value: i64) -> Option<u32> {
    u32::try_from(value).ok()
}

fn file_modified_ms(path: &Path) -> Option<i64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()
        .and_then(system_time_ms)
}

fn system_time_ms(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        naming,
        protocol::{OutputFormat, OutputLocation, ResizeMode},
    };

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

    fn asset(path: &Path, status: PersistedStatus) -> PersistedAsset {
        PersistedAsset {
            id: format!(
                "asset-{}",
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("fixture")
            ),
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("photo.jpg")
                .to_owned(),
            path: path.to_string_lossy().into_owned(),
            size_bytes: path.metadata().map(|value| value.len()).unwrap_or(0),
            extension: "jpg".to_owned(),
            width: Some(20),
            height: Some(10),
            exif: ExifSummary::default(),
            status,
            rotation: 0,
            output_path: None,
            output_bytes: None,
            error: None,
        }
    }

    #[test]
    fn migration_and_snapshot_round_trip_preserve_order_and_settings() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        migrate(&connection).expect("migrate database");
        let directory =
            std::env::temp_dir().join(format!("clearcut-workspace-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let first = directory.join("first.jpg");
        let second = directory.join("second.jpg");
        std::fs::write(&first, b"first").expect("write first fixture");
        std::fs::write(&second, b"second").expect("write second fixture");
        let snapshot = WorkspaceSnapshot {
            items: vec![
                asset(&first, PersistedStatus::Ready),
                asset(&second, PersistedStatus::Failed),
            ],
            settings: settings(),
        };
        save_to_connection(&mut connection, &snapshot).expect("save snapshot");

        let restored = load_from_connection(&connection)
            .expect("load snapshot")
            .expect("workspace exists");
        assert_eq!(restored.items.len(), 2);
        assert_eq!(restored.items[0].path, first.to_string_lossy());
        assert_eq!(restored.items[1].status, PersistedStatus::Failed);
        assert_eq!(restored.settings.suffix, "_bg");

        std::fs::remove_file(first).expect("remove first fixture");
        std::fs::remove_file(second).expect("remove second fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }

    #[test]
    fn in_flight_and_changed_items_are_restored_as_interrupted() {
        let directory =
            std::env::temp_dir().join(format!("clearcut-interrupted-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let source = directory.join("photo.jpg");
        std::fs::write(&source, b"before").expect("write fixture");
        let mut processing = asset(&source, PersistedStatus::Processing);
        assert!(normalize_restored_asset(
            &mut processing,
            file_modified_ms(&source)
        ));
        assert_eq!(processing.status, PersistedStatus::Interrupted);

        let mut changed = asset(&source, PersistedStatus::Done);
        changed.size_bytes += 1;
        assert!(normalize_restored_asset(
            &mut changed,
            file_modified_ms(&source)
        ));
        assert_eq!(changed.status, PersistedStatus::Interrupted);

        std::fs::remove_file(source).expect("remove fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }

    #[test]
    fn completed_item_is_preserved_only_while_its_output_exists() {
        let directory =
            std::env::temp_dir().join(format!("clearcut-completed-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let source = directory.join("photo.jpg");
        let output = directory.join("photo_bg.png");
        std::fs::write(&source, b"source").expect("write source fixture");
        std::fs::write(&output, b"output").expect("write output fixture");
        let mut completed = asset(&source, PersistedStatus::Done);
        completed.output_path = Some(output.to_string_lossy().into_owned());
        completed.output_bytes = Some(6);
        let modified_at_ms = file_modified_ms(&source);

        assert!(!normalize_restored_asset(&mut completed, modified_at_ms));
        assert_eq!(completed.status, PersistedStatus::Done);

        std::fs::remove_file(output).expect("remove output fixture");
        assert!(normalize_restored_asset(&mut completed, modified_at_ms));
        assert_eq!(completed.status, PersistedStatus::Interrupted);
        assert!(completed.output_path.is_none());

        std::fs::remove_file(source).expect("remove source fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }
}
