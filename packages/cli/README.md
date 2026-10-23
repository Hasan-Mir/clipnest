# `@seymi/clipnest-cli` — ClipNest Command-Line Interface (`clipnest` & `clipn`)

**`@seymi/clipnest-cli`** is the official command-line and automation interface for **ClipNest** (the fast, accessible, private clipboard manager and file collector for Windows).

Inspired by CopyQ's CLI and designed with a flat, command-first UX, both **`clipnest`** and its short alias **`clipn`** let you pipe standard input/output in shell scripts, search and manage clipboard history, control Categories (Pinboards), Queue & Drop Basket, run text transformations, and automate backups.

---

## 📦 Installation

### Option 1: Included with the ClipNest Windows Installer (No Node.js Required)

When you install **ClipNest** on Windows (either Per-User without Administrator privileges or All-Users), the installer automatically places both `clipnest` and the short alias `clipn` on your user `PATH` (`HKCU\Environment\Path`). Open any new PowerShell, Command Prompt, or Git Bash window and run:

```bash
clipn --help
clipnest --help
```

If you use the **Portable ZIP** or skipped PATH setup, you can register or remove `clipnest` and `clipn` in your user `PATH` at any time:

```bash
clipn path status
clipn path install
clipn path uninstall
```

### Option 2: Install via npm

```bash
# Install globally (installs both `clipnest` and `clipn` commands)
npm install -g @seymi/clipnest-cli
clipn --help

# Or run directly with npx
npx @seymi/clipnest-cli status
```

Requires **Node.js 18+**. No Rust toolchain or C++ build tools are required.

---

## 📖 Getting Help (`-h` / `--help`)

Every command supports `-h` and `--help` (as well as `clipn help <command>`):

```bash
clipn --help
clipn add --help
clipn move --help
clipn category --help
clipn transform --help
```

If you mistype a command (e.g. `clipn lst`), ClipNest CLI suggests the closest command (`Did you mean 'clipnest list'?`) and exits with code `2` (`EXIT_USAGE`).

---

## 🚀 Quick Examples & Shell Pipelines

### 1. Stdin & Shell Pipelines

```bash
# Save piped stdin as a new item in ClipNest history
git log -5 --oneline | clipn add -

# Copy piped stdin directly to the system clipboard
git diff | clipn copy -

# Combined: add piped stdin to ClipNest history AND copy to the system clipboard (reads stdin once)
git diff | clipn add - --copy

# Output raw content of item #12 to a file or another command
clipn get 12 > output.txt
clipn get 12 | findstr "TODO"

# Output the newest history item (@0 / latest)
clipn get @0

# Output the current system clipboard text
clipn get
```

### 2. History, Categories & Item Management

```bash
clipn list                           # List recent items
clipn list -n 10 --pinned            # List top 10 pinned items
clipn list --category Work           # List items in the "Work" category
clipn search "invoice"               # Smart search (typo-tolerant)
clipn search "^https://" --regex     # Regular expression search
clipn search "trgde" --fuzzy         # Subsequence fuzzy search

clipn add "Hello world" --pin --category Work --tags "work,urgent" --title "Greeting"
clipn edit 12 "Updated content" --title "Edited"
clipn rename 12 "API Endpoint"
clipn pin 12 15                      # Pin in main Clipboard
clipn pin 12 --category Work         # Pin independently inside "Work" category
clipn unpin 12 --category Work
clipn tag 12 work backend
clipn tag 12 --add urgent
clipn tag 12 --clear
clipn move 12 --to Work              # Assign item #12 to "Work" category
clipn move 12 --from Work --to Personal         # Move from "Work" to "Personal"
clipn move 12 --from Work --to Personal --copy  # Copy to "Personal" while keeping in "Work"
clipn move 12 --to main              # Remove from categories
clipn merge 12 15 --sep "\n---\n" --copy
clipn formats 12
clipn delete 12
```

### 3. Built-in Text Transformations

```bash
clipn transform list
clipn transform json-pretty 12
cat payload.json | clipn transform json-min - --copy
echo "كتاب شماره ٢" | clipn transform fa-normalize -
clipn transform upper 12 --save --copy
```

### 4. Categories (Pinboards), Queue & Drop Basket

```bash
clipn category list
clipn category create "Snippets" --color "#34c759" --max 200 --active
clipn category update "Snippets" --paste-mode plain
clipn category activate "Snippets"
clipn category activate none
clipn category delete "Snippets" --yes

clipn queue status
clipn queue add 12 15
clipn queue fifo on
clipn queue clear

clipn basket list
clipn basket add "C:\Users\Ali\Desktop\report.pdf"
clipn basket paste-to "D:\Backup\Docs"
```

### 5. Rules, Custom Actions, Settings & Atomic Backups

