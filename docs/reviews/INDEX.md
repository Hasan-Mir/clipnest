# ClipNest Code Review History Index

> **For AI Reviewers & Coding Agents:** Read this file and the most recent `docs/reviews/round-*.md` report **before** auditing the codebase or applying new patches. Do not re-open items listed under **Intentional Decisions / Do-Not-Reopen** without demonstrating a new, concrete failure mode.

---

## Review Rounds

| Round | Date       | Report File                                      | Scope & Key Highlights                                                                                                                                                |
| ----- | ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01–05 | Historical | Git History                                      | Initial architecture, monorepo restructuring, security hardening, queue accessibility, and IPC stability.                                                             |
| 06    | 2026-11-20 | [round-06-2026-11-20.md](round-06-2026-11-20.md) | 15 stability & concurrency patches, global shortcut AB-BA deadlock resolution, deterministic timestamp tie-breakers, atomic backup naming, and tray taskbar clamping. |
| 07    | 2026-11-20 | [round-07-2026-11-20.md](round-07-2026-11-20.md) | 7 stability patches: sync_intercept lock-free shortcut registration, backup import duplicate clip preservation, preview/submenu focus restoration, WAL BEGIN IMMEDIATE read-write concurrency, ReDoS protection in regex highlighting, and TS CLI subcommand parity. |

---

## Intentional Decisions / Do-Not-Reopen

Record deliberate architectural choices and rejected external review findings here so future review passes do not re-report them:

- **TypeScript typechecking uses `bun run typecheck:bun`**: Intentional fast-path (`bun check --skipLibCheck` across all workspaces in parallel); do not replace with raw `tsc` in agent workflows.
- **Deterministic Category Trimming Order (`pinned DESC, sort_ts DESC, clip_id DESC`)**: SQLite indexes append rowid/pk ascending. When clips share identical millisecond timestamps, `clip_id DESC` ensures older clips are evicted and newer additions survive.
- **Deterministic History Limits Order (`sort_ts DESC, id DESC`)**: Identical timestamp collisions in main history delete older clips first.
- **Global Shortcut Thread Affinity & Locks**: `tauri-plugin-global-shortcut` marshals registration and unregistration synchronously to the Windows main UI thread, while `on_shortcut` runs on that thread and acquires `st.queue_sc`. Never hold `st.queue_sc.lock()` across `register()` or `unregister()`.
- **Transfer `BusyGuard` Disarming**: `run_transfer` must disarm `BusyGuard` on successful completion before returning, ensuring `BusyGuard::drop` does not clear `transfer_busy` or `transfer_progress` of subsequent concurrent transfers.
- **`insert_clip` Immediate Transaction**: Deduplication hash check and format insertions must remain wrapped in a single `rusqlite::TransactionBehavior::Immediate` transaction to prevent TOCTOU unique constraint errors under concurrent writes.
- **Category Assignment with Pin**: Bounded categories must insert into `clip_categories` with the requested pin flag already set so that category limits trimming does not evict new pinned items prematurely.
- **Standalone Read-Then-Write Transactions in SQLite WAL (`with_write_tx`)**: `assign_category_with_pin`, `erase_history` (target board branch), `move_item`, and `merge_from` must use `BEGIN IMMEDIATE` when `conn.is_autocommit()` is true to avoid `SQLITE_BUSY_SNAPSHOT` (517) errors bypassing `busy_timeout` when concurrent writes occur between read and write.
- **JSON Bundle Duplicate Clip Skipping**: `import_json_bundle` must check `SELECT 1 FROM clips WHERE hash=?1` before calling `db::insert_clip` to prevent overwriting existing clip metadata, unmasking sensitive clips, and resetting expiry or order.
- **Highlight Regex Safety (`isSafeHighlightRegex`)**: User regex queries in UI search highlights must reject nested quantifiers `(a+)+`, backreferences `\1`..`\9`, and patterns > 256 chars to protect against catastrophic JS backtracking on the UI thread.
- **TS CLI Subcommand Strict Validation**: The TS CLI argument parser must reject unknown subcommands for `category`, `queue`/`basket`, `rule`, `action`, and `config` with `EXIT_USAGE` (2) upfront to maintain parity with the native Rust CLI.

---

## Pending Manual Verification (Windows Live)

- [x] PowerShell: `.\scripts\bundle-context.ps1 -o test.zip --help` (verified: parameter binding clean, `-o` accepted).
- [ ] Live Tray UI: Right-click tray icon while capture is paused → click **Resume capture** → confirm tray menu shifts upward and **Quit ClipNest** remains 8px above the taskbar.
