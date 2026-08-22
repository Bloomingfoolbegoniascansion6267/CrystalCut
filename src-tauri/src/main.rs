#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--worker") {
        if let Err(error) = crystalcut_lib::worker::run_stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else {
        crystalcut_lib::run();
    }
}
