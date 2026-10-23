//! Platform layer. ClipNest targets Windows; everything OS-specific is isolated here so a
//! macOS/Linux backend could be added later behind the same function names.

#[cfg(windows)]
pub mod win;

#[cfg(all(windows, feature = "uia"))]
pub mod uia;

/// Where to anchor the popup: the text caret -> UI Automation -> the mouse pointer.
/// Returns (x, top, bottom) in physical pixels.
#[cfg(windows)]
pub fn locate_anchor() -> (i32, i32, i32) {
    if let Some(c) = win::caret_win32() {
        return (c.left, c.top, c.bottom);
    }
    #[cfg(feature = "uia")]
    {
        if let Some((l, t, _r, b)) = uia::caret_rect_with_timeout(150) {
            return (l, t, b);
        }
    }
    let (x, y) = win::cursor_pos();
    (x, y, y + 2)
}
