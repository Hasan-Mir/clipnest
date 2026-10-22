# ClipNest — بررسی طرح قبلی و طرح نهایی

## ۱. بررسی طرحِ AI قبلی

**نقاط قوت (حفظ شد):** انتخاب Tauri v2 + Rust (مصرف RAM پایین، دسترسی مستقیم به Win32)، شنونده‌ی رویدادمحور کلیپ‌بورد (`AddClipboardFormatListener`)، ذخیره‌ی همه‌ی فرمت‌ها برای حفظ استایل، SQLite با WAL و `synchronous=FULL`، `SetWindowDisplayAffinity` برای ضداسکرین‌شات، پیدا کردن caret، Paste Stack، فیلتر برنامه‌ها، نرمال‌سازی فارسی.

**مشکلات و تغییرها:**

| موضوع در طرح قبلی | مشکل | تصمیم من |
|---|---|---|
| «چندپلتفرمی» (Windows/macOS/Linux) | شما فقط ویندوز خواستید؛ API های Caret، Display Affinity و Paste در هر OS کاملاً متفاوت است و پیچیدگی را چند برابر می‌کند | فقط ویندوز. تمام کد OS در `platform/` ایزوله شده تا بعداً بشود بک‌اند دیگری اضافه کرد |
| جستجو با FTS5 | FTS5 توکن‌محور است: جستجوی بخشی از کلمه (substring)، نیم‌فاصله‌ی فارسی و regex را خوب پشتیبانی نمی‌کند | ستون `search` نرمال‌شده (حروف فارسی/عربی، ارقام، حذف نیم‌فاصله و اعراب) + پویش مستقیم در Rust؛ برای ۵٬۰۰۰ آیتم چند میلی‌ثانیه است و regex/fuzzy هم می‌دهد |
| Blob Store جدا با BLAKE3 + rename اتمیک | پیچیدگی اضافه؛ SQLite خودش ACID است | بلاب‌ها داخل همان دیتابیس (تراکنش واحد). BLAKE3 فقط برای Dedup |
| ذخیره‌ی DIB خام برای تصاویر | یک اسکرین‌شات 4K حدود ۳۳MB می‌شود | ذخیره به صورت PNG؛ هنگام Paste، DIB ۲۴ بیتی ساخته می‌شود تا Paint/Word هم بفهمند |
| Shiki (WASM) برای هایلایت | سنگین و کند در لود اولیه | رندر مستقیم HTML کپی‌شده در Shadow DOM |
| `WDA_MONITOR` فقط به عنوان «حالت CopyQ» | کد خودِ CopyQ از `WDA_EXCLUDEFROMCAPTURE` استفاده می‌کند | هر دو حالت (مشکی / نامرئی) + خاموش، قابل‌تغییر آنی |
| پنجره‌ی ساده‌ی Caret با UIA | UIA ممکن است گیر کند | روی thread جدا با timeout ۱۵۰ms؛ زنجیره‌ی Win32 caret ← UIA ← ماوس |
| Ctrl+V با فوکوس | اگر Shift هنوز پایین باشد، برنامه‌ی مقصد Ctrl+Shift+V می‌بیند | قبل از ارسال کلید، مادیفایرهای فشرده‌شده آزاد می‌شوند |

## ۲. طرح نهایی

### معماری
```
Rust (Tauri v2)                                   React + TypeScript (WebView2)
├─ platform/win.rs  Win32 (clipboard, focus, SendInput, caret, display affinity)
├─ platform/uia.rs  UI Automation caret (feature "uia")
├─ capture.rs       رویداد کلیپ‌بورد -> خواندن همه‌ی فرمت‌ها -> فیلتر -> طبقه‌بندی -> SQLite
├─ classify.rs      text/code/link/color، کارت بانکی/API key، نرمال‌سازی فارسی
├─ search.rs        smart tokens + regex + fuzzy
├─ db.rs            SQLite WAL+FULL، بکاپ روزانه (VACUUM INTO + gzip)، بازیابی خودکار
├─ paste.rs         نوشتن فرمت‌ها، قوانین هر برنامه، بازگرداندن فوکوس، ارسال کلید
├─ queue.rs         Paste Queue (FIFO/LIFO) و سبد فایل (Drop Basket)
├─ windowing.rs     پنجره‌ها، موقعیت‌دهی، محافظت اسکرین‌شات
└─ commands.rs      فرمان‌های IPC برای popup / settings / queue / tray
```

### پاسخ به چهار نیازمندی اصلی
1. **جستجو** — فوری، با کلمات نوع (`image`, `link`, `code`, `file`, `color`, `text`)، نام برنامه‌ی مبدأ (`code`, `chrome`)، «عبارت دقیق» با کوتیشن، Regex (`.*`) و Fuzzy (`~`). فارسی: «ي/ك/ة»، ارقام فارسی/عربی، نیم‌فاصله و اعراب نادیده گرفته می‌شوند.
2. **حفظ استایل** — هر کپی با *همه‌ی* فرمت‌هایش ذخیره می‌شود (`CF_UNICODETEXT`، `HTML Format`، `Rich Text Format`، `vscode-editor-data`، `CF_HDROP`، فرمت‌های ثبت‌شده‌ی برنامه…). Enter = بازگرداندن همه‌ی فرمت‌ها؛ Shift+Enter = فقط متن ساده. سوییچ سراسری «Plain-text mode» (هات‌کی/تری/تنظیمات) + قانون برای هر برنامه (ترمینال ← ساده، Word ← با استایل).
3. **ماندگاری** — هر کپی همان لحظه در تراکنش SQLite با `journal_mode=WAL` و `synchronous=FULL` نوشته می‌شود (fsync کامل). هنگام اجرا `quick_check`؛ اگر دیتابیس خراب بود، فایل کنار گذاشته و آخرین بکاپ بازگردانی می‌شود. بکاپ روزانه‌ی فشرده، قابل‌تنظیم.
4. **ضد اسکرین‌شات** — `SetWindowDisplayAffinity`: «مشکی» (`WDA_MONITOR`)، «نامرئی» (`WDA_EXCLUDEFROMCAPTURE`) یا خاموش؛ روی همه‌ی پنجره‌ها و بدون ری‌استارت.
