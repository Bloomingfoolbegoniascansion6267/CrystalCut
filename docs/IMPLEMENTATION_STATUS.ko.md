# Clearcut 핵심 처리 구현 현황

- 기준일: 2026-08-22
- 범위: Tauri UI에서 로컬 ONNX 배경 제거 후 PNG/WebP 파일을 안전하게 저장하는 첫 end-to-end 구현

## 1. 실행 구조

```text
React UI
  ├─ 파일 목록·설정·미리보기
  └─ Tauri command / batch-progress event
             │
Tauri Core (Rust)
  ├─ 파일 검사와 출력 경로 계획
  ├─ 모델 다운로드·SHA-256 검증
  ├─ SQLite 작업 snapshot·schema migration
  └─ worker 수명·진행 상태 관리
             │ JSONL protocol v1 / stdin·stdout
동일 실행 파일 --worker
  ├─ ONNX Runtime session 재사용
  ├─ U2NetP mask 추론
  ├─ 기존 alpha × 예측 alpha
  └─ 회전 → resize → PNG/WebP → atomic rename
```

추론을 WebView와 Tauri event loop에서 분리했다. 현재 worker는 batch 한 번에 하나 생성되고 모델 session을 항목 간 재사용한다. worker가 비정상 종료해도 UI process와 입력 원본은 영향을 받지 않는다.

## 2. 처리 계약

`protocolVersion: 1`인 JSON 객체를 한 줄에 하나씩 worker 표준 입력으로 전달하고, worker는 같은 `jobId`를 포함한 응답을 한 줄씩 돌려준다. 요청에는 입력·출력·모델 경로, 회전, resize 및 encoder 설정이 포함된다. 응답에는 성공 여부, 실제 출력 크기, 소요 시간과 오류가 포함된다.

경로 충돌은 처리 전에 계획한다. 기존 파일과 같은 batch 안에서 예약된 이름을 모두 고려해 `파일명 (2).확장자`로 변경하며, worker도 최종 경로가 이미 존재하면 저장을 거부한다. 인코딩 결과는 `.partial`에 기록하고 `sync_all` 후 최종 이름으로 rename한다.

## 3. 모델 관리와 전처리

현재 모델은 U2NetP이며 최초 처리 시 HTTPS로 다운로드한다. 저장 전에 다음 조건을 모두 확인한다.

