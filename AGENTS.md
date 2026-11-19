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
