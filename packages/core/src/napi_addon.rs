//! Zero-dependency Node.js N-API native addon (`clipnest-core.win32-x64-msvc.node`).
//!
//! Exports `napi_register_module_v1` so Node.js can `require()` / `process.dlopen()` the compiled
//! `clipnest_core` library directly as a native `.node` addon without needing `node-gyp` or `node.lib`
//! at link time (resolves the 8 stable N-API C ABI symbols dynamically from the host `node.exe` process).

use std::ffi::{c_char, c_void, CString};
use std::path::Path;
use std::sync::OnceLock;

pub type NapiEnv = *mut c_void;
pub type NapiValue = *mut c_void;
pub type NapiCallbackInfo = *mut c_void;
pub type NapiStatus = i32;
pub type NapiCallback = unsafe extern "C" fn(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue;

struct NapiApi {
    create_function: unsafe extern "C" fn(
        env: NapiEnv,
        utf8name: *const c_char,
        length: usize,
        cb: NapiCallback,
        data: *mut c_void,
        result: *mut NapiValue,
    ) -> NapiStatus,
    set_named_property:
        unsafe extern "C" fn(env: NapiEnv, object: NapiValue, utf8name: *const c_char, value: NapiValue) -> NapiStatus,
    get_cb_info: unsafe extern "C" fn(
        env: NapiEnv,
        cbinfo: NapiCallbackInfo,
        argc: *mut usize,
        argv: *mut NapiValue,
        this_arg: *mut NapiValue,
        data: *mut *mut c_void,
    ) -> NapiStatus,
    get_value_string_utf8: unsafe extern "C" fn(
        env: NapiEnv,
        value: NapiValue,
        buf: *mut u8,
        bufsize: usize,
        result: *mut usize,
    ) -> NapiStatus,
    create_string_utf8:
        unsafe extern "C" fn(env: NapiEnv, str_ptr: *const u8, length: usize, result: *mut NapiValue) -> NapiStatus,
    create_int32: unsafe extern "C" fn(env: NapiEnv, value: i32, result: *mut NapiValue) -> NapiStatus,
    get_boolean: unsafe extern "C" fn(env: NapiEnv, value: bool, result: *mut NapiValue) -> NapiStatus,
    throw_error: unsafe extern "C" fn(env: NapiEnv, code: *const c_char, msg: *const c_char) -> NapiStatus,
}

static NAPI: OnceLock<Option<NapiApi>> = OnceLock::new();

#[cfg(windows)]
unsafe fn load_napi_api() -> Option<NapiApi> {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    let mut hmod = GetModuleHandleW(std::ptr::null());
    if hmod == 0 || GetProcAddress(hmod, b"napi_create_function\0".as_ptr()).is_none() {
        let node_dll: Vec<u16> = "node.dll\0".encode_utf16().collect();
        hmod = GetModuleHandleW(node_dll.as_ptr());
    }
    if hmod == 0 {
        return None;
    }

    macro_rules! sym {
        ($name:literal, $ty:ty) => {{
            let ptr = GetProcAddress(hmod, concat!($name, "\0").as_ptr())?;
            std::mem::transmute::<_, $ty>(ptr)
        }};
    }

    Some(NapiApi {
        create_function: sym!(
            "napi_create_function",
            unsafe extern "C" fn(
                NapiEnv,
                *const c_char,
                usize,
                NapiCallback,
                *mut c_void,
                *mut NapiValue,
            ) -> NapiStatus
        ),
        set_named_property: sym!(
            "napi_set_named_property",
            unsafe extern "C" fn(NapiEnv, NapiValue, *const c_char, NapiValue) -> NapiStatus
        ),
        get_cb_info: sym!(
            "napi_get_cb_info",
            unsafe extern "C" fn(
                NapiEnv,
                NapiCallbackInfo,
                *mut usize,
                *mut NapiValue,
                *mut NapiValue,
                *mut *mut c_void,
            ) -> NapiStatus
        ),
        get_value_string_utf8: sym!(
            "napi_get_value_string_utf8",
            unsafe extern "C" fn(NapiEnv, NapiValue, *mut u8, usize, *mut usize) -> NapiStatus
        ),
        create_string_utf8: sym!(
            "napi_create_string_utf8",
            unsafe extern "C" fn(NapiEnv, *const u8, usize, *mut NapiValue) -> NapiStatus
        ),
        create_int32: sym!("napi_create_int32", unsafe extern "C" fn(NapiEnv, i32, *mut NapiValue) -> NapiStatus),
        get_boolean: sym!("napi_get_boolean", unsafe extern "C" fn(NapiEnv, bool, *mut NapiValue) -> NapiStatus),
        throw_error: sym!(
            "napi_throw_error",
            unsafe extern "C" fn(NapiEnv, *const c_char, *const c_char) -> NapiStatus
        ),
    })
}

#[cfg(not(windows))]
unsafe fn load_napi_api() -> Option<NapiApi> {
    None
}

fn api() -> Option<&'static NapiApi> {
    NAPI.get_or_init(|| unsafe { load_napi_api() }).as_ref()
}

