fn main() {
    if std::env::args().any(|argument| argument == "--worker") {
        if let Err(error) = clearcut_lib::worker::run_stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else {
        clearcut_lib::run();
    }
}
