# CrystalCut 핵심 처리 구현 현황

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

파일명은 `{taken:yyMMdd_HHmmss}`, `{seq:03}`, `{camera}`, `{lens}` 등의 token을 조합한다. EXIF 누락값은 고정 fallback으로 바꾸고 금지 문자, 제어 문자, Windows 예약 이름을 정리한 뒤 경로 충돌을 검사한다. EXIF orientation 1–8은 미리보기와 실제 추론 입력에 먼저 반영한다. GPS는 검토·편집할 수 있지만 출력 보존은 기본적으로 꺼져 있다.

현재 batch는 순차 처리한다. 이는 session 재사용과 메모리 상한을 우선 확인하기 위한 선택이며, 병렬도는 모델·provider별 benchmark 후 bounded concurrency로 확장한다.

동시에 두 batch가 시작되지 않도록 원자적 실행 상태를 관리한다. 취소 요청은 현재 인코딩 중인 파일을 안전하게 완료한 뒤 남은 항목을 `cancelled`로 전환한다. 실패·취소 항목 재시도는 전체 목록의 원래 순번을 유지하므로 `{seq:03}` 결과가 첫 실행과 달라지지 않는다.

worker 표준 입출력이 끊기거나 protocol 응답이 손상되면 해당 요청에 한해 프로세스를 새로 만들고 한 번 재전송한다. 첫 worker가 atomic rename까지 마친 뒤 응답 전에 종료된 경우에는 예약 출력 파일의 존재와 크기를 확인해 성공으로 회수한다. 두 번째 통신도 실패하면 해당 항목만 실패시키고 다음 항목에서 새 worker를 시작한다.

작업 목록, 출력 설정, 회전, 파일별 마스크·가장자리 설정, 검토·편집한 메타데이터 요약과 항목별 처리 결과는 앱 데이터 폴더의 `workspace.sqlite3`에 120ms 단위로 순서대로 자동 저장한다. 미리보기 bitmap은 SQLite에 저장하지 않는다. SQLite는 bundled build와 WAL mode를 사용하며, 전체 snapshot을 하나의 transaction으로 교체해 목록과 설정이 서로 다른 시점으로 남지 않게 한다.

원본·썸네일·편집 결과·마스크 미리보기는 원본 fingerprint, 모델 fingerprint, 회전, 마스크 recipe와 실제 픽셀에 영향을 주는 설정을 묶은 키로 앱 데이터 폴더의 PNG cache에 저장한다. 같은 키는 파일을 다시 선택하거나 앱을 재실행해도 재사용하며, 최대 512MB를 넘으면 최근 사용 시각 기준으로 정리한다. 자동 마스크와 SlimSAM embedding은 별도의 메모리 LRU를 사용하고, 환경설정에서 disk preview cache 용량을 확인하거나 비울 수 있다.

앱 시작 시 원본 경로와 파일 크기, 완료 결과 경로를 다시 검사한다. 사라진 원본은 목록에서 제외하고, 변경된 원본·실행 중 종료된 항목·사라진 결과는 `interrupted`로 복구해 미완료 재시도 대상으로 제공한다. 완료 결과가 남아 있으면 다시 처리하지 않고 결과 미리보기를 복원한다. UI의 작업 비우기는 SQLite snapshot만 제거하며 원본과 결과 파일은 삭제하지 않는다.

SQLite schema v4는 작업 snapshot과 분리된 `app_preferences` table, 파일별 `mask_recipe_json`과 `edge_settings_json`을 저장한다. 톱니바퀴 환경설정에서 새 작업의 기본 출력 recipe와 재시작 복구 여부를 저장하며, 최대 100개의 출력 프리셋도 함께 보존한다. 전역 출력 설정이나 다른 파일의 가장자리 값을 변경해도 이미 지정한 파일별 값은 바뀌지 않는다. schema v1 DB는 작업 table을 보존한 채 v2부터 v4까지 순서대로 migration하고 손상된 환경설정 JSON은 권장 기본값으로 fallback한다.

