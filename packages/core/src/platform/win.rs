//! All direct Win32 calls live here (via `windows-sys`, raw bindings, no wrappers).

use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::OnceLock;
use std::time::Duration;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::DataExchange::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub const CF_UNICODETEXT_ID: u32 = 13;
pub const CF_DIB_ID: u32 = 8;
pub const CF_DIBV5_ID: u32 = 17;
pub const CF_HDROP_ID: u32 = 15;

const WM_CLIPBOARDUPDATE_MSG: u32 = 0x031D;

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn register_format(name: &str) -> u32 {
    unsafe { RegisterClipboardFormatW(wide(name).as_ptr()) }
}

// ───────────────────────────── clipboard listener ─────────────────────────────

static LISTENER_TX: OnceLock<Sender<()>> = OnceLock::new();
/// Hidden message-only window: receives WM_CLIPBOARDUPDATE and owns clipboard writes.
static OWNER_HWND: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn listener_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_CLIPBOARDUPDATE_MSG {
        if let Some(tx) = LISTENER_TX.get() {
            let _ = tx.send(());
        }
        return 0;
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

/// Event-driven (no polling): the OS tells us whenever the clipboard changes.
pub fn spawn_clipboard_listener(tx: Sender<()>) {
    let _ = LISTENER_TX.set(tx);
    std::thread::spawn(|| unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = wide("ClipNestClipboardListener");
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(listener_proc);
        wc.hInstance = hinst;
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
        let hwnd =
            CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, 0, hinst, std::ptr::null());
        if hwnd == 0 {
            eprintln!("clipnest: could not create the clipboard listener window");
            return;
        }
        if AddClipboardFormatListener(hwnd) == 0 {
            eprintln!("clipnest: AddClipboardFormatListener failed");
            DestroyWindow(hwnd);
            return;
        }
        OWNER_HWND.store(hwnd, Ordering::SeqCst);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

pub fn sequence_number() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

// ───────────────────────────── reading ─────────────────────────────

pub struct RawFormat {
    pub id: u32,
    pub name: String,
    pub data: Vec<u8>,
}

pub struct Snapshot {
    pub formats: Vec<RawFormat>,
    pub exe: String,
    pub exe_path: String,
    pub excluded: bool,
}

fn standard_name(id: u32) -> Option<&'static str> {
    Some(match id {
        1 => "CF_TEXT",
        2 => "CF_BITMAP",
        7 => "CF_OEMTEXT",
        8 => "CF_DIB",
        13 => "CF_UNICODETEXT",
        15 => "CF_HDROP",
        16 => "CF_LOCALE",
        17 => "CF_DIBV5",
        _ => return None,
    })
}

fn format_name(id: u32) -> String {
    if let Some(n) = standard_name(id) {
        return n.to_string();
    }
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClipboardFormatNameW(id, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            format!("FORMAT_{id}")
        }
    }
}

/// Formats we never store: GDI handles (cannot be copied as bytes), formats Windows
/// synthesises automatically, and COM/delay-rendered formats that cannot be replayed.
fn skip_format(id: u32, name: &str) -> bool {
    if matches!(id, 1 | 2 | 3 | 7 | 9 | 14 | 16) || (0x80..=0xBF).contains(&id) || (0x200..=0x3FF).contains(&id) {
        return true;
    }
    const BLOCK: &[&str] = &[
        "Shell IDList Array",
        "FileContents",
        "FileGroupDescriptor",
        "FileGroupDescriptorW",
        "DataObject",
        "Ole Private Data",
        "OwnerLink",
        "ObjectLink",
        "Embed Source",
        "Link Source",
        "Object Descriptor",
        "Link Source Descriptor",
        "Native",
        "Clipboard Viewer Ignore",
        "ExcludeClipboardContentFromMonitorProcessing",
        "CanIncludeInClipboardHistory",
        "CanUploadToCloudClipboard",
    ];
    BLOCK.iter().any(|b| b.eq_ignore_ascii_case(name))
}

unsafe fn get_bytes(fmt: u32, max_bytes: Option<usize>) -> Result<Option<Vec<u8>>, ()> {
    let h = GetClipboardData(fmt);
    if h == 0 {
        return Ok(None);
    }
    let h = h as HGLOBAL;
    let size = GlobalSize(h);
    if size == 0 {
        return Ok(None);
    }
    if max_bytes.is_some_and(|limit| size > limit) {
        return Err(());
    }
    let p = GlobalLock(h);
    if p.is_null() {
        return Ok(None);
    }
    let v = std::slice::from_raw_parts(p as *const u8, size).to_vec();
    GlobalUnlock(h);
    Ok(Some(v))
}

