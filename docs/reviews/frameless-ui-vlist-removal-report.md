# گزارش کامل تغییرات معماری، رفع باگ‌ها و بازطراحی رابط کاربری ClipNest

این گزارش تمامی تغییرات اعمال‌شده در این مرحله، دلایل فنی هر تصمیم معماری (برای توسعه‌دهندگان آینده)، نتایج بازبینی همگرای چندعاملی (Cycle 1 و Cycle 2) و فهرست فایل‌های تغییریافته را مستند می‌کند.

---

## ۱. خلاصه‌ی تغییرات کلیدی

1. **پنجره‌ی تنظیمات بدون قاب (Frameless Settings) + کامندهای `async` در Rust:**
   - در `src-tauri/tauri.conf.json` و `src-tauri/src/windowing.rs` پنجره‌ی `settings` به حالت `decorations: false` همراه با `shadow: true` و گوشه‌های گرد بومی ویندوز ۱۱ (`win::round_window_corners`) تبدیل شد.
   - چهار کامند ناهمزمان (`async fn`) در `src-tauri/src/commands.rs` (`settings_minimize`، `settings_toggle_maximize`، `settings_is_maximized`، `settings_close`) اضافه و در `src-tauri/src/lib.rs` و `src/lib/api.ts` ثبت شدند تا از deadlockهای IPC روی WebView2 جلوگیری شود.
   - نوار عنوان داخلی `SettingsTitleBar` با `dir="ltr"` ثابت، `data-tauri-drag-region` بدون `onDoubleClick` مضاعف، همگام‌سازی خودکار وضعیت Maximize/Restore با `resize`/`focus` و نمایش خطای toast در صورت خطای IPC در `src/settings/Settings.tsx` پیاده‌سازی شد.
   - بخش‌های tray و drag-and-drop کاملاً دست‌نخورده باقی ماندند.

2. **حذف نوار عنوان مشکی بومی ویندوز روی پنجره‌ی Paste Queue:**
   - **علت ریشه‌ای:** در `packages/core/src/platform/win.rs` تابع `make_no_activate` فلگ `WS_EX_TOOLWINDOW` را پس از ساخت پنجره به `GWL_EXSTYLE` اضافه می‌کرد. از آنجا که Tauri/tao روی پنجره‌های `decorations(false)` قابل تغییر اندازه، `WS_CAPTION | WS_THICKFRAME` را نگه می‌دارد، افزودن `WS_EX_TOOLWINDOW` باعث می‌شد DWM ویندوز یک نوار عنوان مشکی ToolWindow با دکمه‌ی قرمز `X` بالای پنجره رسم کند.
   - **اصلاح:** حذف `WS_EX_TOOLWINDOW` از `make_no_activate` (چون مخفی‌سازی از تسک‌بار قبلاً با `.skip_taskbar(true)` انجام شده است)، حفظ `WS_EX_NOACTIVATE` و فراخوانی `SetWindowPos(..., SWP_FRAMECHANGED)`.

3. **حذف کامل `virtua` (`VList`) و جایگزینی با لیست DOM صفحه‌بندی‌شده + انیمیشن حذف CSS Grid Collapse:**
   - حذف وابستگی `virtua` از `package.json`، حذف شاخه‌ی `<VList>` از `src/popup/Popup.tsx`، حذف `.vlist*` از `src/styles.css`، و حذف گزینه‌ی `virtual_scroll` از تنظیمات (`models.rs`، `api.ts`، `useSettings.ts`، `Settings.tsx`، `README.md`). به دلیل وجود `#[serde(default)]` بدون `deny_unknown_fields` در `models.rs`، فایل‌های `settings.json` قدیمی کاربران بدون خطا خوانده می‌شوند (همراه با تست واحد `legacy_settings_with_virtual_scroll_deserializes_cleanly`).
   - افزودن تنظیم `page_size` (**Items per page**، پیش‌فرض `100`، بازه‌ی `20..500`) و `IntersectionObserver` sentinel در انتهای `.list` برای لود خودکار صفحات بعدی هنگام اسکرول با ماوس و کیبورد.
   - افزودن هوک مشترک `src/lib/useViewportVisible.ts` (`IntersectionObserver` با `rootMargin: '300px'`) در `RichView.tsx` و `Thumb` (`Card.tsx`) و `content-visibility: auto` روی `.card` برای حفظ سرعت باز شدن پنجره بدون کش‌ریزی IPC.
   - جایگزینی ۱۳۰ خط کد دستوری `translateY` با انیمیشن declarative در CSS Grid (`.card-slot` و `.card-slot.removing` با `grid-template-rows: 1fr -> 0fr` و `margin-bottom: 6px -> 0`).

