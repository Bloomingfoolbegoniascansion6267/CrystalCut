# 배경 제거 데스크톱 앱 제품·아키텍처 계획

작성일: 2026-08-22  
대상: Windows / macOS 신규 데스크톱 애플리케이션

> **결정 상태:** 2026-08-22에 Electron과 Tauri를 비교한 뒤 **Tauri 2**를 최종 선택했다. 상세 근거는 `docs/adr/0001-tauri-over-electron.ko.md`에 기록한다.

## 1. 제품 정의

이 제품의 핵심 문장은 다음과 같다.

> 파일이나 폴더를 놓고 한 번 누르면, 원본을 안전하게 보존하면서 배경이 투명한 이미지를 빠르게 일괄 저장한다.

기본 사용자는 세 가지 결정만 하면 된다.

1. 이미지 선택
2. `배경 지우기` 클릭
3. 결과 폴더 열기

고급 설정은 같은 화면의 우측 Inspector에서 필요할 때만 펼친다. 단순 모드와 고급 모드를 별도 제품처럼 분리하지 않고, 기본값이 이미 올바르게 선택된 progressive disclosure 방식으로 설계한다.

### 제품 차별점

- remove.bg 데스크톱 앱의 파일/폴더 드롭, 일괄 처리, 공통 설정 일괄 적용 흐름
- 반디뷰의 빠른 이미지 목록 탐색, 즉시 미리보기, 변환 및 EXIF 확인 흐름
- 로컬 우선 처리로 개인정보 보호, 인터넷 연결 없이도 동작
- 현재 선택 파일을 최우선 처리하여 체감 대기시간 최소화
- 출력 전 실제 인코딩에 기반한 용량 및 절감률 예상
- EXIF 기반 동적 파일명과 충돌 없는 안전한 저장
- 처리 중에도 파일 추가, 재정렬, 취소, 개별 재시도 가능

## 2. 권장 기술 결정

### 최종 권장안

| 영역 | 선택 | 이유 |
|---|---|---|
| 데스크톱 셸 | Tauri 2 | Windows/macOS 네이티브 WebView 사용, 작은 UI 번들, Rust 코어와 명확한 권한 경계 |
| UI | React + TypeScript + Vite | 복잡한 목록/Inspector/Canvas 상태를 빠르게 개발하고 검증하기 좋음 |
| 스타일 | CSS variables 기반 자체 디자인 시스템 | Figma 같은 정밀한 토큰, 다크/라이트 테마, 플랫폼별 미세 조정 가능 |
| 상태 | Zustand(화면 상태) + TanStack Query(비동기 명령/캐시) | 전역 상태 과잉을 막고 작업 이벤트를 예측 가능하게 관리 |
| 앱 코어 | Rust | 파일 I/O, 큐, 메타데이터, IPC, 저장 안정성을 하나의 타입 시스템 안에서 관리 |
| AI 실행 | 별도 네이티브 worker + ONNX Runtime | UI 멈춤과 AI 크래시를 격리하고 GPU/CPU fallback을 독립적으로 운영 |
| 이미지 처리 | libvips 계층을 감싼 Rust 서비스 | 대용량 이미지의 스트리밍 처리와 낮은 메모리 사용에 유리; 교체 가능한 인터페이스로 격리 |
| 로컬 DB | SQLite WAL | 큐, preset, 최근 작업, 재시작 복구를 작은 단일 파일로 처리 |
| 테스트 | Vitest + Playwright + Rust unit/integration | UI, 명령 계약, 실제 파일 파이프라인을 층별 검증 |

Electron은 라이브러리 생태계와 채용 면에서는 편하지만, 이 제품처럼 장시간 대량 이미지 처리를 수행하는 도구에서는 UI 런타임의 메모리 비용이 커진다. Flutter는 좋은 대안이나 복잡한 데스크톱 drag-and-drop, Web 기술 기반 디자인 인력 활용, 네이티브 추론 연결을 함께 고려하면 Tauri가 더 적합하다.