unsafe fn open_clipboard_retry(owner: HWND) -> bool {
    for _ in 0..25 {
        if OpenClipboard(owner) != 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    false
}

pub fn exe_path_of_hwnd(hwnd: isize) -> String {
    unsafe {
        if hwnd == 0 {
            return String::new();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return String::new();
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return String::new();
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

pub fn exe_of_hwnd(hwnd: isize) -> String {
    let path = exe_path_of_hwnd(hwnd);
    path.rsplit('\\').next().unwrap_or("").to_string()
}

/// Reads every storable format currently on the clipboard.
/// `respect_flags`: honour the "please don't record" markers used by password managers.
pub fn read_clipboard(respect_flags: bool, max_total: usize) -> Result<Snapshot, String> {
    unsafe {
        let owner = GetClipboardOwner();
        let src = if owner != 0 { owner } else { GetForegroundWindow() };
        let exe_path = exe_path_of_hwnd(src);
        let exe = exe_path.rsplit('\\').next().unwrap_or("").to_string();
        if !open_clipboard_retry(0) {
            return Err("clipboard is busy".into());
        }
        let mut ids = Vec::new();
        let mut f = 0u32;
        loop {
            f = EnumClipboardFormats(f);
            if f == 0 {
                break;
            }
            ids.push(f);
        }
        let named: Vec<(u32, String)> = ids.iter().map(|&i| (i, format_name(i))).collect();
        let mut excluded = false;
        if respect_flags {
            for (id, n) in &named {
                if n == "ExcludeClipboardContentFromMonitorProcessing" || n == "Clipboard Viewer Ignore" {
                    excluded = true;
                }
                if n == "CanIncludeInClipboardHistory" {
                    if let Ok(Some(d)) = get_bytes(*id, Some(64)) {
                        if d.len() >= 4 && u32::from_le_bytes([d[0], d[1], d[2], d[3]]) == 0 {
                            excluded = true;
                        }
                    }
                }
            }
        }
        let mut formats = Vec::new();
        if !excluded {
            let mut total = 0usize;
            for (id, name) in named {
                if skip_format(id, &name) {
                    continue;
                }
                let remaining = max_total.saturating_sub(total);
                match get_bytes(id, Some(remaining)) {
                    Ok(Some(data)) => {
                        total += data.len();
                        formats.push(RawFormat { id, name, data });
                    }
                    Ok(None) => {}
                    Err(()) => {
                        CloseClipboard();
                        return Err("clipboard content too large".into());
                    }
                }
            }
        }
        CloseClipboard();
        Ok(Snapshot { formats, exe, exe_path, excluded })
    }
}

// ───────────────────────────── writing ─────────────────────────────

/// Replaces the clipboard content. Registered formats are re-registered by name because
/// their numeric ids can change between sessions. Returns the new sequence number.
unsafe fn acquire_owner_hwnd() -> (HWND, bool) {
    let cur = OWNER_HWND.load(Ordering::SeqCst);
    if cur != 0 && IsWindow(cur) != 0 {
        return (cur, false);
    }
    let hinst = GetModuleHandleW(std::ptr::null());
    let class = wide("ClipNestCliClipboardOwner");
    let mut wc: WNDCLASSW = std::mem::zeroed();
    wc.lpfnWndProc = Some(DefWindowProcW);
    wc.hInstance = hinst;
    wc.lpszClassName = class.as_ptr();
    RegisterClassW(&wc);
    let hwnd =
        CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, 0, hinst, std::ptr::null());
    (hwnd, hwnd != 0)
}

/// Reads plain UTF-16 text (`CF_UNICODETEXT`) directly from the system clipboard.
pub fn read_clipboard_text() -> Result<String, String> {
    unsafe {
        if !open_clipboard_retry(0) {
            return Err("clipboard is busy".into());
        }
        let text = get_bytes(CF_UNICODETEXT_ID, None)
            .ok()
            .flatten()
            .map(|b| crate::capture::decode_utf16(&b))
            .unwrap_or_default();
        CloseClipboard();
        Ok(text)
    }
}

pub fn write_clipboard(items: &[(u32, String, Vec<u8>)]) -> Result<u32, String> {
    unsafe {
        let (owner, is_temp) = acquire_owner_hwnd();
        if owner == 0 {
            return Err("could not create clipboard owner window".into());
        }
        // A real owner window is required, otherwise SetClipboardData fails after EmptyClipboard.
        if !open_clipboard_retry(owner) {
            if is_temp {
                DestroyWindow(owner);
            }
            return Err("clipboard is busy".into());
        }
        if EmptyClipboard() == 0 {
            CloseClipboard();
            if is_temp {
                DestroyWindow(owner);
            }
            return Err("EmptyClipboard failed".into());
        }
        for (id, name, data) in items {
            let fmt = if *id >= 0xC000 { RegisterClipboardFormatW(wide(name).as_ptr()) } else { *id };
            if fmt == 0 {
                continue;
            }
            let h = GlobalAlloc(GMEM_MOVEABLE | 0x0040, data.len().max(1));
            if h.is_null() {
                continue;
            }
            let p = GlobalLock(h);
            if p.is_null() {
                GlobalFree(h);
                continue;
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut u8, data.len());
            GlobalUnlock(h);
            if SetClipboardData(fmt, h as HANDLE) == 0 {
                GlobalFree(h);
            }
        }
        CloseClipboard();
        if is_temp {
            DestroyWindow(owner);
        }
        Ok(GetClipboardSequenceNumber())
    }
}

// ───────────────────────────── focus & keyboard ─────────────────────────────

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() }
}

pub fn is_own_window(hwnd: isize) -> bool {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        pid == GetCurrentProcessId()
    }
}

pub fn focus_window(hwnd: isize) -> bool {
    unsafe {
        if hwnd == 0 || IsWindow(hwnd) == 0 {
            return false;
        }
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        let fg = GetForegroundWindow();
        if fg == hwnd {
            return true;
        }
        let cur = GetCurrentThreadId();
        let fg_tid = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let attach = fg_tid != 0 && fg_tid != cur;
        if attach {
            AttachThreadInput(cur, fg_tid, 1);
        }
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attach {
            AttachThreadInput(cur, fg_tid, 0);
        }
        GetForegroundWindow() == hwnd
    }
}

fn key_input(vk: u16, up: bool, extended: bool) -> INPUT {
    unsafe {
        let mut i: INPUT = std::mem::zeroed();
        i.r#type = INPUT_KEYBOARD;
        let mut flags = 0u32;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        i.Anonymous.ki = KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        i
    }
}

fn send(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

pub fn is_down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0 }
}

/// Releases modifiers the user is still physically holding (e.g. Shift from Shift+Enter), so the
/// target app sees a clean shortcut. A held Ctrl is kept when the shortcut needs Ctrl anyway:
/// releasing it would break "hold Ctrl, tap V repeatedly" in the paste queue.
fn release_held_modifiers(keep_ctrl: bool) {
    let mut list: Vec<u16> = vec![VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN];
    if !keep_ctrl {
        list.extend([VK_CONTROL, VK_LCONTROL, VK_RCONTROL]);
    }
    let ups: Vec<INPUT> = list.into_iter().filter(|vk| is_down(*vk)).map(|vk| key_input(vk, true, false)).collect();
    if !ups.is_empty() {
        send(&ups);
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// `keys`: "ctrl+v" | "shift+insert" | "ctrl+shift+v"
pub fn send_paste_keys(keys: &str) {
    let k = keys.to_lowercase();
    let (mods, key, ext): (Vec<u16>, u16, bool) = match k.as_str() {
        "shift+insert" => (vec![VK_SHIFT], VK_INSERT, true),
        "ctrl+shift+v" => (vec![VK_CONTROL, VK_SHIFT], 0x56, false),
        _ => (vec![VK_CONTROL], 0x56, false),
    };
    let need_ctrl = mods.contains(&VK_CONTROL);
    let ctrl_held = need_ctrl && (is_down(VK_CONTROL) || is_down(VK_LCONTROL) || is_down(VK_RCONTROL));
    release_held_modifiers(need_ctrl);
    let mut seq = Vec::new();
    for m in &mods {
        if *m == VK_CONTROL && ctrl_held {
            continue; // already down: pressing/releasing it again would desync the physical key
        }
        seq.push(key_input(*m, false, false));
    }
    seq.push(key_input(key, false, ext));
    seq.push(key_input(key, true, ext));
    for m in mods.iter().rev() {
        if *m == VK_CONTROL && ctrl_held {
            continue;
        }
        seq.push(key_input(*m, true, false));
    }
    send(&seq);
}

// ───────────────────────────── geometry ─────────────────────────────

pub struct CaretRect {
    pub left: i32,
    pub top: i32,
    pub bottom: i32,
}

/// Classic Win32 caret (Notepad, WordPad, legacy controls).
pub fn caret_win32() -> Option<CaretRect> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 {
            return None;
        }
        let tid = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let mut gi: GUITHREADINFO = std::mem::zeroed();
        gi.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if GetGUIThreadInfo(tid, &mut gi) == 0 || gi.hwndCaret == 0 {
            return None;
        }
        let r = gi.rcCaret;
        if r.left == 0 && r.right == 0 && r.top == 0 && r.bottom == 0 {
            return None;
        }
        let mut p1 = POINT { x: r.left, y: r.top };
        let mut p2 = POINT { x: r.left, y: r.bottom };
        ClientToScreen(gi.hwndCaret, &mut p1);
        ClientToScreen(gi.hwndCaret, &mut p2);
        Some(CaretRect { left: p1.x, top: p1.y, bottom: p2.y })
    }
}

