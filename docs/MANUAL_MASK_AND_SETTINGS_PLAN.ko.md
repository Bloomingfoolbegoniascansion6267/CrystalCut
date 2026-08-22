# Clearcut 수동 객체 선택·마스크 보정·환경설정 구현 계획

- 기준일: 2026-08-22
- 상태: 환경설정 shell 완료, 수동 mask 편집 기반 구현 예정, promptable segmentation 모델은 benchmark 후 확정
- 원칙: 자동 처리는 한 번의 클릭으로 유지하고 수동 편집은 파일별 opt-in으로 제공

## 1. 제품 동작 결정

배경 제거 제품에서 가장 자연스러운 흐름은 `자동 결과 → 대상 선택 → 마스크 보정`의 세 단계다. 사용자가 그린 선을 그대로 남기는 단순 그림판이 아니라, 선이 지나간 부분을 positive prompt로 해석해 그 부분이 속한 물체 전체를 선택하는 동작은 promptable segmentation에 해당한다.

Clearcut은 다음 세 모드를 제공한다.

| 모드 | 목적 | 동작 |
| --- | --- | --- |
| 자동 | 대부분의 사진과 일괄 처리 | 현재 U2NetP 계열이 전경 mask를 자동 생성 |
| 대상 선택 | 자동 결과가 엉뚱한 물체를 고른 경우 | 유지할 물체 위에 선을 그리거나 클릭·상자를 지정하면 그 물체 전체를 선택 |
| 마스크 보정 | 머리카락, 구멍, 소품 등 세부 수정 | `유지`와 `지우기` 브러시가 최종 mask를 직접 보정 |

자동 모드는 계속 기본값이다. 수동 입력이 없는 수백 장 batch에는 추가 모델 비용이 생기지 않는다. 수동 recipe는 선택한 한 파일에만 적용하며 여러 파일에 무조건 복사하지 않는다.

## 2. 사용자 흐름

1. 이미지를 추가하면 원본 미리보기를 즉시 표시하고, `자동 미리보기` 또는 최종 처리 요청 시 자동 mask를 생성한다.
2. 자동 결과 대신 특정 물체를 먼저 지정하려면 Canvas toolbar의 `대상 선택`을 눌러 편집 mode로 전환한다.
3. 사용자는 유지할 물체 위에 초록색 선을 긋는다. 필요하면 `제외`로 바꾸어 배경 또는 잘못 포함된 물체 위에 자홍색 선을 긋는다.
4. pointer를 놓으면 해당 선을 일정 간격의 positive/negative point prompt로 바꾸고 물체 mask를 갱신한다.
5. 결과가 맞으면 `적용`, 아니면 Undo/Redo 또는 prompt 추가로 보정한다.
6. 가장자리 세부 수정은 `마스크 보정`에서 유지/지우기 brush로 직접 칠한다.
7. 비교 화면에서 확인한 뒤 저장한다. 수정한 파일만 다시 export하며 원본은 바꾸지 않는다.

필수 편집 조작은 brush 크기, 유지/제외 전환, Undo/Redo, zoom, pan, mask overlay 표시/숨기기, 자동 결과로 재설정이다. 마우스뿐 아니라 Windows Pen과 macOS trackpad의 pointer event도 같은 좌표 계약으로 처리한다. 키보드는 `[`/`]` brush 크기, `Space` pan, `Ctrl/Cmd+Z` Undo, `Shift+Ctrl/Cmd+Z` Redo를 제공한다.

## 3. Mask 좌표와 recipe 계약

모든 편집 좌표는 화면 pixel이 아니라 EXIF orientation을 적용한 원본 이미지의 0–1 정규화 좌표로 저장한다. zoom, 창 크기, Retina/고해상도 scale이 달라져도 같은 위치를 가리키게 하기 위함이다. 수동 회전과 출력 resize는 mask 합성 뒤에 적용한다.

```text
ManualMaskRecipeV1
  mode: automatic | prompted | refined
  prompts[]
    kind: keep | exclude
    geometry: point | stroke | box
    normalized coordinates
    brush radius in source-relative units
  correctionMaskPath?: app-data/workspace/masks/{assetId}.png
  correctionMaskSha256?: string
  baseModelId + baseModelRevision
  updatedAt
```