Python `rembg`는 모델 품질과 전처리 방식을 비교하는 초기 실험 도구로만 사용한다. 제품 배포본은 Python 런타임과 별도 서버를 포함하지 않고 ONNX Runtime 기반 네이티브 worker로 만든다. 이로써 시작 시간, 설치 크기, 서브프로세스 관리 문제를 줄인다.

### AI 엔진 전략

`BackgroundRemovalProvider` 인터페이스를 먼저 정의하고 구현을 교체 가능하게 만든다.

```text
BackgroundRemovalProvider
├─ LocalFast      빠른 로컬 모델
├─ LocalQuality   선택 설치하는 고품질 로컬 모델
└─ CloudQuality   향후 선택 기능, 명시적 동의가 있을 때만 업로드
```

- MVP 기본 후보: BiRefNet general lite 계열 ONNX 모델
- 고품질 후보: 더 큰 BiRefNet general/matting 모델을 선택 다운로드
- Windows: Windows ML/호환 GPU provider 우선, CPU fallback
- macOS: CoreML Execution Provider 우선, CPU fallback
- 첫 실행 시 하드웨어 점검 후 가장 빠른 provider를 자동 선택하되 환경 설정에서 변경 가능
- 모델은 앱 업데이트와 분리하고 `model-manifest.json`, SHA-256, 버전, 출처, 라이선스를 기록
- 코드 라이선스와 모델 weight 라이선스는 별개로 법무 검토한다. 검토가 끝나기 전에는 모델을 상용 설치 파일에 포함하지 않는다.

## 3. 사용자 경험

### 기본 화면

```text
┌────────────────────────────────────────────────────────────────────┐
│ Logo  파일 추가  폴더 추가                 설정  도움말            │
├───────────────┬─────────────────────────────┬──────────────────────┤
│ 파일 목록     │ 미리보기 Canvas             │ 출력 Inspector       │
│               │                             │                      │
│ thumbnail     │  원본 | 결과 | 비교 슬라이더 │ PNG / WebP           │
│ thumbnail     │  checkerboard / 흰색 / 검정  │ 크기 / 회전          │
│ thumbnail     │  zoom / pan / fit           │ 품질 / 예상 용량      │
│ ...           │                             │ 저장 위치 / 파일명   │
├───────────────┴─────────────────────────────┴──────────────────────┤
│ 24개 · 예상 84 MB → 21–29 MB       [24개 배경 지우고 저장]        │
└────────────────────────────────────────────────────────────────────┘
```

폭이 좁아지면 Inspector는 drawer가 되고 파일 목록은 접을 수 있다. Canvas가 항상 가장 넓은 영역을 차지한다.

### 처음부터 끝까지의 기본 흐름

1. 시작 화면 전체를 drop zone으로 사용한다.
2. 파일 또는 폴더가 들어오면 EXIF orientation을 반영한 썸네일을 즉시 보여준다.
3. 첫 파일을 자동 선택하고 원본 미리보기를 먼저 표시한다.
4. 선택 파일의 저해상도 배경 제거를 최우선 실행하여 비교 미리보기를 갱신한다.
5. 기본값은 `PNG / 원본 크기 / 같은 폴더의 Removed Background 하위 폴더 / 원본명_bg`이다.
6. 사용자가 하단의 한 개 primary button을 누르면 전체 작업을 시작한다.
7. 파일별 진행률, 전체 ETA, 성공/실패 수를 계속 표시한다.
8. 완료 후 `폴더 열기`, `실패 항목만 재시도`, `새 작업`을 제공한다.

원본 덮어쓰기는 기본적으로 금지한다. 같은 경로와 이름이 생기면 자동 번호 추가가 기본이며, 덮어쓰기는 고급 설정에서 명시적으로 선택해야 한다.

### 상호작용 원칙

