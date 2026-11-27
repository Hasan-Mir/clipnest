# 📋 ClipNest — Fast, Smart & Private Clipboard Manager for Windows (with Full CLI: `clipnest` / `clipn`)

**ClipNest** is a fast, secure, and 100% offline clipboard manager and file collector for **Windows 10 and 11**. It pairs the clean, distraction-free UI of Copywren and Notion with the power-user depth of CopyQ and a full command-line interface (`clipnest` and short alias `clipn`) for scripting and automation.

Built with Tauri v2 · Rust · Win32 · React · SQLite.

---

## ✨ Key Features

- ⚡ **Instant Performance, Atomic Writes & Data Safety:** Native Rust + SQLite core in WAL mode with `synchronous=FULL`; all file, settings, export, and backup writes are performed atomically (`.tmp` + rename) so no file is ever left half-written or corrupted.
- 💻 **Full Command-Line Interface with Short Alias `clipn` (`clipnest` / `clipn` CLI):** Inspired by CopyQ CLI with short, command-first subcommands (`add`, `list`, `search`, `get`, `copy`, `paste`, `edit`, `rename`, `delete`, `pin`, `unpin`, `tag`, `move`, `merge`, `formats`, `transform`, `category`, `queue`, `basket`, `rule`, `action`, `config`, `export`, `import`, `backup`, `erase`, `status`, `path`), full `-h` / `--help` documentation for every command, `stdin`/`stdout` pipeline support, human-readable and `--json` output, secure local IPC, and direct offline database fallback.
- 🗂️ **Categories with Smart Copy to / Move to & Independent Pinning:**
    - Unlimited color-coded category tabs with smooth horizontal scrolling (mouse wheel or grab-to-scroll) and an optional multi-row tab wrap mode (`Wrap category tabs onto multiple lines`, similar to `workbench.editor.wrapTabs` in VS Code).
    - In the main **Clipboard** tab, right-clicking or dragging a card onto a category performs **Copy to** (with a copy icon), keeping the item in the main history.
    - Inside a **Category**, the default action in the context menu and Drag & Drop onto another category is **Move to** (with a right-arrow icon); holding **`Ctrl`** switches it live to **Copy to** (highlighting the word `Copy` in the accent color with a copy icon).
    - **Independent pinning per category:** By default, pinning a card inside a category pins it only within that category without altering the main Clipboard tab or other categories (configurable in Settings).
