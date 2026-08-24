use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    metadata::ExifSummary,
    protocol::{
        EdgeSettings, ManualMaskRecipe, MetadataOutputPolicy, OutputSettings, ResizeOverride,
    },
};

const SCHEMA_VERSION: i64 = 8;
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
    #[serde(default)]
    pub mask_recipe: ManualMaskRecipe,
    #[serde(default)]
    pub edge_settings: EdgeSettings,
    #[serde(default)]
    pub metadata_policy: Option<MetadataOutputPolicy>,
    #[serde(default)]
    pub resize_override: Option<ResizeOverride>,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    #[serde(default)]
    pub output_preview_key: Option<String>,
    #[serde(default)]
    pub edit_preview_key: Option<String>,
    #[serde(default)]
    pub preview_cache_key: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppPreferences {
    pub default_settings: OutputSettings,
    pub restore_workspace: bool,
    pub presets: Vec<OutputPreset>,
    pub language: LanguagePreference,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum LanguagePreference {
    #[serde(rename = "system")]
    #[default]
    System,
    #[serde(rename = "ko")]
    Ko,
    #[serde(rename = "en")]
    En,
    #[serde(rename = "ja")]
    Ja,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "de")]
    De,
    #[serde(rename = "fr")]
    Fr,
    #[serde(rename = "pt-BR")]
    PtBr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPreset {
    pub id: String,
    pub name: String,
    pub settings: OutputSettings,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            default_settings: OutputSettings::default(),
            restore_workspace: true,
            presets: Vec::new(),
            language: LanguagePreference::System,
        }
    }
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

pub fn load_preferences(app: &AppHandle) -> Result<AppPreferences, String> {
    let connection = open(app)?;
    load_preferences_from_connection(&connection)
}

pub fn save_preferences(app: &AppHandle, preferences: AppPreferences) -> Result<(), String> {
    validate_preferences(&preferences)?;
    let connection = open(app)?;
    save_preferences_to_connection(&connection, &preferences)
}

pub fn reset_preferences(app: &AppHandle) -> Result<AppPreferences, String> {
    let preferences = AppPreferences::default();
    let connection = open(app)?;
    save_preferences_to_connection(&connection, &preferences)?;
    Ok(preferences)
}

pub fn database_size(app: &AppHandle) -> Result<u64, String> {
    let path = database_path(app)?;
    let mut bytes = path.metadata().map_or(0, |metadata| metadata.len());
    for suffix in ["-wal", "-shm"] {
        let sidecar = Path::new(&format!("{}{suffix}", path.to_string_lossy())).to_path_buf();
        bytes = bytes.saturating_add(sidecar.metadata().map_or(0, |metadata| metadata.len()));
    }
    Ok(bytes)
}

pub fn app_data_directory(app: &AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("앱 데이터 폴더를 찾지 못했습니다: {error}"))
}

fn database_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(DATABASE_FILE))
        .map_err(|error| format!("앱 데이터 폴더를 찾지 못했습니다: {error}"))
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
    let mut version = connection
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
        version = 1;
    }
    if version == 1 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS app_preferences (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    preferences_json TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                 );
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(|error| format!("환경설정 schema를 만들지 못했습니다: {error}"))?;
        version = 2;
    }
    if version == 2 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE workspace_items ADD COLUMN mask_recipe_json TEXT NOT NULL DEFAULT '{\"mode\":\"automatic\",\"strokes\":[]}';
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(|error| format!("브러시 마스크 schema를 만들지 못했습니다: {error}"))?;
        version = 3;
    }
    if version == 3 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE workspace_items ADD COLUMN edge_settings_json TEXT NOT NULL DEFAULT '{\"edgeSmoothing\":2,\"edgeFeather\":1,\"edgeShift\":0,\"alphaThreshold\":2,\"maskContrast\":0,\"preserveOriginalAlpha\":true}';
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(|error| format!("파일별 가장자리 설정 schema를 만들지 못했습니다: {error}"))?;
        version = 4;
    }
    if version == 4 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE workspace_items ADD COLUMN metadata_policy_json TEXT;
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(|error| {
                format!("파일별 메타데이터 정책 schema를 만들지 못했습니다: {error}")
            })?;
        version = 5;
    }
    if version == 5 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE workspace_items ADD COLUMN resize_override_json TEXT;
                 PRAGMA user_version = 6;
                 COMMIT;",
            )
            .map_err(|error| {
                format!("파일별 크기 변경 설정 schema를 만들지 못했습니다: {error}")
            })?;
    }
    if version <= 6 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE workspace_items ADD COLUMN output_preview_key TEXT;
                 PRAGMA user_version = 7;
                 COMMIT;",
            )
            .map_err(|error| format!("출력 미리보기 식별자 schema를 만들지 못했습니다: {error}"))?;
        version = 7;
    }
    if version == 7 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE workspace_items ADD COLUMN edit_preview_key TEXT;
                 ALTER TABLE workspace_items ADD COLUMN preview_cache_key TEXT;
                 PRAGMA user_version = 8;
                 COMMIT;",
            )
            .map_err(|error| {
                format!("편집 미리보기 캐시 식별자 schema를 만들지 못했습니다: {error}")
            })?;
    }
    Ok(())
}

