# AI Agent Guidelines & Repository Directives

This document defines core instructions and operational guidelines for autonomous AI agents (Antigravity, Claude Code, Cursor, etc.) working in this repository.

---

## ⚡ 1. TypeScript Verification: Use `typecheck:bun`

When verifying code changes, adding features, or applying bug fixes, **DO NOT run `npm run typecheck` or raw `tsc`**.

Instead, always run:

```bash
bun run typecheck:bun
```

### Why:

- **Speed**: Executes in **~100–200ms** total across the root and all monorepo packages (`packages/core` and `packages/cli`).
- **Command Used**: Uses `concurrently` with labels (`[root]`, `[core]`, `[cli]`) to run `bun check --skipLibCheck` across all workspaces in parallel.
- **Efficiency**: Avoids re-parsing deep library declarations while rigorously validating project TypeScript types.

If checking an individual package directly:

- `packages/core`: `bun --cwd packages/core run typecheck:bun`
- `packages/cli`: `bun --cwd packages/cli run typecheck:bun`

---

## 📦 2. Exporting Context for External AI Review

To generate a curated archive of the repository for external code review or second-opinion analysis:

```bash
bun run bundle:context
# or run the root script:
.\bundle-context.cmd
```

This creates `<project>-context.zip` (e.g. `clipnest-context.zip`) containing all required files and an injected `prompt.txt` with review instructions.

---

## 🧪 3. Verification & Testing Workflow

Before and after applying modifications:

1. **Type Checking**:
    ```bash
    bun run typecheck:bun
    ```
2. **Rust Tests**:
    ```bash
    cargo test --manifest-path packages/core/Cargo.toml
    cargo test --manifest-path src-tauri/Cargo.toml
    ```
3. **Frontend Tests**:
    ```bash
    npm test
    ```
4. **Formatting**:
    ```bash
    npm run format
    ```

---

## 📝 4. Mandatory Detailed Git Commit Standard

Every Git commit created in this repository (by AI agents or human contributors) **MUST** be comprehensive, detailed, and structured. Single-line, terse, or vague commit messages (such as `"fix bugs"`, `"update styles"`, or `"refactor code"`) are **strictly prohibited**.

### Core Requirements for Every Commit Message:
1. **Header (Subject Line)**:
   - Format: `<type>(<optional-scope>): <imperative summary>` (e.g. `fix: resolve clipboard overflow and CLI path resolution`).
   - Limit: Under 72 characters.
   - Mood: Imperative active present tense (`apply`, `fix`, `resolve`, `harden`).
2. **Context & Root Cause (What was the problem?)**:
   - Explicitly describe what was broken, the defect/limitation, why it happened, and what conditions triggered it.
3. **Resolution & Mechanism (How was it solved?)**:
   - Detail the architectural and code-level changes made to eliminate the root cause and guarantee safety.
4. **Key Changes by Component (Subsystem Breakdown)**:
   - Partition changes by architectural layer with exact symbols, files, and functions in backticks:
     - **Core & Storage**: SQLite tables, queries, migrations, Rust db/search/ipc invariants.
     - **CLI & Client Tooling**: TypeScript CLI options, argument parsers, exit codes, IPC transports.
     - **Tauri Backend & Platform**: OS APIs, Windows COM, Win32 calls, process management.
     - **Frontend & Security**: React components, CSS sanitization, event listeners, keyboard traps.
     - **CI & Build Pipeline**: GitHub Actions workflows, portable bundlers, release scripts.
5. **Regression Tests & Verification**:
   - Explicitly list all new or updated tests and edge cases verified (unit tests, integration tests, E2E tests).

### Canonical Commit Template:

```text
<type>(<scope>): <concise imperative summary under 72 chars>

<Detailed explanation of the problem / defect / requirement: what triggered it,
why it occurred, and the operational impact on users or the runtime.>

<Detailed explanation of the solution: how the issue was resolved, the architectural
strategy chosen, and what safety guarantees or invariants were established.>

Key changes by component:
- <Subsystem / Layer 1>:
  - <Imperative action> in `<symbol_or_path>` to prevent <issue> (<DIRECTIVE_OR_ISSUE_ID>).
  - <Imperative action> to ensure <invariant>.

- <Subsystem / Layer 2>:
  - <Imperative action> in `<symbol_or_path>`: <details>.

Regression tests added / verified:
- `<exact::test::path_or_identifier>`
- `<test-file.test.ts>`: <description of attack-vectors or edge-cases tested>
```