- 파일을 클릭하면 원본은 즉시, 처리 결과는 캐시가 있으면 즉시 표시
- 선택 파일, 화면에 보이는 thumbnail, 나머지 batch 순으로 작업 우선순위 지정
- Space: 원본/결과 임시 전환
- `[` / `]`: 좌우 90도 회전, `0`: 화면 맞춤, `1`: 100%, Delete: 목록에서 제거
- 여러 항목 선택 후 설정 변경 시 `선택 항목에 적용`과 `전체에 적용`을 구분
- 처리 상태는 색상만으로 전달하지 않고 아이콘과 텍스트를 함께 사용
- Undo/Redo는 최소한 회전, resize, 파일명 template, 개별 설정 override에 제공

### 시각 디자인 방향

- 4px 기반 spacing, 8/12px radius, 얇은 neutral border, 절제된 shadow
- 장식적 glass 효과보다 정보 계층, 선명한 typography, 빠른 motion을 우선
- 기본 13–14px UI 글자, 숫자/용량은 tabular numerals 사용
- accent 색은 실행/선택에만 쓰고 처리 성공, 경고, 오류 색과 분리
- 120–180ms의 짧은 transition, `prefers-reduced-motion` 지원
- Windows와 macOS의 title bar/traffic light 영역을 각각 자연스럽게 처리
- WCAG AA 대비, 키보드 focus ring, screen reader label을 출시 조건에 포함

## 4. 기능 우선순위와 완료 조건

### P0 — 첫 공개 베타에 반드시 포함

| 기능 | 완료 조건 |
|---|---|
| 파일/폴더 입력 | drag-and-drop 및 picker, 중복 경로 감지, 지원하지 않는 파일을 이유와 함께 표시 |
| 입력 포맷 | JPEG, PNG, WebP; EXIF orientation 자동 적용 |
| 배경 제거 | 로컬 빠른 모델, GPU 자동 감지, CPU fallback, 실패 파일 개별 재시도 |
| 즉시 미리보기 | 파일 선택 즉시 원본 표시, 처리 후 checkerboard 결과 및 before/after slider |
| 일괄 처리 | 1개~1만 개 큐, pause/resume/cancel, 앱 재시작 후 미완료 작업 복구 |
| 회전 | 90도 단위 비파괴 회전, EXIF 회전과 수동 회전 순서가 일관됨 |
| 크기 변경 | 원본/퍼센트/가로/세로/긴 변 기준, 비율 잠금, 확대 금지 기본값 |
| 출력 | 투명 PNG, 투명 WebP(lossy/lossless), 색상 배경 합성 옵션 |
| 품질/압축 | WebP quality와 alpha quality, PNG compression effort를 의미에 맞게 분리 |
| 저장 위치 | 원본과 같은 폴더, 원본 아래 새 폴더, 사용자가 지정한 한 폴더 |
| 이름 규칙 | prefix/suffix, EXIF 촬영일 token, 순번, 충돌 미리보기 및 안전한 자동 rename |
| 용량 예상 | 선택 파일 실인코딩 예상값과 batch 표본 기반 범위를 표시, 계산 중 상태 제공 |
| 안전한 저장 | 임시 파일 작성 후 atomic rename, 원본 보호, 디스크 공간 사전 확인 |

### P1 — 정식 1.0

- 빠른 모델/고품질 모델 전환 및 모델 관리자
- edge refine: foreground decontamination, feather, threshold, mask expand/shrink
- 브러시로 유지/삭제 영역을 짧게 보정하고 개별 파일에만 저장
- resize mode: fit, fill/crop, contain/pad 및 canvas 정렬
- 배경색/사용자 배경 이미지 합성
- HEIC/AVIF 입력 및 AVIF 출력(플랫폼 codec와 라이선스 검토 후)
- preset 저장, 최근 preset, preset export/import
- EXIF 상세 보기와 metadata 보존 정책
- Finder/Explorer 컨텍스트 메뉴의 `배경 지우기`
- signed auto-update, crash recovery, opt-in 진단 보고

### P2 — 후속 버전

- RAW 입력, PSD 내보내기, drag-out export
- 감시 폴더 자동 처리
- CLI 및 automation API
- 선택적 cloud high-quality provider
- 팀 preset 및 업무용 라이선스 관리
- 사진 유형 자동 분류 후 모델/preset 자동 선택

## 5. 출력 및 이름 규칙

### 크기 변경