pub fn cursor_pos() -> (i32, i32) {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        GetCursorPos(&mut p);
        (p.x, p.y)
    }
}

/// Work area (left, top, right, bottom) in physical pixels of the monitor containing the point.
pub fn work_area_at(x: i32, y: i32) -> (i32, i32, i32, i32) {
    unsafe {
        let mon = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return (0, 0, 1920, 1040);
        }
        (mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom)
    }
}

// ───────────────────────────── window styles ─────────────────────────────

/// mode: "off" | "black" | "hidden"
///  black  -> WDA_MONITOR (0x1): the window shows as a black rectangle in screenshots/recordings
///  hidden -> WDA_EXCLUDEFROMCAPTURE (0x11, Win10 2004+): the window is invisible in captures
///
/// IMPORTANT: Never call `SetWindowDisplayAffinity` on a hidden (`!IsWindowVisible`) window on Windows:
/// calling it before a window is shown forces DWM to compose and display a white ghost window frame.
pub fn set_capture_protection(hwnd: isize, mode: &str) -> bool {
    if hwnd == 0 {
        return false;
    }
    let affinity: u32 = match mode {
        "black" => 0x1,
        "hidden" => 0x11,
        _ => 0x0,
    };
    unsafe {
        if IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 {
            return false;
        }
        let mut current: u32 = 0;
        if GetWindowDisplayAffinity(hwnd, &mut current) != 0 && current == affinity {
            return true;
        }
        SetWindowDisplayAffinity(hwnd, affinity) != 0
    }
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, dwattribute: u32, pvattribute: *const c_void, cbattribute: u32) -> i32;
}

/// Applies native Windows 11 DWM rounded corners (`DWMWA_WINDOW_CORNER_PREFERENCE = 33`, `DWMWCP_ROUND = 2`)
/// so frameless windows (`tray`, `popup`, `queue`) have smooth OS-composited rounded corners and shadow
/// without a sharp rectangular outer box sticking out behind the rounded CSS surface.
pub fn round_window_corners(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        if IsWindow(hwnd) == 0 {
            return;
        }
        let pref: u32 = 2; // DWMWCP_ROUND
        let _ = DwmSetWindowAttribute(hwnd, 33, &pref as *const u32 as *const c_void, 4);
    }
}

/// Marks a frameless Tauri window as non-activating (`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`)
/// without stripping `WS_THICKFRAME` from `GWL_STYLE` (preserving Tauri's `WM_NCCALCSIZE` client rect
/// so no unpainted white Win32 border appears around the WebView).
pub fn make_no_activate(hwnd: isize) {
    unsafe {
        if hwnd == 0 || IsWindow(hwnd) == 0 {
            return;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let target_ex = (ex & !(WS_EX_APPWINDOW as isize)) | (WS_EX_NOACTIVATE as isize) | (WS_EX_TOOLWINDOW as isize);
        if ex != target_ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, target_ex);
        }
    }
}

pub fn show_no_activate(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

pub fn hide_window(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd, SW_HIDE);
    }
}

#[allow(dead_code)]
pub fn _unused(_: *const c_void) {}

// ───────────────────────────── system fonts enumeration ─────────────────────────────

unsafe extern "system" fn enum_font_proc(
    lpelfe: *const LOGFONTW,
    _lpntme: *const TEXTMETRICW,
    _font_type: u32,
    lparam: LPARAM,
) -> i32 {
    if !lpelfe.is_null() && lparam != 0 {
        let lf = &*lpelfe;
        let end = lf.lfFaceName.iter().position(|&c| c == 0).unwrap_or(lf.lfFaceName.len());
        if end > 0 {
            let name = String::from_utf16_lossy(&lf.lfFaceName[..end]).trim().to_string();
            if !name.is_empty() && !name.starts_with('@') {
                let out = &mut *(lparam as *mut Vec<String>);
                out.push(name);
            }
        }
    }
    1
}

/// Enumerates all installed font families on Windows via GDI EnumFontFamiliesExW.
pub fn list_system_fonts() -> Vec<String> {
    unsafe {
        let hdc = GetDC(0);
        if hdc == 0 {
            return vec![];
        }
        let mut lf: LOGFONTW = std::mem::zeroed();
        lf.lfCharSet = DEFAULT_CHARSET as u8;
        let mut names: Vec<String> = Vec::with_capacity(256);
        EnumFontFamiliesExW(hdc, &lf, Some(enum_font_proc), &mut names as *mut Vec<String> as LPARAM, 0);
        ReleaseDC(0, hdc);
        names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        names
    }
}

// ───────────────────────────── Windows File Explorer context menu ─────────────────────────────

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        hkey: isize,
        lp_sub_key: *const u16,
        reserved: u32,
        lp_class: *const u16,
        dw_options: u32,
        sam_desired: u32,
        lp_security_attributes: *const c_void,
        phk_result: *mut isize,
        lpdw_disposition: *mut u32,
    ) -> i32;
    fn RegQueryValueExW(
        hkey: isize,
        lp_value_name: *const u16,
        lp_reserved: *const u32,
        lp_type: *mut u32,
        lp_data: *mut u8,
        lpcb_data: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        hkey: isize,
        lp_value_name: *const u16,
        reserved: u32,
        dw_type: u32,
        lp_data: *const u8,
        cb_data: u32,
    ) -> i32;
    fn RegDeleteTreeW(hkey: isize, lp_sub_key: *const u16) -> i32;
    fn RegCloseKey(hkey: isize) -> i32;
}

const HKEY_CURRENT_USER_HANDLE: isize = 0x80000001u32 as i32 as isize;
const KEY_WRITE_ACCESS: u32 = 0x20006;
const REG_SZ_TYPE: u32 = 1;

