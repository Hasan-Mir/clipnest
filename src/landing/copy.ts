export type LandingLang = 'en' | 'fa';

export interface CopyDict {
    nav: {
        demo: string;
        queueBasket: string;
        features: string;
        cli: string;
        download: string;
        langToggle: string;
    };
    hero: {
        badge: string;
        title: string;
        subtitle: string;
        ctaPrimary: string;
        ctaSecondary: string;
        installHint: string;
    };
    demo: {
        workbenchLabel: string;
        themeLabel: string;
        themes: { dark: string; oled: string; light: string };
        accentLabel: string;
        queueBtn: string;
        simCopy: string;
        reset: string;
        hint: string;
        demoLangLabel: string;
        settingsNote: string;
        pastedEvent: string;
        copiedEvent: string;
        userCopiedEvent: string;
    };
    showcase: {
        title: string;
        subtitle: string;
        tabQueue: string;
        tabBasket: string;
        play: string;
        pause: string;
        replay: string;
        nextStep: string;
        queue: {
            lead: string;
            sourceApp: string;
            windowTitle: string;
            targetForm: string;
            orderToggle: string;
            stepLabels: string[];
            fields: Array<{ label: string; key: string }>;
            emptyQueue: string;
            doneHint: string;
        };
        basket: {
            lead: string;
            sourcesTitle: string;
            windowTitle: string;
            destTitle: string;
            verifiedBadge: string;
            cutClearedNote: string;
            stepLabels: string[];
            pasteBtn: string;
            toggleCutTip: string;
        };
    };
    features: {
        title: string;
        subtitle: string;
        rich: {
            title: string;
            desc: string;
            badgeRich: string;
            badgePlain: string;
        };
        categories: {
            title: string;
            desc: string;
            holdCtrl: string;
            fromMain: string;
            fromCat: string;
            fromCatCtrl: string;
        };
        search: {
            title: string;
            desc: string;
            modes: Array<{ code: string; name: string; sample: string }>;
        };
        safety: {
            title: string;
            desc: string;
            items: Array<{ label: string; detail: string }>;
        };
    };
    cli: {
        title: string;
        subtitle: string;
        copyCmd: string;
        copied: string;
        tabs: Array<{ id: string; label: string; lines: Array<{ cmd: string; out?: string }> }>;
    };
    shortcuts: {
        title: string;
        subtitle: string;
        groups: Array<{
            title: string;
            items: Array<{ keys: string; desc: string }>;
        }>;
    };
    download: {
        title: string;
        subtitle: string;
        installer: { title: string; badge: string; desc: string; btn: string };
        portable: { title: string; badge: string; desc: string; btn: string };
        cliPkg: { title: string; badge: string; desc: string; cmd: string };
        credits: string;
    };
}

