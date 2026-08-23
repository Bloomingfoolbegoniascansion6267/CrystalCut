# 제3자 AI 모델 고지

CrystalCut 소스 코드의 Apache License 2.0은 아래 제3자 모델 파일을 다시 라이선스하지 않는다. 모델은 설치 파일에 포함하지 않고 해당 기능을 처음 사용할 때 내려받는다.

## U2NetP ONNX

- 용도: 기본 자동 배경 제거 마스크 생성
- 다운로드 배포: `danielgatis/rembg` 모델 릴리스
- 원본 구조: `xuebinqin/U-2-Net`
- U-2-Net 소스 라이선스: Apache License 2.0
- rembg 소스 라이선스: MIT
- 모델 URL: https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
- Bytes: `4,574,861`
- SHA-256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`

현재 위 릴리스의 정확한 `u2netp.onnx` 파일에는 모델 전용 라이선스와 완전한 변환 출처가 별도로 첨부되어 있지 않다. 따라서 CrystalCut은 이 파일이 CrystalCut의 Apache-2.0 적용 대상이라고 표시하지 않는다. 상업적으로 재배포하려는 경우 해당 모델 파일의 권리를 별도로 확인하거나 출처와 라이선스가 명확한 모델로 교체해야 한다.

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