환경설정 modal은 focus trap, Esc 닫기와 호출 버튼 focus 복귀를 지원한다. 일반, AI 모델·저장 공간, 개인정보, 진단 영역을 제공하며 모델 설치·삭제는 batch와 같은 실행 잠금을 사용한다. 앱 version, worker protocol, OS/architecture, DB 크기와 앱 데이터 경로는 실제 Tauri command에서 읽는다. 새 작업 기본값과 현재 출력 설정에서 촬영 메타데이터 보존을 선택할 수 있다. ICC 보존과 아직 검증하지 않은 GPU provider는 활성 control로 노출하지 않는다.

출력 검사기에서 비율 변경은 100%, 긴 변 기준은 선택한 원본의 실제 긴 변 픽셀을 시작값으로 사용한다. 파일 형식의 `기본값`은 형식과 PNG/WebP 압축 관련 값을 함께 복원한다. 알림 toast는 5초 진행 표시 후 자동으로 닫히며 사용자가 즉시 닫을 수도 있다. 배포 및 진단에 표시되는 앱 버전은 프런트엔드 package, Rust crate와 Tauri bundle에서 모두 `1.0.0`으로 통일한다.

미리보기 canvas는 휠과 버튼 확대·축소, pointer drag 이동, 화면 맞춤을 지원한다. 비교 모드는 원본과 수정본을 같은 좌표계에 겹치고 수직 분할 바를 좌우로 움직여 경계를 확인한다. `미리보기` 화면은 저장 전 편집 상태와 저장된 결과를 별도 badge로 구분한다. 브러시 편집 좌표는 zoom·pan과 무관한 회전 후 이미지의 정규화 좌표로 저장한다.

마스크는 `automatic`, `refine`, `manual`, `sam` 네 방식이다. `refine`은 U2NetP 결과 화면을 편집 기준으로 삼아 초록 유지·빨강 제거 stroke를 합성하고, `manual`은 빈 마스크에서 유지 stroke로 객체를 직접 칠한다. `sam`은 SlimSAM 77 Uniform의 양자화 ONNX image encoder와 prompt/mask decoder를 실행해 초록·빨강 stroke가 가리키는 물체 전체를 선택한다. 같은 파일의 image embedding은 재사용한다. 회전 시 stroke 좌표도 함께 변환하며 Undo/Redo와 전체 지우기를 제공한다. worker는 선택된 mask를 만든 다음 파일별 smoothing, feather, 확장·축소, alpha threshold와 mask contrast를 순서대로 처리한다. 각 값은 선택한 파일의 실시간 미리보기에 반영되며 해당 항목만 권장 기본값으로 되돌릴 수 있다.

출력 설정에는 `배경 제거`와 `이미지만 변환` 처리 방식이 있다. 변환 mode는 AI 모델과 마스크를 완전히 건너뛰고 EXIF 방향 보정, 사용자 회전, resize, PNG/WebP 압축과 안전한 atomic 저장만 수행한다. 기본 하위 폴더도 `Removed Background`와 `Converted Images`로 구분한다. 출력 프리셋은 처리 방식, 형식, 품질·압축, 크기, 저장 위치, 이름 규칙과 메타데이터 선택을 하나의 recipe로 저장·불러오기·삭제한다.

`촬영 메타데이터 보존`을 켜면 원본에서 추출하거나 사용자가 편집한 촬영일·카메라·렌즈·설명으로 새 EXIF profile을 만들고 orientation은 픽셀 회전이 반영된 `1`로 정규화한다. GPS와 인식된 생성 프롬프트·워크플로는 별도 옵션을 켠 경우에만 새 profile에 포함한다. PNG에는 `eXIf` chunk, WebP에는 extended RIFF의 `EXIF` chunk로 기록하며 원본 전체 EXIF block은 복사하지 않는다. ICC profile은 현재 보존하지 않는다.

브라우저 기본 context menu는 텍스트 편집 명령과 CrystalCut의 브러시·미리보기·파일 추가·환경설정 명령을 제공하는 앱 메뉴로 교체했다. 작업 목록의 파일을 우클릭하면 해당 파일의 원본 미리보기, 객체 편집, 회전, Explorer/Finder에서 원본·결과 위치 열기와 작업 목록 제거를 제공한다. 목록 제거는 원본·결과 파일을 삭제하지 않는다. Windows release는 GUI subsystem으로 빌드해 console 창을 숨기고 debug build에서는 console을 유지한다.

