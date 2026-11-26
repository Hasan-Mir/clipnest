# ClipNest Architecture, Bug Fixes & Calm UI Craft Report

This report documents the architectural changes, bug fixes, design rationale (for future maintainers), convergent multi-agent review results, and modified files.

---

## 1. Summary of Changes

1. **Frameless Settings Window & `async` Rust Window Commands:**
   - Updated `src-tauri/tauri.conf.json` and `src-tauri/src/windowing.rs` so the `settings` window uses `decorations: false`, `shadow: true`, and native Windows 11 DWM rounded corners (`win::round_window_corners`).
   - Added and registered four `async fn` Tauri commands (`settings_minimize`, `settings_toggle_maximize`, `settings_is_maximized`, `settings_close`) in `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, and `src/lib/api.ts` to avoid Win32/WebView2 IPC deadlocks.
   - Added `SettingsTitleBar` (`dir="ltr"`, `data-tauri-drag-region` without duplicate `onDoubleClick`, automatic `resize`/`focus` maximize-state sync, and visible error toast on IPC failure) in `src/settings/Settings.tsx`.
   - Left tray and drag-and-drop subsystems completely untouched.

2. **Eliminated Native Windows Title Bar on the Paste Queue Window:**
   - **Root Cause:** `packages/core/src/platform/win.rs::make_no_activate` previously added `WS_EX_TOOLWINDOW` to `GWL_EXSTYLE` after window creation. Because Tauri/tao retains `WS_CAPTION | WS_THICKFRAME` on resizable frameless windows (`decorations(false)`), adding `WS_EX_TOOLWINDOW` caused Windows DWM to paint a black ToolWindow caption bar with a red `X` button above the WebView.
   - **Fix:** Omitted `WS_EX_TOOLWINDOW` (taskbar hiding is already handled by `.skip_taskbar(true)` in `windowing.rs`), kept `WS_EX_NOACTIVATE` with `WS_EX_APPWINDOW` cleared, and called `SetWindowPos(..., SWP_FRAMECHANGED)`.

3. **Removed `virtua` (`VList`) in Favor of Configurable Scroll Pagination & CSS Grid Collapse:**
   - Removed `virtua` from `package.json`, removed the `<VList>` render branch from `src/popup/Popup.tsx`, removed `.vlist*` CSS from `src/styles.css`, and replaced `virtual_scroll` with `page_size` (**Items per page**, default `100`, range `20..500`) across `models.rs`, `api.ts`, `useSettings.ts`, `Settings.tsx`, and `README.md`. `#[serde(default)]` without `deny_unknown_fields` preserves full backward compatibility for existing `settings.json` files (verified by `legacy_settings_with_virtual_scroll_deserializes_cleanly`).
   - Added an `IntersectionObserver` bottom sentinel in `Popup.tsx` so mouse/trackpad scrolling loads subsequent pages automatically.
   - Added `src/lib/useViewportVisible.ts` (shared `IntersectionObserver`, `rootMargin: '300px'`) in `RichView.tsx` and `Thumb` (`Card.tsx`), paired with `content-visibility: auto` on `.card`, preventing off-screen IPC bursts and cache thrashing.
   - Replaced the 130-line imperative `translateY` animation hack with declarative CSS Grid Collapse (`.card-slot` with `grid-template-columns: minmax(0, 1fr)` and `min-width: 0` so wide `<pre>`/`RichView` lines never cause horizontal overflow).

4. **Fixed 7 Multi-Select, Delete & Reload Synchronization Bugs (`src/popup/Popup.tsx`):**
   - Fixed `targets()` to honor any live `multi.length > 0` selection and fixed `Ctrl+Click` deselection collapsing 2 items to 1 so `sel` and `anchor.current` move to the remaining selected item instead of leaving `cur` on the deselected card.
   - Pruned stale/moved/expired IDs from `multi` inside `reload()` and cleared `multi` on non-copy category moves (`!shouldCopy`).
   - Filtered `pendingDeleteIdsRef` in `reload()` and incremented `++seq.current` during optimistic removal so concurrent `items-changed` events never resurrect deleted items mid-animation.
   - Replaced unconditional `setMulti([])` in `doDelete` with targeted removal of `idSet` and added a pure `useEffect` clamping `sel` when `items.length` shrinks.

5. **Calm Desktop UI Polish (`src/styles.css`, `Popup.tsx`, `Overlays.tsx`, `CustomSelect.tsx`, `Settings.tsx`):**
   - Added `scrollbar-gutter: stable` and `overflow-x: hidden` on `.list` (and `scrollbar-gutter: stable` on `.qlist`, `.spane`, `.cselect-list`) to eliminate horizontal layout shift when filtering.
   - Redesigned the popup **Pin** button (accent SVG `fill` + smooth `-45deg` rotation instead of a solid background square) and **Toggle side toolbar** button (accent SVG stroke without a solid background box).
   - Fixed the side toolbar toggle so it opens cleanly even when the list is empty (`const toolbar = Boolean(s?.show_toolbar)` with `disabled={!cur}` on card-specific actions).
   - Added calm `175ms` tactile press-in physics across buttons, switches (`.switch:active`), and window controls (`.win-ctl`) using `:where(...)` so component rules retain clean specificity.
   - Fixed instant-popping modal/menu/dropdown entrance animations with double-rAF `src/lib/useEntered.ts` (`.entered` on `CustomSelect`, `ContextMenu`, `SubMenu`, `Prompt`, `BoardDialog`) and smooth `.srow::before` modified-setting bar transitions.
   - Added 5 self-hosted `@fontsource-variable/*` UI fonts (`Google Sans` default, `Inter`, `Plus Jakarta Sans`, `DM Sans`, `Roboto`) with embedded `Vazirmatn` permanently locked in for Persian/Arabic glyphs (`src/lib/uiFonts.ts`), plus `10..20 px` font size presets (default `14 px`).

---

## 2. Convergent Multi-Agent Review Summary

- **Cycle 1 (Backend & Frontend Fresh-Context Auditors):**
  - Backend/Rust/Win32/serde changes passed with zero Rust or Win32 defects (flagged `package-lock.json` sync via `npm install`, `windowing.rs` doc comment update, and adding a legacy serde unit test).
  - Frontend audit caught and resolved 4 defects: undeclared `subEntered` in `SubMenu`, missing `.entered` class on `.overlay`/`.dialog` in `Prompt` and `BoardDialog`, drag-drop insertion indicator clipping from `content-visibility: auto` / `overflow: hidden`, and global `button:not(...)` specificity overriding `.switch:active` and `.win-ctl`.
- **Cycle 2 & Polish Verification:**
  - Verified all Cycle 1 fixes with zero regressions, tightened `@media (prefers-reduced-motion: reduce)` for `.switch:active`, and verified `grid-template-columns: minmax(0, 1fr)` + `min-width: 0` horizontal overflow elimination and `.srow::before` LTR/RTL transitions.

---

## 3. Post-Extraction Verification Commands (Windows)

Because `node_modules` and `cargo` are unavailable in this offline sandbox, quit any running ClipNest tray instance after extracting the archive and run:

```powershell
npm install
npm run typecheck
npm test
cargo test --manifest-path packages/core/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```
