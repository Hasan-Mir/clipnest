//! Dedicated console-subsystem binary for the ClipNest CLI (`clipnest-cli.exe`).
//! Uses `clipnest_core::ipc` directly.

fn main() {
    std::process::exit(clipnest_core::ipc::run_from_env());
}