AI mask는 적절한 모델 입력 크기로 계산하되 최종 alpha를 원본 좌표에 복원한다. 수동 회전과 최종 resize는 mask 합성 뒤 수행한다. 그래야 작은 최종 출력에서도 가장자리 품질을 유지한다.

설정 항목:

- 원본 크기 유지
- 비율: 25%, 50%, 75%, 사용자 지정
- 가로/세로/긴 변/짧은 변의 최대 픽셀
- 정확한 canvas 크기와 fit/cover/contain
- 확대 허용 여부(기본 꺼짐)
- 보간법은 `자동`이 기본이며 고급에서 Lanczos 등 선택 가능

### 포맷과 압축

- PNG는 lossless이므로 `화질` slider를 보여주지 않는다. 대신 `빠른 저장 ↔ 작은 파일` compression effort를 제공한다.
- WebP는 `손실 압축 quality 1–100`과 `무손실`을 구분한다. 투명 영역의 alpha quality는 고급 설정으로 둔다.
- JPG는 투명도를 보존할 수 없으므로 선택 시 반드시 배경색을 요구한다. P0에서는 출력 포맷 목록에서 제외해도 된다.
- 색상 profile은 sRGB 변환을 기본으로 하되 `원본 ICC 유지`를 고급 설정으로 제공한다.
- GPS EXIF는 개인정보 보호를 위해 기본 제거하고, 촬영일/카메라 등의 보존 여부를 별도 선택하게 한다.

### 예상 용량

예상값을 단순 공식으로 계산하지 않는다. 이미지 내용과 alpha 경계에 따라 압축률이 크게 달라지기 때문이다.

1. 현재 선택 파일은 처리 결과를 실제 설정으로 메모리 인코딩하여 정확한 예상 바이트를 표시한다.
2. 설정을 움직이는 동안 250ms debounce 후 다시 계산한다.
3. batch는 파일 크기/해상도 구간별 표본 3–10개를 인코딩하여 `예상 21–29 MB, 66–75% 감소`처럼 범위로 표시한다.
4. 표본 처리가 끝나기 전에는 `계산 중` 또는 낮은 신뢰도임을 표시한다.
5. 실제 저장 후 예상과 실제 차이를 기록해 다음 표본 선택을 개선한다.

### 파일명 template

가독성 있는 token 방식으로 시작한다.

```text
{prefix}{taken:yyMMdd_HHmmss}_{name}{suffix}_{seq:03}.{ext}
```

지원 token:

- `{name}`: 확장자를 뺀 원본 이름
- `{ext}`: 선택한 출력 확장자
- `{taken:yyMMdd_HHmmss}`: EXIF DateTimeOriginal
- `{modified:yyMMdd}`: 파일 수정일
- `{camera}` / `{lens}`: 정리된 EXIF 값
- `{width}` / `{height}`: 최종 출력 픽셀
- `{seq:03}`: 001 형태의 순번
- `{prefix}` / `{suffix}`: 사용자가 직접 지정한 문자열

촬영일이 없으면 `촬영일 → 파일 생성일 → 수정일` fallback을 제공하고, UI에서 어떤 값을 사용했는지 tooltip으로 보여준다. 금지 문자 제거, Unicode normalization, 예약 파일명, 대소문자 충돌을 Windows/macOS 양쪽 규칙으로 사전 검사한다. 저장 전 첫 5개와 충돌 항목을 미리 보여준다.

## 6. 내부 아키텍처

### 프로세스와 데이터 흐름

```text
React UI (WebView)
    │ 작은 command / progress event만 IPC
    ▼
Tauri Core (Rust)
    ├─ Project/Settings/SQLite
    ├─ Priority Scheduler
    ├─ Thumbnail & Metadata service
    ├─ Image transform/encode service
    └─ Worker supervisor
             │ 로컬 socket, job id와 파일/공유 버퍼 참조
             ▼
       AI Worker Process
       ├─ Model manager
       ├─ ONNX Runtime
       ├─ Windows ML / CoreML / CPU adapter
       └─ Mask post-processing
```