fn set_hkcu_string(subkey: &str, value_name: Option<&str>, data: &str) -> Result<(), String> {
    unsafe {
        let wsub = wide(subkey);
        let mut hkey: isize = 0;
        let mut disp: u32 = 0;
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER_HANDLE,
            wsub.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_WRITE_ACCESS,
            std::ptr::null(),
            &mut hkey,
            &mut disp,
        );
        if rc != 0 || hkey == 0 {
            return Err(format!("RegCreateKeyExW failed for {subkey}: code {rc}"));
        }
        let wname = value_name.map(wide);
        let name_ptr = wname.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null());
        let wdata = wide(data);
        let byte_len = (wdata.len() * 2) as u32;
        let rc_set = RegSetValueExW(hkey, name_ptr, 0, REG_SZ_TYPE, wdata.as_ptr() as *const u8, byte_len);
        RegCloseKey(hkey);
        if rc_set != 0 {
            return Err(format!("RegSetValueExW failed for {subkey}: code {rc_set}"));
        }
        Ok(())
    }
}

fn delete_hkcu_tree(subkey: &str) {
    unsafe {
        let wsub = wide(subkey);
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER_HANDLE, wsub.as_ptr());
    }
}

/// Registers or removes ClipNest entries in the per-user Windows File Explorer context menu (`HKCU\Software\Classes`).
/// Works without Administrator privileges on both per-user and system-wide installations.
pub fn sync_explorer_context_menu(enabled: bool, lang: &str) -> Result<(), String> {
    let keys = [
        r"Software\Classes\Directory\Background\shell\ClipNest",
        r"Software\Classes\Directory\Background\shell\ClipNestBasket",
        r"Software\Classes\Directory\shell\ClipNest",
        r"Software\Classes\*\shell\ClipNestCollect",
    ];
    if !enabled {
        for k in keys {
            delete_hkcu_tree(k);
        }
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().to_string();
    let icon_val = format!("\"{exe_str}\",0");

    let (lbl_view_bg, lbl_basket_bg, lbl_view_dir, lbl_collect_file) = match lang {
        "fa" => (
            "ClipNest — مشاهده و پیست فایل‌های کپی‌شده در اینجا",
            "ClipNest — پیست سبد فایل‌ها (Drop Basket) در اینجا",
            "ClipNest — مشاهده و پیست فایل‌های کپی‌شده در این پوشه",
            "ClipNest — افزودن فایل به سبد (Drop Basket)",
        ),
        "ar" => (
            "ClipNest — عرض ولصق الملفات المنسوخة هنا",
            "ClipNest — لصق سلة الملفات (Drop Basket) هنا",
            "ClipNest — عرض ولصق الملفات المنسوخة في هذا المجلد",
            "ClipNest — إضافة الملف إلى سلة الملفات (Drop Basket)",
        ),
        "de" => (
            "ClipNest — Kopierte Dateien hier anzeigen & einfügen",
            "ClipNest — Dateikorb (Drop Basket) hier einfügen",
            "ClipNest — Kopierte Dateien im Ordner anzeigen & einfügen",
            "ClipNest — Datei zum Dateikorb (Drop Basket) hinzufügen",
        ),
        "es" => (
            "ClipNest — Ver y pegar archivos copiados aquí",
            "ClipNest — Pegar cesta de archivos (Drop Basket) aquí",
            "ClipNest — Ver y pegar archivos copiados en la carpeta",
            "ClipNest — Añadir archivo a la cesta (Drop Basket)",
        ),
        "fr" => (
            "ClipNest — Afficher et coller les fichiers copiés ici",
            "ClipNest — Coller le panier de fichiers (Drop Basket) ici",
            "ClipNest — Afficher et coller les fichiers copiés dans le dossier",
            "ClipNest — Ajouter le fichier au panier (Drop Basket)",
        ),
        "ru" => (
            "ClipNest — Показать и вставить скопированные файлы сюда",
            "ClipNest — Вставить корзину файлов (Drop Basket) сюда",
            "ClipNest — Показать и вставить скопированные файлы в папку",
            "ClipNest — Добавить файл в корзину (Drop Basket)",
        ),
        "tr" => (
            "ClipNest — Kopyalanan Dosyaları Burada Görüntüle ve Yapıştır",
            "ClipNest — Dosya Sepetini (Drop Basket) Buraya Yapıştır",
            "ClipNest — Kopyalanan Dosyaları Klasörde Görüntüle ve Yapıştır",
            "ClipNest — Dosyayı Dosya Sepetine (Drop Basket) Ekle",
        ),
        "zh" => (
            "ClipNest — 在此处查看并粘贴已复制的文件",
            "ClipNest — 在此处粘贴文件篮 (Drop Basket)",
            "ClipNest — 在文件夹中查看并粘贴已复制的文件",
            "ClipNest — 将文件添加到文件篮 (Drop Basket)",
        ),
        _ => (
            "ClipNest — View & Paste Copied Files Here",
            "ClipNest — Paste Drop Basket Here",
            "ClipNest — View & Paste Copied Files in Folder",
            "ClipNest — Add File to Drop Basket",
        ),
    };

    // 1. Folder background right-click: View & Paste Copied Files Here
    set_hkcu_string(r"Software\Classes\Directory\Background\shell\ClipNest", None, lbl_view_bg)?;
    set_hkcu_string(r"Software\Classes\Directory\Background\shell\ClipNest", Some("Icon"), &icon_val)?;
    set_hkcu_string(
        r"Software\Classes\Directory\Background\shell\ClipNest\command",
        None,
        &format!("\"{exe_str}\" --explorer-files \"%V\""),
    )?;

    // 2. Folder background right-click: Paste Drop Basket Here
    set_hkcu_string(r"Software\Classes\Directory\Background\shell\ClipNestBasket", None, lbl_basket_bg)?;
    set_hkcu_string(r"Software\Classes\Directory\Background\shell\ClipNestBasket", Some("Icon"), &icon_val)?;
    set_hkcu_string(
        r"Software\Classes\Directory\Background\shell\ClipNestBasket\command",
        None,
        &format!("\"{exe_str}\" --paste-basket \"%V\""),
    )?;

    // 3. Folder item right-click: View & Paste Copied Files in Folder
    set_hkcu_string(r"Software\Classes\Directory\shell\ClipNest", None, lbl_view_dir)?;
    set_hkcu_string(r"Software\Classes\Directory\shell\ClipNest", Some("Icon"), &icon_val)?;
    set_hkcu_string(
        r"Software\Classes\Directory\shell\ClipNest\command",
        None,
        &format!("\"{exe_str}\" --explorer-files \"%1\""),
    )?;

    // 4. Individual file right-click: Add File to Drop Basket
    set_hkcu_string(r"Software\Classes\*\shell\ClipNestCollect", None, lbl_collect_file)?;
    set_hkcu_string(r"Software\Classes\*\shell\ClipNestCollect", Some("Icon"), &icon_val)?;
    set_hkcu_string(
        r"Software\Classes\*\shell\ClipNestCollect\command",
        None,
        &format!("\"{exe_str}\" --collect-file \"%1\""),
    )?;

    Ok(())
}

// ───────────────────────────── application & shell thumbnails ─────────────────────────────

#[repr(C)]
struct Bmi {
    header: BITMAPINFOHEADER,
    colors: [u32; 256],
}

impl Bmi {
    fn new_top_down(w: i32, h: i32) -> Self {
        let mut bi: Bmi = unsafe { std::mem::zeroed() };
        bi.header.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.header.biWidth = w;
        bi.header.biHeight = -h; // top-down
        bi.header.biPlanes = 1;
        bi.header.biBitCount = 32;
        bi.header.biCompression = 0; // BI_RGB
        bi
    }
}

/// Extracts the 32×32 icon of an executable as RGBA pixels.
pub fn extract_icon_rgba(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    unsafe {
        let wpath = wide(path);
        let mut large: isize = 0;
        let mut small: isize = 0;
        let n = ExtractIconExW(wpath.as_ptr(), 0, &mut large, &mut small, 1);
        if small != 0 {
            DestroyIcon(small);
        }
        if n == 0 || large == 0 {
            if large != 0 {
                DestroyIcon(large);
            }
            return None;
        }
        let res = icon_to_rgba(large);
        DestroyIcon(large);
        res
    }
}

unsafe fn icon_to_rgba(hicon: isize) -> Option<(u32, u32, Vec<u8>)> {
    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut ii) == 0 {
        return None;
    }
    let (hc, hm) = (ii.hbmColor, ii.hbmMask);
    let mut result = None;
    if hc != 0 {
        let mut bm: BITMAP = std::mem::zeroed();
        GetObjectW(hc, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut BITMAP as *mut c_void);
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w > 0 && h > 0 {
            let hdc = GetDC(0);
            let n = (w * h) as usize;
            let mut px = vec![0u8; n * 4];
            let mut bi = Bmi::new_top_down(w, h);
            let got = GetDIBits(
                hdc,
                hc,
                0,
                h as u32,
                px.as_mut_ptr() as *mut c_void,
                &mut bi as *mut Bmi as *mut BITMAPINFO,
                0,
            );
            if got != 0 {
                // Old icons carry no alpha channel: derive it from the AND mask.
                if px.chunks_exact(4).all(|p| p[3] == 0) && hm != 0 {
                    let mut mask = vec![0u8; n * 4];
                    let mut bi2 = Bmi::new_top_down(w, h);
                    if GetDIBits(
                        hdc,
                        hm,
                        0,
                        h as u32,
                        mask.as_mut_ptr() as *mut c_void,
                        &mut bi2 as *mut Bmi as *mut BITMAPINFO,
                        0,
                    ) != 0
                    {
                        for i in 0..n {
                            px[i * 4 + 3] = if mask[i * 4] == 0 { 255 } else { 0 };
                        }
                    }
                }
                for p in px.chunks_exact_mut(4) {
                    p.swap(0, 2); // BGRA -> RGBA
                }
                result = Some((w as u32, h as u32, px));
            }
            ReleaseDC(0, hdc);
        }
    }
    if hc != 0 {
        DeleteObject(hc);
    }
    if hm != 0 {
        DeleteObject(hm);
    }
    result
}