- 크기: 4,574,861 bytes
- SHA-256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`
- 입력: RGB, NCHW, `1 × 3 × 320 × 320`
- 출력: foreground alpha, `1 × 1 × 320 × 320`

전처리는 공식 rembg 구현과 맞춰 Lanczos로 320×320 변환하고, 이미지 전체의 최대 채널값으로 0–1 정규화한 다음 ImageNet mean/std를 채널별로 적용한다. 출력은 min-max 정규화하고 원본 크기로 Lanczos 확대한다.

모델 파일은 저장소에 포함하지 않는다. manifest만 version control에 두며, 다운로드 중에는 `.partial`을 사용하고 검증에 실패하면 확정 경로로 이동하지 않는다.

Windows/macOS system TLS를 쓰도록 ureq Native TLS Agent를 명시적으로 구성한다. `native-tls` feature만 활성화한 상태에서 Rustls가 기본인 crate 편의 함수를 호출하면 HTTPS 요청이 panic하는 조합이 되므로, 모델 다운로드는 항상 provider가 고정된 Agent를 거친다.

## 4. UI 상태 흐름

각 항목은 `ready → queued → processing → done/failed` 상태를 갖는다. Rust core가 `batch-progress` event를 보내면 UI가 진행률과 현재 파일을 갱신한다. 완료 항목을 선택하면 결과 파일에서 새 미리보기를 만들고 원본·결과·비교 탭을 즉시 사용할 수 있다.

출력 설정이 바뀌면 450ms debounce 후 최대 3개 파일을 실제 선택 encoder로 축소 인코딩해 전체 예상 용량과 원본 대비 증감률을 계산한다. 이는 foreground alpha를 만들기 전의 표본 추정치이므로 UI에서 항상 “예상”으로 표시하고, 처리가 끝나면 실제 저장 용량으로 교체한다.

파일명은 `{taken:yyMMdd_HHmmss}`, `{seq:03}`, `{camera}`, `{lens}` 등의 token을 조합한다. EXIF 누락값은 고정 fallback으로 바꾸고 금지 문자, 제어 문자, Windows 예약 이름을 정리한 뒤 경로 충돌을 검사한다. GPS 필드는 추출 대상에서 제외한다. EXIF orientation 1–8은 미리보기와 실제 추론 입력에 먼저 반영한다.

현재 batch는 순차 처리한다. 이는 session 재사용과 메모리 상한을 우선 확인하기 위한 선택이며, 병렬도는 모델·provider별 benchmark 후 bounded concurrency로 확장한다.

동시에 두 batch가 시작되지 않도록 원자적 실행 상태를 관리한다. 취소 요청은 현재 인코딩 중인 파일을 안전하게 완료한 뒤 남은 항목을 `cancelled`로 전환한다. 실패·취소 항목 재시도는 전체 목록의 원래 순번을 유지하므로 `{seq:03}` 결과가 첫 실행과 달라지지 않는다.

worker 표준 입출력이 끊기거나 protocol 응답이 손상되면 해당 요청에 한해 프로세스를 새로 만들고 한 번 재전송한다. 첫 worker가 atomic rename까지 마친 뒤 응답 전에 종료된 경우에는 예약 출력 파일의 존재와 크기를 확인해 성공으로 회수한다. 두 번째 통신도 실패하면 해당 항목만 실패시키고 다음 항목에서 새 worker를 시작한다.

작업 목록, 출력 설정, 회전, EXIF 요약과 항목별 처리 결과는 앱 데이터 폴더의 `workspace.sqlite3`에 120ms 단위로 순서대로 자동 저장한다. 미리보기 bitmap과 GPS는 저장하지 않는다. SQLite는 bundled build와 WAL mode를 사용하며, 전체 snapshot을 하나의 transaction으로 교체해 목록과 설정이 서로 다른 시점으로 남지 않게 한다.

앱 시작 시 원본 경로와 파일 크기, 완료 결과 경로를 다시 검사한다. 사라진 원본은 목록에서 제외하고, 변경된 원본·실행 중 종료된 항목·사라진 결과는 `interrupted`로 복구해 미완료 재시도 대상으로 제공한다. 완료 결과가 남아 있으면 다시 처리하지 않고 결과 미리보기를 복원한다. UI의 작업 비우기는 SQLite snapshot만 제거하며 원본과 결과 파일은 삭제하지 않는다.

SQLite schema v2는 작업 snapshot과 분리된 `app_preferences` table을 추가한다. 톱니바퀴 환경설정에서 새 작업의 기본 출력 recipe와 재시작 복구 여부를 저장하며, 전역 기본값 변경은 이미 목록에 들어온 작업을 자동 변경하지 않는다. schema v1 DB는 작업 table을 보존한 채 v2로 migration하고 손상된 환경설정 JSON은 권장 기본값으로 fallback한다.

환경설정 modal은 focus trap, Esc 닫기와 호출 버튼 focus 복귀를 지원한다. 일반, AI 모델·저장 공간, 개인정보, 진단 영역을 제공하며 모델 설치·삭제는 batch와 같은 실행 잠금을 사용한다. 앱 version, worker protocol, OS/architecture, DB 크기와 앱 데이터 경로는 실제 Tauri command에서 읽는다. 아직 검증하지 않은 GPU provider나 EXIF/ICC 보존 option은 활성 control로 노출하지 않는다.

## 5. 검증 범위

- Rust 단위 테스트 28개: resize 비율, 확대 방지, 기존 alpha 결합, 모델 입력 layout·정규화, 모델 hash·TLS provider, EXIF 추출, 동적 이름 template, 파일명 및 경로 충돌, SQLite v1→v2 migration·환경설정 fallback·snapshot round trip·중단/완료 결과 복구
- TypeScript production build
- 공식 U-2-Net 테스트 사진을 사용한 worker 스모크 테스트
  - 400×267 PNG 입력
  - 추론·PNG 저장 약 0.55초(개발 빌드, 현재 Windows 개발 장비)
  - 좌·우 하늘과 하단 잔디 alpha 0, 말 몸통과 인물 몸통 alpha 255 확인
- Tauri release `--no-bundle` 빌드로 frontend와 native binary 결합 확인

위 시간은 제품 성능 보장이 아니라 단일 개발 장비의 구조 검증값이다.

## 6. 다음 우선순위

1. Canvas 유지/지우기 brush, Undo/Redo와 correction mask 저장
2. promptable segmentation 및 자동 배경 제거 모델의 품질·속도·메모리 benchmark와 물체 단위 대상 선택
3. Windows DirectML/Windows ML과 macOS CoreML provider packaging
4. 선택 파일 자동 미리보기와 최종 export 결과 일치 검증
5. 현재 추론까지 즉시 중단하는 강제 취소 option과 `.partial` 정리 검증
6. 결과 파일의 촬영일·ICC 보존 및 GPS 제거 정책 구현
7. 대규모 목록 virtual scroll과 SQLite delta 저장 최적화
8. 서명된 Windows/macOS installer와 updater 검증

## 참고 구현

- U-2-Net: https://github.com/xuebinqin/U-2-Net
- rembg U2NetP session: https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2netp.py
- ort: https://github.com/pykeio/ort