unsafe fn read_arg_string(napi: &NapiApi, env: NapiEnv, val: NapiValue) -> String {
    let mut len: usize = 0;
    if (napi.get_value_string_utf8)(env, val, std::ptr::null_mut(), 0, &mut len) != 0 {
        return String::new();
    }
    let mut buf = vec![0u8; len + 1];
    let mut written: usize = 0;
    if (napi.get_value_string_utf8)(env, val, buf.as_mut_ptr(), buf.len(), &mut written) != 0 {
        return String::new();
    }
    buf.truncate(written);
    String::from_utf8_lossy(&buf).to_string()
}

unsafe fn make_string(napi: &NapiApi, env: NapiEnv, s: &str) -> NapiValue {
    let mut out: NapiValue = std::ptr::null_mut();
    let _ = (napi.create_string_utf8)(env, s.as_ptr(), s.len(), &mut out);
    out
}

unsafe fn throw_js_error(napi: &NapiApi, env: NapiEnv, msg: &str) {
    let sanitized = msg.replace('\0', "");
    if let Ok(cmsg) = CString::new(sanitized) {
        let _ = (napi.throw_error)(env, std::ptr::null(), cmsg.as_ptr());
    } else {
        let _ = (napi.throw_error)(env, std::ptr::null(), b"native addon error\0".as_ptr() as *const c_char);
    }
}