fn load_preferences_from_connection(connection: &Connection) -> Result<AppPreferences, String> {
    let stored = connection
        .query_row(
            "SELECT preferences_json FROM app_preferences WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("환경설정을 읽지 못했습니다: {error}"))?;
    Ok(stored
        .and_then(|json| serde_json::from_str(&json).ok())
        .filter(|preferences: &AppPreferences| validate_preferences(preferences).is_ok())
        .unwrap_or_default())
}

fn validate_preferences(preferences: &AppPreferences) -> Result<(), String> {
    crate::validate_settings(&preferences.default_settings)?;
    if preferences.presets.len() > 100 {
        return Err("출력 프리셋은 최대 100개까지 저장할 수 있습니다.".to_owned());
    }
    let mut ids = std::collections::HashSet::new();
    for preset in &preferences.presets {
        if preset.id.trim().is_empty()
            || preset.name.trim().is_empty()
            || preset.name.chars().count() > 40
        {
            return Err("출력 프리셋의 이름이 올바르지 않습니다.".to_owned());
        }
        if !ids.insert(preset.id.as_str()) {
            return Err("중복된 출력 프리셋 ID가 있습니다.".to_owned());
        }
        crate::validate_settings(&preset.settings)?;
    }
    Ok(())
}

fn save_preferences_to_connection(
    connection: &Connection,
    preferences: &AppPreferences,
) -> Result<(), String> {
    let preferences_json = serde_json::to_string(preferences)
        .map_err(|error| format!("환경설정을 직렬화하지 못했습니다: {error}"))?;
    connection
        .execute(
            "INSERT INTO app_preferences(singleton, preferences_json, updated_at_ms)
             VALUES(1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET
                preferences_json = excluded.preferences_json,
                updated_at_ms = excluded.updated_at_ms",
            params![preferences_json, now_ms()],
        )
        .map_err(|error| format!("환경설정을 저장하지 못했습니다: {error}"))?;
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
    let saved_at_ms = now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("작업 목록 저장 transaction을 시작하지 못했습니다: {error}"))?;
    let retained_ids = snapshot
        .items
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    let removed_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM workspace_items")
            .map_err(|error| format!("기존 작업 항목을 확인하지 못했습니다: {error}"))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("기존 작업 항목을 읽지 못했습니다: {error}"))?
            .filter_map(Result::ok)
            .filter(|id| !retained_ids.contains(id.as_str()))
            .collect::<Vec<_>>();
        ids
    };
    for id in removed_ids {
        transaction
            .execute("DELETE FROM workspace_items WHERE id = ?1", [id])
            .map_err(|error| format!("삭제된 작업 항목을 정리하지 못했습니다: {error}"))?;
    }
    move_reordered_positions_out_of_way(&transaction, &snapshot.items)?;
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
        upsert_asset(&transaction, position, item)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("작업 목록 저장을 확정하지 못했습니다: {error}"))
}

