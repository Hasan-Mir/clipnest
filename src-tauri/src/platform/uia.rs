//! Caret location through Microsoft UI Automation.
//! Works for apps that do not expose a classic Win32 caret: VS Code, Chrome/Edge, Word, Slack…
//! Runs on a short-lived thread with a timeout because UIA calls into other processes can stall.

use std::time::Duration;
use windows::Win32::Foundation::BOOL;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData,
};
use windows::Win32::UI::Accessibility::*;

/// (left, top, right, bottom) in physical pixels.
pub fn caret_rect_with_timeout(ms: u64) -> Option<(i32, i32, i32, i32)> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // MTA: no message loop needed. caret_rect() drops every COM object before we uninitialise.
        let inited = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
        let r = unsafe { caret_rect() };
        if inited {
            unsafe { CoUninitialize() };
        }
        let _ = tx.send(r);
    });
    rx.recv_timeout(Duration::from_millis(ms)).ok().flatten()
}

unsafe fn first_rect(range: &IUIAutomationTextRange) -> Option<(i32, i32, i32, i32)> {
    let sa = range.GetBoundingRectangles().ok()?;
    if sa.is_null() {
        return None;
    }
    let lb = SafeArrayGetLBound(sa, 1).ok()?;
    let ub = SafeArrayGetUBound(sa, 1).ok()?;
    let n = (ub - lb + 1).max(0) as usize;
    if n < 4 {
        let _ = SafeArrayDestroy(sa);
        return None;
    }
    let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
    if SafeArrayAccessData(sa, &mut data).is_err() || data.is_null() {
        let _ = SafeArrayDestroy(sa);
        return None;
    }
    let d = std::slice::from_raw_parts(data as *const f64, n);
    let r = (d[0] as i32, d[1] as i32, (d[0] + d[2]) as i32, (d[1] + d[3]) as i32);
    let _ = SafeArrayUnaccessData(sa);
    let _ = SafeArrayDestroy(sa);
    Some(r)
}

unsafe fn caret_rect() -> Option<(i32, i32, i32, i32)> {
    let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
    let el = uia.GetFocusedElement().ok()?;

    // 1) The real caret (TextPattern2).
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id) {
        let mut active = BOOL(0);
        if let Ok(range) = p.GetCaretRange(&mut active) {
            let _ = range.ExpandToEnclosingUnit(TextUnit_Character);
            if let Some(r) = first_rect(&range) {
                return Some(r);
            }
        }
    }
    // 2) The current selection (TextPattern).
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
        if let Ok(sel) = p.GetSelection() {
            if sel.Length().unwrap_or(0) > 0 {
                if let Ok(range) = sel.GetElement(0) {
                    let _ = range.ExpandToEnclosingUnit(TextUnit_Character);
                    if let Some(r) = first_rect(&range) {
                        return Some(r);
                    }
                }
            }
        }
    }
    // 3) The focused single-line field itself (ignored when it is a big editor area).
    let r = el.CurrentBoundingRectangle().ok()?;
    if r.right > r.left && (r.bottom - r.top) <= 120 {
        return Some((r.left, r.top, r.right, r.bottom));
    }
    None
}
