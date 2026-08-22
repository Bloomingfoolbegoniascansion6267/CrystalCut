fn main() {
    println!("cargo:rerun-if-env-changed=CLEARCUT_TAURI_BUILD");
    let is_release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");
    let is_tauri_production = std::env::var("CLEARCUT_TAURI_BUILD").is_ok_and(|value| value == "1");
    if is_release && !is_tauri_production {
        panic!(
            "Clearcut release는 `npm run build:desktop`으로 빌드해야 합니다. 직접 `cargo build --release`를 실행하면 프런트엔드 대신 devUrl을 사용합니다."
        );
    }
    tauri_build::build()
}