- 📂 **Multi-File Selection in Windows Explorer (`Show in Explorer`):** When selecting multiple files (either inside a multi-file card or across multiple selected file cards) and choosing **Show in Explorer**, the target folder opens with **all selected files highlighted simultaneously** using the native `SHOpenFolderAndSelectItems` Win32 API.
- ♿ **Full Accessibility & Keyboard Navigation:** Full screen-reader support (NVDA / JAWS / Narrator) with standard ARIA roles (`listbox`, `option`, `tablist`, `tab`, `menu`, `menuitem`, `dialog`, `aria-live="polite"`), opening card context menus via `Shift+F10` or the `ContextMenu` key, full arrow-key navigation across menus and submenus, and suppression of intrusive browser shortcuts (such as Chromium's `Ctrl+P` print dialog).
- 🎨 **Rich Style Preservation (Original Style / Rich HTML):** Code snippets and formatted text copied from VS Code, Word, and browsers render inside an isolated Shadow DOM with their original font, colors, and background, paired with a quick `Aa` toggle to switch instantly between Rich and Plain Text views.
- 🧺 **Dual-Mode Paste Queue & File/Image Drop Basket:**
    - **Queue Mode:** Copy multiple items in sequence and press `Ctrl+V` repeatedly to paste them in order (FIFO or LIFO).
    - **Drop Basket (Collector Mode):** Collect files and images from across folders and paste or move them all into a destination folder in one click (`CUT` mode removes source files only after destination copy and exact byte-size verification succeed).
- 📜 **Incremental Scroll Pagination (No Virtual List):** The main list uses configurable scroll pagination (`Items per page`, default `100`), viewport-proximity lazy loading for thumbnails and `RichView` (`IntersectionObserver`), and `scrollbar-gutter: stable` to prevent horizontal layout shifts while filtering.
- 🔤 **Modern Typography with Built-In Persian/Arabic Support:** Five self-hosted variable UI fonts (`Google Sans` default, `Inter`, `Plus Jakarta Sans`, `DM Sans`, and `Roboto`) with embedded `Vazirmatn` locked in for Persian/Arabic glyphs, plus configurable font sizes (`10` to `20 px`, default `14 px`).

---

## 💻 Command-Line Interface (`clipnest` and short alias `clipn`)

### Installing the CLI

1. **Included with the ClipNest Windows Installer (no Node.js required):** After installing ClipNest, both `clipnest` and `clipn` are added to your user `PATH` automatically. In the Portable edition, run `clipn path install` to register them in `PATH`.
2. **Install via npm:**
    ```bash
    npm install -g @seymi/clipnest-cli
    clipn --help
    clipnest --help
    ```

### Quick Command Reference (`-h` / `--help`)

Append `-h` or `--help` to view general help or detailed usage for any subcommand:

```bash
clipn --help
clipn <command> --help
clipn help <command>
```

| Command (`clipn` or `clipnest`)       | Description & Key Flags                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `add <text\|->`                       | Add text, piped `stdin` (`-`), or a file (`-f <path>`) to history (`-c/--copy`, `-p/--pin`, `-b/--category <name>`, `-t/--tags`, `--title`)                  |
| `list` (or `ls`)                      | List recent items (`-n <limit>`, `-b/--category <name>`, `-k/--kind <kind>`, `--pinned`, `--json`)                                                           |
| `search <query>` (or `find`)          | Search history (`-m smart\|fuzzy\|regex`, `-r/--regex`, `-z/--fuzzy`, `-b/--category <name>`, `-n <limit>`)                                                  |
| `get [id]`                            | Read raw item content (`12` or `@0`/`latest`) or current system clipboard (no args); supports `--format plain\|html\|meta\|formats` and `-o <file>`          |
| `copy <text\|->` (or `cp`)            | Put text, `stdin` (`-`), file (`-f`), or history item (`--id <id>`) onto the system clipboard (`--plain`)                                                    |
| `paste [id]`                          | Copy an item (default `@0`) and paste into the active window (`--plain`, `--rich`, `--auto`)                                                                 |
| `edit <id> [text\|-]`                 | Edit an item's text, title (`--title`), or tags (`--tags`)                                                                                                   |
| `rename <id> <title>`                 | Set or clear a custom item title                                                                                                                             |
| `delete <id...>` (or `rm`)            | Delete one or more items (deleting more than 3 items requires `--yes`)                                                                                       |
| `pin <id...>` / `unpin <id...>`       | Pin or unpin items (supports `--category <name>` for per-category independent pinning)                                                                       |
| `tag <id> [tags...]`                  | Set, add (`--add`), remove (`--remove`), or clear (`--clear`) item tags                                                                                      |
| `move <id...> --to <cat\|main>`       | Move or copy (`--copy`, `--from <cat>`) items to a category, or reorder (`--before <id>` / `--after <id>`)                                                   |
| `merge <id1> <id2> [...]`             | Merge multiple text items into a new clip (`--sep "\n---\n"`, `--copy`)                                                                                      |
| `formats [id]`                        | Inspect stored clipboard/MIME formats and byte sizes                                                                                                         |
| `transform <tr\|list> [id\|-]`        | Run built-in text transforms (`upper`, `lower`, `json-pretty`, `b64-enc`, `fa-normalize`, `fa-digits`, etc.) with `--save` and `--copy`                     |
| `category <subcommand>`               | Manage categories (`list`, `create <name> --color #hex --max N --active`, `update`, `delete <name> --yes`, `activate <name\|none>`); aliases: `cat`, `pinboard`, `board` |
| `queue <subcommand>`                  | Manage Paste Queue (`status`, `list`, `add <id...>`, `remove <id>`, `clear`, `toggle`, `close`, `fifo <on\|off>`)                                            |
| `basket <subcommand>`                 | Manage Drop Basket (`list`, `add <file\|id...>`, `remove <id>`, `cut <id>`, `paste-to <folder>`, `clear`)                                                    |
| `rule <subcommand>`                   | Manage automatic rules (`list`, `add`, `enable`, `disable`, `delete`)                                                                                        |
| `action <subcommand>`                 | Manage and execute custom shell actions (`list`, `run <act> [id]`, `add <name> --cmd <cmd>`, `delete`)                                                       |
| `config <subcommand>`                 | View and update settings (`list`, `get <key>`, `set <key> <val>`, `reset [key] [--yes]`)                                                                     |
| `status`                              | Show daemon, capture, queue, item count, and data directory status (`--check-running`, `--json`)                                                             |
| `pause [min]` / `resume`              | Temporarily pause or resume clipboard capture                                                                                                                |
| `plain [on\|off\|toggle]`             | Toggle or set global plain-text paste mode                                                                                                                   |
| `export <file>` / `import <file>`     | Export or import history and categories (`.json` or `.db.gz`) or settings (`--settings`)                                                                     |
| `backup [file]`                       | Create an immediate compressed SQLite snapshot (`.db.gz`)                                                                                                    |
| `erase --yes`                         | Erase history (`--category <name>`, `--include-pinned`, `--all-boards`)                                                                                      |
| `open` / `hide` / `settings` / `quit` | Show or hide the popup window, open Settings, or exit ClipNest completely                                                                                    |
| `path [status\|install\|uninstall]`   | Check, add, or remove `clipnest` and `clipn` in the Windows user `PATH`                                                                                      |

### Practical Pipeline Examples

```bash
# Add piped command output to ClipNest history using the short alias `clipn`
git log -5 --oneline | clipn add -

# Copy piped output directly to the Windows clipboard
git diff | clipn copy -

# Combined: save to history and copy to clipboard in a single stdin read
git diff | clipn add - --copy

# Retrieve raw item content for piping or saving to a file
clipn get 12 > output.txt
clipn get @0 | another-command

# Read the current system clipboard
clipn get

# Manage items, categories, text transforms, and JSON output
clipn list -n 20
clipn search "keyword" --json
clipn pin 12 --category Work
clipn unpin 12 --category Work
clipn tag 12 work urgent
clipn move 12 --to Work
clipn move 12 --from Work --to Personal --copy
clipn transform fa-normalize 12 --save --copy
clipn status
clipn export backup.json
```

Full documentation for all CLI commands, flags, and exit codes is available in [`packages/cli/README.md`](packages/cli/README.md).

---

## 🚀 Prerequisites, Build, Test & Format

1. **Windows 10 (2004+)** or **Windows 11** (with WebView2)
2. **[Rust](https://rustup.rs)** (`stable-x86_64-pc-windows-msvc`, 1.77+)
3. **Visual Studio Build Tools** with the "Desktop development with C++" workload
4. **Node.js ≥ 20**

```powershell
npm install
npm run tauri dev       # Run in development mode
npm run tauri:build     # Build NSIS installer, CLI binary, and Portable edition
```

### 🧪 Testing & Formatting

```powershell
bun run typecheck:bun   # Ultra-fast TypeScript check with Bun (`bun check --skipLibCheck`)
npm run typecheck       # Full TypeScript check with tsc
npm test                # Run frontend and CLI unit tests with Vitest
npm run test:rust       # Run core and Tauri Rust unit/integration tests
npm run test:all        # Run all frontend, CLI, and Rust tests
npm run format          # Auto-format frontend (Prettier) and Rust (rustfmt)
npm run format:check    # Verify formatting in CI
```

---

## ⌨️ Keyboard & Mouse Shortcuts

| Action                                        | Shortcut / Mouse                                               |
| --------------------------------------------- | -------------------------------------------------------------- |
| Open ClipNest popup                           | `Win+V` (default; customizable to `Alt+V`, etc. in Settings)   |
| Paste rich / plain text (or file path)        | Double-click or `Enter` / `Shift+Enter` (`Ctrl+Enter` = rich)  |
| Single / range / multi selection              | Click / `Shift+Click` (or `Shift+↑/↓`) / `Ctrl+Click`          |
| Open card context menu via keyboard           | `Shift+F10` or `ContextMenu` key                               |
| Copy to category on Drag & Drop or menu       | Hold `Ctrl`                                                    |
| Quick-paste visible cards                     | `Ctrl+1` … `Ctrl+9`                                            |
| Reorder cards                                 | Drag & Drop or `Alt+↑/↓`                                       |
| Preview & inline edit (with auto-save)        | `Space` (or `F3`) · `Ctrl+E`                                   |
| Switch between Clipboard & category tabs      | `←` `→` or `Tab` or `Ctrl+[ ]`                                 |
| Focus search bar                              | `Ctrl+F`                                                       |
| Pin item to top                               | `Ctrl+P`                                                       |
| Rename / Tags / MIME format inspector         | `F2` / `Ctrl+T` / `Ctrl+I`                                     |
| Merge selected items                          | `Ctrl+M`                                                       |
| Toggle Paste Queue / Drop Basket              | `Ctrl+Alt+Q`                                                   |
| Toggle global plain-text paste mode           | `Ctrl+Alt+P`                                                   |
| Open Settings                                 | `Ctrl+,`                                                       |

---

## 📂 Data Storage Location

All data is stored strictly locally at:
`%APPDATA%\com.clipnest.app\` (`clipnest.db`, `settings.json`, `backups\`, `cli-rpc.json`)

---

## 🙏 Credits & Acknowledgements

ClipNest is inspired by and modeled after two outstanding projects:

- **[Copywren](https://github.com/sonatina-dream/copywren):** ClipNest's clean UI design, card structure, category tabs, popup layout, and modern user experience are directly inspired by **Copywren**.
- **[CopyQ](https://github.com/hluk/CopyQ):** ClipNest's advanced clipboard management features—automatic rules, custom shell actions, side toolbar, and command-line interface (`clipnest` / `clipn`)—are inspired by the open-source **CopyQ** project.
