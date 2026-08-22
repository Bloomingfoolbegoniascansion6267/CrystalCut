# Clearcut

Windows와 macOS에서 이미지 배경을 로컬로 제거하고 일괄 변환하는 Tauri 2 데스크톱 앱입니다. 현재는 실제 파일을 선택해 ONNX 추론부터 PNG/WebP 저장까지 완료할 수 있는 핵심 end-to-end vertical slice가 구현되어 있습니다.

## 현재 구현

- React/TypeScript 기반 3단 작업 화면과 즉시 원본·결과·비교 미리보기
- 파일·폴더 drag-and-drop 및 native picker, Rust 기반 이미지 유효성·크기 검사
- UI와 분리된 동일 실행 파일의 `--worker` 모드 및 버전이 명시된 JSONL protocol
- 최초 처리 시 U2NetP 모델 다운로드, 파일 크기·SHA-256 검증, 안전한 임시 파일 교체
- 로컬 ONNX Runtime 추론, 기존 알파 보존, 회전 및 비율/긴 변 기준 크기 변경
- PNG 압축 강도와 WebP 손실/무손실·품질 설정
- 원본과 같은 폴더, 하위 폴더, 사용자 지정 폴더 저장 및 접두사·접미사
- EXIF 촬영일·카메라·렌즈 및 순번을 조합하는 안전한 파일명 템플릿과 실시간 미리보기
- 최대 3개 대표 파일의 실제 encoder sample을 이용한 출력 용량·증감률 사전 예측
- 출력 충돌 시 기존 파일을 덮어쓰지 않고 `이름 (2).png` 방식으로 자동 회피
- 항목별 처리 상태, 전체 진행률, 결과 용량·소요 시간 표시
- 현재 파일 완료 후 안전하게 중단하는 batch 취소와 실패·취소 항목만 다시 처리하는 재시도
- worker 통신 종료 시 새 프로세스로 1회 자동 복구하며 완료 직후 응답 손실도 중복 저장 없이 회수
- SQLite WAL에 작업 목록·출력 설정·처리 상태를 자동 저장하고 앱 재시작 시 파일을 재검증해 복구

U2NetP는 처리 파이프라인과 배포 구조를 빠르게 검증하기 위한 경량 모델입니다. 머리카락·반투명 물체 같은 최종 제품 품질은 BiRefNet 등 후보 모델을 동일 protocol 뒤에서 비교한 후 결정합니다. GPU provider와 모델 품질 benchmark는 다음 단계입니다.

파일명 템플릿은 `{name}`, `{prefix}`, `{suffix}`, `{taken:yyMMdd_HHmmss}`, `{seq:03}`, `{camera}`, `{lens}`를 지원합니다. 촬영일·카메라·렌즈 정보가 없으면 각각 `undated`, `unknown-camera`, `unknown-lens`를 사용하므로 batch 결과가 임의로 달라지지 않습니다. GPS EXIF는 읽거나 UI에 노출하지 않습니다.

## 개발 실행

```powershell
npm install
npm run tauri dev
```

프론트엔드만 확인하려면 다음 명령을 사용합니다. 이 모드에서는 native 파일 처리 기능을 사용할 수 없습니다.

```powershell
npm run dev
```

첫 실제 처리 때 모델을 앱 데이터 폴더에 내려받습니다. 개발 저장소의 `models/cache/`는 로컬 검증용이며 Git에서 제외됩니다. 모델 출처·해시·입력 규격은 [`models/manifest/u2netp.json`](models/manifest/u2netp.json)에 고정되어 있습니다.

## 검사

```powershell
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --no-bundle
```

## 문서

- [제품·아키텍처 계획](docs/PRODUCT_ARCHITECTURE_PLAN.ko.md)
- [현재 구현 구조와 검증 결과](docs/IMPLEMENTATION_STATUS.ko.md)
- [ADR 0001: Electron 대신 Tauri 2 사용](docs/adr/0001-tauri-over-electron.ko.md)
