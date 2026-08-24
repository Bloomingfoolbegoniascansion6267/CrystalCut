use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

use ort::session::{builder::GraphOptimizationLevel, Session};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputeMode {
    #[default]
    Auto,
    Cpu,
    DirectMl,
    CoreMlAll,
    CoreMlCpuAndGpu,
    CoreMlCpuAndNeuralEngine,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ComputePreference {
    pub mode: ComputeMode,
    pub device_id: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeDevice {
    pub mode: ComputeMode,
    pub device_id: Option<i32>,
    pub label: String,
    pub dedicated_memory_bytes: Option<u64>,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeCapabilities {
    pub platform_backend: &'static str,
    pub devices: Vec<ComputeDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeRuntimeStatus {
    pub initialized: bool,
    pub requested: ComputePreference,
    pub effective_mode: ComputeMode,
    pub effective_device_id: Option<i32>,
    pub effective_label: String,
    pub fallback_reason: Option<String>,
}

impl Default for ComputeRuntimeStatus {
    fn default() -> Self {
        Self {
            initialized: false,
            requested: ComputePreference::default(),
            effective_mode: ComputeMode::Cpu,
            effective_device_id: None,
            effective_label: "CPU".to_owned(),
            fallback_reason: None,
        }
    }
}

pub struct SessionOutcome {
    pub session: Session,
    pub status: ComputeRuntimeStatus,
}

static LAST_RUNTIME_STATUS: OnceLock<Mutex<ComputeRuntimeStatus>> = OnceLock::new();

pub fn capabilities() -> ComputeCapabilities {
    let mut devices = vec![
        ComputeDevice {
            mode: ComputeMode::Auto,
            device_id: None,
            label: "Automatic".to_owned(),
            dedicated_memory_bytes: None,
            recommended: true,
        },
        ComputeDevice {
            mode: ComputeMode::Cpu,
            device_id: None,
            label: "CPU".to_owned(),
            dedicated_memory_bytes: None,
            recommended: false,
        },
    ];

    #[cfg(target_os = "windows")]
    devices.extend(windows_adapters());

    #[cfg(target_os = "macos")]
    devices.extend([
        ComputeDevice {
            mode: ComputeMode::CoreMlAll,
            device_id: None,
            label: "CoreML · All compute units".to_owned(),
            dedicated_memory_bytes: None,
            recommended: false,
        },
        ComputeDevice {
            mode: ComputeMode::CoreMlCpuAndNeuralEngine,
            device_id: None,
            label: "CoreML · CPU + Neural Engine".to_owned(),
            dedicated_memory_bytes: None,
            recommended: false,
        },
        ComputeDevice {
            mode: ComputeMode::CoreMlCpuAndGpu,
            device_id: None,
            label: "CoreML · CPU + GPU".to_owned(),
            dedicated_memory_bytes: None,
            recommended: false,
        },
    ]);

    ComputeCapabilities {
        platform_backend: if cfg!(target_os = "windows") {
            "DirectML"
        } else if cfg!(target_os = "macos") {
            "CoreML"
        } else {
            "CPU"
        },
        devices,
    }
}

pub fn runtime_status() -> ComputeRuntimeStatus {
    LAST_RUNTIME_STATUS
        .get_or_init(|| Mutex::new(ComputeRuntimeStatus::default()))
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

pub fn open_session(
    model_path: &Path,
    preference: &ComputePreference,
) -> Result<SessionOutcome, String> {
    let _ = ort::init().with_name("CrystalCut AI").commit();
    let resolved = resolve_preference(preference);
    let accelerated = !matches!(resolved.mode, ComputeMode::Cpu);
    let first_attempt = build_session(model_path, &resolved);
    let outcome = match first_attempt {
        Ok(session) => SessionOutcome {
            session,
            status: status_for(preference, &resolved, None),
        },
        Err(accelerator_error) if accelerated => {
            let cpu = ComputePreference {
                mode: ComputeMode::Cpu,
                device_id: None,
            };
            let session = build_session(model_path, &cpu).map_err(|cpu_error| {
                format!(
                    "hardware acceleration failed ({accelerator_error}); CPU fallback also failed ({cpu_error})"
                )
            })?;
            SessionOutcome {
                session,
                status: status_for(preference, &cpu, Some(accelerator_error)),
            }
        }
        Err(error) => return Err(error),
    };
    record_runtime_status(&outcome.status);
    Ok(outcome)
}

pub fn open_cpu_fallback(
    model_path: &Path,
    requested: &ComputePreference,
    reason: impl Into<String>,
) -> Result<SessionOutcome, String> {
    let cpu = ComputePreference {
        mode: ComputeMode::Cpu,
        device_id: None,
    };
    let session = build_session(model_path, &cpu)?;
    let status = status_for(requested, &cpu, Some(reason.into()));
    record_runtime_status(&status);
    Ok(SessionOutcome { session, status })
}

fn resolve_preference(preference: &ComputePreference) -> ComputePreference {
    if !matches!(preference.mode, ComputeMode::Auto) {
        return preference.clone();
    }
    #[cfg(target_os = "windows")]
    if let Some(device) = windows_adapters().into_iter().next() {
        return ComputePreference {
            mode: ComputeMode::DirectMl,
            device_id: device.device_id,
        };
    }
    #[cfg(target_os = "macos")]
    return ComputePreference {
        mode: ComputeMode::CoreMlAll,
        device_id: None,
    };
    #[allow(unreachable_code)]
    ComputePreference {
        mode: ComputeMode::Cpu,
        device_id: None,
    }
}

fn build_session(model_path: &Path, preference: &ComputePreference) -> Result<Session, String> {
    let threads = std::thread::available_parallelism()
        .map(|value| value.get().clamp(1, 8))
        .unwrap_or(2);
    let builder = Session::builder()
        .map_err(|error| format!("could not create ONNX session builder: {error}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| format!("could not configure ONNX optimization: {error}"))?
        .with_intra_threads(threads)
        .map_err(|error| format!("could not configure ONNX threads: {error}"))?;

    #[cfg(target_os = "windows")]
    let builder = if matches!(preference.mode, ComputeMode::DirectMl) {
        use ort::execution_providers::DirectMLExecutionProvider;
        builder
            .with_parallel_execution(false)
            .and_then(|builder| builder.with_memory_pattern(false))
            .and_then(|builder| {
                builder.with_execution_providers([DirectMLExecutionProvider::default()
                    .with_device_id(preference.device_id.unwrap_or(0))
                    .build()])
            })
            .map_err(|error| format!("could not initialize DirectML: {error}"))?
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = if matches!(
        preference.mode,
        ComputeMode::CoreMlAll
            | ComputeMode::CoreMlCpuAndGpu
            | ComputeMode::CoreMlCpuAndNeuralEngine
    ) {
        use ort::execution_providers::{CoreMLComputeUnits, CoreMLExecutionProvider};
        let units = match preference.mode {
            ComputeMode::CoreMlCpuAndGpu => CoreMLComputeUnits::CPUAndGPU,
            ComputeMode::CoreMlCpuAndNeuralEngine => CoreMLComputeUnits::CPUAndNeuralEngine,
            _ => CoreMLComputeUnits::All,
        };
        let cache_dir = model_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("coreml-cache");
        builder
            .with_execution_providers([CoreMLExecutionProvider::default()
                .with_compute_units(units)
                .with_model_cache_dir(cache_dir.to_string_lossy())
                .build()])
            .map_err(|error| format!("could not initialize CoreML: {error}"))?
    } else {
        builder
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    if !matches!(preference.mode, ComputeMode::Auto | ComputeMode::Cpu) {
        return Err(
            "the selected accelerator is not supported on this operating system".to_owned(),
        );
    }

    builder
        .commit_from_file(model_path)
        .map_err(|error| format!("could not load ONNX model: {error}"))
}

fn status_for(
    requested: &ComputePreference,
    effective: &ComputePreference,
    fallback_reason: Option<String>,
) -> ComputeRuntimeStatus {
    let effective_label = match effective.mode {
        ComputeMode::Auto => "Automatic".to_owned(),
        ComputeMode::Cpu => "CPU".to_owned(),
        ComputeMode::DirectMl => capabilities()
            .devices
            .into_iter()
            .find(|device| {
                device.mode == ComputeMode::DirectMl && device.device_id == effective.device_id
            })
            .map(|device| format!("DirectML · {}", device.label))
            .unwrap_or_else(|| format!("DirectML · GPU {}", effective.device_id.unwrap_or(0))),
        ComputeMode::CoreMlAll => "CoreML · All compute units".to_owned(),
        ComputeMode::CoreMlCpuAndGpu => "CoreML · CPU + GPU".to_owned(),
        ComputeMode::CoreMlCpuAndNeuralEngine => "CoreML · CPU + Neural Engine".to_owned(),
    };
    ComputeRuntimeStatus {
        initialized: true,
        requested: requested.clone(),
        effective_mode: effective.mode,
        effective_device_id: effective.device_id,
        effective_label,
        fallback_reason,
    }
}

pub(crate) fn record_runtime_status(status: &ComputeRuntimeStatus) {
    if let Ok(mut current) = LAST_RUNTIME_STATUS
        .get_or_init(|| Mutex::new(ComputeRuntimeStatus::default()))
        .lock()
    {
        *current = status.clone();
    }
}

#[cfg(target_os = "windows")]
fn windows_adapters() -> Vec<ComputeDevice> {
    use windows::Win32::Graphics::{
        Direct3D::D3D_FEATURE_LEVEL_11_0,
        Direct3D12::{D3D12CreateDevice, ID3D12Device},
        Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE},
    };

    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return Vec::new();
    };
    let mut devices = Vec::new();
    for index in 0_u32.. {
        let Ok(adapter): Result<IDXGIAdapter1, _> = (unsafe { factory.EnumAdapters1(index) })
        else {
            break;
        };
        let Ok(description) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        if description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let mut d3d_device: Option<ID3D12Device> = None;
        if unsafe { D3D12CreateDevice(&adapter, D3D_FEATURE_LEVEL_11_0, &mut d3d_device) }.is_err()
        {
            continue;
        }
        let length = description
            .Description
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(description.Description.len());
        let label = String::from_utf16_lossy(&description.Description[..length]);
        devices.push(ComputeDevice {
            mode: ComputeMode::DirectMl,
            device_id: Some(index as i32),
            label,
            dedicated_memory_bytes: Some(description.DedicatedVideoMemory as u64),
            recommended: false,
        });
    }
    devices.sort_by(|left, right| {
        right
            .dedicated_memory_bytes
            .unwrap_or(0)
            .cmp(&left.dedicated_memory_bytes.unwrap_or(0))
            .then_with(|| left.device_id.cmp(&right.device_id))
    });
    if let Some(recommended) = devices.first_mut() {
        recommended.recommended = true;
    }
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_preference_defaults_to_auto() {
        assert_eq!(ComputePreference::default().mode, ComputeMode::Auto);
        assert_eq!(ComputePreference::default().device_id, None);
    }

    #[test]
    fn compute_preference_deserializes_from_empty_legacy_object() {
        let preference: ComputePreference = serde_json::from_str("{}").unwrap();
        assert_eq!(preference, ComputePreference::default());
    }

    #[test]
    #[ignore = "requires the checked-in model and a working platform accelerator"]
    fn accelerated_u2net_session_smoke_test() {
        let model = Path::new("../models/cache/u2netp.onnx");
        assert!(
            model.is_file(),
            "missing smoke-test model: {}",
            model.display()
        );
        let preference = ComputePreference::default();
        let outcome = open_session(model, &preference).expect("session must load");
        assert!(!matches!(outcome.status.effective_mode, ComputeMode::Cpu));
    }
}