```bash
clipn status
clipn status --json
clipn pause 15
clipn resume
clipn plain toggle

clipn config list
clipn config get independent_pinning
clipn config set independent_pinning true
clipn config set wrap_categories true
clipn config reset max_items

clipn export backup.json
clipn export clipnest-snapshot.db.gz
clipn import backup.json
clipn backup
clipn erase --yes
```

---

## 📋 Complete Command Reference

| Command | Aliases | Description |
| --- | --- | --- |
| `add <text\|->` | — | Add text, stdin (`-`), or `--file <path>` to history (`--copy`, `--pin`, `--category`, `--tags`, `--title`). |
| `list` | `ls` | List history items (`-n/--limit`, `-b/--category/--board`, `-k/--kind`, `--pinned`, `--json`). |
| `search <query>` | `find` | Search items (`--mode smart\|fuzzy\|regex`, `--regex`, `--fuzzy`, `--category`, `-n`). |
| `get [id]` | — | Print raw text/HTML/formats/metadata for an item (`12`, `@0`, `latest`) or system clipboard (when `id` omitted). |
| `copy <text\|->` | `cp` | Set OS clipboard from text, stdin (`-`), `--file`, or history item (`--id <id> [--plain]`). |
| `paste [id]` | — | Copy item (default `@0`) and simulate paste into active window (`--plain`, `--rich`, `--auto`). |
| `edit <id> [text\|-]` | — | Edit item text, `--title`, or `--tags`. |
| `rename <id> <title>` | — | Set or clear custom title for an item. |
| `delete <id...>` | `rm` | Delete items (bulk delete > 3 items requires `--yes`). |
| `pin <id...>` / `unpin <id...>` | — | Pin or unpin items globally or inside `--category <name>`. |
| `tag <id> [tags...]` | — | Set, `--add`, `--remove`, or `--clear` item tags. |
| `move <id...>` | `mv` | Move or `--copy` items to `--to <category\|main>` (`--from <cat>`), or reorder (`--before`/`--after`). |
| `merge <id...>` | — | Merge multiple text items with `--sep <str>` (`--copy`). |
| `formats [id]` | — | List stored clipboard/MIME formats and byte sizes for an item. |
| `transform <tr\|list>` | `tr` | Run built-in text transform on item ID, stdin (`-`), or `--text` (`--save`, `--copy`). |
| `category <sub>` | `cat`, `categories`, `pinboard`, `board`, `pinboards` | `list`, `create`, `update`, `delete --yes`, `activate <name\|none>`. |
| `queue <sub>` | — | `status`, `list`, `add`, `remove`, `clear`, `toggle`, `close`, `fifo <on\|off>`. |
| `basket <sub>` | — | `list`, `add`, `remove`, `cut`, `paste-to <folder>`, `clear`. |
| `rule <sub>` | `rules` | `list`, `add`, `enable`, `disable`, `delete`. |
| `action <sub>` | `actions` | `list`, `run <action> [id]`, `add <name> --cmd <cmd>`, `delete`. |
| `config <sub>` | — | `list`, `get <key>`, `set <key> <value>`, `reset [key] [--yes]`. |
| `status` | — | Show daemon, capture, paste mode, item/category counts, and data directory (`--check-running`). |
| `pause [min]` / `resume` | — | Pause or resume clipboard monitoring. |
| `plain [on\|off\|toggle]` | — | Set or toggle global plain-text paste mode. |
| `export <file>` | — | Atomically export history/categories/settings to `.json` or `.db.gz` (or `--settings`). |
| `import <file>` | — | Import/merge `.json`, `.db.gz`, or `.db` backup (or `--settings`). |
| `backup [file]` | — | Create an immediate compressed `.db.gz` snapshot. |
| `erase --yes` | `clear-history` | Permanently erase history (`--category`, `--include-pinned`, `--all-boards`). |
| `open` / `hide` / `settings` / `quit` | `show` | Show/hide popup window, open Settings window, or quit ClipNest. |
| `path <sub>` | — | `status`, `install`, `uninstall` (`clipnest` and `clipn` in Windows user `PATH`). |

---

## 🔢 Exit Codes

| Exit Code | Constant         | Meaning                                                                                     |
| --------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `0`       | `EXIT_OK`        | Command completed successfully.                                                             |
| `1`       | `EXIT_ERROR`     | General runtime or I/O error.                                                               |
| `2`       | `EXIT_USAGE`     | Invalid command, flag, missing argument, or missing `--yes` confirmation.                   |
| `3`       | `EXIT_NOT_FOUND` | Requested item ID, category, rule, action, or setting key was not found.                    |
| `4`       | `EXIT_OFFLINE`   | ClipNest desktop app is not running (for daemon-only commands or `--online-only`) / IPC err.|
| `5`       | `EXIT_PARTIAL`   | Combined operation partially succeeded (e.g. `add - --copy` saved to DB but clipboard err). |
