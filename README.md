<p align="center">
  <img src="assets/app-icon.svg" alt="CrystalCut" width="112" />
</p>

<h1 align="center">CrystalCut</h1>

<p align="center">
  Fast, local-first background removal and batch image conversion for Windows and macOS.
</p>

<p align="center">
  <img alt="Version 1.0.2" src="https://img.shields.io/badge/version-1.0.2-7057e8" />
  <img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/engine-Rust-000000?logo=rust&logoColor=white" />
  <img alt="Local processing" src="https://img.shields.io/badge/processing-local--first-2f855a" />
  <img alt="9 languages" src="https://img.shields.io/badge/languages-9-4f46e5" />
</p>

<p align="center">
  <a href="../../releases/latest"><strong>Download the latest release</strong></a>
  ·
  <a href="#quick-start">Build from source</a>
  ·
  <a href="#한국어-안내">한국어 안내</a>
</p>

CrystalCut turns background removal into a dependable desktop workflow: add one image or a whole folder, review the result instantly, refine the object when needed, and export optimized PNG or WebP files with one click. Images stay on your computer; only the pinned AI model files are downloaded on first use.

![CrystalCut workspace](docs/assets/crystalcut-workspace.png)

## Why CrystalCut?

| | Capability |
| --- | --- |
| **Private by design** | Background removal, previews, brush masks, resizing, metadata handling and encoding run locally. Images are not uploaded. |
| **Fast batch workflow** | Drag in files or folders, preload thumbnails, process a queue, cancel safely, and retry only unfinished items. |
| **Editable AI results** | Use automatic removal, SlimSAM object selection, a keep/remove brush, undo/redo and per-file edge controls. |
| **More than a remover** | Convert without removing the background, rotate, resize, compress and rename an entire batch. |
| **Predictable output** | Preview names and estimated sizes, avoid accidental overwrites, and save complete output presets. |
| **Native desktop feel** | Tauri 2 shell, Rust processing engine, native pickers, app-specific context menus and no release console window on Windows. |

## A three-step workflow

1. **Add images** — choose JPEG, PNG or WebP files, select a folder, paste, or drag and drop.
2. **Review and refine** — inspect the live result, zoom, pan, rotate, view the mask, or drag the comparison slider across the original and edited image.
3. **Export once or in bulk** — remove backgrounds or convert only, then apply format, quality, size, metadata, destination and naming rules to the queue.

## Editing and preview tools

- Automatic U2NetP background removal with a verified, pinned model download.
- SlimSAM-assisted object selection using include/exclude marks.
- Manual selection from an empty mask and brush refinement over an AI result.
- Restore/erase brushes, adjustable brush size, undo, redo and clear actions.
- Original, result, mask and split comparison views.
- Wheel zoom, toolbar zoom, fit-to-screen and drag-to-pan navigation.
- Live per-file edge preview for smoothing, feathering, mask expansion/contraction, faint-pixel trimming, contrast and original-alpha preservation.

## Batch output

### Formats and size

- Input: **JPEG, PNG, WebP**
- Output: **PNG, lossy WebP, lossless WebP**
- Keep original dimensions, resize by percentage, or set the long edge in pixels.
- Prevent upscaling of smaller source images.
- Tune WebP quality or PNG compression effort and see an estimated size change before export.
- Switch to **Convert only** to keep the background while applying rotation, resize, format and compression.

### Destination and naming

- Save beside each original, into a new neighboring folder, or into one chosen folder.
- Add a prefix or suffix, or build a reusable file-name template.
- Available tokens: `{name}`, `{prefix}`, `{suffix}`, `{taken:yyMMdd_HHmmss}`, `{seq:03}`, `{camera}`, `{lens}`.
- Missing EXIF values resolve deterministically to `undated`, `unknown-camera` and `unknown-lens`.
- Existing files are never overwritten silently; CrystalCut creates `name (2).png`, and so on.
- Save format, quality, size, destination, naming and metadata as an output preset.

### Metadata and privacy

When metadata preservation is enabled, CrystalCut writes only the capture date, camera and lens to the output. GPS and the full original EXIF block are never copied. Location EXIF is not stored in the job database.

## Languages

CrystalCut follows the operating-system language by default and can be changed instantly in Settings.

- 한국어
- English
- 日本語
- 简体中文
- 繁體中文
- Español
- Deutsch
- Français
- Português (Brasil)

All 355 interface messages—including toasts, errors, confirmations, context menus and accessibility labels—are covered in every supported locale. The build fails if a locale is missing a message.

## Download and installation

Open [GitHub Releases](../../releases/latest) and choose the package for your computer:

- **Windows x64:** the `setup.exe` installer is the simplest option; `.msi` is also published for managed environments.
- **macOS Apple Silicon:** for M1, M2, M3, M4 and newer Apple chips.
- **macOS Intel:** for older Intel-based Macs.

Current community builds are unsigned. Windows SmartScreen or macOS Gatekeeper may therefore ask you to confirm the first launch. Code signing is intentionally kept separate from the public build workflow until signing credentials are configured.

The removal model and SlimSAM files are not bundled into the installer. They are downloaded only when needed, verified against pinned size/hash metadata, and cached in the application data folder. After installation, first-time AI use therefore requires an internet connection.

## Architecture

```text
React + TypeScript UI
        │  typed Tauri commands / events
        ▼
Rust desktop coordinator ─── SQLite workspace and preferences
        │  versioned JSONL over stdio
        ▼
Same executable in --worker mode
        ├── ONNX Runtime inference (U2NetP / SlimSAM)
        ├── mask and edge processing
        └── rotate, resize, metadata and PNG/WebP encoding
```