전체 UI는 `모든 파일` 출력 설정과 `현재 파일` 편집 설정을 시각적으로 분리하고, 파일 상태를 색과 현재 언어의 badge로 함께 표시한다. 좌우 panel은 각각 접을 수 있으며 940px 이하에서는 canvas toolbar를 compact mode로 전환한다. checkbox의 실제 input은 custom check 영역 안에 고정해 focus scroll에 의한 layout jump를 막고, preview 상태와 batch 진행은 live region으로 전달한다.

다국어 기반은 React Intl 메시지 카탈로그와 Tauri OS locale 감지로 구현한다. 최초 화면을 그리기 전에 저장된 언어 선택과 BCP-47 시스템 locale을 함께 읽어 언어 전환 깜박임을 줄인다. `system`, 한국어, 영어, 일본어, 중국어 간체·번체, 스페인어, 독일어, 프랑스어와 포르투갈어(브라질)를 선택할 수 있으며 설정 창에서 즉시 미리보기하고 저장 또는 취소할 수 있다. 숫자·파일 크기·이미지 크기는 지역 형식으로 표시한다. Rust command 오류와 출력 이름 경고는 번역된 완성 문장이 아니라 안정적인 code와 parameter로 전달한다. `check:i18n`은 영어 기준 메시지 누락과 카탈로그 밖 한글 UI literal을 production build 전에 검사한다.

## 5. 검증 범위

- Rust 단위 테스트 41개(네트워크 모델 다운로드 1개 기본 제외): resize 비율, 확대 방지, 목록 전용 thumbnail 크기 제한, AI 없는 변환 저장, 기존 alpha 결합·교체, 수동 유지·제거 마스크와 입력 검증, 가장자리 확장, U2NetP 입력 layout·정규화, U2NetP/SlimSAM model hash·TLS provider, 실제 SlimSAM prompt 추론, EXIF 추출·안전한 PNG/WebP 출력 EXIF, 동적 이름 template, 파일명 및 경로 충돌, SQLite v1→v4 migration·파일별 마스크/가장자리 recipe·출력 프리셋·환경설정 fallback·언어 필드 없는 기존 JSON의 system 기본값·snapshot round trip·중단/완료 결과 복구
- TypeScript production build
- 공식 U-2-Net 테스트 사진을 사용한 worker 스모크 테스트
  - 400×267 PNG 입력
  - 추론·PNG 저장 약 0.55초(개발 빌드, 현재 Windows 개발 장비)
  - 좌·우 하늘과 하단 잔디 alpha 0, 말 몸통과 인물 몸통 alpha 255 확인
  - `manual` 유지 브러시를 중앙에 적용한 실제 protocol 요청에서 중앙 alpha 255, 모서리와 외부 alpha 0 확인
- Tauri release `--no-bundle` 빌드로 frontend와 native binary 결합 확인

위 시간은 제품 성능 보장이 아니라 단일 개발 장비의 구조 검증값이다.

## 6. 다음 우선순위

1. SlimSAM, MobileSAM, SAM 2.1 tiny와 자동 배경 제거 모델의 품질·속도·메모리 benchmark
2. Windows DirectML/Windows ML과 macOS CoreML provider packaging
3. 브러시 overlay·SlimSAM 미리보기와 최종 export mask의 pixel 일치 golden test
4. 여러 파일의 image embedding LRU cache와 preview worker 분리
5. 현재 추론까지 즉시 중단하는 강제 취소 option과 `.partial` 정리 검증
6. ICC color profile 보존 범위와 색 공간 변환 정책 구현
7. 대규모 목록 virtual scroll과 SQLite delta 저장 최적화
8. 서명된 Windows/macOS installer와 updater 검증

## 참고 구현

- U-2-Net: https://github.com/xuebinqin/U-2-Net
- rembg U2NetP session: https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2netp.py
- ort: https://github.com/pykeio/ort
