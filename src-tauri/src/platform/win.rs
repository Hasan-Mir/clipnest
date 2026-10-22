//! All direct Win32 calls live here (via `windows-sys`, raw bindings, no wrappers).

use std::ffi::c_void;
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
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub const CF_UNICODETEXT_ID: u32 = 13;
pub const CF_DIB_ID: u32 = 8;
pub const CF_DIBV5_ID: u32 = 17;
pub const CF_HDROP_ID: u32 = 15;

const WM_CLIPBOARDUPDATE_MSG: u32 = 0x031D;

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
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
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            0,
            hinst,
            std::ptr::null(),
        );
        if hwnd == 0 {
            eprintln!("clipnest: could not create the clipboard listener window");
            return;
        }
        OWNER_HWND.store(hwnd, Ordering::SeqCst);
        if AddClipboardFormatListener(hwnd) == 0 {
            eprintln!("clipnest: AddClipboardFormatListener failed");
            return;
        }
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

unsafe fn get_bytes(fmt: u32) -> Option<Vec<u8>> {
    let h = GetClipboardData(fmt);
    if h == 0 {
        return None;
    }
    let h = h as HGLOBAL;
    let size = GlobalSize(h);
    if size == 0 {
        return None;
    }
    let p = GlobalLock(h);
    if p.is_null() {
        return None;
    }
    let v = std::slice::from_raw_parts(p as *const u8, size).to_vec();
    GlobalUnlock(h);
    Some(v)
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
                    if let Some(d) = get_bytes(*id) {
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
                if let Some(data) = get_bytes(id) {
                    total += data.len();
                    if total > max_total {
                        CloseClipboard();
                        return Err("clipboard content too large".into());
                    }
                    formats.push(RawFormat { id, name, data });
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
pub fn write_clipboard(items: &[(u32, String, Vec<u8>)]) -> Result<u32, String> {
    unsafe {
        let mut owner = OWNER_HWND.load(Ordering::SeqCst);
        for _ in 0..50 {
            if owner != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            owner = OWNER_HWND.load(Ordering::SeqCst);
        }
        // A real owner window is required, otherwise SetClipboardData fails after EmptyClipboard.
        if !open_clipboard_retry(owner) {
            return Err("clipboard is busy".into());
        }
        EmptyClipboard();
        for (id, name, data) in items {
            let fmt = if *id >= 0xC000 { RegisterClipboardFormatW(wide(name).as_ptr()) } else { *id };
            if fmt == 0 {
                continue;
            }
            let h = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1));
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

fn is_down(vk: u16) -> bool {
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
///  black  → WDA_MONITOR (0x1): the window shows as a black rectangle in screenshots/recordings
///  hidden → WDA_EXCLUDEFROMCAPTURE (0x11, Win10 2004+): the window is invisible in captures
pub fn set_capture_protection(hwnd: isize, mode: &str) -> bool {
    let affinity: u32 = match mode {
        "black" => 0x1,
        "hidden" => 0x11,
        _ => 0x0,
    };
    unsafe { SetWindowDisplayAffinity(hwnd, affinity) != 0 }
}

/// Window that never steals focus (used for the paste-queue overlay).
pub fn make_no_activate(hwnd: isize) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE as isize) | (WS_EX_TOOLWINDOW as isize));
    }
}

pub fn show_no_activate(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

#[allow(dead_code)]
pub fn _unused(_: *const c_void) {}

// ───────────────────────────── application icons ─────────────────────────────

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
            let make_bi = || {
                let mut bi: BITMAPINFO = std::mem::zeroed();
                bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                bi.bmiHeader.biWidth = w;
                bi.bmiHeader.biHeight = -h; // top-down
                bi.bmiHeader.biPlanes = 1;
                bi.bmiHeader.biBitCount = 32;
                bi.bmiHeader.biCompression = 0; // BI_RGB
                bi
            };
            let n = (w * h) as usize;
            let mut px = vec![0u8; n * 4];
            let mut bi = make_bi();
            let got = GetDIBits(hdc, hc, 0, h as u32, px.as_mut_ptr() as *mut c_void, &mut bi, 0);
            if got != 0 {
                // Old icons carry no alpha channel: derive it from the AND mask.
                if px.chunks_exact(4).all(|p| p[3] == 0) && hm != 0 {
                    let mut mask = vec![0u8; n * 4];
                    let mut bi2 = make_bi();
                    if GetDIBits(hdc, hm, 0, h as u32, mask.as_mut_ptr() as *mut c_void, &mut bi2, 0) != 0 {
                        for i in 0..n {
                            px[i * 4 + 3] = if mask[i * 4] == 0 { 255 } else { 0 };
                        }
                    }
                }
                for p in px.chunks_exact_mut(4) {
                    p.swap(0, 2); // BGRA → RGBA
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

pub fn is_win_shortcut(s: &str) -> bool {
    s.split('+').any(|p| matches!(p.trim().to_lowercase().as_str(), "super" | "win" | "meta" | "cmd" | "command"))
}

/// "Super+V" / "Ctrl+Alt+F5" → (modifier mask, virtual-key code)
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
                    k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphanumeric() => k.to_uppercase().as_bytes()[0] as u32,
                    k if k.starts_with('f') && k[1..].parse::<u32>().map(|n| (1..=24).contains(&n)).unwrap_or(false) => {
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

pub fn set_hook_bindings(v: Vec<(u8, u32, u32)>) {
    *BINDINGS.lock() = v;
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

/// Starts the hook thread once (idempotent). `tx` receives the binding id of every matched shortcut.
pub fn start_hotkey_hook(tx: Sender<u32>) {
    if HOOK_TX.set(tx).is_err() {
        return;
    }
    std::thread::spawn(|| unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_keyboard_proc), hinst, 0);
        if hook == 0 {
            eprintln!("clipnest: could not install the keyboard hook");
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        UnhookWindowsHookEx(hook);
    });
}
