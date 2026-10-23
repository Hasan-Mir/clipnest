//! Dedicated console-subsystem binary for the ClipNest CLI (`clipnest-cli.exe`).
//! Uses `clipnest_core` directly without linking Tauri/WebView2.

fn main() {
    std::process::exit(clipnest_core::ipc::run_from_env());
}