원본 이미지 byte와 전체 해상도 RGBA buffer를 WebView IPC로 보내지 않는다. UI에는 thumbnail 또는 preview용 파일 URL만 전달한다. 전체 해상도 데이터는 native 영역에서 decode → inference → composite → resize → encode까지 처리한다.

### 처리 파이프라인

```text
discover
→ metadata + EXIF orientation
→ thumbnail cache
→ preview inference (선택 파일 우선)
→ full-resolution decode
→ model preprocess
→ inference
→ alpha post-process
→ original resolution composite
→ manual rotation / resize
→ metadata policy
→ encode to temporary file
→ validate
→ atomic rename
```

AI가 원본 전체 해상도를 그대로 입력받는다는 의미는 아니다. 모델은 고정 또는 제한된 크기로 추론하고, alpha mask를 원본 해상도로 복원한 뒤 edge-aware 처리를 한다. 초고해상도 및 얇은 머리카락은 P1의 tile/refinement 경로에서 별도로 처리한다.

### 작업 상태

```text
discovered → indexed → preview_ready → queued → processing → completed
                                      ├────────→ failed → queued(retry)
                                      └────────→ cancelled
```

각 `JobItem`은 원본 경로, 파일 fingerprint, EXIF 요약, transform recipe, output recipe, 상태, 진행률, 오류 코드를 가진다. 설정은 원본을 바꾸지 않는 recipe로 보관한다.

### Scheduler 원칙

- queue 0: 사용자가 현재 선택한 파일의 preview
- queue 1: 화면에 보이는 thumbnail/preview
- queue 2: 사용자가 실행한 export batch
- queue 3: 예상 용량 표본과 background indexing
- GPU inference는 기본 1 session 직렬 실행
- decode/resize/encode는 CPU와 메모리에 맞춘 bounded pool
- 디스크 I/O 동시성은 낮게 제한하고 HDD에서도 thrashing을 피함
- 메모리 예산을 초과하면 새 decode를 시작하지 않는 backpressure 적용
- cancellation token을 모든 단계가 확인하며 partial 파일은 안전하게 정리

## 7. 권장 저장소 구조

```text
/
├─ apps/
│  └─ desktop/
│     ├─ src/                    # React UI
│     └─ src-tauri/              # Tauri entry, commands, permissions
├─ crates/
│  ├─ domain/                    # Job, Recipe, naming 규칙
│  ├─ scheduler/                 # 우선순위 큐와 취소/복구
│  ├─ media/                     # decode, metadata, rotate, resize, encode
│  ├─ inference-contract/        # worker protocol
│  ├─ storage/                   # SQLite, cache, atomic output
│  └─ platform/                  # keychain, paths, hardware probing
├─ workers/
│  └─ inference/                 # ONNX Runtime worker
├─ models/
│  └─ manifest/                  # 모델 버전/해시/라이선스; weight는 저장소 제외
├─ packages/
│  ├─ ui/                        # design tokens/components
│  └─ contracts/                 # 생성된 TypeScript IPC types
├─ tests/
│  ├─ fixtures/
│  ├─ golden/
│  └─ performance/
└─ docs/
```

UI가 문자열 기반 command 이름이나 자유 형식 JSON에 의존하지 않도록 Rust 계약에서 TypeScript type을 생성한다. worker protocol에도 version을 넣어 앱과 모델 worker 업데이트가 어긋났을 때 명확히 차단한다.

## 8. 성능 목표와 측정법

하드웨어와 모델에 따라 AI 시간 차이가 크므로 절대 속도를 마케팅 문구로 먼저 확정하지 않는다. 다음을 초기 engineering target으로 잡고 1주차 spike에서 현실화한다.

