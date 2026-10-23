//! Dedicated console-subsystem binary for the ClipNest CLI (`clipnest-cli.exe`).
//! Provides synchronous stdin/stdout/stderr pipeline support and exit codes on Windows.

fn main() {
    std::process::exit(clipnest_lib::cli::run_from_env());
}
