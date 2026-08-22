# 제3자 AI 모델 고지

## SlimSAM 77 Uniform ONNX

- 용도: 사용자가 초록색 유지·빨간색 제외 브러시로 지정한 객체의 전체 마스크 생성
- 원본 모델: `nielsr/slimsam-77-uniform`
- ONNX 배포: `Xenova/slimsam-77-uniform`
- 라이선스: Apache License 2.0
- 모델 페이지: https://huggingface.co/Xenova/slimsam-77-uniform

CrystalCut은 다음 두 양자화 graph를 revision과 SHA-256으로 고정해 최초 사용 시 내려받는다.

| Graph | Revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| vision encoder | `7c8459c48dabad6291b384c97be46c451c25d6c4` | 8,882,165 | `cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971` |
| prompt encoder + mask decoder | `69c9d2e880cd421621781e9ded1f0bf1c20e1f74` | 4,903,810 | `cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2` |

다운로드한 파일은 앱 데이터 폴더의 `models/slimsam-77-uniform` 아래에 저장한다. Python, Conda, WSL은 필요하지 않으며 CrystalCut의 Rust ONNX Runtime worker가 직접 실행한다.
