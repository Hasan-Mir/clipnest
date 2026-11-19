---
name: detailed-git-commit
description: Mandate and generate comprehensive, structured git commit messages that explain the root cause, defect details, resolution mechanism, component-level breakdown, and regression tests. Use whenever preparing, drafting, or executing git commits in this repository.
---

# Detailed Git Commit Skill

This skill enforces high-fidelity, production-grade Git commit messages across the repository. It guarantees that any future developer or agent can read `git log` and immediately understand:
1. **The Problem**: What was broken, missing, or insecure (root cause and trigger conditions).
2. **The Fix**: How it was resolved architecturally and algorithmically.
3. **The Scope**: Which files, functions, and subsystems were touched.
4. **The Proof**: What regression tests or verifications validate the change.

---

## Commit Message Topology

Every commit message produced must adhere to this exact structural hierarchy:

```text
<type>(<scope>): <summary up to 72 chars>

Problem & Root Cause:
<Thorough explanation of the defect, bug, or limitation. Explain why it occurred,
the affected edge cases, and the adverse impact on system behavior.>

Solution & Architecture:
<Detailed explanation of the technical resolution. Mention the design patterns,
invariants enforced, performance considerations, and safety measures applied.>

Key changes by component:
- Core & SQLite Storage:
  - <Imperative action> in `<symbol_or_path>` to ensure <guarantee> (<ISSUE_OR_DIRECTIVE_REF>).
  - <Imperative action> in `<symbol_or_path>` to reject <invalid state>.

- CLI & Client Tooling:
  - <Imperative action> to handle <edge case> with `<EXIT_CODE>`.

- Tauri Backend & Platform:
  - <Imperative action> to offload <blocking operation> to background thread.

- Frontend & Security:
  - <Imperative action> in `<component>` to eliminate <security risk or UI glitch>.

- CI, Packaging & Tooling:
  - <Imperative action> in `<script_or_workflow>` to guarantee <build invariant>.

Regression tests added / verified:
- `<exact::test::identifier_1>`
- `<exact::test::identifier_2>`
- `<test_suite.test.ts>`: <description of verified attack vector or boundary condition>
```

---

## Rules & Behavioral Standards

1. **Strictly Forbidden Messages**:
   - Single-line messages (e.g. `git commit -m "fix bug"`).
   - Terse descriptions without root cause (e.g. `git commit -m "update styles and fix tests"`).
   - Messages missing component breakdowns or regression tests.

2. **Grammar & Tone**:
   - The first line (subject) must be in the **imperative mood** (`fix: resolve ...`, not `fixed:` or `fixes:`).
   - All code identifiers, paths, types, flags, and exit codes must be in backticks (e.g. `` `trim_board` ``, `` `EXIT_USAGE` ``).
   - Paragraphs in the body should be wrapped at ~72 to 80 characters for clean terminal viewing in `git log`.

3. **Subsystem Categorization**:
   Group bullet points logically under recognizable architectural sections:
   - `Core & SQLite Storage`
   - `CLI & Client Tooling`
   - `Tauri Backend & Platform`
   - `Frontend & Security`
   - `CI, Packaging & Tooling`

---

## Canonical Reference Example