The UI process never performs heavy image work. The worker can be restarted once after an unexpected communication failure, and completed output is recovered without saving a duplicate. Workspace state uses SQLite WAL and is revalidated when the app reopens.

## Quick start

### Prerequisites

- Node.js 20 or newer (CI uses Node.js 22)
- Rust stable toolchain
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/) for Windows or macOS

### Run the desktop app

```powershell
git clone <your-fork-or-repository-url>
cd CrystalCut
npm ci
npm run tauri dev
```

To inspect only the React interface in a browser:

```powershell
npm run dev
```

Native file inspection, AI inference and export require the Tauri desktop runtime and are intentionally unavailable in browser-only mode.

## Validation

```powershell
npm run build
npm run check:release
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run build:desktop
```

- `npm run build:desktop` creates an unbundled production executable for local verification.
- `npm run build:bundle` creates the installers supported by the current operating system.
- Do not run `cargo build --release` directly: the build guard prevents a release binary from accidentally retaining the development-server URL.

## Publishing a GitHub release

The repository includes [`.github/workflows/release.yml`](.github/workflows/release.yml). Pushing a version tag builds Windows x64, macOS Apple Silicon and macOS Intel packages in parallel, creates a GitHub Release and uploads each installer.

Before tagging, keep the version identical in these three files:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Then validate and push the matching tag:

```powershell
npm run check:release
git tag v1.0.2
git push origin v1.0.2
```

The workflow rejects a tag that does not match the application version and uploads installers as GitHub Release assets. The workflow uses the official Tauri release action pinned to an explicit version; add Windows and Apple signing secrets later without committing certificates or passwords.

> Intel macOS compatibility: CrystalCut pins `ort` to `2.0.0-rc.10`, the newest release that still provides an `x86_64-apple-darwin` ONNX Runtime binary. Do not upgrade it independently while Intel macOS remains in the release matrix.

## Project layout

```text
assets/                 Brand source artwork
docs/                   Product, UX, model and localization decisions
models/manifest/        Pinned background-removal model metadata
scripts/                Build and consistency checks
src/                    React UI and locale catalogs
src-tauri/src/          Rust coordinator, worker, inference and image pipeline
.github/workflows/      Cross-platform GitHub Release automation
```

## Current limitations and roadmap

- U2NetP is the lightweight baseline. Hair, glass, fur and other difficult edges still need broader BiRefNet-style model benchmarking.
- Processing is CPU-first; DirectML/CoreML selection remains disabled until quality and recovery behavior are validated.
- The first model download can take time depending on the network.
- Public builds are not yet code-signed or notarized.
- Installer and model licenses must be reviewed together with [third-party notices](THIRD_PARTY_NOTICES.md) before commercial redistribution.

Well-scoped bug reports are welcome. For processing issues, include the OS, CPU architecture, CrystalCut version, model status and the diagnostics shown in Settings—without attaching private source images unless you choose to share them.

## License

CrystalCut source code is available under the [Apache License 2.0](LICENSE). Third-party software and AI model assets retain their own licenses; review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before redistribution. The CrystalCut name and logo are not granted as trademarks by the source-code license.

## Documentation

- [Product and architecture plan (Korean)](docs/01_PRODUCT_ARCHITECTURE_PLAN.ko.md)
- [Implementation status (Korean)](docs/02_IMPLEMENTATION_STATUS.ko.md)
- [Manual masks and settings plan (Korean)](docs/03_MANUAL_MASK_AND_SETTINGS_PLAN.ko.md)
- [SAM integration plan (Korean)](docs/04_SAM_INTEGRATION_PLAN.ko.md)
- [Third-party AI model notices (Korean)](docs/05_THIRD_PARTY_MODELS.ko.md)
- [UI/UX audit (Korean)](docs/06_UI_UX_AUDIT_PLAN.ko.md)
- [Localization implementation plan (Korean)](docs/07_LOCALIZATION_IMPLEMENTATION_PLAN.ko.md)
- [ADR: Tauri instead of Electron (Korean)](docs/adr/01_tauri-over-electron.ko.md)

## 한국어 안내

CrystalCut은 Windows와 macOS에서 동작하는 로컬 우선 배경 제거·일괄 이미지 변환 앱입니다. 이미지나 폴더를 추가한 뒤 자동 배경 제거 결과를 즉시 확인하고, 필요할 때 AI 객체 선택 또는 유지·제거 브러시로 보정할 수 있습니다. 배경을 지우지 않고 회전·크기·형식·압축만 일괄 적용하는 변환 모드도 제공합니다.

- 원본·결과·마스크·드래그 비교 화면과 확대·축소·이동
- 파일별 가장자리 감지 설정과 실시간 미리보기
- PNG/WebP, 화질·압축, 비율·긴 변 크기 변경
- 같은 폴더·새 폴더·지정 폴더 저장과 EXIF 기반 파일명
- 출력 프리셋, 작업 자동 복구, 안전한 취소·재시도
- 촬영일·카메라·렌즈 선택 보존, GPS 항상 제외
- 시스템 언어 자동 감지 및 9개 언어 완전 지원

이미지는 외부 서버로 전송되지 않습니다. 최초 AI 기능 사용 시 검증된 모델 파일만 내려받으며, 이후에는 앱 데이터 폴더의 로컬 캐시를 사용합니다. 일반 사용자는 [Releases](../../releases/latest)에서 운영체제에 맞는 설치 파일을 받으면 됩니다.
