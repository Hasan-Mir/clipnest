# 📋 ClipNest — مدیر کلیپ‌بورد سریع، هوشمند و خصوصی برای ویندوز (همراه با CLI کامل: `clipnest` / `clipn`)

**ClipNest** یک مدیر کلیپ‌بورد فوق‌سریع، ایمن و کاملاً آفلاین برای **ویندوز ۱۰ و ۱۱** است که سادگی و زیبایی رابط کاربری Copywren و Notion را با قدرت و امکانات پیشرفته CopyQ و یک رابط خط فرمان (`clipnest` و نام کوتاه `clipn`) برای اسکریپت‌نویسی و اتومیشن ترکیب می‌کند.
Fast, accessible, private clipboard manager, file collector & automation CLI for Windows (Tauri v2 · Rust · Win32 · React · SQLite).

---

## ✨ امکانات کلیدی (Key Features)

- ⚡ **عملکرد آنی، نوشتن اتمی و ایمنی کامل داده:** هسته‌ی بومی Rust + SQLite در حالت WAL با `synchronous=FULL`؛ تمامی نوشتن‌های فایل، تنظیمات، خروجی‌ها و بک‌آپ‌ها به‌صورت اتمی (`.tmp` + rename) انجام می‌شوند تا هیچ فایلی هرگز دچار خرابی (corruption) نشود.
- 💻 **رابط خط فرمان کامل با نام کوتاه `clipn` (`clipnest` / `clipn` CLI):** الهام‌گرفته از CopyQ CLI با دستورات کوتاه و command-first (`add`, `list`, `search`, `get`, `copy`, `paste`, `edit`, `rename`, `delete`, `pin`, `unpin`, `tag`, `move`, `merge`, `formats`, `transform`, `category`, `queue`, `basket`, `rule`, `action`, `config`, `export`, `import`, `backup`, `erase`, `status`, `path`)، راهنمای کامل برای تک‌تک دستورات با `-h` / `--help`، پشتیبانی از `stdin`/`stdout` و pipelineهای شل، خروجی انسانی و `--json`، ارتباط محلی امن (IPC) و fallback آفلاین مستقیم به دیتابیس.
- 🗂️ **دسته‌بندی‌ها (Categories) با منطق هوشمند Copy to / Move to و سنجاق مستقل:**
    - تب‌های رنگی نامحدود با اسکرول افقی نرم (با چرخ ماوس یا کلیک و کشیدن / Grab-to-scroll) و گزینه‌ی چندخطی شدن تب‌ها (`Wrap category tabs onto multiple lines` مشابه `workbench.editor.wrapTabs` در VS Code).
    - در تب اصلی **Clipboard**، راست‌کلیک یا کشیدن کارت روی یک دسته‌بندی عملیات **Copy to** (با آیکن کپی) را انجام می‌دهد (چون آیتم در تب اصلی باقی می‌ماند).
    - در داخل یک **Category**، عملیات پیش‌فرض در منوی راست‌کلیک و Drag & Drop روی دسته‌بندی دیگر **Move to** (با آیکن فلش به راست) است و با نگه داشتن کلید **`Ctrl`** در لحظه به **Copy to** (با هایلایت رنگی کلمه Copy به رنگ accent و آیکن کپی) تبدیل می‌شود.
    - **سنجاق مستقل در هر دسته‌بندی (`Independent pinning per category`):** به‌طور پیش‌فرض پین کردن یک کارت داخل یک دسته‌بندی فقط در همان دسته‌بندی اعمال می‌شود و تب اصلی Clipboard یا سایر دسته‌بندی‌ها را تغییر نمی‌دهد (قابل تغییر از تنظیمات).