| 항목 | 목표 |
|---|---|
| warm launch | 기준 PC/Mac에서 1.5초 이내에 입력 가능한 화면 |
| 파일 drop 반응 | 50ms 이내 목록 placeholder 표시 |
| thumbnail | 일반 JPEG 첫 화면분을 파일당 150ms 이내 순차 표시 |
| UI | batch 처리 중 scroll/zoom p95 frame 16.7ms 근접, 긴 main-thread task 50ms 미만 |
| 선택 파일 preview | GPU 기준 2초 이내 결과를 목표, 원본은 즉시 표시 |
| 안정성 | 1만 파일 queue에서 UI 응답 유지, 실패가 전체 batch를 중단하지 않음 |
| 메모리 | 24MP 이미지 batch에서 working set에 상한을 두고 파일 수에 비례해 증가하지 않음 |
| 복구 | 강제 종료 후 완료 파일은 다시 쓰지 않고 미완료 항목만 재개 |

측정 장비를 최소 세 등급으로 고정한다.

- Windows 저사양: 내장 GPU + 16GB RAM
- Windows 중급: 보급형 외장 GPU + 16/32GB RAM
- macOS: Apple Silicon 기본형 + 16GB RAM

CPU-only 결과도 별도로 기록한다. 각 release의 모델 버전, provider, 입력 해상도, p50/p95 시간, peak RSS, 출력 품질 metric을 benchmark artifact로 보존한다.

## 9. 보안·개인정보·배포

- 로컬 모드에서는 이미지가 기기를 떠나지 않는다는 사실을 명확히 표시
- cloud provider는 사용자가 작업 단위로 선택해야 하며 첫 업로드 전에 전송 사실과 보관 정책 안내
- API key는 Windows Credential Manager/macOS Keychain에만 저장
- Tauri capability/permission을 필요한 파일 picker, drag-drop, updater 범위로 최소화
- crash report에서 파일 경로, EXIF, 이미지 내용 제거; 전송은 opt-in
- 모델 다운로드는 HTTPS와 SHA-256 검증, 실패 시 이전 모델 유지
- Windows code signing, macOS Developer ID signing/notarization, signed updater를 베타 배포 전 완료
- output은 같은 파일시스템에 임시 저장 후 atomic rename하고, 완료 전에는 최종 이름을 노출하지 않음

## 10. 테스트 전략

### 품질 dataset

배포 권리가 정리된 이미지로 category-balanced golden set을 만든다.

- 인물: 긴 머리, 곱슬머리, 안경, 반투명 천
- 상품: 흰 제품/흰 배경, 반사 금속, 유리, 그림자
- 동물: 털, 수염
- 자동차/가구: 내부 빈 공간, 바퀴 spokes
- 그래픽: 로고, 애니메이션, 얇은 선
- 어려운 장면: 낮은 대비, motion blur, 여러 피사체, 40MP 이상

SAD/MAE/IoU 같은 mask metric과 함께 육안 검수 score를 유지한다. 모델 교체는 속도와 품질의 회귀 기준을 모두 통과해야 한다.

### 필수 자동화

- 이름 template의 timezone, EXIF 누락, 금지 문자, 중복 1만 건 property test
- orientation 1–8, 알파 유무, 손상 파일, 거대 이미지, CMYK JPEG fixture
- 같은 설정의 preview/export 일치 golden test
- pause/resume/cancel, worker crash, 디스크 부족, 권한 오류, 긴 경로 integration test
- 1만 파일 queue와 반복 import/remove soak test
- Windows/macOS light/dark, 100/125/150/200% scale visual regression
- installer upgrade/downgrade, model migration, DB migration test

## 11. 개발 단계

일정은 개발자 2명과 파트타임 디자인/QA를 가정한 범위이며, 1주차 성능 spike 뒤 다시 산정한다.

### 0단계 — 기술·모델 spike (1주)

- Tauri shell에서 500개 파일 import와 virtualized list 검증
- 후보 모델 2–3개를 Windows GPU/CPU 및 Apple Silicon에서 비교
- ONNX provider 호환성, 첫 실행 시간, 메모리, alpha 품질 측정
- libvips packaging과 PNG/WebP 실제 인코딩 benchmark
- 모델 weight의 배포 및 상용 라이선스 검토 시작

종료 기준: 기본 모델/provider 조합, installer 크기 전략, 현실적인 성능 기준 확정.

### 1단계 — UX skeleton과 데이터 계약 (1–2주)

