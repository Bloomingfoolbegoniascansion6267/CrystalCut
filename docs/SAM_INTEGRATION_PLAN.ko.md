# Clearcut SAM 계열 객체 선택 통합 계획

- 기준일: 2026-08-22
- 결론: 첫 제품 후보는 MobileSAM, SAM 2.1 tiny는 후속 품질 비교 후보

## 1. 역할 분리

기존 U2NetP는 파일을 넣고 한 번 눌러 전체 batch의 배경을 자동 제거하는 기본 engine으로 유지한다. SAM 계열은 자동 제거 model을 바로 대체하지 않고, 사용자가 브러시나 click으로 가리킨 물체 전체를 선택하는 interactive engine으로 추가한다.

- `자동`: U2NetP가 foreground mask 생성
- `자동 + 보정`: U2NetP mask에 현재 유지·제거 brush를 직접 합성
- `객체 선택`: MobileSAM이 유지·제외 prompt로 물체 단위 mask 생성
- `직접 칠하기`: AI와 무관하게 사용자가 칠한 영역만 foreground로 사용

SAM 결과 뒤에도 현재 deterministic brush correction과 가장자리 option을 마지막 단계로 적용한다. 따라서 prompt model이 잘못 선택한 작은 영역은 기존 도구로 확실하게 고칠 수 있다.

## 2. 첫 후보를 MobileSAM으로 정하는 이유

Meta SAM v1은 point와 box prompt 및 ONNX mask decoder export를 공식 지원하고 Apache 2.0으로 배포된다. MobileSAM도 Apache 2.0이며 SAM의 prompt decoder 계약을 유지하면서 image encoder를 TinyViT로 줄였다. 공식 저장소 설명 기준 encoder는 5M parameter이고 전체 pipeline은 9.66M parameter다.

주의할 점은 MobileSAM의 공식 `export_onnx_model.py`가 설명 그대로 prompt encoder와 mask decoder만 ONNX로 만든다는 것이다. Clearcut처럼 Python을 포함하지 않는 Rust desktop app에는 다음 두 graph가 모두 필요하다.

1. `mobile_sam_image_encoder.onnx`: RGB 1024 입력에서 image embedding 생성
2. `mobile_sam_mask_decoder.onnx`: embedding과 keep/remove point·box에서 mask·score 생성

따라서 encoder 변환 script, 입력 정규화, tensor 이름·shape, opset과 수치 오차를 Clearcut repository의 model manifest와 golden test로 고정해야 한다. 출처가 불명확한 임의 변환 model을 그대로 내려받아 제품에 넣지 않는다.

SAM 2.1 tiny는 공식 checkpoint가 38.9M parameter이고 image prompt 품질 후보로 유망하다. 그러나 공식 설치가 PyTorch 2.5.1 이상과 Windows WSL을 권장하며, 공식 repository가 제공하는 완전한 cross-platform ONNX desktop 배포 경로가 MobileSAM보다 명확하지 않다. 첫 단계에서는 제외하고 MobileSAM 결과와 품질·속도·memory를 비교한 뒤 승격한다.

## 3. Clearcut runtime 구조

```text
편집 화면 진입
  → 회전·EXIF가 반영된 1024px 입력 생성
  → MobileSAM image encoder 1회 실행
  → assetId + source fingerprint + rotation별 embedding LRU cache
  → keep/remove stroke를 일정 간격의 point prompt로 변환
  → mask decoder만 반복 실행
  → revision이 최신인 mask만 canvas에 표시
  → 직접 brush correction 합성
  → 가장자리 option → resize → 저장
```

encoder는 이미지마다 한 번만 실행하고 stroke 중에는 작은 decoder만 다시 실행한다. 선택 파일이 바뀌면 최근 embedding을 제한된 memory LRU에 보관한다. 원본 변경·회전·model revision 변경 시 cache를 폐기한다.

현재 `ManualMaskRecipe`는 최종 pixel correction 역할을 유지하고, SAM prompt는 별도 versioned recipe로 저장한다.

```text
PromptMaskRecipeV1
  modelId + revision
  prompts[]
    kind: keep | remove
    geometry: point | stroke | box
    normalized coordinates
  selectedCandidate
  updatedAt
```

## 4. 구현 단계

### A. Model package와 benchmark

- 재현 가능한 MobileSAM encoder·decoder ONNX export script
- model URL, byte size, SHA-256, Apache 2.0 license와 tensor contract manifest
- Windows/macOS CPU에서 첫 embedding, decoder p50/p95, peak memory 측정
- 원본 PyTorch output과 ONNX mask IoU golden test

### B. Preview session

- `OpenPromptSession`, `UpdatePrompts`, `ClosePromptSession` worker protocol
- 요청 revision으로 오래된 decoder 응답 폐기
- asset fingerprint 기반 embedding cache와 worker crash 복구
- 사용자가 그리는 동안 UI thread를 막지 않는 비동기 preview

### C. 객체 선택 UX

- `객체 선택` mode와 초록 유지·빨강 제외 stroke
- stroke를 source-relative point prompt로 sampling
- 여러 후보 mask의 score·stability를 이용한 기본 후보 선택
- `적용`, `다시 선택`, 자동 mask로 돌아가기, 최종 직접 보정

### D. 배포와 가속

- 최초 사용 때 선택 model만 내려받고 hash 검증
- CPU baseline을 먼저 보장
- Windows는 WinML/DirectML, macOS는 CoreML provider를 별도 benchmark 후 활성화
- provider 실패 시 CPU로 안전하게 fallback

## 5. 제품 적용 완료 조건

- 한 번의 keep stroke로 사람·상품 등 연결된 주 객체 전체가 선택된다.
- 추가 remove stroke가 200ms 목표 안에서 최신 mask를 갱신한다. 실제 보장값은 benchmark 후 확정한다.
- preview와 export가 같은 recipe revision에서 pixel 단위로 일치한다.
- model이 없거나 실행에 실패해도 기존 자동 제거와 직접 칠하기는 계속 동작한다.
- Windows/macOS installer에 Python, Conda, WSL을 요구하지 않는다.

## 공식 참고 자료

- Meta Segment Anything: https://github.com/facebookresearch/segment-anything
- MobileSAM: https://github.com/ChaoningZhang/MobileSAM
- Meta SAM 2: https://github.com/facebookresearch/sam2
- ONNX Runtime execution providers: https://onnxruntime.ai/docs/execution-providers/