unsafe extern "C" fn js_dispatch_offline_json(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Some(napi) = api() else {
        return std::ptr::null_mut();
    };
    let mut argc: usize = 3;
    let mut argv: [NapiValue; 3] = [std::ptr::null_mut(); 3];
    let _ = (napi.get_cb_info)(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
    let data_dir = if argc > 0 { read_arg_string(napi, env, argv[0]) } else { String::new() };
    let op = if argc > 1 { read_arg_string(napi, env, argv[1]) } else { String::new() };
    let params_raw = if argc > 2 { read_arg_string(napi, env, argv[2]) } else { String::from("{}") };
    let params: serde_json::Value = match serde_json::from_str(&params_raw) {
        Ok(v) => v,
        Err(e) => {
            throw_js_error(napi, env, &format!("Invalid JSON params: {e}"));
            return std::ptr::null_mut();
        }
    };
    let resolved_dir = if data_dir.trim().is_empty() {
        crate::ipc::resolve_cli_data_dir(None)
    } else {
        Path::new(&data_dir).to_path_buf()
    };
    let resp = crate::ipc::dispatch_offline(&resolved_dir, &op, &params);
    let json_str = serde_json::to_string(&resp).unwrap_or_else(|_| String::from("{\"ok\":false,\"exit_code\":1}"));
    make_string(napi, env, &json_str)
}

unsafe extern "C" fn js_apply_transform(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Some(napi) = api() else {
        return std::ptr::null_mut();
    };
    let mut argc: usize = 2;
    let mut argv: [NapiValue; 2] = [std::ptr::null_mut(); 2];
    let _ = (napi.get_cb_info)(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
    let tr_id = if argc > 0 { read_arg_string(napi, env, argv[0]) } else { String::new() };
    let input = if argc > 1 { read_arg_string(napi, env, argv[1]) } else { String::new() };
    match crate::transforms::apply_transform(&tr_id, &input) {
        Ok(out) => make_string(napi, env, &out),
        Err(err) => {
            throw_js_error(napi, env, &err);
            std::ptr::null_mut()
        }
    }
}

unsafe extern "C" fn js_list_transforms_json(env: NapiEnv, _info: NapiCallbackInfo) -> NapiValue {
    let Some(napi) = api() else {
        return std::ptr::null_mut();
    };
    let s = serde_json::to_string(crate::transforms::TRANSFORM_LIST).unwrap_or_else(|_| String::from("[]"));
    make_string(napi, env, &s)
}

unsafe extern "C" fn js_normalize_text(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Some(napi) = api() else {
        return std::ptr::null_mut();
    };
    let mut argc: usize = 1;
    let mut argv: [NapiValue; 1] = [std::ptr::null_mut(); 1];
    let _ = (napi.get_cb_info)(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
    let input = if argc > 0 { read_arg_string(napi, env, argv[0]) } else { String::new() };
    let norm = crate::classify::normalize(&input);
    make_string(napi, env, &norm)
}

unsafe extern "C" fn js_is_sensitive(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Some(napi) = api() else {
        return std::ptr::null_mut();
    };
    let mut argc: usize = 1;
    let mut argv: [NapiValue; 1] = [std::ptr::null_mut(); 1];
    let _ = (napi.get_cb_info)(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
    let input = if argc > 0 { read_arg_string(napi, env, argv[0]) } else { String::new() };
    let sens = crate::classify::is_sensitive(&input);
    let mut out: NapiValue = std::ptr::null_mut();
    let _ = (napi.get_boolean)(env, sens, &mut out);
    out
}

unsafe extern "C" fn js_run_cli_native(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Some(napi) = api() else {
        return std::ptr::null_mut();
    };
    let mut argc: usize = 1;
    let mut argv: [NapiValue; 1] = [std::ptr::null_mut(); 1];
    let _ = (napi.get_cb_info)(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
    let raw = if argc > 0 { read_arg_string(napi, env, argv[0]) } else { String::from("[]") };
    let args: Vec<String> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            throw_js_error(napi, env, &format!("Invalid JSON args array: {e}"));
            return std::ptr::null_mut();
        }
    };
    let code = crate::ipc::run_cli(&args);
    let mut out: NapiValue = std::ptr::null_mut();
    let _ = (napi.create_int32)(env, code, &mut out);
    out
}

unsafe fn export_fn(napi: &NapiApi, env: NapiEnv, exports: NapiValue, name: &str, cb: NapiCallback) {
    let Ok(cname) = CString::new(name) else {
        return;
    };
    let mut fn_val: NapiValue = std::ptr::null_mut();
    if (napi.create_function)(env, cname.as_ptr(), name.len(), cb, std::ptr::null_mut(), &mut fn_val) == 0 {
        let _ = (napi.set_named_property)(env, exports, cname.as_ptr(), fn_val);
    }
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    if let Some(napi) = api() {
        export_fn(napi, env, exports, "dispatchOfflineJson", js_dispatch_offline_json);
        export_fn(napi, env, exports, "applyTransformNative", js_apply_transform);
        export_fn(napi, env, exports, "listTransformsJson", js_list_transforms_json);
        export_fn(napi, env, exports, "normalizeTextNative", js_normalize_text);
        export_fn(napi, env, exports, "isSensitiveNative", js_is_sensitive);
        export_fn(napi, env, exports, "runCliNative", js_run_cli_native);
    }
    exports
}