unsafe fn hbitmap_to_rgba(hbmp: isize) -> Option<(u32, u32, Vec<u8>)> {
    if hbmp == 0 {
        return None;
    }
    let mut bm: BITMAP = std::mem::zeroed();
    if GetObjectW(hbmp, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut BITMAP as *mut c_void) == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    if w <= 0 || h <= 0 {
        return None;
    }
    let hdc = GetDC(0);
    let n = (w * h) as usize;
    let mut px = vec![0u8; n * 4];
    let mut bi = Bmi::new_top_down(w, h);
    let got =
        GetDIBits(hdc, hbmp, 0, h as u32, px.as_mut_ptr() as *mut c_void, &mut bi as *mut Bmi as *mut BITMAPINFO, 0);
    ReleaseDC(0, hdc);
    if got == 0 {
        return None;
    }
    if px.chunks_exact(4).all(|p| p[3] == 0) {
        for p in px.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2); // BGRA -> RGBA
    }
    Some((w as u32, h as u32, px))
}

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

#[repr(C)]
struct IShellItemImageFactoryVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_image: unsafe extern "system" fn(*mut c_void, POINT, i32, *mut isize) -> i32,
}

#[repr(C)]
struct IShellItemImageFactoryRaw {
    lp_vtbl: *const IShellItemImageFactoryVtbl,
}

#[link(name = "shell32")]
extern "system" {
    fn SHCreateItemFromParsingName(
        psz_path: *const u16,
        pbc: *mut c_void,
        riid: *const Guid,
        ppv: *mut *mut c_void,
    ) -> i32;
    fn ILCreateFromPathW(psz_path: *const u16) -> *mut c_void;
    fn ILFindLastID(pidl: *const c_void) -> *const c_void;
    fn ILFree(pidl: *const c_void);
    fn SHOpenFolderAndSelectItems(
        pidl_folder: *const c_void,
        cidl: u32,
        apidl: *const *const c_void,
        dw_flags: u32,
    ) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pv_reserved: *mut c_void, dw_co_init: u32) -> i32;
    fn CoUninitialize();
}

