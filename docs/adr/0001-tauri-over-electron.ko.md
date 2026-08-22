# ADR 0001: Electron 대신 Tauri 2 사용

- 상태: 승인
- 결정일: 2026-08-22
- 범위: Windows/macOS 배경 제거 데스크톱 앱

## 배경

이 앱은 Figma 수준의 현대적인 UI뿐 아니라 수백~수천 장의 이미지 처리, 즉시 미리보기, 로컬 AI 추론, 리사이즈·회전·인코딩, 중단 복구를 동시에 제공해야 한다. 따라서 프레임워크 선택은 UI 개발 속도뿐 아니라 유휴 메모리, 네이티브 연동, 장시간 batch 안정성, 보안 경계까지 고려해야 한다.

## 비교

| 기준 | Electron | Tauri 2 | 이 제품의 판단 |
|---|---|---|---|
| UI 개발 | React/TypeScript와 단일 Chromium이라 빠르고 OS 간 일관성이 높음 | React/TypeScript 사용 가능하나 WebView2/WKWebView 차이 검증 필요 | Electron 근소 우세 |
| 시작 속도·기본 메모리 | Chromium과 Node.js runtime을 함께 배포 | OS WebView와 Rust binary 사용 | Tauri 우세 |
| AI·이미지 처리 | native module, worker thread 또는 별도 process가 필요 | Rust core 및 native sidecar와 자연스럽게 연결 | Tauri 우세 |
| 대량 처리 안정성 | main/renderer 차단을 피하도록 별도 utility process 설계 필요 | bounded Rust scheduler와 worker supervisor 구성에 적합 | Tauri 우세 |
| 초기 개발 속도 | JS/TS 전담 팀이라면 가장 빠름 | Rust와 typed IPC 역량 필요 | Electron 우세 |
| 렌더링 일관성 | 모든 플랫폼에 동일 계열 Chromium 포함 | 플랫폼 WebView별 visual regression 필요 | Electron 우세 |
| 배포 크기 | 상대적으로 큰 기본 runtime | UI shell이 작음. 단, AI model 크기는 양쪽 모두 별도 | Tauri 우세 |
| 권한 통제 | sandbox/context isolation/preload를 정확히 구성해야 함 | capability별 frontend 권한을 좁게 허용 가능 | Tauri 우세 |
| native 유지보수 | Electron ABI에 맞춘 native Node module 재빌드 가능성 | C API/Rust 또는 versioned sidecar로 격리 가능 | Tauri 근소 우세 |

## 결정

Tauri 2를 데스크톱 shell로 사용한다.

```text
React UI (WebView)
    │ typed command / event
Tauri Core (Rust)
    ├─ 파일·EXIF·출력 recipe
    ├─ 우선순위 queue와 SQLite 복구
    ├─ thumbnail·resize·encode
    └─ AI worker supervisor
             │ versioned local protocol
        Native AI Worker
             └─ ONNX Runtime → Windows ML/CoreML/CPU
```

AI inference를 Tauri core command 안에서 직접 장시간 실행하지 않는다. 별도 worker process로 격리하여 모델 또는 GPU provider가 실패해도 창, queue와 작업 기록을 유지한다. 전체 해상도 pixel buffer는 WebView IPC를 통과시키지 않는다.

## 이유

1. 이 앱의 주된 병목은 AI와 image codec이므로 native worker가 필요하다. Rust core와 worker를 중심으로 두면 파일 및 메모리 수명 관리가 명확하다.
2. 장시간 batch에서 UI runtime 이외의 기본 메모리 비용을 줄일 가치가 있다.
3. frontend에 필요한 파일·dialog·event 권한만 capability로 공개할 수 있다.
4. 설치 파일에 Chromium을 포함하지 않아 shell 배포 부담을 낮출 수 있다. AI model 자체의 크기는 별도 model manager로 관리한다.
5. 처리 엔진과 UI의 protocol을 versioning하면 미래에 모델이나 native 구현을 바꾸더라도 화면을 다시 만들 필요가 없다.

## 감수할 비용

- Windows WebView2와 macOS WKWebView에서 CSS, drag-and-drop, Canvas 결과를 각각 테스트한다.
- Rust 및 ONNX Runtime native packaging 역량이 필요하다.
- Electron보다 일부 데스크톱 plugin 생태계가 작으므로 핵심 기능은 직접 얇은 adapter로 감싼다.
- Tauri가 AI 추론 자체를 자동으로 빠르게 만들지는 않는다. 성능은 모델, provider, worker 및 메모리 pipeline에서 확보한다.

## Electron으로 재검토하는 조건

다음 조건 중 하나가 제품 우선순위가 되면 이 결정을 다시 검토한다.

- Rust 개발 인력을 확보할 수 없고 출시 속도가 절대적으로 우선일 때
- 모든 OS에서 완전히 같은 Chromium 동작이 제품 필수 조건일 때
- 기존 Node/Electron code 또는 native module 자산을 대량으로 재사용할 때

## 구현 규칙

- React renderer는 파일 시스템에 직접 접근하지 않는다.
- Tauri command payload는 Rust type에서 TypeScript type을 생성할 수 있는 형태로 유지한다.
- UI thread와 Tauri core event loop에서 decode, inference, encode를 실행하지 않는다.
- path 대신 가능하면 job id와 preview URL을 IPC로 전달한다.
- capability는 window와 명령별 최소 권한으로 유지한다.
- Windows/macOS visual regression과 installer test를 모두 CI release gate로 둔다.

## 근거 자료

- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron performance: https://www.electronjs.org/docs/latest/tutorial/performance
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron native Node modules: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- Tauri architecture: https://v2.tauri.app/concept/architecture/
- Tauri process model: https://v2.tauri.app/concept/process-model/
- Tauri capabilities: https://v2.tauri.app/security/capabilities/
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
