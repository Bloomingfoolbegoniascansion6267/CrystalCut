# Clearcut

Windows와 macOS에서 이미지 배경을 로컬로 제거하고 일괄 변환하는 Tauri 2 데스크톱 앱입니다.

현재 구현 범위는 첫 vertical slice입니다.

- React/TypeScript 기반 3단 작업 화면
- 파일 및 폴더 drag-and-drop/picker
- Rust에서 지원 이미지 검사와 크기 확인
- native 영역에서 축소한 원본 미리보기
- PNG/WebP, resize, 회전, 저장 위치와 파일명 설정 UI
- 출력 경로 사전 검증 및 미리보기 계약

AI worker, 실제 alpha 생성, 최종 encoder와 영속 queue는 다음 단계에서 연결합니다. UI는 완료되지 않은 처리를 성공으로 표시하지 않습니다.

## 개발 실행

```powershell
npm install
npm run tauri dev
```

프론트엔드만 확인하려면 다음 명령을 사용합니다. 이 모드에서는 브라우저 파일 picker와 원본 미리보기만 동작합니다.

```powershell
npm run dev
```

## 검사

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 문서

- [제품·아키텍처 계획](docs/PRODUCT_ARCHITECTURE_PLAN.ko.md)
- [ADR 0001: Electron 대신 Tauri 2 사용](docs/adr/0001-tauri-over-electron.ko.md)