/// Opens the parent folder(s) in Windows File Explorer and highlights ALL specified files simultaneously
/// via `SHOpenFolderAndSelectItems` (falling back to `explorer /select` if a Shell PIDL cannot be resolved).
pub fn reveal_files_in_explorer(paths: &[String]) -> Result<(), String> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for raw in paths {
        let cleaned = raw.trim().trim_matches('"').replace('/', "\\");
        if cleaned.is_empty() || cleaned.contains(['"', '\0', '\r', '\n']) {
            continue;
        }
        let parent = Path::new(&cleaned).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if parent.is_empty() {
            continue;
        }
        if let Some((_, list)) = groups.iter_mut().find(|(dir, _)| dir.eq_ignore_ascii_case(&parent)) {
            if !list.iter().any(|existing| existing.eq_ignore_ascii_case(&cleaned)) {
                list.push(cleaned);
            }
        } else {
            groups.push((parent, vec![cleaned]));
        }
    }

    if groups.is_empty() {
        return Ok(());
    }

    unsafe {
        // COINIT_APARTMENTTHREADED (0x2) is required by SHOpenFolderAndSelectItems.
        let hr_init = CoInitializeEx(std::ptr::null_mut(), 0x2);
        let should_uninit = hr_init >= 0;

        for (folder, files) in &groups {
            let wfolder = wide(folder);
            let pidl_folder = ILCreateFromPathW(wfolder.as_ptr());
            let mut selected_ok = false;

            if !pidl_folder.is_null() {
                let mut full_pidls: Vec<*const c_void> = Vec::with_capacity(files.len());
                let mut child_pidls: Vec<*const c_void> = Vec::with_capacity(files.len());
                for f in files {
                    let wf = wide(f);
                    let pidl = ILCreateFromPathW(wf.as_ptr());
                    if !pidl.is_null() {
                        full_pidls.push(pidl as *const c_void);
                        child_pidls.push(ILFindLastID(pidl as *const c_void));
                    }
                }
                if !child_pidls.is_empty() {
                    let hr = SHOpenFolderAndSelectItems(
                        pidl_folder as *const c_void,
                        child_pidls.len() as u32,
                        child_pidls.as_ptr(),
                        0,
                    );
                    if hr >= 0 {
                        selected_ok = true;
                    }
                }
                for p in full_pidls {
                    ILFree(p);
                }
                ILFree(pidl_folder as *const c_void);
            }

            if !selected_ok {
                if let Some(first) = files.first() {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{first}\"")).spawn();
                }
            }
        }

        if should_uninit {
            CoUninitialize();
        }
    }
    Ok(())
}

/// Extracts a thumbnail for an image, video, or media file via IShellItemImageFactory.
pub fn extract_shell_thumbnail_rgba(path: &str, max_side: i32) -> Option<(u32, u32, Vec<u8>)> {
    const IID_ISHELL_ITEM_IMAGE_FACTORY: Guid = Guid {
        data1: 0xbcc18b79,
        data2: 0xba16,
        data3: 0x442f,
        data4: [0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b],
    };
    // SIIGBF_BIGGERSIZEOK (0x01) | SIIGBF_THUMBNAILONLY (0x08)
    const SIIGBF_THUMBNAIL: i32 = 0x01 | 0x08;
    const SIIGBF_RESIZETOFIT: i32 = 0x00;

    unsafe {
        let hr_init = CoInitializeEx(std::ptr::null_mut(), 0); // COINIT_MULTITHREADED
        let should_uninit = hr_init >= 0;
        let wpath = wide(path);
        let mut factory_ptr: *mut c_void = std::ptr::null_mut();
        let hr = SHCreateItemFromParsingName(
            wpath.as_ptr(),
            std::ptr::null_mut(),
            &IID_ISHELL_ITEM_IMAGE_FACTORY,
            &mut factory_ptr,
        );
        let mut out = None;
        if hr >= 0 && !factory_ptr.is_null() {
            let factory = &*(factory_ptr as *const IShellItemImageFactoryRaw);
            let mut hbmp: isize = 0;
            let sz = POINT { x: max_side, y: max_side };
            let mut hr_img = ((*factory.lp_vtbl).get_image)(factory_ptr, sz, SIIGBF_THUMBNAIL, &mut hbmp);
            if hr_img < 0 || hbmp == 0 {
                hr_img = ((*factory.lp_vtbl).get_image)(factory_ptr, sz, SIIGBF_RESIZETOFIT, &mut hbmp);
            }
            if hr_img >= 0 && hbmp != 0 {
                out = hbitmap_to_rgba(hbmp);
                DeleteObject(hbmp);
            }
            ((*factory.lp_vtbl).release)(factory_ptr);
        }
        if should_uninit {
            CoUninitialize();
        }
        out
    }
}

/// Extracts the icon Windows Explorer shows for a file/folder (file-type icon, folder icon, exe/lnk icon …)
/// via IShellItemImageFactory with `SIIGBF_ICONONLY` (never a content thumbnail).
pub fn extract_shell_icon_rgba(path: &str, side: i32) -> Option<(u32, u32, Vec<u8>)> {
    const IID_ISHELL_ITEM_IMAGE_FACTORY: Guid = Guid {
        data1: 0xbcc18b79,
        data2: 0xba16,
        data3: 0x442f,
        data4: [0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b],
    };
    // SIIGBF_BIGGERSIZEOK (0x01) | SIIGBF_ICONONLY (0x04)
    const SIIGBF_ICON: i32 = 0x01 | 0x04;

    unsafe {
        let hr_init = CoInitializeEx(std::ptr::null_mut(), 0); // COINIT_MULTITHREADED
        let should_uninit = hr_init >= 0;
        let wpath = wide(path);
        let mut factory_ptr: *mut c_void = std::ptr::null_mut();
        let hr = SHCreateItemFromParsingName(
            wpath.as_ptr(),
            std::ptr::null_mut(),
            &IID_ISHELL_ITEM_IMAGE_FACTORY,
            &mut factory_ptr,
        );
        let mut out = None;
        if hr >= 0 && !factory_ptr.is_null() {
            let factory = &*(factory_ptr as *const IShellItemImageFactoryRaw);
            let mut hbmp: isize = 0;
            let sz = POINT { x: side, y: side };
            let hr_img = ((*factory.lp_vtbl).get_image)(factory_ptr, sz, SIIGBF_ICON, &mut hbmp);
            if hr_img >= 0 && hbmp != 0 {
                out = hbitmap_to_rgba(hbmp);
                DeleteObject(hbmp);
            }
            ((*factory.lp_vtbl).release)(factory_ptr);
        }
        if should_uninit {
            CoUninitialize();
        }
        out
    }
}

// ───────────────────────────── low-level keyboard hook (Win-key shortcuts) ─────────────────────────────
//
// Windows reserves shortcuts such as Win+V for itself, so RegisterHotKey refuses them. A low-level
// keyboard hook sees the keys first (this is how AutoHotkey does it): the matching key press is
// swallowed and a harmless "mask" key stops the Start menu from opening when Win is released.

pub const MOD_CTRL: u8 = 1;
pub const MOD_ALT: u8 = 2;
pub const MOD_SHIFT: u8 = 4;
pub const MOD_WIN: u8 = 8;

static HOOK_TX: OnceLock<Sender<u32>> = OnceLock::new();
/// (modifier mask, virtual key, binding id)
static BINDINGS: parking_lot::Mutex<Vec<(u8, u32, u32)>> = parking_lot::Mutex::new(Vec::new());
static SWALLOWED_VK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static HOOK_TID: parking_lot::Mutex<u32> = parking_lot::Mutex::new(0);

pub fn is_win_shortcut(s: &str) -> bool {
    s.split('+').any(|p| matches!(p.trim().to_lowercase().as_str(), "super" | "win" | "meta" | "cmd" | "command"))
}