```text
commit f0f482a1e9bded7786ba3ca1ef96e292e1974da7
Author: Hasan Mir <seyed.hasan.mir@gmail.com>
Date:   Fri Nov 20 01:51:36 2026 +0330

    fix: apply 25 comprehensive architectural, security, and CLI stability patches
    
    Apply the complete 25-patch directive addressing critical, high, medium,
    and low-severity defects across the database core, CLI, frontend UI, Tauri
    backend, CI release pipeline, and packaging scripts.
    
    Key changes by component:
    - Core & SQLite Storage:
      - Preserve main-clipboard pinned clips during category trimming in `trim_board`
        and pin before assigning categories in `add_item_shared` (PATCH-01).
      - Reject stdin I/O and JSON parse failures with EXIT_USAGE in `--offline-rpc`
        instead of silently defaulting to null / erasing history (PATCH-02).
      - Reject negative IDs and invalid non-integer JSON types in `resolve_board_id` (PATCH-03).
      - Resolve relative CLI paths against caller CWD before IPC transmission (PATCH-07).
      - Preserve existing clip titles, categories, pins, and tags on duplicate hash
        imports in `import_json_bundle` (PATCH-13).
      - Filter `merge_from` `clip_categories` insert with `WHERE mc.id > ?1` to preserve
        pinboard_id invariants for existing clips (PATCH-14).
      - Reject non-positive pause durations in native CLI with EXIT_USAGE (PATCH-20).
      - Parameterize `LIMIT` and return early on `limit == 0` in `search::list_scoped` (PATCH-22).
      - Wrap single-board `erase_history` in `SAVEPOINT erase_board` and propagate errors (PATCH-23).
      - Honor `-o` flag with `--json` output in native Rust CLI (PATCH-25).
    
    - CLI & Core NPM Packages:
      - Replace `hasNext` with `requireNext` across all CLI commands to reject dangling
        value-taking flags with EXIT_USAGE instead of consuming positional text (PATCH-06).
      - Expand `findNativeBinary` candidate paths for npm hoisted layouts and harden
        `callIpc` post-connect fallback and stale `cli-rpc.json` version check (PATCH-10).
      - Raise `spawnSync` `maxBuffer` to 66 MiB and inspect `r.error` in offline execution
        and clipboard readers (PATCH-12).
      - Implement `writeFileAtomically` with rollback cleanup and enforce `--json` error
        reporting contract on output write failures (PATCH-18).
      - Normalize path casing on Windows in `resolveRealPath` for direct execution detection (PATCH-19).
    
    - Tauri Backend & Platform:
      - Refresh `state.target_hwnd` from `win::foreground()` before online `paste` (PATCH-08).
      - Attach parent terminal console via `AttachConsole` for GUI-subsystem CLI runs on Windows (PATCH-09).
      - Offload blocking Shell COM / RPC / `Path::exists()` calls in `reveal_item` and
        `reveal_paths` to `tauri::async_runtime::spawn_blocking` (PATCH-15).
    
    - Frontend & Security:
      - Fix nested `@import` reconstruction and unclosed `url(` / `image-set(` CSS bypasses
        in `cleanCss` (PATCH-04).
      - Guard capture-phase `Ctrl+F` against modifiers, shortcut recording, and modal overlays (PATCH-05).
      - Stop `Preview` `onKey` from hijacking interactive button `Enter`/`Space` and add
        `stopPropagation` on `.pv-colorrow` (PATCH-16).
      - Hold `Win` modifier locally (`recWin`) during `ShortcutInput` recording (PATCH-17).
      - Deduplicate `handleReport` between transfer polling and `basket-finished` event (PATCH-24).
    
    - CI & Packaging:
      - Enable `$PSNativeCommandUseErrorActionPreference = $true` in release workflow and fail
        if expected portable ZIP or CLI binary is missing (PATCH-11).
      - Fix `ROOT_DIR`, `--dry-run`, `--no-prompt`, `core.quotepath=false`, and deleted files
        in `bundle-context.ts` (PATCH-21).
      - Replace wildcard `Compress-Archive` with .NET `ZipFile::CreateFromDirectory` in
        `build-portable.ts` (PATCH-25).
    
    Regression tests added:
    - `db::tests::trim_board_preserves_main_clipboard_pinned_clip_on_overflow`
    - `db::tests::merge_from_does_not_insert_clip_categories_for_existing_clips_without_category`
    - `ipc::tests::add_item_shared_pinned_on_full_category_succeeds`
    - `ipc::tests::resolve_board_id_validates_types_and_rejects_negative`
    - `ipc::tests::import_json_bundle_preserves_existing_clip_metadata`
    - `search::tests::list_scoped_handles_zero_limit_and_max_limit`
    - `richView.test.ts`: nested `@import` and unclosed CSS sanitization bypass tests
    - `run-cli.test.ts`: dangling value-taking flags rejection and atomic unwritable `-o` error handling
```