- 📂 **انتخاب چندتایی فایل‌ها در Windows Explorer (`Show in Explorer`):** هنگام انتخاب چند فایل (چه داخل یک کارت چندفایله و چه با انتخاب چند کارت فایل) و زدن گزینه‌ی **Show in Explorer**، پوشه‌ی مقصد باز شده و **تمامی فایل‌های انتخاب‌شده هم‌زمان در Explorer در حالت Select قرار می‌گیرند** (با استفاده از API بومی `SHOpenFolderAndSelectItems`).
- ♿ **دسترسی‌پذیری کامل (Full Accessibility & Keyboard Navigation):** پشتیبانی کامل از صفحه‌خوان‌ها (NVDA / Jaws / Narrator) با نقش‌های استاندارد ARIA (`listbox`, `option`, `tablist`, `tab`, `menu`, `menuitem`, `dialog`, `aria-live="polite"`)، باز کردن منوی راست‌کلیک کارت با `Shift+F10` یا کلید `ContextMenu`، پیمایش کامل منوها و زیرمنوها با کلیدهای جهت‌نما، و غیرفعال‌سازی کامل شورتکات‌های مزاحم مرورگر (مانند دیالوگ پرینت `Ctrl+P`).
- 🎨 **نمایش و پیست دقیق استایل (Original Style / Rich HTML):** کدها و متن‌های کپی‌شده از VS Code، Word و مرورگرها دقیقاً با همان فونت، رنگ و پس‌زمینه داخل Shadow DOM امن نمایش داده می‌شوند؛ همراه با دکمه‌ی سریع `Aa` برای تغییر آنی بین نمایش با استایل و متن ساده.
- 🧺 **صف پیست دوحالته و سبد فایل و تصویر (Paste Queue & Drop Basket):**
    - **Queue Mode:** چندین متن یا آیتم را کپی کنید و با زدن پیاپی `Ctrl+V` به ترتیب (FIFO یا LIFO) پیست کنید.
    - **Drop Basket (Collector Mode):** فایل‌ها و تصاویر را از پوشه‌های مختلف جمع کنید و با یک کلیک همه‌ی آن‌ها را در پوشه‌ی مقصد پیست یا منتقل کنید (حذف فایل مبدأ در حالت `CUT` فقط پس از تأیید کامل کپی و بررسی دقیق حجم فایل در مقصد انجام می‌شود).

---

## 💻 استفاده از خط فرمان (`clipnest` و نام کوتاه `clipn`)

### نصب CLI

1. **همراه با نصاب ویندوز ClipNest (بدون نیاز به Node.js):** پس از نصب برنامه، هر دو دستور `clipnest` و نام کوتاه `clipn` به‌طور خودکار به `PATH` کاربر اضافه می‌شوند. در نسخه‌ی Portable نیز می‌توانید با دستور `clipn path install` آن‌ها را به `PATH` اضافه کنید.
2. **نصب از طریق npm:**
   ```bash
   npm install -g @seymi/clipnest-cli
   clipn --help
   clipnest --help
   ```

### راهنمای سریع تمام دستورات CLI (`-h` / `--help`)

برای مشاهده‌ی راهنمای کلی یا راهنمای اختصاصی هر دستور، کافی است `-h` یا `--help` را به دستور اضافه کنید:

```bash
clipn --help
clipn <command> --help
clipn help <command>
```

