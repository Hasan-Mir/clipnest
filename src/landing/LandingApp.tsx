import React, { useEffect, useState } from 'react';
import { COPY, LandingLang } from './copy';
import { DemoStage } from './DemoStage';
import { QueueBasketShowcase } from './QueueBasketShowcase';
import { demoCaptureUserCopy } from './tauriShim';
import { Icon } from '../lib/icons';

const RELEASES_URL = 'https://github.com/Hasan-Mir/clipnest/releases/latest';
const REPO_URL = 'https://github.com/Hasan-Mir/clipnest';
const NPM_CMD = 'npm install -g @seymi/clipnest-cli';
const NAV_SECTIONS = ['demo', 'queue-basket', 'features', 'cli'] as const;

function renderHeroTitle(title: string, lang: LandingLang) {
    const token = lang === 'fa' ? 'کلیپ‌بورد' : 'clipboard';
    const idx = title.indexOf(token);
    if (idx < 0) return title;
    return (
        <>
            {title.slice(0, idx)}
            <span className="lp-grad-word">{token}</span>
            {title.slice(idx + token.length)}
        </>
    );
}

export function LandingApp() {
    const [lang, setLang] = useState<LandingLang>(() => {
        try {
            return localStorage.getItem('clipnest_lp_lang') === 'fa' ? 'fa' : 'en';
        } catch {
            return 'en';
        }
    });
    const [activeSection, setActiveSection] = useState<string>('demo');
    const [cliTab, setCliTab] = useState('pipe');
    const [copiedInstall, setCopiedInstall] = useState(false);
    const [copiedCli, setCopiedCli] = useState(false);
    const [copiedDlCli, setCopiedDlCli] = useState(false);

    // Interactive micro-states inside Feature Bento
    const [richPreview, setRichPreview] = useState(true);
    const [ctrlHeldDemo, setCtrlHeldDemo] = useState(false);

    useEffect(() => {
        const updateActive = () => {
            const probe = window.scrollY + 180;
            let current: string = 'demo';
            for (const id of NAV_SECTIONS) {
                const el = document.getElementById(id);
                if (!el) continue;
                const top = el.getBoundingClientRect().top + window.scrollY;
                if (top <= probe) {
                    current = id;
                }
            }
            setActiveSection(current);
        };
        updateActive();
        window.addEventListener('scroll', updateActive, { passive: true });
        window.addEventListener('resize', updateActive, { passive: true });
        return () => {
            window.removeEventListener('scroll', updateActive);
            window.removeEventListener('resize', updateActive);
        };
    }, []);

    const copy = COPY[lang];
    const dir = lang === 'fa' ? 'rtl' : 'ltr';

    const toggleLang = () => {
        const next: LandingLang = lang === 'en' ? 'fa' : 'en';
        setLang(next);
        try {
            localStorage.setItem('clipnest_lp_lang', next);
        } catch {
            // ignore
        }
    };

    const copyToClipboard = async (text: string, which: 'install' | 'cli' | 'dl-cli') => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // fallback silent
        }
        demoCaptureUserCopy(text);
        if (which === 'install') {
            setCopiedInstall(true);
            window.setTimeout(() => setCopiedInstall(false), 1600);
        } else if (which === 'dl-cli') {
            setCopiedDlCli(true);
            window.setTimeout(() => setCopiedDlCli(false), 1600);
        } else {
            setCopiedCli(true);
            window.setTimeout(() => setCopiedCli(false), 1600);
        }
    };

    const activeCli = copy.cli.tabs.find((t) => t.id === cliTab) ?? copy.cli.tabs[0];

    return (
        <div className="lp-page" dir={dir} data-lp-lang={lang}>
            {/* ───────── Top Navbar ───────── */}
            <header className="lp-nav-wrap">
                <div className="lp-container lp-nav">
                    <a href="#top" className="lp-brand">
                        <img src="./icon.png" alt="ClipNest" />
                        <span>ClipNest</span>
                        <span className="lp-ver">v0.2.0</span>
                    </a>

                    <nav className="lp-nav-links" aria-label="Main navigation">
                        <a href="#demo" className={activeSection === 'demo' ? 'active' : ''}>
                            {copy.nav.demo}
                        </a>
                        <a href="#queue-basket" className={activeSection === 'queue-basket' ? 'active' : ''}>
                            {copy.nav.queueBasket}
                        </a>
                        <a href="#features" className={activeSection === 'features' ? 'active' : ''}>
                            {copy.nav.features}
                        </a>
                        <a href="#cli" className={activeSection === 'cli' ? 'active' : ''}>
                            {copy.nav.cli}
                        </a>
                    </nav>

                    <div className="lp-nav-actions">
                        <button type="button" className="lp-ghost-btn" onClick={toggleLang}>
                            {copy.nav.langToggle}
                        </button>
                        <a
                            href={REPO_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="lp-ghost-btn lp-gh-btn"
                            aria-label="GitHub"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.11.78-.25.78-.55 0-.27-.01-1.16-.02-2.11-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 015.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.26 5.67.42.36.79 1.06.79 2.15 0 1.55-.01 2.8-.01 3.18 0 .31.21.67.79.55A11.51 11.51 0 0023.5 12C23.5 5.65 18.35.5 12 .5z" />
                            </svg>
                            <span>GitHub</span>
                        </a>
                        <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="lp-primary-btn small">
                            {copy.nav.download}
                        </a>
                    </div>
                </div>
            </header>

            <main id="top">
                {/* ───────── Hero + Live Synced Interactive App Demo ───────── */}
                <section className="lp-hero">
                    <div className="lp-container lp-hero-grid">
                        <div className="lp-hero-copy">
                            <div className="lp-hero-pill">
                                <span className="lp-pill-dot" aria-hidden />
                                <span>{copy.hero.badge}</span>
                            </div>

                            <h1>{renderHeroTitle(copy.hero.title, lang)}</h1>
                            <p className="lp-hero-sub">{copy.hero.subtitle}</p>

                            <div className="lp-hero-ctas">
                                <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="lp-primary-btn">
                                    {copy.hero.ctaPrimary}
                                </a>
                                <a href="#queue-basket" className="lp-secondary-btn">
                                    {copy.hero.ctaSecondary}
                                </a>
                            </div>

                            <div className="lp-install-strip">
                                <span className="lp-install-label">{copy.hero.installHint}</span>
                                <div className="lp-install-box" dir="ltr">
                                    <code>{NPM_CMD}</code>
                                    <button
                                        type="button"
                                        className="lp-copy-mini"
                                        onClick={() => copyToClipboard(NPM_CMD, 'install')}
                                    >
                                        {copiedInstall ? copy.cli.copied : copy.cli.copyCmd}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="lp-hero-demo-col">
                            <DemoStage copy={copy.demo} />
                        </div>
                    </div>
                </section>

                {/* ───────── Animated Paste Queue & Drop Basket Showcase ───────── */}
                <QueueBasketShowcase copy={copy.showcase} />

                {/* ───────── Feature Architecture Bento ───────── */}
                <section className="lp-section" id="features">
                    <div className="lp-container">
                        <div className="lp-section-head">
                            <h2>{copy.features.title}</h2>
                            <p>{copy.features.subtitle}</p>
                        </div>

                        <div className="lp-bento">
                            {/* Card 1: Rich HTML & Shadow DOM */}
                            <article className="lp-bento-card span-2">
                                <div className="lp-bento-top">
                                    <h3>{copy.features.rich.title}</h3>
                                    <button
                                        type="button"
                                        className={`lp-bento-toggle${richPreview ? ' on' : ''}`}
                                        onClick={() => setRichPreview((v) => !v)}
                                    >
                                        {richPreview ? copy.features.rich.badgeRich : copy.features.rich.badgePlain}
                                    </button>
                                </div>
                                <p>{copy.features.rich.desc}</p>
                                <div className="lp-rich-compare" dir="ltr">
                                    {richPreview ? (
                                        <pre className="lp-code-rich">
                                            <span className="tok-k">pub fn</span>{' '}
                                            <span className="tok-f">save_atomic</span>(path:{' '}
                                            <span className="tok-t">&amp;Path</span>, bytes:{' '}
                                            <span className="tok-t">&amp;[u8]</span>) -&gt;{' '}
                                            <span className="tok-t">Result&lt;()&gt;</span> {'{\n'}
                                            {'    '}
                                            <span className="tok-k">let</span> tmp = path.
                                            <span className="tok-f">with_extension</span>(
                                            <span className="tok-s">"tmp"</span>);{'\n'}
                                            {'    '}fs::<span className="tok-f">write</span>(&amp;tmp, bytes)?;{'\n'}
                                            {'    '}fs::<span className="tok-f">rename</span>(tmp, path){'\n}'}
                                        </pre>
                                    ) : (
                                        <pre className="lp-code-plain">
                                            {`pub fn save_atomic(path: &Path, bytes: &[u8]) -> Result<()> {\n    let tmp = path.with_extension("tmp");\n    fs::write(&tmp, bytes)?;\n    fs::rename(tmp, path)\n}`}
                                        </pre>
                                    )}
                                </div>
                            </article>

                            {/* Card 2: Categories & Ctrl Move/Copy */}
                            <article className="lp-bento-card">
                                <div className="lp-bento-top">
                                    <h3>{copy.features.categories.title}</h3>
                                    <button
                                        type="button"
                                        className={`lp-bento-toggle${ctrlHeldDemo ? ' on' : ''}`}
                                        onClick={() => setCtrlHeldDemo((v) => !v)}
                                    >
                                        {copy.features.categories.holdCtrl}
                                    </button>
                                </div>
                                <p>{copy.features.categories.desc}</p>
                                <div className="lp-cat-sim" dir="ltr">
                                    <div className="lp-cat-pill">
                                        <Icon name="copy" size={13} />
                                        <span>{copy.features.categories.fromMain}</span>
                                    </div>
                                    <div className={`lp-cat-pill${ctrlHeldDemo ? ' accent' : ''}`}>
                                        <Icon name={ctrlHeldDemo ? 'copy' : 'arrowRight'} size={13} />
                                        <span>
                                            {ctrlHeldDemo
                                                ? copy.features.categories.fromCatCtrl
                                                : copy.features.categories.fromCat}
                                        </span>
                                    </div>
                                </div>
                            </article>

                            {/* Card 3: Multi-Modal Search */}
                            <article className="lp-bento-card">
                                <h3>{copy.features.search.title}</h3>
                                <p>{copy.features.search.desc}</p>
                                <div className="lp-search-modes">
                                    {copy.features.search.modes.map((m) => (
                                        <div key={m.code} className="lp-sm-row">
                                            <span className="lp-sm-badge" dir="ltr">
                                                {m.code}
                                            </span>
                                            <span className="lp-sm-name">{m.name}</span>
                                            <code className="lp-sm-sample" dir="ltr">
                                                {m.sample}
                                            </code>
                                        </div>
                                    ))}
                                </div>
                            </article>

                            {/* Card 4: Rust + SQLite + Privacy */}
                            <article className="lp-bento-card span-2">
                                <h3>{copy.features.safety.title}</h3>
                                <p>{copy.features.safety.desc}</p>
                                <div className="lp-safety-grid">
                                    {copy.features.safety.items.map((item) => (
                                        <div key={item.label} className="lp-safety-item">
                                            <strong>{item.label}</strong>
                                            <span>{item.detail}</span>
                                        </div>
                                    ))}
                                </div>
                            </article>
                        </div>
                    </div>
                </section>

                {/* ───────── CLI Showcase ───────── */}
                <section className="lp-section" id="cli">
                    <div className="lp-container">
                        <div className="lp-section-head">
                            <h2>{copy.cli.title}</h2>
                            <p>{copy.cli.subtitle}</p>
                        </div>

                        <div className="lp-cli-shell" dir="ltr">
                            <div className="lp-cli-head">
                                <div className="lp-cli-tabs" role="tablist">
                                    {copy.cli.tabs.map((tab) => (
                                        <button
                                            key={tab.id}
                                            type="button"
                                            role="tab"
                                            aria-selected={cliTab === tab.id}
                                            className={`lp-cli-tab${cliTab === tab.id ? ' active' : ''}`}
                                            onClick={() => setCliTab(tab.id)}
                                        >
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>
                                <button
                                    type="button"
                                    className="lp-copy-mini"
                                    onClick={() => copyToClipboard(activeCli.lines.map((l) => l.cmd).join('\n'), 'cli')}
                                >
                                    {copiedCli ? copy.cli.copied : copy.cli.copyCmd}
                                </button>
                            </div>

                            <div className="lp-cli-body">
                                {activeCli.lines.map((line, i) => (
                                    <div key={i} className="lp-cli-block">
                                        <div className="lp-cli-cmd">
                                            <span className="lp-cli-prompt">$</span>
                                            <code>{line.cmd}</code>
                                        </div>
                                        {line.out && <div className="lp-cli-out">{line.out}</div>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                {/* ───────── Keyboard Shortcuts ───────── */}
                <section className="lp-section">
                    <div className="lp-container">
                        <div className="lp-section-head">
                            <h2>{copy.shortcuts.title}</h2>
                            <p>{copy.shortcuts.subtitle}</p>
                        </div>

                        <div className="lp-kbd-grid">
                            {copy.shortcuts.groups.map((grp) => (
                                <div key={grp.title} className="lp-kbd-card">
                                    <h3>{grp.title}</h3>
                                    <ul>
                                        {grp.items.map((it) => (
                                            <li key={it.keys}>
                                                <span>{it.desc}</span>
                                                <kbd dir="ltr">{it.keys}</kbd>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ───────── Download & Footer ───────── */}
                <section className="lp-section lp-download-section" id="download">
                    <div className="lp-container">
                        <div className="lp-section-head">
                            <h2>{copy.download.title}</h2>
                            <p>{copy.download.subtitle}</p>
                        </div>

                        <div className="lp-dl-grid">
                            <div className="lp-dl-card featured">
                                <div className="lp-dl-head">
                                    <h3>{copy.download.installer.title}</h3>
                                    <span className="lp-dl-badge accent">{copy.download.installer.badge}</span>
                                </div>
                                <p>{copy.download.installer.desc}</p>
                                <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="lp-primary-btn">
                                    {copy.download.installer.btn}
                                </a>
                            </div>

                            <div className="lp-dl-card">
                                <div className="lp-dl-head">
                                    <h3>{copy.download.portable.title}</h3>
                                    <span className="lp-dl-badge">{copy.download.portable.badge}</span>
                                </div>
                                <p>{copy.download.portable.desc}</p>
                                <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="lp-secondary-btn">
                                    {copy.download.portable.btn}
                                </a>
                            </div>

                            <div className="lp-dl-card">
                                <div className="lp-dl-head">
                                    <h3>{copy.download.cliPkg.title}</h3>
                                    <span className="lp-dl-badge">{copy.download.cliPkg.badge}</span>
                                </div>
                                <p>{copy.download.cliPkg.desc}</p>
                                <div className="lp-install-box" dir="ltr">
                                    <code>{copy.download.cliPkg.cmd}</code>
                                    <button
                                        type="button"
                                        className="lp-copy-mini"
                                        onClick={() => copyToClipboard(copy.download.cliPkg.cmd, 'dl-cli')}
                                    >
                                        {copiedDlCli ? copy.cli.copied : copy.cli.copyCmd}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="lp-footer">
                <div className="lp-container lp-footer-inner">
                    <div className="lp-footer-brand">
                        <img src="./icon.png" alt="" />
                        <span>ClipNest</span>
                    </div>
                    <p>{copy.download.credits}</p>
                    <div className="lp-footer-links">
                        <a href={REPO_URL} target="_blank" rel="noreferrer">
                            GitHub
                        </a>
                        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                            Releases
                        </a>
                    </div>
                </div>
            </footer>
        </div>
    );
}
