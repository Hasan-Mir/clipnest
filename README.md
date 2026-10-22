# ClipNest

مدیر کلیپ‌بورد سریع و خصوصی برای **ویندوز** — ظاهر و تجربه‌ی Copywren + قدرت و تنظیمات CopyQ.
Fast, private clipboard manager for Windows (Tauri v2 · Rust · React · SQLite).

> ⚠️ **این کد هنوز کامپایل نشده است** (محیط ساخت Rust نداشت). جزئیات در `docs/PLAN.fa.md`.

## پیش‌نیازها
1. Windows 10 (2004+) یا 11 — WebView2 (در ویندوز ۱۱ پیش‌فرض نصب است)
2. [Rust](https://rustup.rs) (toolchain `stable-x86_64-pc-windows-msvc`، نسخه ≥ 1.77)
3. Visual Studio Build Tools با workload «Desktop development with C++»
4. Node.js ≥ 18

## اجرا و ساخت
```powershell
npm install
npm run tauri dev        # اجرای توسعه
npm run tauri build      # نصاب در src-tauri\target\release\bundle\nsis\
```
اگر ماژول UI Automation هنگام کامپایل خطا داد:
```powershell
npm run tauri build -- --no-default-features
```
(پنجره در این حالت فقط برای برنامه‌های کلاسیک زیر caret باز می‌شود و برای VS Code/Chrome کنار ماوس.)

## استفاده
| کار | کلید |
|---|---|
| باز کردن | `Ctrl+Alt+V` (قابل تغییر؛ در تنظیمات می‌شود `Win+V` گذاشت) |
| جابه‌جایی کارت | درگ یا `Alt+↑/↓` |
| Paste با استایل / متن ساده | `Enter` / `Shift+Enter` |
| Paste سریع | `Ctrl+1` … `Ctrl+9` |
| پیش‌نمایش | `Space` |
| تب‌ها | `←` `→` یا `Tab` |
| انتخاب چندتایی | `Shift+↑/↓` (Enter = ادغام و Paste) |
| Paste Queue | `Ctrl+Alt+Q`، سپس `Ctrl+V` پشت‌سرهم |
| حالت متن ساده‌ی سراسری | `Ctrl+Alt+P` |
| تنظیمات | `Ctrl+,` یا آیکون چرخ‌دنده |

داده‌ها: `%APPDATA%\com.clipnest.app\` (`clipnest.db`, `settings.json`, `backups\`).

## ساختار
تغییرهای نسخه‌ی ۲: `docs/CHANGES-2.md`

`src-tauri/` هسته‌ی Rust · `src/` رابط React · `docs/PLAN.fa.md` طرح و بررسی.