export const COPY: Record<LandingLang, CopyDict> = {
    en: {
        nav: {
            demo: 'Live UI',
            queueBasket: 'Queue & Basket',
            features: 'Features',
            cli: 'CLI',
            download: 'Download',
            langToggle: 'فارسی',
        },
        hero: {
            badge: 'Built for Windows 10 & 11',
            title: 'Manage your Windows clipboard faster and smarter.',
            subtitle:
                'Access every copied snippet, image, and file with Win+V. Paste sequences in order with Paste Queue, gather files across folders in Drop Basket, keep original code styling, or automate tasks with the clipn CLI.',
            ctaPrimary: 'Download for Windows',
            ctaSecondary: 'See Queue & Basket in action',
            installHint: 'CLI included in installer, or via npm:',
        },
        demo: {
            workbenchLabel: 'Live App Preview',
            themeLabel: 'Theme',
            themes: { dark: 'Dark', oled: 'OLED', light: 'Light' },
            accentLabel: 'Accent',
            queueBtn: 'Queue / Basket',
            simCopy: 'Simulate Copy',
            reset: 'Reset',
            hint: 'Interactive preview of the ClipNest UI — try search, Aa / .* / ~, right-click cards, drag onto tabs, Space to preview, or open Queue. Desktop-only actions (Settings, Explorer) are disabled here.',
            demoLangLabel: 'App UI',
            settingsNote: 'Settings & OS Explorer buttons stay silent in web preview.',
            pastedEvent: 'Copied to clipboard (demo paste)',
            copiedEvent: 'Simulated new copy captured',
            userCopiedEvent: 'Captured your page copy into ClipNest',
        },
        showcase: {
            title: 'Two dedicated workflows for multi-item pasting and file gathering',
            subtitle:
                'Switch between Paste Queue for sequential form filling and Drop Basket for collecting files across scattered folders before transferring them in one pass.',
            tabQueue: 'Paste Queue (FIFO / LIFO)',
            tabBasket: 'Drop Basket (File Collector)',
            play: 'Play',
            pause: 'Pause',
            replay: 'Replay',
            nextStep: 'Next Step',
            queue: {
                lead: 'Turn on Queue Mode (Ctrl+Alt+Q), copy everything you need in one sweep, then press Ctrl+V repeatedly — ClipNest automatically loads the next item after every paste.',
                sourceApp: 'Source Notes / Terminal',
                windowTitle: 'ClipNest · Queue',
                targetForm: 'Deployment Config Form',
                orderToggle: 'Order',
                stepLabels: [
                    '1. Copy items sequentially from any app',
                    '2. Queue lines them up with #1 primed',
                    '3. First Ctrl+V pastes #1 and advances',
                    '4. Subsequent Ctrl+V pastes finish the form',
                ],
                fields: [
                    { label: 'Endpoint URL', key: 'endpoint' },
                    { label: 'Client ID', key: 'client' },
                    { label: 'Bearer Token', key: 'token' },
                ],
                emptyQueue: 'Queue complete — all items pasted',
                doneHint: 'Switch between FIFO ↓ and LIFO ↑ anytime without re-copying.',
            },
            basket: {
                lead: 'Gather files from different folders and images from your browser or any app into a single Drop Basket. Mark individual files or whole folders as COPY or CUT, then paste them all into one destination.',
                sourcesTitle: 'Scattered Windows Sources',
                windowTitle: 'ClipNest · Drop Basket',
                destTitle: 'Target: D:\\Release\\Assets\\',
                verifiedBadge: 'Transfer verified ✓',
                cutClearedNote: 'CUT originals are removed only after destination copy and size verification succeed.',
                stepLabels: [
                    '1. Collect files & images from anywhere',
                    '2. Auto-grouped by folder · toggle COPY / CUT',
                    '3. Paste All to Folder… with live progress',
                    '4. Verified copy · CUT sources cleaned up',
                ],
                pasteBtn: 'Paste All to Folder…',
                toggleCutTip: 'Click COPY/CUT badge in the animation to toggle mode',
            },
        },
        features: {
            title: 'Designed for speed, shaped around everyday workflows',
            subtitle:
                'From keeping syntax colors intact to instant multi-mode search and local privacy protection, everything stays fast and effortless.',
            rich: {
                title: 'Original Style Preservation',
                desc: 'Code and formatted snippets copied from VS Code, Word, or browsers keep their original colors and styling while staying readable on dark or light themes. Toggle Aa anytime to view or paste plain text.',
                badgeRich: 'Aa · Rich HTML',
                badgePlain: 'Plain text',
            },
            categories: {
                title: 'Categories with Smart Copy vs. Move',
                desc: 'Organize clips in unlimited color-coded tabs. Dragging from main Clipboard copies; dragging between categories moves by default and turns into Copy when holding Ctrl.',
                holdCtrl: 'Hold Ctrl',
                fromMain: 'From Clipboard → Copy to Dev',
                fromCat: 'From Dev → Move to Links',
                fromCatCtrl: 'From Dev + Ctrl → Copy to Links',
            },
            search: {
                title: 'Smart, Regex & Strict Fuzzy Search',
                desc: 'Search across content, titles, tags, source app names, and item kinds with Persian/Arabic normalization and match highlighting that keeps ligatures intact.',
                modes: [
                    { code: 'Smart', name: 'Token + type words', sample: 'code atomic' },
                    { code: '.*', name: 'Regular expression', sample: '^pub fn \\w+' },
                    { code: '~', name: 'Strict fuzzy order', sample: 'clpnst' },
                ],
            },
            safety: {
                title: 'Private, offline, and built to protect sensitive data',
                desc: 'Everything you copy stays strictly on your own PC, with automatic safeguards for passwords, tokens, and backups.',
                items: [
                    {
                        label: 'Crash-Safe Local Storage',
                        detail: 'Atomic local saves prevent corruption on sudden power loss, with automatic compressed backups',
                    },
                    {
                        label: 'Screen-Share Protection',
                        detail: 'Keeps the ClipNest window hidden during screen sharing and desktop screenshots',
                    },
                    {
                        label: 'Sensitive Data Masking',
                        detail: 'Detects API keys and tokens, blurs them by default, and can auto-delete them on a timer',
                    },
                    {
                        label: 'Password Manager Guard',
                        detail: 'Automatically skips KeePass, Bitwarden, 1Password, and confidential clipboard items',
                    },
                ],
            },
        },
        cli: {
            title: 'Full automation via clipnest / clipn CLI',
            subtitle:
                'Script your clipboard history, pipe command output straight into categories, transform Persian or JSON text, and control the Paste Queue or Drop Basket.',
            copyCmd: 'Copy',
            copied: 'Copied',
            tabs: [
                {
                    id: 'pipe',
                    label: 'Pipelines & Stdin',
                    lines: [
                        {
                            cmd: 'git log -5 --oneline | clipn add - --category Dev --copy',
                            out: 'Added item #412 to "Dev" and copied to clipboard.',
                        },
                        { cmd: 'clipn get @0 > latest-commit.txt' },
                        {
                            cmd: 'clipn merge 410 411 412 --sep "\\n---\\n" --copy',
                            out: 'Merged 3 items -> #413 (copied)',
                        },
                    ],
                },
                {
                    id: 'search',
                    label: 'Search & JSON',
                    lines: [
                        {
                            cmd: 'clipn search "atomic" --mode smart --json',
                            out: '[{"id":107,"kind":"code","app":"VS Code","tags":"rust"}]',
                        },
                        { cmd: 'clipn formats 103', out: 'HTML Format (318 B) · CF_UNICODETEXT (412 B)' },
                        { cmd: 'clipn pin 107 --category Dev', out: 'Pinned #107 in category "Dev".' },
                    ],
                },
                {
                    id: 'queue',
                    label: 'Queue & Basket',
                    lines: [
                        {
                            cmd: 'clipn queue toggle && clipn queue add 103 104 107',
                            out: 'Queue active (FIFO): 3 items ready.',
                        },
                        {
                            cmd: 'clipn basket add C:\\Shots\\hero.png --cut',
                            out: 'Added 1 file to Drop Basket [CUT].',
                        },
                        {
                            cmd: 'clipn basket paste-to D:\\Release\\Assets',
                            out: 'Verified & transferred 1 item (CUT source removed).',
                        },
                    ],
                },
                {
                    id: 'transform',
                    label: 'Transforms',
                    lines: [
                        {
                            cmd: 'clipn transform json-pretty 103 --save --copy',
                            out: 'Transformed #103 -> new item #414.',
                        },
                        {
                            cmd: 'clipn transform fa-normalize 102 --save',
                            out: 'Normalized Persian Yeh/Kaf & digits -> #415.',
                        },
                        { cmd: 'clipn transform b64-enc @0', out: 'eyJ2ZXJzaW9uIjoiMi4xMi40In0=' },
                    ],
                },
            ],
        },
        shortcuts: {
            title: 'Keyboard-first from end to end',
            subtitle: 'Navigate, preview, transform, queue, and open context menus without leaving the keyboard.',
            groups: [
                {
                    title: 'Open & Navigate',
                    items: [
                        { keys: 'Win+V', desc: 'Open ClipNest popup' },
                        { keys: 'Ctrl+F', desc: 'Focus search bar' },
                        { keys: '← → / Tab', desc: 'Switch category tabs' },
                        { keys: 'Ctrl+1…9', desc: 'Quick-paste visible card' },
                    ],
                },
                {
                    title: 'Cards & Editing',
                    items: [
                        { keys: 'Enter / ⇧↵', desc: 'Paste formatted / plain text' },
                        { keys: 'Space · Ctrl+E', desc: 'Preview & inline edit' },
                        { keys: 'Ctrl+I · F2 · Ctrl+T', desc: 'MIME inspector · Rename · Tags' },
                        { keys: 'Shift+F10', desc: 'Open card context menu' },
                    ],
                },
                {
                    title: 'Organization & Queue',
                    items: [
                        { keys: 'Ctrl+P', desc: 'Pin / unpin card to top' },
                        { keys: 'Alt+↑ / ↓', desc: 'Reorder cards in list' },
                        { keys: 'Ctrl+M', desc: 'Merge selected cards' },
                        { keys: 'Ctrl+Alt+Q', desc: 'Toggle Paste Queue / Drop Basket' },
                    ],
                },
            ],
        },
        download: {
            title: 'Ready for Windows 10 & 11',
            subtitle: 'Completely free, open-source, and completely local. No cloud account or tracking.',
            installer: {
                title: 'Windows Installer (NSIS)',
                badge: 'Recommended',
                desc: 'Supports both per-user (no admin) and all-users installation. Automatically registers clipnest & clipn in PATH and adds optional Explorer context menu.',
                btn: 'Download Latest Installer',
            },
            portable: {
                title: 'Portable Archive (.zip)',
                badge: 'Zero-Install',
                desc: 'Extract anywhere and run immediately. Run "clipn path install" anytime if you want the CLI commands on your PATH.',
                btn: 'View Portable Releases',
            },
            cliPkg: {
                title: 'Standalone CLI via npm',
                badge: 'v0.2.0',
                desc: 'Install clipnest and clipn directly for terminal workflows and automation scripts.',
                cmd: 'npm install -g @seymi/clipnest-cli',
            },
            credits:
                'Inspired by Copywren (card layout) and CopyQ (categories, side toolbar, rules & CLI). Built by SeyMi.',
        },
    },
    fa: {
        nav: {
            demo: 'پیش‌نمایش زنده',
            queueBasket: 'صف و سبد فایل',
            features: 'امکانات',
            cli: 'خط فرمان',
            download: 'دانلود',
            langToggle: 'EN',
        },
        hero: {
            badge: 'مخصوص ویندوز ۱۰ و ۱۱',
            title: 'کلیپ‌بورد ویندوزت رو سریع و مرتب مدیریت کن.',
            subtitle:
                'با زدن Win+V به تمام متن‌ها، کدها، تصاویر و فایل‌هایی که کپی کردی دسترسی داشته باش؛ با Paste Queue پشت‌سرهم پیست کن، با Drop Basket فایل‌ها را از چند پوشه جمع کن، رنگ و استایل کدها را نگه دار و کارها را با خط فرمان clipn خودکار کن.',
            ctaPrimary: 'دانلود برای ویندوز',
            ctaSecondary: 'تماشای عملکرد صف و سبد فایل',
            installHint: 'خط فرمان همراه نصب‌کننده یا از طریق npm:',
        },
        demo: {
            workbenchLabel: 'پیش‌نمایش زنده‌ی برنامه',
            themeLabel: 'تم',
            themes: { dark: 'تیره', oled: 'OLED', light: 'روشن' },
            accentLabel: 'رنگ تاکیدی',
            queueBtn: 'صف / سبد فایل',
            simCopy: 'شبیه‌سازی کپی',
            reset: 'بازنشانی',
            hint: 'این همان رابط کاربری واقعی ClipNest است — جست‌وجو، دکمه‌های Aa / .* / ~، راست‌کلیک کارت‌ها، کشیدن کارت روی تب‌ها، کلید Space برای پیش‌نمایش و دکمه‌ی صف را امتحان کن. دکمه‌های سیستمی مثل تنظیمات و Explorer در نسخه‌ی وب غیرفعال‌اند.',
            demoLangLabel: 'زبان برنامه',
            settingsNote: 'دکمه‌های تنظیمات و Explorer در پیش‌نمایش وب غیرفعال هستند.',
            pastedEvent: 'در کلیپ‌بورد کپی شد (دمو)',
            copiedEvent: 'یک مورد جدید شبیه‌سازی و ثبت شد',
            userCopiedEvent: 'متنی که از صفحه کپی کردی داخل ClipNest ثبت شد',
        },
        showcase: {
            title: 'دو ابزار کاربردی برای پیست ترتیبی و جمع‌آوری فایل‌ها',
            subtitle:
                'با Paste Queue فرم‌ها را بدون جابه‌جایی بین پنجره‌ها پر کن و با Drop Basket فایل‌های پراکنده در پوشه‌های مختلف را یک‌جا جمع و منتقل کن.',
            tabQueue: 'Paste Queue (صف پیست)',
            tabBasket: 'Drop Basket (سبد فایل)',
            play: 'پخش',
            pause: 'توقف',
            replay: 'پخش مجدد',
            nextStep: 'مرحله‌ی بعد',
            queue: {
                lead: 'حالت صف را با Ctrl+Alt+Q روشن کن، چند مقدار را پشت سر هم کپی کن و بعد فقط با زدن Ctrl+V آن‌ها را به ترتیب در فیلدها قرار بده.',
                sourceApp: 'برنامه‌ی مبدا / ترمینال',
                windowTitle: 'ClipNest · Queue',
                targetForm: 'فرم تنظیمات',
                orderToggle: 'ترتیب',
                stepLabels: [
                    '۱. موارد را یکی‌یکی از هر برنامه‌ای کپی کن',
                    '۲. صف آن‌ها را مرتب می‌کند و مورد اول آماده است',
                    '۳. اولین Ctrl+V مورد اول را پیست و بعدی را آماده می‌کند',
                    '۴. با Ctrl+V های بعدی کل فرم سریع پر می‌شود',
                ],
                fields: [
                    { label: 'آدرس سرور', key: 'endpoint' },
                    { label: 'شناسه‌ی کلاینت', key: 'client' },
                    { label: 'توکن دسترسی', key: 'token' },
                ],
                emptyQueue: 'صف تمام شد — همه‌ی موارد پیست شدند',
                doneHint: 'هر زمان می‌توانی ترتیب را بین FIFO ↓ و LIFO ↑ برعکس کنی.',
            },
            basket: {
                lead: 'فایل‌ها را از پوشه‌های مختلف و تصاویر را از مرورگر یا هر برنامه‌ی دیگری در یک Drop Basket جمع کن؛ برای هر فایل یا پوشه حالت COPY یا CUT بگذار و همه را یک‌جا به مقصد منتقل کن.',
                sourcesTitle: 'پوشه‌های پراکنده‌ی ویندوز',
                windowTitle: 'ClipNest · Drop Basket',
                destTitle: 'مقصد: D:\\Release\\Assets\\',
                verifiedBadge: 'انتقال تایید شد ✓',
                cutClearedNote: 'در حالت CUT، فایل‌های اصلی فقط پس از اطمینان از کپی کامل و دقیق در مقصد حذف می‌شوند.',
                stepLabels: [
                    '۱. فایل‌ها و تصاویر را از هر برنامه و پوشه‌ای جمع کن',
                    '۲. دسته‌بندی خودکار بر اساس پوشه · انتخاب COPY یا CUT',
                    '۳. کلیک روی Paste All to Folder… همراه با نوار پیشرفت',
                    '۴. تایید انتقال کامل و پاک‌سازی ایمن فایل‌های CUT',
                ],
                pasteBtn: 'Paste All to Folder…',
                toggleCutTip: 'روی برچسب COPY/CUT کلیک کن تا حالتش تغییر کند',
            },
        },
        features: {
            title: 'ساخته‌شده برای سرعت و راحتی در کارهای روزمره',
            subtitle:
                'از حفظ رنگ و قالب کدها گرفته تا جست‌وجوی سریع و نگهداری ایمن تاریخچه، همه‌چیز برای کار سریع‌تر آماده شده است.',
            rich: {
                title: 'حفظ استایل و رنگ اصلی متن و کد',
                desc: 'کدهای کپی‌شده از VS Code یا متن‌های قالب‌بندی‌شده از Word و وب‌سایت‌ها با همان رنگ و فونت اصلی نمایش داده می‌شوند و همیشه خوانا می‌مانند. هر زمان هم با دکمه‌ی Aa می‌توانی به متن ساده سوییچ کنی.',
                badgeRich: 'Aa · استایل اصلی',
                badgePlain: 'متن ساده',
            },
            categories: {
                title: 'دسته‌بندی‌ها با کپی یا انتقال هوشمند',
                desc: 'کلیپ‌هایت را در تب‌های رنگی نامحدود مرتب کن. کشیدن کارت از تب اصلی «کپی» انجام می‌دهد؛ بین دسته‌بندی‌ها به طور پیش‌فرض «انتقال» می‌دهد و با نگه داشتن کلید Ctrl به «کپی» تغییر می‌کند.',
                holdCtrl: 'نگه داشتن Ctrl',
                fromMain: 'از Clipboard ← کپی به Dev',
                fromCat: 'از Dev ← انتقال به Links',
                fromCatCtrl: 'از Dev + کلید Ctrl ← کپی به Links',
            },
            search: {
                title: 'جست‌وجوی هوشمند، Regex و Fuzzy',
                desc: 'در متن، عنوان، تگ، نام برنامه و نوع محتوا جست‌وجو کن؛ همراه با پشتیبانی کامل از فارسی (ی، ک و ارقام) و هایلایت دقیق بدون به‌هم ریختن حروف چسبان.',
                modes: [
                    { code: 'Smart', name: 'ترکیب کلمات و نوع', sample: 'code atomic' },
                    { code: '.*', name: 'عبارت باقاعده', sample: '^pub fn \\w+' },
                    { code: '~', name: 'تطبیق فازی ترتیبی', sample: 'clpnst' },
                ],
            },
            safety: {
                title: 'کاملاً شخصی، امن و بدون نیاز به اینترنت',
                desc: 'تمام تاریخچه‌ی کلیپ‌بورد فقط روی سیستم خودت ذخیره می‌شود و بدون ارسال هیچ داده‌ای به بیرون، از اطلاعات حساس محافظت می‌کند.',
                items: [
                    {
                        label: 'ذخیره‌سازی مطمئن و پشتیبان‌گیری',
                        detail: 'ذخیره‌ی آنی تاریخچه بدون خطر خراب شدن در زمان قطعی برق، همراه با بکاپ خودکار فشرده',
                    },
                    {
                        label: 'پنهان در اسکرین‌شات و اشتراک صفحه',
                        detail: 'در زمان اشتراک‌گذاری صفحه یا گرفتن اسکرین‌شات، پنجره‌ی ClipNest دیده نمی‌شود',
                    },
                    {
                        label: 'تار کردن اطلاعات حساس',
                        detail: 'تشخیص خودکار کلیدهای API و رمزها، تار کردن نمایش آن‌ها و امکان حذف خودکار پس از چند دقیقه',
                    },
                    {
                        label: 'محافظت از رمزهای عبور',
                        detail: 'کپی‌های انجام‌شده از KeePass، Bitwarden، 1Password و محتوای محرمانه در تاریخچه ثبت نمی‌شوند',
                    },
                ],
            },
        },
        cli: {
            title: 'اتوماسیون کامل با خط فرمان clipnest و clipn',
            subtitle:
                'خروجی دستورات را مستقیم وارد دسته‌بندی‌ها کن، جست‌وجوی JSON بگیر، متن فارسی یا JSON را تبدیل کن و صف یا سبد فایل را از ترمینال کنترل کن.',
            copyCmd: 'کپی',
            copied: 'کپی شد',
            tabs: [
                {
                    id: 'pipe',
                    label: 'پایپ و Stdin',
                    lines: [
                        {
                            cmd: 'git log -5 --oneline | clipn add - --category Dev --copy',
                            out: 'Added item #412 to "Dev" and copied to clipboard.',
                        },
                        { cmd: 'clipn get @0 > latest-commit.txt' },
                        {
                            cmd: 'clipn merge 410 411 412 --sep "\\n---\\n" --copy',
                            out: 'Merged 3 items -> #413 (copied)',
                        },
                    ],
                },
                {
                    id: 'search',
                    label: 'جست‌وجو و JSON',
                    lines: [
                        {
                            cmd: 'clipn search "atomic" --mode smart --json',
                            out: '[{"id":107,"kind":"code","app":"VS Code","tags":"rust"}]',
                        },
                        { cmd: 'clipn formats 103', out: 'HTML Format (318 B) · CF_UNICODETEXT (412 B)' },
                        { cmd: 'clipn pin 107 --category Dev', out: 'Pinned #107 in category "Dev".' },
                    ],
                },
                {
                    id: 'queue',
                    label: 'صف و سبد فایل',
                    lines: [
                        {
                            cmd: 'clipn queue toggle && clipn queue add 103 104 107',
                            out: 'Queue active (FIFO): 3 items ready.',
                        },
                        {
                            cmd: 'clipn basket add C:\\Shots\\hero.png --cut',
                            out: 'Added 1 file to Drop Basket [CUT].',
                        },
                        {
                            cmd: 'clipn basket paste-to D:\\Release\\Assets',
                            out: 'Verified & transferred 1 item (CUT source removed).',
                        },
                    ],
                },
                {
                    id: 'transform',
                    label: 'تبدیل متن',
                    lines: [
                        {
                            cmd: 'clipn transform json-pretty 103 --save --copy',
                            out: 'Transformed #103 -> new item #414.',
                        },
                        {
                            cmd: 'clipn transform fa-normalize 102 --save',
                            out: 'Normalized Persian Yeh/Kaf & digits -> #415.',
                        },
                        { cmd: 'clipn transform b64-enc @0', out: 'eyJ2ZXJzaW9uIjoiMi4xMi40In0=' },
                    ],
                },
            ],
        },
        shortcuts: {
            title: 'سرعت کامل با کیبورد',
            subtitle: 'از باز کردن پنجره تا باز کردن منوی کارت و کنترل صف، همه‌چیز با کیبورد در دسترس است.',
            groups: [
                {
                    title: 'باز کردن و جابه‌جایی',
                    items: [
                        { keys: 'Win+V', desc: 'باز کردن پنجره‌ی کلیپ‌نست' },
                        { keys: 'Ctrl+F', desc: 'رفتن به کادر جست‌وجو' },
                        { keys: '← → / Tab', desc: 'جابه‌جایی بین دسته‌بندی‌ها' },
                        { keys: 'Ctrl+1…9', desc: 'پیست سریع کارت‌های نمایان' },
                    ],
                },
                {
                    title: 'کارت‌ها و ویرایش',
                    items: [
                        { keys: 'Enter / ⇧↵', desc: 'پیست با استایل / متن ساده' },
                        { keys: 'Space · Ctrl+E', desc: 'پیش‌نمایش و ویرایش سریع' },
                        { keys: 'Ctrl+I · F2 · Ctrl+T', desc: 'فرمت‌های MIME · تغییر نام · تگ' },
                        { keys: 'Shift+F10', desc: 'باز کردن منوی کارت با کیبورد' },
                    ],
                },
                {
                    title: 'مرتب‌سازی و صف',
                    items: [
                        { keys: 'Ctrl+P', desc: 'سنجاق به بالای فهرست' },
                        { keys: 'Alt+↑ / ↓', desc: 'جابه‌جایی ترتیب کارت‌ها' },
                        { keys: 'Ctrl+M', desc: 'ادغام کارت‌های انتخاب‌شده' },
                        { keys: 'Ctrl+Alt+Q', desc: 'باز و بسته کردن صف پیست و سبد فایل' },
                    ],
                },
            ],
        },
        download: {
            title: 'آماده برای ویندوز ۱۰ و ۱۱',
            subtitle: 'رایگان، متن‌باز و کاملاً محلی؛ بدون نیاز به حساب کاربری و بدون اینترنت.',
            installer: {
                title: 'نصب‌کننده‌ی ویندوز (NSIS)',
                badge: 'پیشنهادی',
                desc: 'قابل نصب برای کاربر فعلی (بدون نیاز به دسترسی ادمین) یا همه‌ی کاربران. دستورات clipnest و clipn را خودکار به PATH اضافه می‌کند.',
                btn: 'دانلود آخرین نسخه',
            },
            portable: {
                title: 'نسخه‌ی پرتابل (.zip)',
                badge: 'بدون نصب',
                desc: 'در هر پوشه‌ای استخراج و بلافاصله اجرا کن. هر زمان خواستی می‌توانی با دستور clipn path install خط فرمان را به PATH اضافه کنی.',
                btn: 'مشاهده‌ی فایل‌های انتشار',
            },
            cliPkg: {
                title: 'نصب مستقل CLI با npm',
                badge: 'v0.2.0',
                desc: 'نصب مستقیم clipnest و clipn برای استفاده در ترمینال و اسکریپت‌های خودکار.',
                cmd: 'npm install -g @seymi/clipnest-cli',
            },
            credits:
                'الهام‌گرفته از Copywren (ظاهر کارت‌ها) و CopyQ (دسته‌بندی‌ها، نوار ابزار و خط فرمان). ساخته‌شده توسط SeyMi.',
        },
    },
};
