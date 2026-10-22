# ClipNest Changelog Specification (`CHANGELOG.md`)

This document defines the strict, machine-parsable standard for writing and maintaining `CHANGELOG.md` in the **ClipNest** repository. Both human contributors and AI agents **must** follow this specification verbatim so that:

1. `.github/workflows/release.yml` can automatically extract release notes for GitHub Releases.
2. Any future website generator can deterministically parse `CHANGELOG.md` into structured JSON or HTML release cards without manual editing.

---

## 1. Current State

While ClipNest is in pre-release development and no public version has been published yet, `CHANGELOG.md` remains **completely empty** (`0` bytes). As soon as the first version (e.g., `0.1.0` or `1.0.0`) is tagged for release, add its entry to `CHANGELOG.md` using the exact format below.

---

## 2. Exact Entry Format (Telegram Desktop Style)

Every release block in `CHANGELOG.md` follows the **Telegram Desktop** changelog convention:

```text
<MAJOR>.<MINOR>.<PATCH> (<DD>.<MM>.<YY>)

- <Change description 1>.
- <Change description 2>.
- <Change description 3>.
```

### Concrete Example

```text
0.2.0 (22.10.26)

- Add Drop Basket mode for collecting files and browser images across folders before batch pasting.
- Add per-pinboard default paste mode and Active Pinboard capture routing.
- Improve search match highlighting with Persian cursive-safe rendering and customizable color presets.
- Fix auto-repeat toggling when holding down Win+V in the low-level keyboard hook.
- Fix transparent background detection in RichView cards copied from Chrome and Word.

0.1.0 (10.10.26)

- Add event-driven Win32 clipboard listener with crash-safe SQLite WAL storage.
- Add multi-modal search with smart tokens, fuzzy subsequence matching, and regular expressions.
- Add screen-capture protection via SetWindowDisplayAffinity.
```

---

## 3. Strict Formatting Rules for Humans & AI Agents

1. **No Markdown Headings or Frontmatter in `CHANGELOG.md`:**
   - Do **not** put `# Changelog`, `## [0.1.0]`, or horizontal rules (`---`) inside `CHANGELOG.md`.
   - Each release header is a plain line matching the regular expression:
     `^(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\((?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{2})\)$`
2. **Chronological Order:**
   - Newest releases **always** go at the very top of `CHANGELOG.md`.
   - Separate consecutive release blocks with **one blank line**.
3. **Date Format (`DD.MM.YY`):**
   - Always use 2-digit day, 2-digit month, and 2-digit year separated by dots: e.g., `22.10.26` for October 22, 2026.
4. **Bullet Structure:**
   - Leave **exactly one blank line** between the `<VERSION> (<DD>.<MM>.<YY>)` header line and the first `- ` bullet item.
   - Start every item with `- ` (hyphen + single space).
   - Start every bullet sentence with a present-tense imperative verb:
     - `Add ...` (new features, settings, or capabilities)
     - `Improve ...` (UX, performance, visual polish, or refactoring)
     - `Fix ...` (bug fixes, crash fixes, or edge-case corrections)
     - `Remove ...` (removed features or deprecated options)
     - `Migrate ...` (major dependency or schema upgrades)
   - End every bullet sentence with a period (`.`).
   - Keep each bullet on a **single line** (no multi-line wrapped bullets) so line-by-line parsers remain trivial.
   - Optional parenthetical context at the end of a bullet is allowed: e.g., `- Add NSIS dual install mode. (supports both per-user without admin privileges and all-users installation)`

---

## 4. Reference Parser (For Website Generators & CI Scripts)

Any static site generator or script can parse `CHANGELOG.md` into structured data with the following TypeScript function:

```ts
export interface ReleaseEntry {
  version: string;
  date: string; // "DD.MM.YY"
  isoDate: string; // "20YY-MM-DD"
  items: string[];
}

export function parseChangelog(raw: string): ReleaseEntry[] {
  const releases: ReleaseEntry[] = [];
  let current: ReleaseEntry | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const headerMatch = line.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\((\d{2})\.(\d{2})\.(\d{2})\)$/);
    if (headerMatch) {
      const [, version, dd, mm, yy] = headerMatch;
      current = {
        version,
        date: `${dd}.${mm}.${yy}`,
        isoDate: `20${yy}-${mm}-${dd}`,
        items: [],
      };
      releases.push(current);
      continue;
    }
    if (line.startsWith("- ") && current) {
      current.items.push(line.slice(2).trim());
    }
  }

  return releases;
}
```