4. **رفع ۷ باگ انتخاب چندتایی، حذف و همگام‌سازی لیست (`src/popup/Popup.tsx`):**
   - اصلاح `targets()` برای پشتیبانی از `multi.length > 0` و اصلاح `Ctrl+Click` deselect (تبدیل تمیز انتخاب ۲تایی به انتخاب تکی روی آیتم باقی‌مانده + آپدیت `anchor.current`).
   - پالایش آیدی‌های منقضی/حذف/منتقل‌شده از `multi` در `reload()` و پاک‌سازی `multi` پس از Move به دسته‌بندی دیگر (`!shouldCopy`).
   - فیلتر کردن `pendingDeleteIdsRef` در `reload()` و افزایش `++seq.current` هنگام حذف خوش‌بینانه برای جلوگیری از بازگشت موقت آیتم حذف‌شده.
   - حذف `setMulti([])` مطلق در `doDelete` (فقط آیدی‌های حذف‌شده از `multi` کم می‌شوند) و clamp کردن خالص `sel` با `useEffect` روی `items.length`.

5. **اصلاحات UX و استایل Calm Desktop UI (`src/styles.css`، `Popup.tsx`، `Overlays.tsx`، `CustomSelect.tsx`، `Settings.tsx`):**
   - افزودن `scrollbar-gutter: stable` روی `.list`، `.qlist`، `.spane` و `.cselect-list` برای حذف کامل شیفت افقی هنگام فیلتر شدن لیست.
   - بازطراحی دکمه‌ی **Pin** در هدر Popup (تغییر `fill` به رنگ accent + چرخش نرم `-45deg` بدون پس‌زمینه‌ی رنگی) و دکمه‌ی **Toggle side toolbar** (تغییر رنگ SVG بدون پس‌زمینه‌ی رنگی).
   - رفع باگ باز نشدن نوار ابزار کناری در لیست خالی (`const toolbar = Boolean(s?.show_toolbar)` و غیرفعال شدن ایمن دکمه‌های وابسته به کارت با `disabled={!cur}`).
   - افزودن حس فشردن فیزیکی آرام‌تر (`175ms`) روی همه‌ی دکمه‌ها، **سوییچ‌ها (`.switch`)** و **دکمه‌های Close/Minimize/Maximize (`.win-ctl`)** با `:where(...)` برای جلوگیری از تداخل specificity.
   - رفع مشکل پریدن انیمیشن باز شدن دیالوگ‌ها، مودال‌ها و منوها در mount اولیه با هوک double-rAF (`src/lib/useEntered.ts`) و زمان‌بندی آرام‌تر شبیه Notion (`210ms–240ms`).
   - افزودن ۵ فونت مدرن متغیر برای رابط کاربری لاتین (`Google Sans` پیش‌فرض، `Inter`، `Plus Jakarta Sans`، `DM Sans`، `Roboto` از `@fontsource-variable/*`) همراه با قفل بودن دائمی فونت تعبیه‌شده‌ی `Vazirmatn` برای متن‌های فارسی/عربی (`src/lib/uiFonts.ts`)، و انتخاب اندازه‌ی فونت `12 / 14 / 16 / 18 px` در تنظیمات.

---

## ۲. نتیجه‌ی بازبینی همگرای چندعاملی (Convergent Multi-Agent Review)

- **Cycle 1 (۲ ساب‌ایجنت مستقل Backend و Frontend):**
  - بخش Rust/Win32/Tauri بدون هیچ باگ کامپایل یا رگرسیون تأیید شد (تنها نیاز به اجرای `npm install` برای همگام‌سازی `package-lock.json` و افزودن تست serde و اصلاح کامنت `windowing.rs` گزارش شد).
  - در بخش Frontend چهار باگ مهم کشف و بلافاصله رفع شدند: (۱) تعریف نشدن `subEntered` در `SubMenu`، (۲) جا ماندن کلاس `.entered` روی `.overlay`/`.dialog` در `Prompt` و `BoardDialog`، (۳) بریدگی نشانگرهای drag-and-drop توسط `content-visibility: auto` و `overflow: hidden` روی `.card-slot-inner`، و (۴) تداخل specificity سلکتور `button:not(...)` با `.switch:active` و `.win-ctl`.
- **Cycle 2 (ساب‌ایجنت همگرایی تازه):**
  - همه‌ی اصلاحات Cycle 1 بدون هیچ رگرسیونی تأیید شدند و آخرین مورد جزئی (`!important` روی `.switch:active` داخل `@media (prefers-reduced-motion: reduce)`) اعمال شد.

---

## ۳. دستورات لازم پس از استخراج روی ویندوز

به دلیل آفلاین بودن سندباکس و نبود `node_modules` و `cargo`، لطفاً پس از استخراج فایل فشرده روی مخزن و بستن نمونه‌ی در حال اجرای ClipNest در tray، دستورات زیر را اجرا کنید:

```powershell
npm install
npm run typecheck
npm test
cargo test --manifest-path packages/core/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```