/// "Super+V" / "Ctrl+Alt+F5" -> (modifier mask, virtual-key code)
pub fn parse_shortcut(s: &str) -> Option<(u8, u32)> {
    let mut mods = 0u8;
    let mut vk: Option<u32> = None;
    for part in s.split('+') {
        let p = part.trim().to_lowercase();
        match p.as_str() {
            "ctrl" | "control" => mods |= MOD_CTRL,
            "alt" | "option" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "super" | "win" | "meta" | "cmd" | "command" => mods |= MOD_WIN,
            "" => {}
            key => {
                let code = match key {
                    "space" => 0x20,
                    "enter" | "return" => 0x0D,
                    "tab" => 0x09,
                    "escape" | "esc" => 0x1B,
                    "backspace" => 0x08,
                    "delete" => 0x2E,
                    "insert" => 0x2D,
                    "home" => 0x24,
                    "end" => 0x23,
                    "pageup" => 0x21,
                    "pagedown" => 0x22,
                    "arrowleft" | "left" => 0x25,
                    "arrowup" | "up" => 0x26,
                    "arrowright" | "right" => 0x27,
                    "arrowdown" | "down" => 0x28,
                    "backquote" => 0xC0,
                    "minus" => 0xBD,
                    "equal" => 0xBB,
                    "comma" => 0xBC,
                    "period" => 0xBE,
                    "slash" => 0xBF,
                    "semicolon" => 0xBA,
                    "quote" => 0xDE,
                    "bracketleft" => 0xDB,
                    "bracketright" => 0xDD,
                    "backslash" => 0xDC,
                    k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphanumeric() => {
                        k.to_uppercase().as_bytes()[0] as u32
                    }
                    k if k.starts_with('f')
                        && k[1..].parse::<u32>().map(|n| (1..=24).contains(&n)).unwrap_or(false) =>
                    {
                        0x70 + k[1..].parse::<u32>().unwrap() - 1
                    }
                    _ => return None,
                };
                vk = Some(code);
            }
        }
    }
    vk.map(|v| (mods, v))
}

/// Probes whether a global hotkey is currently available in Windows via RegisterHotKey.
/// Returns `Ok(true)` if free, `Ok(false)` if claimed by another process or the OS.
pub fn probe_hotkey_available(shortcut: &str) -> Result<bool, String> {
    let (mods, vk) = parse_shortcut(shortcut).ok_or_else(|| String::from("Invalid shortcut"))?;
    let mut win_mods: u32 = 0x4000; // MOD_NOREPEAT
    if (mods & MOD_ALT) != 0 {
        win_mods |= 0x0001; // MOD_ALT
    }
    if (mods & MOD_CTRL) != 0 {
        win_mods |= 0x0002; // MOD_CONTROL
    }
    if (mods & MOD_SHIFT) != 0 {
        win_mods |= 0x0004; // MOD_SHIFT
    }
    if (mods & MOD_WIN) != 0 {
        win_mods |= 0x0008; // MOD_WIN
    }
    const PROBE_ID: i32 = 0x6F7E;
    unsafe {
        let ok = RegisterHotKey(0, PROBE_ID, win_mods, vk);
        if ok != 0 {
            UnregisterHotKey(0, PROBE_ID);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

pub fn set_hook_bindings(v: Vec<(u8, u32, u32)>) {
    let empty = v.is_empty();
    *BINDINGS.lock() = v;
    let mut tid_guard = HOOK_TID.lock();
    if empty {
        let tid = std::mem::take(&mut *tid_guard);
        if tid != 0 {
            unsafe {
                PostThreadMessageW(tid, WM_QUIT, 0, 0);
            }
        }
    } else if *tid_guard == 0 {
        if let Some(tid) = spawn_hook_thread_sync() {
            *tid_guard = tid;
        }
    }
}

fn current_mods() -> u8 {
    let mut m = 0u8;
    if is_down(VK_CONTROL) {
        m |= MOD_CTRL;
    }
    if is_down(VK_MENU) {
        m |= MOD_ALT;
    }
    if is_down(VK_SHIFT) {
        m |= MOD_SHIFT;
    }
    if is_down(VK_LWIN) || is_down(VK_RWIN) {
        m |= MOD_WIN;
    }
    m
}

unsafe extern "system" fn ll_keyboard_proc(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lp as *const KBDLLHOOKSTRUCT);
        if kb.flags & LLKHF_INJECTED == 0 {
            let msg = wp as u32;
            let vk = kb.vkCode;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                if SWALLOWED_VK.load(Ordering::SeqCst) == vk {
                    return 1;
                }
                let mods = current_mods();
                let hit = BINDINGS.lock().iter().find(|b| b.1 == vk && b.0 == mods).copied();
                if let Some((m, _, id)) = hit {
                    if let Some(tx) = HOOK_TX.get() {
                        let _ = tx.send(id);
                    }
                    SWALLOWED_VK.store(vk, Ordering::SeqCst);
                    if m & MOD_WIN != 0 {
                        // Unassigned key tap: tells the shell "another key was used", so the Start menu stays closed.
                        send(&[key_input(0xE8, false, false), key_input(0xE8, true, false)]);
                    }
                    return 1;
                }
            } else if (msg == WM_KEYUP || msg == WM_SYSKEYUP) && SWALLOWED_VK.load(Ordering::SeqCst) == vk {
                SWALLOWED_VK.store(0, Ordering::SeqCst);
                return 1;
            }
        }
    }
    CallNextHookEx(0, code, wp, lp)
}

fn spawn_hook_thread_sync() -> Option<u32> {
    if HOOK_TX.get().is_none() {
        return None;
    }
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Option<u32>>(1);
    std::thread::spawn(move || unsafe {
        let tid = GetCurrentThreadId();
        // Force creation of the thread message queue before publishing `tid` so PostThreadMessageW never fails.
        let mut init_msg: MSG = std::mem::zeroed();
        PeekMessageW(&mut init_msg, 0, WM_USER, WM_USER, PM_NOREMOVE);
        let hinst = GetModuleHandleW(std::ptr::null());
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_keyboard_proc), hinst, 0);
        if hook == 0 {
            eprintln!("clipnest: could not install the keyboard hook");
            let _ = ready_tx.send(None);
            return;
        }
        let _ = ready_tx.send(Some(tid));
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        UnhookWindowsHookEx(hook);
        let mut guard = HOOK_TID.lock();
        if *guard == tid {
            *guard = 0;
        }
    });
    ready_rx.recv().ok().flatten()
}