fn move_reordered_positions_out_of_way(
    transaction: &Transaction<'_>,
    items: &[PersistedAsset],
) -> Result<(), String> {
    let desired_positions = items
        .iter()
        .enumerate()
        .map(|(position, item)| (item.id.as_str(), to_i64(position as u64)))
        .collect::<HashMap<_, _>>();
    let positions_changed = {
        let mut statement = transaction
            .prepare("SELECT id, position FROM workspace_items")
            .map_err(|error| format!("기존 작업 순서를 확인하지 못했습니다: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| format!("기존 작업 순서를 읽지 못했습니다: {error}"))?;
        let mut changed = false;
        for row in rows {
            let (id, position) =
                row.map_err(|error| format!("기존 작업 순서가 올바르지 않습니다: {error}"))?;
            if desired_positions.get(id.as_str()).copied() != Some(position) {
                changed = true;
                break;
            }
        }
        changed
    };
    if positions_changed {
        transaction
            .execute("UPDATE workspace_items SET position = -position - 1", [])
            .map_err(|error| format!("작업 순서를 안전하게 재배치하지 못했습니다: {error}"))?;
    }
    Ok(())
}

fn upsert_asset(
    transaction: &Transaction<'_>,
    position: usize,
    item: &PersistedAsset,
) -> Result<(), String> {
    let exif_json = serde_json::to_string(&item.exif)
        .map_err(|error| format!("EXIF 요약을 직렬화하지 못했습니다: {error}"))?;
    let mask_recipe_json = serde_json::to_string(&item.mask_recipe)
        .map_err(|error| format!("브러시 마스크를 직렬화하지 못했습니다: {error}"))?;
    let edge_settings_json = serde_json::to_string(&item.edge_settings)
        .map_err(|error| format!("가장자리 설정을 직렬화하지 못했습니다: {error}"))?;
    let metadata_policy_json = item
        .metadata_policy
        .map(|policy| serde_json::to_string(&policy))
        .transpose()
        .map_err(|error| format!("메타데이터 정책을 직렬화하지 못했습니다: {error}"))?;
    let resize_override_json = item
        .resize_override
        .map(|resize_override| serde_json::to_string(&resize_override))
        .transpose()
        .map_err(|error| format!("파일별 크기 변경 설정을 직렬화하지 못했습니다: {error}"))?;
    let modified_at_ms = file_modified_ms(Path::new(&item.path));
    transaction
        .execute(
            "INSERT INTO workspace_items(
                id, position, name, path, size_bytes, modified_at_ms, extension, width, height,
                exif_json, status, rotation, mask_recipe_json, edge_settings_json, metadata_policy_json,
                resize_override_json, output_path, output_bytes, output_preview_key,
                edit_preview_key, preview_cache_key, error
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
             ON CONFLICT(id) DO UPDATE SET
                position = excluded.position,
                name = excluded.name,
                path = excluded.path,
                size_bytes = excluded.size_bytes,
                modified_at_ms = excluded.modified_at_ms,
                extension = excluded.extension,
                width = excluded.width,
                height = excluded.height,
                exif_json = excluded.exif_json,
                status = excluded.status,
                rotation = excluded.rotation,
                mask_recipe_json = excluded.mask_recipe_json,
                edge_settings_json = excluded.edge_settings_json,
                metadata_policy_json = excluded.metadata_policy_json,
                resize_override_json = excluded.resize_override_json,
                output_path = excluded.output_path,
                output_bytes = excluded.output_bytes,
                output_preview_key = excluded.output_preview_key,
                edit_preview_key = excluded.edit_preview_key,
                preview_cache_key = excluded.preview_cache_key,
                error = excluded.error
             WHERE workspace_items.position IS NOT excluded.position
                OR workspace_items.name IS NOT excluded.name
                OR workspace_items.path IS NOT excluded.path
                OR workspace_items.size_bytes IS NOT excluded.size_bytes
                OR workspace_items.modified_at_ms IS NOT excluded.modified_at_ms
                OR workspace_items.extension IS NOT excluded.extension
                OR workspace_items.width IS NOT excluded.width
                OR workspace_items.height IS NOT excluded.height
                OR workspace_items.exif_json IS NOT excluded.exif_json
                OR workspace_items.status IS NOT excluded.status
                OR workspace_items.rotation IS NOT excluded.rotation
                OR workspace_items.mask_recipe_json IS NOT excluded.mask_recipe_json
                OR workspace_items.edge_settings_json IS NOT excluded.edge_settings_json
                OR workspace_items.metadata_policy_json IS NOT excluded.metadata_policy_json
                OR workspace_items.resize_override_json IS NOT excluded.resize_override_json
                OR workspace_items.output_path IS NOT excluded.output_path
                OR workspace_items.output_bytes IS NOT excluded.output_bytes
                OR workspace_items.output_preview_key IS NOT excluded.output_preview_key
                OR workspace_items.edit_preview_key IS NOT excluded.edit_preview_key
                OR workspace_items.preview_cache_key IS NOT excluded.preview_cache_key
                OR workspace_items.error IS NOT excluded.error",
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
                mask_recipe_json,
                edge_settings_json,
                metadata_policy_json,
                resize_override_json,
                item.output_path,
                item.output_bytes.map(to_i64),
                item.output_preview_key,
                item.edit_preview_key,
                item.preview_cache_key,
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
                    status, rotation, mask_recipe_json, edge_settings_json, metadata_policy_json,
                    resize_override_json, output_path, output_bytes, output_preview_key,
                    edit_preview_key, preview_cache_key, error
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
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<i64>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, Option<String>>(18)?,
                row.get::<_, Option<String>>(19)?,
                row.get::<_, Option<String>>(20)?,
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
            mask_recipe_json,
            edge_settings_json,
            metadata_policy_json,
            resize_override_json,
            output_path,
            output_bytes,
            output_preview_key,
            edit_preview_key,
            preview_cache_key,
            error,
        ) = row.map_err(|error| format!("저장된 작업 항목이 올바르지 않습니다: {error}"))?;
        if !Path::new(&path).is_file() {
            missing_files += 1;
            continue;
        }
        let exif = serde_json::from_str(&exif_json)
            .map_err(|error| format!("저장된 EXIF 요약이 올바르지 않습니다: {error}"))?;
        let mask_recipe = serde_json::from_str(&mask_recipe_json)
            .map_err(|error| format!("저장된 브러시 마스크가 올바르지 않습니다: {error}"))?;
        let edge_settings = serde_json::from_str(&edge_settings_json)
            .map_err(|error| format!("저장된 가장자리 설정이 올바르지 않습니다: {error}"))?;
        let metadata_policy = metadata_policy_json
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| format!("저장된 메타데이터 정책이 올바르지 않습니다: {error}"))?;
        let resize_override = resize_override_json
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| {
                format!("저장된 파일별 크기 변경 설정이 올바르지 않습니다: {error}")
            })?;
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
            mask_recipe,
            edge_settings,
            metadata_policy,
            resize_override,
            output_path,
            output_bytes: output_bytes.map(to_u64),
            output_preview_key,
            edit_preview_key,
            preview_cache_key,
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
        item.output_preview_key = None;
        if source_changed {
            item.edit_preview_key = None;
            item.preview_cache_key = None;
        }
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
    crate::validate_edge_settings(&item.edge_settings)?;
    if let Some(resize_override) = item.resize_override {
        if resize_override.value == 0 || resize_override.value > 32_768 {
            return Err("파일별 출력 크기는 1px에서 32,768px 사이여야 합니다.".to_owned());
        }
    }
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

fn now_ms() -> i64 {
    system_time_ms(SystemTime::now()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        BrushMode, BrushStroke, MaskMode, MaskPoint, OutputFormat, OutputLocation,
    };

    fn settings() -> OutputSettings {
        OutputSettings {
            output_location: OutputLocation::SameFolder,
            ..OutputSettings::default()
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
            mask_recipe: ManualMaskRecipe::default(),
            edge_settings: EdgeSettings::default(),
            metadata_policy: None,
            resize_override: None,
            output_path: None,
            output_bytes: None,
            output_preview_key: None,
            edit_preview_key: None,
            preview_cache_key: None,
            error: None,
        }
    }

    #[test]
    fn migration_and_snapshot_round_trip_preserve_order_and_settings() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        migrate(&connection).expect("migrate database");
        let schema_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read schema version");
        assert_eq!(schema_version, SCHEMA_VERSION);
        let directory =
            std::env::temp_dir().join(format!("crystalcut-workspace-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let first = directory.join("first.jpg");
        let second = directory.join("second.jpg");
        std::fs::write(&first, b"first").expect("write first fixture");
        std::fs::write(&second, b"second").expect("write second fixture");
        let mut edited = asset(&first, PersistedStatus::Ready);
        edited.mask_recipe = ManualMaskRecipe {
            mode: MaskMode::Manual,
            strokes: vec![BrushStroke {
                mode: BrushMode::Keep,
                radius: 0.04,
                points: vec![MaskPoint { x: 0.25, y: 0.75 }],
            }],
        };
        edited.edge_settings.edge_feather = 7;
        edited.metadata_policy = Some(MetadataOutputPolicy {
            preserve_metadata: true,
            preserve_gps: false,
            preserve_prompt: true,
        });
        edited.resize_override = Some(ResizeOverride {
            axis: crate::protocol::ResizeAxis::Width,
            value: 1_280,
            prevent_upscale: true,
        });
        edited.output_preview_key = Some("preview-v1-fixture".to_owned());
        edited.edit_preview_key = Some("preview-v1-edit-fixture".to_owned());
        edited.preview_cache_key = Some("cache-v1-fixture".to_owned());
        let snapshot = WorkspaceSnapshot {
            items: vec![edited, asset(&second, PersistedStatus::Failed)],
            settings: settings(),
        };
        save_to_connection(&mut connection, &snapshot).expect("save snapshot");

        let restored = load_from_connection(&connection)
            .expect("load snapshot")
            .expect("workspace exists");
        assert_eq!(restored.items.len(), 2);
        assert_eq!(restored.items[0].path, first.to_string_lossy());
        assert!(matches!(
            restored.items[0].mask_recipe.mode,
            MaskMode::Manual
        ));
        assert_eq!(restored.items[0].mask_recipe.strokes.len(), 1);
        assert_eq!(restored.items[0].edge_settings.edge_feather, 7);
        assert_eq!(
            restored.items[0].metadata_policy,
            Some(MetadataOutputPolicy {
                preserve_metadata: true,
                preserve_gps: false,
                preserve_prompt: true,
            })
        );
        assert_eq!(
            restored.items[0].resize_override,
            Some(ResizeOverride {
                axis: crate::protocol::ResizeAxis::Width,
                value: 1_280,
                prevent_upscale: true,
            })
        );
        assert_eq!(
            restored.items[0].output_preview_key.as_deref(),
            Some("preview-v1-fixture")
        );
        assert_eq!(
            restored.items[0].edit_preview_key.as_deref(),
            Some("preview-v1-edit-fixture")
        );
        assert_eq!(
            restored.items[0].preview_cache_key.as_deref(),
            Some("cache-v1-fixture")
        );
        assert_eq!(restored.items[1].status, PersistedStatus::Failed);
        assert_eq!(restored.settings.suffix, "_bg");

        std::fs::remove_file(first).expect("remove first fixture");
        std::fs::remove_file(second).expect("remove second fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }

    #[test]
    fn repeated_workspace_save_updates_only_changed_rows() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        migrate(&connection).expect("migrate database");
        let directory =
            std::env::temp_dir().join(format!("crystalcut-workspace-delta-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let first = directory.join("first.jpg");
        let second = directory.join("second.jpg");
        std::fs::write(&first, b"first").expect("write first fixture");
        std::fs::write(&second, b"second").expect("write second fixture");
        let snapshot = WorkspaceSnapshot {
            items: vec![
                asset(&first, PersistedStatus::Ready),
                asset(&second, PersistedStatus::Ready),
            ],
            settings: settings(),
        };
        save_to_connection(&mut connection, &snapshot).expect("save initial snapshot");

        let before_same = connection.total_changes();
        save_to_connection(&mut connection, &snapshot).expect("save unchanged snapshot");
        assert_eq!(connection.total_changes() - before_same, 1);

        let mut changed = snapshot.clone();
        changed.items[1].status = PersistedStatus::Failed;
        let before_change = connection.total_changes();
        save_to_connection(&mut connection, &changed).expect("save changed snapshot");
        assert_eq!(connection.total_changes() - before_change, 2);

        let removed = WorkspaceSnapshot {
            items: vec![changed.items[0].clone()],
            settings: changed.settings,
        };
        let before_remove = connection.total_changes();
        save_to_connection(&mut connection, &removed).expect("save removed snapshot");
        assert_eq!(connection.total_changes() - before_remove, 2);

        std::fs::remove_file(first).expect("remove first fixture");
        std::fs::remove_file(second).expect("remove second fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }

    #[test]
    fn reordered_workspace_items_save_without_unique_position_conflicts() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        migrate(&connection).expect("migrate database");
        let directory =
            std::env::temp_dir().join(format!("crystalcut-workspace-order-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let first = directory.join("first.jpg");
        let second = directory.join("second.jpg");
        std::fs::write(&first, b"first").expect("write first fixture");
        std::fs::write(&second, b"second").expect("write second fixture");

        let initial = WorkspaceSnapshot {
            items: vec![
                asset(&first, PersistedStatus::Ready),
                asset(&second, PersistedStatus::Ready),
            ],
            settings: settings(),
        };
        save_to_connection(&mut connection, &initial).expect("save initial order");

        let mut reordered = WorkspaceSnapshot {
            items: vec![initial.items[1].clone(), initial.items[0].clone()],
            settings: initial.settings.clone(),
        };
        save_to_connection(&mut connection, &reordered).expect("save reordered items");
        reordered.items[0].rotation = 90;
        reordered.items[0].edge_settings.edge_feather = 4;
        reordered.items[0].resize_override = Some(ResizeOverride {
            axis: crate::protocol::ResizeAxis::Width,
            value: 960,
            prevent_upscale: true,
        });
        save_to_connection(&mut connection, &reordered).expect("save edits after reordered items");

        let restored = load_from_connection(&connection)
            .expect("load reordered workspace")
            .expect("workspace exists");
        assert_eq!(restored.items[0].path, second.to_string_lossy());
        assert_eq!(restored.items[0].rotation, 90);
        assert_eq!(restored.items[0].edge_settings.edge_feather, 4);
        assert_eq!(
            restored.items[0].resize_override,
            reordered.items[0].resize_override
        );

        std::fs::remove_file(first).expect("remove first fixture");
        std::fs::remove_file(second).expect("remove second fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }

    #[test]
    fn in_flight_and_changed_items_are_restored_as_interrupted() {
        let directory =
            std::env::temp_dir().join(format!("crystalcut-interrupted-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let source = directory.join("photo.jpg");
        std::fs::write(&source, b"before").expect("write fixture");
        let mut processing = asset(&source, PersistedStatus::Processing);
        processing.edit_preview_key = Some("preview-v1-processing".to_owned());
        processing.preview_cache_key = Some("cache-v1-processing".to_owned());
        assert!(normalize_restored_asset(
            &mut processing,
            file_modified_ms(&source)
        ));
        assert_eq!(processing.status, PersistedStatus::Interrupted);
        assert!(processing.edit_preview_key.is_some());
        assert!(processing.preview_cache_key.is_some());

        let mut changed = asset(&source, PersistedStatus::Done);
        changed.edit_preview_key = Some("preview-v1-changed".to_owned());
        changed.preview_cache_key = Some("cache-v1-changed".to_owned());
        changed.size_bytes += 1;
        assert!(normalize_restored_asset(
            &mut changed,
            file_modified_ms(&source)
        ));
        assert_eq!(changed.status, PersistedStatus::Interrupted);
        assert!(changed.edit_preview_key.is_none());
        assert!(changed.preview_cache_key.is_none());

        std::fs::remove_file(source).expect("remove fixture");
        std::fs::remove_dir(directory).expect("remove fixture directory");
    }

    #[test]
    fn completed_item_is_preserved_only_while_its_output_exists() {
        let directory =
            std::env::temp_dir().join(format!("crystalcut-completed-{}", std::process::id()));
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

    #[test]
    fn app_preferences_round_trip_and_corruption_fallback() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        migrate(&connection).expect("migrate database");
        let preferences = AppPreferences {
            restore_workspace: false,
            language: LanguagePreference::Ja,
            default_settings: OutputSettings {
                format: OutputFormat::Webp,
                prefix: "default_".to_owned(),
                ..OutputSettings::default()
            },
            presets: vec![OutputPreset {
                id: "web-store".to_owned(),
                name: "웹 스토어".to_owned(),
                settings: OutputSettings {
                    format: OutputFormat::Webp,
                    ..OutputSettings::default()
                },
            }],
        };

        save_preferences_to_connection(&connection, &preferences).expect("save preferences");
        assert_eq!(
            load_preferences_from_connection(&connection).expect("load preferences"),
            preferences
        );

        connection
            .execute(
                "UPDATE app_preferences SET preferences_json = 'not-json' WHERE singleton = 1",
                [],
            )
            .expect("corrupt preferences fixture");
        assert_eq!(
            load_preferences_from_connection(&connection).expect("fallback preferences"),
            AppPreferences::default()
        );
    }

    #[test]
    fn legacy_preferences_without_language_use_system_locale() {
        let legacy = serde_json::json!({
            "defaultSettings": OutputSettings::default(),
            "restoreWorkspace": true,
            "presets": []
        });
        let preferences: AppPreferences =
            serde_json::from_value(legacy).expect("deserialize legacy preferences");
        assert_eq!(preferences.language, LanguagePreference::System);
    }

    #[test]
    fn version_one_database_migrates_without_losing_workspace_tables() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE workspace_state (
                    singleton INTEGER PRIMARY KEY,
                    settings_json TEXT NOT NULL,
                    saved_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE workspace_items (
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
                 PRAGMA user_version = 1;",
            )
            .expect("create version one database");

        migrate(&connection).expect("migrate version one database");
        let schema_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read schema version");
        assert_eq!(schema_version, SCHEMA_VERSION);
        assert_eq!(
            load_preferences_from_connection(&connection).expect("load default preferences"),
            AppPreferences::default()
        );
    }
}