| دستور (با `clipn` یا `clipnest`) | توضیح و فلگ‌های اصلی |
| --- | --- |
| `add <text\|->` | افزودن متن، ورودی پایپ (`-`) یا فایل (`-f <path>`) به تاریخچه (`-c/--copy`، `-p/--pin`، `-b/--category <name>`، `-t/--tags`، `--title`) |
| `list` (یا `ls`) | نمایش فهرست آخرین آیتم‌ها (`-n <limit>`، `-b/--category <name>`، `-k/--kind <kind>`، `--pinned`، `--json`) |
| `search <query>` (یا `find`) | جستجو در تاریخچه (`-m smart\|fuzzy\|regex`، `-r/--regex`، `-z/--fuzzy`، `-b/--category <name>`، `-n <limit>`) |
| `get [id]` | دریافت محتوای خام آیتم (`12` یا `@0`/`latest`) یا محتوای فعلی کلیپ‌بورد سیستم (بدون آرگومان)؛ پشتیبانی از `--format plain\|html\|meta\|formats` و `-o <file>` |
| `copy <text\|->` (یا `cp`) | قرار دادن متن، `stdin` (`-`)، فایل (`-f`) یا آیتم تاریخچه (`--id <id>`) در کلیپ‌بورد سیستم (`--plain`) |
| `paste [id]` | کپی آیتم (پیش‌فرض `@0`) در کلیپ‌بورد و پیست در پنجره‌ی فعال (`--plain`، `--rich`، `--auto`) |
| `edit <id> [text\|-]` | ویرایش متن، عنوان (`--title`) یا برچسب‌های (`--tags`) یک آیتم |
| `rename <id> <title>` | تنظیم یا پاک کردن عنوان سفارشی آیتم |
| `delete <id...>` (یا `rm`) | حذف یک یا چند آیتم (حذف بیش از ۳ آیتم نیازمند `--yes` است) |
| `pin <id...>` / `unpin <id...>` | سنجاق کردن یا برداشتن سنجاق آیتم‌ها (پشتیبانی از `--category <name>` برای پین مستقل در یک دسته‌بندی) |
| `tag <id> [tags...]` | تنظیم، افزودن (`--add`)، حذف (`--remove`) یا پاک کردن (`--clear`) تگ‌های آیتم |
| `move <id...> --to <cat\|main>` | انتقال یا کپی (`--copy`، `--from <cat>`) آیتم‌ها به دسته‌بندی مقصد، یا تغییر ترتیب (`--before <id>` / `--after <id>`) |
| `merge <id1> <id2> [...]` | ادغام چند آیتم متنی در یک آیتم جدید (`--sep "\n---\n"`، `--copy`) |
| `formats [id]` | مشاهده‌ی فرمت‌های ذخیره‌شده‌ی کلیپ‌بورد/MIME و حجم هرکدام |
| `transform <tr\|list> [id\|-]` | اجرای تبدیل‌های متنی (`upper`, `lower`, `json-pretty`, `b64-enc`, `fa-normalize`, `fa-digits` و غیره) با `--save` و `--copy` |
| `category <subcommand>` | مدیریت دسته‌بندی‌ها (`list`، `create <name> --color #hex --max N --active`، `update`، `delete <name> --yes`، `activate <name\|none>`)؛ نام مستعار: `cat`, `pinboard`, `board` |
| `queue <subcommand>` | مدیریت صف پیست (`status`, `list`, `add <id...>`, `remove <id>`, `clear`, `toggle`, `close`, `fifo <on\|off>`) |
| `basket <subcommand>` | مدیریت سبد فایل (`list`, `add <file\|id...>`, `remove <id>`, `cut <id>`, `paste-to <folder>`, `clear`) |
| `rule <subcommand>` | مدیریت قوانین خودکار (`list`, `add`, `enable`, `disable`, `delete`) |
| `action <subcommand>` | مدیریت و اجرای اکشن‌های سفارشی شل (`list`, `run <act> [id]`, `add <name> --cmd <cmd>`, `delete`) |
| `config <subcommand>` | مشاهده و تغییر تنظیمات (`list`, `get <key>`, `set <key> <val>`, `reset [key] [--yes]`) |
| `status` | نمایش وضعیت دیمون، کپچر، صف، تعداد آیتم‌ها و مسیر داده (`--check-running`، `--json`) |
| `pause [min]` / `resume` | توقف موقت یا ادامه‌ی ثبت کلیپ‌بورد |
| `plain [on\|off\|toggle]` | تغییر یا تنظیم حالت پیست متن ساده‌ی سراسری |
| `export <file>` / `import <file>` | خروجی گرفتن یا وارد کردن تاریخچه و دسته‌بندی‌ها (`.json` یا `.db.gz`) یا تنظیمات (`--settings`) |
| `backup [file]` | تهیه‌ی فوری اسنپ‌شات فشرده SQLite (`.db.gz`) |
| `erase --yes` | پاک‌سازی تاریخچه (`--category <name>`، `--include-pinned`، `--all-boards`) |
| `open` / `hide` / `settings` / `quit` | باز و بسته کردن پنجره‌ی پاپ‌آپ، باز کردن تنظیمات یا خروج کامل از برنامه |
| `path [status\|install\|uninstall]` | بررسی، افزودن یا حذف `clipnest` و `clipn` در `PATH` کاربر ویندوز |

### مثال‌های کاربردی و Pipeline

