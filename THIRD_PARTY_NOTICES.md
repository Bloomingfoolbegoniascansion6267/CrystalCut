# Third-party notices

CrystalCut is licensed under the Apache License 2.0. That license applies to
the CrystalCut source code and does not replace or relicense third-party
software or AI model assets.

## Runtime and framework components

CrystalCut is built with open-source components including Tauri, Rust crates,
React, and ONNX Runtime. Each component remains subject to the license declared
by its upstream project and package metadata. Notable runtime components are:

- **Tauri** — Apache-2.0 OR MIT — <https://github.com/tauri-apps/tauri>
- **ONNX Runtime** — MIT — <https://github.com/microsoft/onnxruntime>
- **React** — MIT — <https://github.com/facebook/react>
- **rembg source project** — MIT, Copyright 2020 Daniel Gatis —
  <https://github.com/danielgatis/rembg>

The complete dependency versions used for a build are pinned in
`package-lock.json` and `src-tauri/Cargo.lock`.

## AI model assets

AI model files are not stored in this repository or embedded in CrystalCut
installers. They are downloaded on first use, verified by pinned byte length
and SHA-256 digest, and cached in the application data directory.

### SlimSAM 77 Uniform ONNX

- Original model: `nielsr/slimsam-77-uniform`
- ONNX distribution: `Xenova/slimsam-77-uniform`
- Declared license: Apache-2.0
- Model page: <https://huggingface.co/Xenova/slimsam-77-uniform>

### U2NetP ONNX

- Download location: `danielgatis/rembg` model release
- Upstream architecture: `xuebinqin/U-2-Net`
- U-2-Net source repository license: Apache-2.0
- rembg source repository license: MIT
- Model URL: <https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx>

The exact `u2netp.onnx` release asset does not currently include a separate,
model-specific license or complete conversion provenance. CrystalCut therefore
does not represent that asset as covered by the CrystalCut Apache-2.0 license.
Commercial redistributors should independently verify the model-file rights or
replace it with a model artifact whose provenance and license are explicit.

## No endorsement

Third-party names and trademarks belong to their respective owners. Their use
here identifies technical dependencies and does not imply endorsement of
CrystalCut.