- 디자인 token, 3-pane workspace, drag-drop, virtual list, Canvas
- Job/Recipe/IPC schema와 SQLite migration
- metadata/thumbnail cache와 파일 선택 우선순위 구현
- 실제 처리 없이 전체 사용자 흐름 clickable prototype 테스트

종료 기준: 500개 파일에서 UI가 부드럽고 기본 작업을 설명 없이 완료하는 usability test.

### 2단계 — 핵심 end-to-end MVP (2–3주)

- worker supervisor, ONNX inference, CPU fallback
- 원본/결과/비교 preview
- PNG/WebP export, resize, 회전, 저장 위치
- atomic save, conflict 처리, 오류 분류와 retry

종료 기준: 지원 포맷 100개 혼합 batch를 원본 손상 없이 끝내고 앱을 계속 사용할 수 있음.

### 3단계 — 고급 batch 기능 (2주)

- EXIF 파일명 template과 live preview
- 실제 인코딩 기반 용량 예상
- preset, 선택 적용/전체 적용, pause/resume/cancel
- 앱 재시작 복구 및 worker crash recovery

종료 기준: 1만 항목 queue, 중단/재시작, 충돌 경로 테스트 통과.

### 4단계 — 품질·배포 안정화 (2–3주)

- edge refine 1차, 모델 관리자, 성능 tuning
- 접근성, 다크 모드, 한국어/영어
- signing/notarization/updater, telemetry opt-in
- hardware matrix와 golden image 회귀 테스트

종료 기준: Windows/macOS signed beta, 알려진 데이터 손실 위험 0건, blocker 0건.

예상 범위는 베타까지 8–11주다. 1인 개발이면 디자인, 두 OS 배포, 품질 검증을 포함해 14–18주가 더 현실적이다.

## 12. 1주차에 확정할 결정

다음 항목은 구현 전에 제품 책임자가 확정해야 한다. 괄호 안은 권장 기본값이다.

1. 완전 오프라인 제품인지 선택적 cloud를 허용할지 (로컬 기본 + cloud는 P2)
2. 유료/상용 배포 여부와 모델 weight의 상용 사용 권리 (상용 가능 모델만 기본 탑재)
3. 최소 OS와 CPU architecture (Windows 10/11 x64, macOS 13+ Apple Silicon/Intel)
4. 첫 버전에 브러시 수동 보정이 필수인지 (P1로 미루되 provider 계약은 고려)
5. HEIC/AVIF/RAW의 출시 우선순위 (JPEG/PNG/WebP부터)
6. 원본 metadata 보존 정책 (촬영일/ICC 유지, GPS 제거 기본)
7. 설치 파일에 기본 모델을 포함할지 첫 실행 때 받을지 (빠른 모델 포함, 고품질 모델 별도 다운로드)

## 13. 바로 이어서 만들 산출물

1. 15–20장 대표 이미지로 모델/속도 spike
2. 메인 화면, processing, 완료/오류 상태를 포함한 Figma 수준 wireframe
3. `Job`, `TransformRecipe`, `OutputRecipe`, `NamingTemplate` schema
4. Tauri + React 저장소 skeleton과 실제 ONNX worker를 사용한 vertical slice (2026-08-22 완료)
5. Windows/macOS CI 및 서명 전 unsigned 개발 installer

이 순서를 지키면 모델 선택이 바뀌어도 UI와 batch 엔진을 다시 만들지 않고, 디자인 검증과 성능 검증을 병행할 수 있다.

## 참고 자료

- remove.bg desktop: https://www.remove.bg/a/background-remover-windows-mac-linux
- BandiView screenshots: https://kr.bandisoft.com/bandiview/screenshots/
- Tauri process model: https://v2.tauri.app/concept/process-model/
- Tauri updater: https://v2.tauri.app/plugin/updater/
- ONNX Runtime DirectML: https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html
- ONNX Runtime CoreML: https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html
- Windows ML overview: https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/overview
- BiRefNet official repository: https://github.com/ZhengPeng7/BiRefNet
- rembg repository: https://github.com/danielgatis/rembg