```bash
# افزودن خروجی پایپ به تاریخچه ClipNest با نام کوتاه clipn
git log -5 --oneline | clipn add -

# قرار دادن خروجی پایپ در کلیپ‌بورد سیستم
git diff | clipn copy -

# عملیات ترکیبی: افزودن به تاریخچه و کپی در کلیپ‌بورد با یک بار خواندن stdin
git diff | clipn add - --copy

# دریافت محتوای خام یک آیتم برای پایپ یا ذخیره در فایل
clipn get 12 > output.txt
clipn get @0 | another-command

# خواندن محتوای فعلی کلیپ‌بورد سیستم
clipn get

# مدیریت آیتم‌ها، دسته‌بندی‌ها (Categories)، تبدیل متن و خروجی JSON
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

مستندات کامل دستورات، فلگ‌ها و کدهای خروجی (Exit Codes) در فایل [`packages/cli/README.md`](packages/cli/README.md) قرار دارد.

---

## 🚀 پیش‌نیازها و اجرا (Build, Test & Format)

1. **Windows 10 (2004+)** یا **Windows 11** (همراه با WebView2)
2. **[Rust](https://rustup.rs)** (نسخه‌ی `stable-x86_64-pc-windows-msvc`، ۱.۷۷ به بالا)
3. **Visual Studio Build Tools** با گزینه‌ی «Desktop development with C++»
4. **Node.js ≥ 20**

```powershell
npm install
npm run tauri dev       # اجرای محیط توسعه
npm run tauri:build     # ساخت نصاب NSIS، باینری CLI و نسخه‌ی Portable
```

### 🧪 اجرای تست‌ها و فرمت خودکار کد (Testing & Formatting)

```powershell
bun run typecheck:bun   # بررسی فوق‌سریع تایپ‌ها با Bun (`bun check --skipLibCheck`) — توصیه برای AI Agents و توسعه
npm run typecheck       # بررسی کامل تایپ‌های TypeScript با tsc (کندتر)
npm test                # اجرای تست‌های واحد فرانت‌اند و CLI با Vitest
npm run test:rust       # اجرای تست‌های واحد و یکپارچه بک‌اند و CLI با Cargo Test
npm run test:all        # اجرای کامل تمامی تست‌های فرانت‌اند و Rust
npm run format          # مرتب‌سازی خودکار کدهای فرانت‌اند (Prettier) و Rust (rustfmt)
npm run format:check    # بررسی استایل کدها در CI
```

---

## ⌨️ کلیدهای میانبر (Keyboard & Mouse Shortcuts)

| عملکرد                                         | کلید / ماوس                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| باز کردن پنجره‌ی اصلی                          | `Win+V` (پیش‌فرض؛ در تنظیمات قابل تغییر به `Alt+V` و غیره)       |
| پیست با استایل / متن ساده (یا مسیر فایل)       | دوبار کلیک یا `Enter` / `Shift+Enter` (`Ctrl+Enter` = با استایل) |
| انتخاب تکی / انتخاب بازه‌ای / انتخاب چندتایی   | تک‌کلیک / `Shift+Click` (یا `Shift+↑/↓`) / `Ctrl+Click`          |
| باز کردن منوی راست‌کلیک کارت با کیبورد         | `Shift+F10` یا کلید `ContextMenu`                                |
| کپی به دسته‌بندی هنگام Drag & Drop یا در منو   | نگه داشتن کلید `Ctrl`                                            |
| پیست سریع کارت‌های قابل‌مشاهده                 | `Ctrl+1` … `Ctrl+9`                                              |
| جابه‌جایی ترتیب کارت‌ها                        | کشیدن با ماوس (Drag & Drop) یا `Alt+↑/↓`                         |
| پیش‌نمایش و ویرایش درجا (با ذخیره‌ی خودکار)    | `Space` (یا `F3`) · `Ctrl+E`                                     |
| جابه‌جایی بین تب Clipboard و دسته‌بندی‌ها      | `←` `→` یا `Tab` یا `Ctrl+[ ]`                                   |
| فوکوس روی نوار جستجو                           | `Ctrl+F`                                                         |
| سنجاق کردن آیتم به بالای لیست                  | `Ctrl+P`                                                         |
| تغییر نام / برچسب‌ها / بازرس فرمت‌ها           | `F2` / `Ctrl+T` / `Ctrl+I`                                       |
| ادغام چند آیتم انتخاب‌شده                      | `Ctrl+M`                                                         |
| صف پیست و سبد فایل (Paste Queue / Drop Basket) | `Ctrl+Alt+Q`                                                     |
| تغییر حالت متن ساده‌ی سراسری                   | `Ctrl+Alt+P`                                                     |
| باز کردن تنظیمات                               | `Ctrl+,`                                                         |

---

## 📂 مسیر ذخیره‌سازی داده‌ها

تمامی داده‌ها به‌صورت کاملاً محلی در مسیر زیر ذخیره می‌شوند:
`%APPDATA%\com.clipnest.app\` (`clipnest.db`, `settings.json`, `backups\`, `cli-rpc.json`)

---

## 🙏 قدردانی و الهام‌گیری (Credits & Acknowledgements)

این نرم‌افزار با الهام و الگوبرداری از دو پروژه‌ی ارزشمند **Copywren** و **CopyQ** طراحی و توسعه داده شده است و صمیمانه از سازندگان آن‌ها قدردانی می‌کنیم:

- **Copywren:** طراحی رابط کاربری (UI)، ساختار بصری کارت‌ها، پنجره‌ی پاپ‌آپ و تجربه‌ی کاربری مدرن ClipNest مستقیماً از رابط کاربری چشم‌نواز **Copywren** الگوبرداری شده است.
- **[CopyQ](https://github.com/hluk/CopyQ):** ایده‌ی امکانات پیشرفته‌ی مدیریت کلیپ‌بورد، دسته‌بندی‌ها ( تب‌ها)، قوانین خودکار، اکشن‌های سفارشی، نوار ابزار کناری و طراحی رابط خط فرمان (`clipnest` / `clipn` CLI) از نرم‌افزار قدرتمند و متن‌باز **CopyQ** الهام گرفته شده است.