Prompt stroke는 작으므로 SQLite `workspace_items`와 연결된 JSON으로 저장한다. 사용자가 직접 칠한 correction mask는 정확한 결과와 빠른 복구를 위해 lossless grayscale PNG sidecar로 저장하고 DB에는 경로와 hash만 기록한다. 큰 bitmap을 SQLite row나 프런트 JSON에 넣지 않는다. 원본 fingerprint가 바뀌면 기존 수동 recipe는 삭제하지 않고 `재검토 필요`로 표시한다.

## 4. 추론 구조

현재 자동 모델과 수동 객체 선택 모델은 역할을 분리한다.

```text
원본 decode + EXIF orientation
        │
        ├─ 자동 mode ─ U2Net 계열 foreground mask
        │
        └─ 대상 선택 mode
             image encoder → embedding cache
             keep/exclude point·stroke·box → prompt decoder → object mask
        │
        └─ 유지/지우기 correction mask 합성
        │
        └─ edge refine → 수동 회전 → resize → PNG/WebP atomic save
```

브러시를 움직일 때마다 무거운 image encoder를 반복 실행하지 않는다. 파일을 편집 mode로 열 때 embedding을 한 번 계산하고 각 stroke 뒤에는 prompt decoder만 다시 실행한다. 선택 파일을 바꾸면 최근 embedding만 제한된 LRU cache에 유지한다.

현재 U2NetP에는 point나 brush prompt를 해석하는 입력이 없으므로 이 기능을 U2Net mask 후처리만으로 흉내 내지 않는다. 모델 spike에서는 다음 후보를 동일 ONNX Runtime provider 계약으로 비교한다.

- MobileSAM ONNX: desktop CPU에서 encoder와 prompt decoder 분리가 쉬운 첫 prototype 후보
- SAM 2 tiny 계열: 품질 후보지만 공식 Python/CUDA 중심 구현을 그대로 포함하지 않고 ONNX export, Windows/macOS packaging, 메모리와 license를 별도 검증
- 직접 유지/지우기 brush: AI 모델과 무관하게 항상 동작하는 deterministic fallback

최종 모델은 사람, 상품, 털·머리카락, 여러 물체, 투명·반투명 물체를 포함한 golden set에서 첫 embedding 시간, prompt 응답 p95, peak memory, mask 품질과 배포 크기를 비교한 뒤 확정한다. 초기 engineering target은 prompt decoder 응답 150ms 이내, 선택 화면 진입 후 첫 embedding CPU 1.5초 이내이며 제품 성능 보장은 benchmark 후 결정한다.

## 5. Worker와 IPC 변경

현재 batch용 단발 `Process` protocol과 별도로 장시간 유지되는 preview session을 추가한다.

```text
OpenPreviewSession(assetId, path, modelRevision)
SetPrompts(sessionId, revision, prompts)
ApplyCorrection(sessionId, revision, stroke)
PreviewMaskReady(sessionId, revision, maskPath/bytes, score)
ClosePreviewSession(sessionId)
```

각 요청에 증가하는 `revision`을 넣어 늦게 도착한 이전 mask가 최신 화면을 덮지 못하게 한다. preview worker가 죽으면 session과 embedding만 재생성하고 저장된 prompt/correction recipe로 결과를 복구한다. batch export 요청은 최종 recipe revision과 correction mask hash를 받아 미리보기와 저장 결과가 같은지 검증한다.

## 6. 환경설정 버튼 계획

우측 Inspector의 `출력 설정`은 현재 작업의 recipe이고, 상단 톱니바퀴는 앱 전체 환경설정이다. 둘을 섞지 않는다. 톱니바퀴를 누르면 modal 또는 큰 sheet가 즉시 열리고 다음 영역을 제공한다.

| 영역 | 첫 구현 | 후속 구현 |
| --- | --- | --- |
| 일반 | 새 작업의 기본 출력 형식·저장 위치·파일명, 작업 복구 여부 | 언어, theme, 시작 동작 |
| AI 모델 | 자동 모델 설치 상태, 다운로드 재시도, 모델 삭제 | 자동/고품질 모델 선택, prompt 모델 관리 |
| 성능 | provider `자동/CPU`, 동시 작업 수의 안전한 기본값 | DirectML/Windows ML, CoreML, benchmark 결과 |
| 개인정보 | GPS 제거 고정 안내, EXIF 보존 정책 | ICC/촬영일 세부 정책 |
| 저장 공간 | DB·모델·preview cache 용량, cache 비우기, 데이터 폴더 열기 | cache 상한과 자동 정리 |
| 진단 | 앱/모델/protocol version 복사, log 폴더 열기 | 개인정보 제거된 진단 bundle export |
| 업데이트 | 현재 version 표시 | 서명 검증된 updater channel |