/// Starts the hook thread once (idempotent). `tx` receives the binding id of every matched shortcut.
pub fn start_hotkey_hook(tx: Sender<u32>) {
    let _ = HOOK_TX.set(tx);
    if !BINDINGS.lock().is_empty() {
        let mut tid_guard = HOOK_TID.lock();
        if *tid_guard == 0 {
            if let Some(tid) = spawn_hook_thread_sync() {
                *tid_guard = tid;
            }
        }
    }
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(h_algorithm: *mut c_void, pb_buffer: *mut u8, cb_buffer: u32, dw_flags: u32) -> i32;
}

/// Generates `len` cryptographically secure random bytes using Windows CNG (`BCryptGenRandom`).
pub fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let mut buf = vec![0u8; len];
    let status =
        unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), len as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status != 0 {
        return Err(format!("BCryptGenRandom failed: NTSTATUS 0x{:08X}", status as u32));
    }
    Ok(buf)
}

// ───────────────────────────── CLI User PATH & Console Helpers ─────────────────────────────

const KEY_READ_WRITE_ACCESS: u32 = 0x2001F;
const REG_EXPAND_SZ_TYPE: u32 = 2;
const ERROR_FILE_NOT_FOUND_CODE: i32 = 2;
const ERROR_MORE_DATA_CODE: i32 = 234;

fn norm_path_entry(p: &str) -> String {
    p.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_lowercase()
}

/// Reads the current user's `Path` environment variable from `HKCU\Environment`.
pub fn get_user_path() -> Result<String, String> {
    unsafe {
        let wsub = wide("Environment");
        let mut hkey: isize = 0;
        let mut disp: u32 = 0;
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER_HANDLE,
            wsub.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_READ_WRITE_ACCESS,
            std::ptr::null(),
            &mut hkey,
            &mut disp,
        );
        if rc != 0 || hkey == 0 {
            return Err(format!("RegCreateKeyExW(Environment) failed: code {rc}"));
        }
        let wname = wide("Path");
        let mut dtype: u32 = 0;
        let mut size: u32 = 0;
        let rc_q =
            RegQueryValueExW(hkey, wname.as_ptr(), std::ptr::null(), &mut dtype, std::ptr::null_mut(), &mut size);
        if rc_q == ERROR_FILE_NOT_FOUND_CODE || (rc_q == 0 && size == 0) {
            RegCloseKey(hkey);
            return Ok(String::new());
        }
        if rc_q != 0 {
            RegCloseKey(hkey);
            return Err(format!("RegQueryValueExW(Path size) failed: code {rc_q}"));
        }
        let mut buf: Vec<u16>;
        let mut actual: u32;
        let mut rc_read = ERROR_MORE_DATA_CODE;
        for _ in 0..4 {
            buf = vec![0u16; (size as usize / 2) + 2];
            actual = (buf.len() * 2) as u32;
            rc_read = RegQueryValueExW(
                hkey,
                wname.as_ptr(),
                std::ptr::null(),
                &mut dtype,
                buf.as_mut_ptr() as *mut u8,
                &mut actual,
            );
            if rc_read == 0 {
                RegCloseKey(hkey);
                if dtype != REG_SZ_TYPE && dtype != REG_EXPAND_SZ_TYPE {
                    return Err(format!("unexpected registry type for Path: {dtype}"));
                }
                let len = (actual as usize / 2).min(buf.len());
                let end = buf[..len].iter().position(|&c| c == 0).unwrap_or(len);
                return Ok(String::from_utf16_lossy(&buf[..end]));
            }
            if rc_read != ERROR_MORE_DATA_CODE {
                break;
            }
            size = actual;
        }
        RegCloseKey(hkey);
        Err(format!("RegQueryValueExW(Path read) failed: code {rc_read}"))
    }
}

pub fn is_dir_in_user_path(dir: &str) -> bool {
    let target = norm_path_entry(dir);
    if target.is_empty() {
        return false;
    }
    let Ok(cur) = get_user_path() else {
        return false;
    };
    cur.split(';').any(|part| norm_path_entry(part) == target)
}

/// Ensures `clipnest.cmd` and `clipn.cmd` console shims exist inside `dir` so both `clipnest`
/// and the short alias `clipn` work in CMD, PowerShell, and Git Bash.
fn ensure_cli_shims(dir: &Path) {
    let shim = "@echo off\r\nsetlocal\r\nif exist \"%~dp0clipnest-cli.exe\" (\r\n  \"%~dp0clipnest-cli.exe\" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\n\"%~dp0ClipNest.exe\" %*\r\nexit /b %ERRORLEVEL%\r\n";
    for name in ["clipnest.cmd", "clipn.cmd"] {
        let p = dir.join(name);
        if !p.exists() {
            let _ = std::fs::write(&p, shim.as_bytes());
        }
    }
}

/// Adds or removes `dir` in `HKCU\Environment` `Path` without requiring Administrator privileges,
/// preventing duplicates and preserving all unrelated user PATH entries. Broadcasts `WM_SETTINGCHANGE`.
pub fn sync_user_path(dir: &str, enable: bool) -> Result<bool, String> {
    let clean_dir = dir.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_string();
    let target = norm_path_entry(&clean_dir);
    if target.is_empty() {
        return Err("empty directory path".into());
    }
    if enable {
        ensure_cli_shims(Path::new(&clean_dir));
    }
    let cur = get_user_path()?;
    let mut parts: Vec<String> = cur.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let exists = parts.iter().any(|p| norm_path_entry(p) == target);
    if enable && exists {
        return Ok(false);
    }
    if !enable && !exists {
        return Ok(false);
    }
    if enable {
        parts.push(clean_dir);
    } else {
        parts.retain(|p| norm_path_entry(p) != target);
    }
    let new_path = parts.join(";");
    unsafe {
        let wsub = wide("Environment");
        let mut hkey: isize = 0;
        let mut disp: u32 = 0;
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER_HANDLE,
            wsub.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_READ_WRITE_ACCESS,
            std::ptr::null(),
            &mut hkey,
            &mut disp,
        );
        if rc != 0 || hkey == 0 {
            return Err(format!("RegCreateKeyExW(Environment) failed: code {rc}"));
        }
        let wname = wide("Path");
        let wdata = wide(&new_path);
        let byte_len = (wdata.len() * 2) as u32;
        let rc_set = RegSetValueExW(hkey, wname.as_ptr(), 0, REG_EXPAND_SZ_TYPE, wdata.as_ptr() as *const u8, byte_len);
        RegCloseKey(hkey);
        if rc_set != 0 {
            return Err(format!("RegSetValueExW(Path) failed: code {rc_set}"));
        }
        let env_wide = wide("Environment");
        let mut res: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            env_wide.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            1000,
            &mut res,
        );
    }
    Ok(true)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn random_bytes_returns_non_repeating_entropy() {
        let a = random_bytes(32).expect("BCryptGenRandom");
        let b = random_bytes(32).expect("BCryptGenRandom");
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
