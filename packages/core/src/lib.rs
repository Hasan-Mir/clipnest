//! ClipNest Core (`clipnest_core`)
//!
//! Shared Rust engine powering both the ClipNest Tauri GUI (`src-tauri`) and the
//! ClipNest CLI (`packages/cli` via N-API `.node` addon + `clipnest-cli` binary).

pub mod classify;
pub mod codec;
pub mod db;
pub mod ipc;
pub mod models;
pub mod napi_addon;
pub mod platform;
pub mod rules;
pub mod search;
pub mod transforms;

pub mod capture {
    pub use crate::codec::*;
}

pub mod state {
    pub use crate::models::*;
}