환경설정은 versioned `AppPreferencesV1`로 SQLite의 별도 table에 저장한다. 현재 작업의 `OutputSettings` snapshot과 분리해 전역 기본값을 바꿔도 이미 목록에 들어온 작업이 몰래 바뀌지 않게 한다. model/provider 변경은 적용 가능 여부를 먼저 검사하고 실패하면 이전 값으로 되돌린다. API key나 비밀값이 생기면 SQLite가 아니라 Windows Credential Manager/macOS Keychain을 사용한다.

접근성 완료 조건은 열릴 때 첫 heading으로 focus 이동, Tab focus trap, Esc 닫기, 닫은 뒤 톱니바퀴로 focus 복귀, screen reader label, 위험한 삭제 동작의 명시적 확인이다. 구현 전까지 반응 없는 활성 버튼을 유지하지 않고 다음 iteration에서 가장 먼저 settings shell을 연결한다.

## 7. 구현 순서와 완료 조건

### A. 환경설정 shell과 저장 계약 — 완료

- 톱니바퀴 modal, focus/keyboard 동작, 일반·모델·저장 공간·진단 기본 화면
- `app_preferences` schema migration, 기본값, reset, 손상된 값 fallback
- 모델 다운로드 오류와 재시도 UI, 앱/worker/model version 진단 정보
- 완료 조건: 버튼이 항상 반응하고 재시작 후 설정이 복원되며 현재 작업 recipe는 의도 없이 바뀌지 않음

### B. Canvas 편집 기반과 직접 마스크 보정

- 원본 좌표 변환, zoom/pan, overlay canvas, pointer/pen 입력
- 유지/지우기 brush, Undo/Redo, correction mask sidecar와 자동 저장
- export pipeline에 correction mask 합성
- 완료 조건: AI prompt 모델 없이도 사용자가 누락·과다 제거 영역을 정확히 수정 가능

### C. Promptable segmentation model spike

- 후보 모델 ONNX 변환과 license manifest
- CPU, Windows GPU, macOS provider별 embedding/decoder benchmark
- golden set 품질 비교와 모델 package 크기 측정
- 완료 조건: 목표 미달이면 대형 모델을 제품에 넣지 않고 직접 brush만 먼저 출시

### D. 물체 단위 대상 선택

- 유지/제외 click·stroke·box prompt와 embedding cache
- stale revision 무시, preview worker crash recovery
- 자동 mask와 prompt mask 전환, 적용/재설정 UX
- 완료 조건: 표시한 물체 전체를 선택하고 추가 제외 prompt로 즉시 수정 가능

### E. 영속화·일괄 처리·회귀 검증

- manual recipe DB migration과 sidecar hash 검증
- 앱 강제 종료 후 편집 복구, 원본 변경 시 재검토 상태
- preview/export pixel 일치 golden test, 고해상도·회전·EXIF orientation·Pen 입력 테스트
- 완료 조건: 수동 편집 파일만 다시 export하고 다른 batch 항목의 자동 동작과 성능이 퇴행하지 않음

## 8. 이번 결정에서 제외하는 범위

- 한 이미지의 brush를 관계없는 batch 전체에 자동 복사하지 않는다.
- 수동 편집을 원본 pixel에 destructive하게 기록하지 않는다.
- preview용 저해상도 mask만 저장 결과에 확대해 사용하지 않는다.
- 모델 benchmark 전 특정 prompt 모델을 설치 파일에 고정하지 않는다.
- 설정 화면에서 아직 동작하지 않는 option을 활성 control처럼 노출하지 않는다.

## 참고 자료

- Meta SAM 2 공식 저장소: https://github.com/facebookresearch/segment-anything-2
- Meta SAM 2 연구 소개: https://ai.meta.com/research/sam2/
- MobileSAM 공식 저장소와 ONNX export 예제: https://github.com/ChaoningZhang/MobileSAM
