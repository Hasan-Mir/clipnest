// @vitest-environment jsdom
// @ts-expect-error global flag for react act
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { api, ClipRow } from '../lib/api';
import { ColorPicker, hexToHsl, hslToHex, isValidHex } from '../lib/ColorPicker';
import { CustomSelect } from '../lib/CustomSelect';
import { ContextMenu, MenuEntry } from '../popup/Overlays';
import { Preview } from '../popup/Preview';
import { handleFolderHeaderKeyDown } from '../queue/Queue';

describe('UI Accessibility KeyDown handlers', () => {
    it('ContextMenu does not hijack Enter/Space on focused chip buttons', async () => {
        const chip1Click = vi.fn();
        const chip2Click = vi.fn();
        const firstEntryClick = vi.fn();
        const onClose = vi.fn();

        const entries: MenuEntry[] = [
            { label: 'First Entry', onClick: firstEntryClick },
            {
                chips: [
                    { label: 'Chip 1', onClick: chip1Click },
                    { label: 'Chip 2', onClick: chip2Click },
                ],
            },
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(<ContextMenu x={100} y={100} entries={entries} onClose={onClose} />);
        });

        const chipButtons = container.querySelectorAll<HTMLButtonElement>('.menu-chips button');
        expect(chipButtons.length).toBe(2);

        const chip2 = chipButtons[1];
        chip2.focus();

        const enterEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        const notPrevented = chip2.dispatchEvent(enterEvent);

        expect(notPrevented).toBe(true);
        expect(firstEntryClick).not.toHaveBeenCalled();
        expect(chip1Click).not.toHaveBeenCalled();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('Folder header onKeyDown ignores Enter/Space dispatched on nested action buttons', () => {
        let toggled = false;
        const toggleGroup = () => {
            toggled = true;
        };

        const headerDiv = document.createElement('div');
        headerDiv.className = 'brow bghead';
        const button = document.createElement('button');
        button.className = 'iconbtn';
        headerDiv.appendChild(button);
        document.body.appendChild(headerDiv);

        headerDiv.addEventListener('keydown', (e) => {
            handleFolderHeaderKeyDown(e, toggleGroup);
        });

        // 1. Enter key on nested action button must NOT toggle group and must NOT prevent default
        const buttonEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        button.dispatchEvent(buttonEnter);
        expect(toggled).toBe(false);
        expect(buttonEnter.defaultPrevented).toBe(false);

        // 2. Space key on nested action button must NOT toggle group and must NOT prevent default
        const buttonSpace = new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
        });
        button.dispatchEvent(buttonSpace);
        expect(toggled).toBe(false);
        expect(buttonSpace.defaultPrevented).toBe(false);

        // 3. Enter key on header itself MUST toggle group and prevent default
        const headerEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        headerDiv.dispatchEvent(headerEnter);
        expect(toggled).toBe(true);
        expect(headerEnter.defaultPrevented).toBe(true);

        // 4. Space key on header itself MUST toggle group and prevent default
        toggled = false;
        const headerSpace = new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
        });
        headerDiv.dispatchEvent(headerSpace);
        expect(toggled).toBe(true);
        expect(headerSpace.defaultPrevented).toBe(true);

        headerDiv.remove();
    });

    it('ContextMenu submenu supports keyboard focus navigation and activation', async () => {
        const itemAClick = vi.fn();
        const itemBClick = vi.fn();
        const onClose = vi.fn();

        const entries: MenuEntry[] = [
            {
                label: 'Parent With Submenu',
                submenu: [
                    { label: 'Item A', onClick: itemAClick },
                    { label: 'Item B', onClick: itemBClick },
                ],
            },
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(<ContextMenu x={100} y={100} entries={entries} onClose={onClose} />);
        });

        const menuEl = container.querySelector<HTMLDivElement>('.menu');
        expect(menuEl).toBeTruthy();

        // 1. Open submenu using ArrowRight on the parent item
        await act(async () => {
            menuEl?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'ArrowRight',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        const subMenuEl = container.querySelector<HTMLDivElement>('.menu.sub');
        expect(subMenuEl).toBeTruthy();

        // 2. Test closing via ArrowLeft closes only the submenu
        await act(async () => {
            subMenuEl?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'ArrowLeft',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        expect(container.querySelector('.menu.sub')).toBeNull();
        expect(container.querySelector('.menu')).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();

        // 3. Re-open submenu
        await act(async () => {
            menuEl?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'ArrowRight',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        const subMenuEl2 = container.querySelector<HTMLDivElement>('.menu.sub');
        expect(subMenuEl2).toBeTruthy();

        // Submenu initially has focusIdx at 0 (Item A).
        // Press ArrowDown to navigate to Item B (index 1).
        await act(async () => {
            subMenuEl2?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'ArrowDown',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        // Press Enter to activate Item B
        await act(async () => {
            subMenuEl2?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        expect(itemBClick).toHaveBeenCalled();
        expect(itemAClick).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('Preview restores DOM focus to .preview when exiting inline edit mode', async () => {
        vi.spyOn(api, 'getText').mockResolvedValue('Editable clip content');
        vi.spyOn(api, 'getFormats').mockResolvedValue([]);
        const onClose = vi.fn();

        const item: ClipRow = {
            id: 42,
            kind: 'text',
            preview: 'Editable clip content',
            title: 'Editable clip',
            tags: '',
            app_name: 'Notepad',
            app_exe: 'notepad.exe',
            lang: null,
            img_w: null,
            img_h: null,
            color: null,
            chars: 21,
            file_count: null,
            pinboard_id: null,
            pinned: false,
            sensitive: false,
            has_rich: false,
            ts: Date.now(),
            created_at: Date.now(),
            has_thumb: false,
            cut: false,
        };

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(
                <Preview
                    item={item}
                    startEdit={true}
                    startFormats={false}
                    richDefault={false}
                    autoSaveEdit={false}
                    query=""
                    searchMode="smart"
                    highlight={false}
                    onClose={onClose}
                    onPaste={vi.fn()}
                    onToast={vi.fn()}
                />
            );
        });

        // Wait for textarea to mount and acquire focus
        const textarea = container.querySelector<HTMLTextAreaElement>('textarea.editor');
        expect(textarea).toBeTruthy();
        expect(document.activeElement).toBe(textarea);

        // Escape out of editing mode
        await act(async () => {
            textarea?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        const previewEl = container.querySelector<HTMLDivElement>('.preview');
        expect(container.querySelector('textarea.editor')).toBeNull();
        expect(document.activeElement).toBe(previewEl);

        // Escape on .preview closes the preview
        await act(async () => {
            previewEl?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        expect(onClose).toHaveBeenCalled();

        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
    });

    it('ContextMenu restores DOM focus to .menu when SubMenu closes via hover', async () => {
        const siblingClick = vi.fn();
        const onClose = vi.fn();

        const entries: MenuEntry[] = [
            {
                label: 'Transform',
                submenu: [
                    { label: 'Upper', onClick: vi.fn() },
                    { label: 'Lower', onClick: vi.fn() },
                ],
            },
            {
                label: 'Sibling Item',
                onClick: siblingClick,
            },
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(<ContextMenu x={100} y={100} entries={entries} onClose={onClose} />);
        });

        const menuEl = container.querySelector<HTMLDivElement>('.menu');
        const items = container.querySelectorAll<HTMLDivElement>('.menu-item');
        expect(items.length).toBe(2);

        const triggerMouseEnter = (el: HTMLElement) => {
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        };

        // Hover over the first item (has submenu)
        await act(async () => {
            triggerMouseEnter(items[0]);
        });

        const subMenuEl = container.querySelector<HTMLDivElement>('.menu.sub');
        expect(subMenuEl).toBeTruthy();
        expect(document.activeElement).toBe(subMenuEl);

        // Hover over sibling item -> submenu closes, menu should regain focus
        await act(async () => {
            triggerMouseEnter(items[1]);
        });

        expect(container.querySelector('.menu.sub')).toBeNull();
        expect(document.activeElement).toBe(menuEl);

        // Press Enter on menu to activate the sibling item
        await act(async () => {
            menuEl?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });

        expect(siblingClick).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('CustomSelect applies scrollbar-gutter class only when searchable and stops Escape propagation', async () => {
        const onChange = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(
                <CustomSelect
                    value="compact"
                    onChange={onChange}
                    options={[
                        { value: 'compact', label: 'Compact' },
                        { value: 'comfortable', label: 'Comfortable' },
                    ]}
                />
            );
        });

        const trigger = container.querySelector<HTMLButtonElement>('.cselect-btn');
        expect(trigger).toBeTruthy();

        await act(async () => {
            trigger?.click();
        });

        const listEl = document.body.querySelector<HTMLDivElement>('.cselect-list');
        expect(listEl).toBeTruthy();
        expect(listEl?.classList.contains('searchable')).toBe(false);

        const bubbleEscape = vi.fn();
        window.addEventListener('keydown', bubbleEscape, false);
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        window.removeEventListener('keydown', bubbleEscape, false);
        expect(bubbleEscape).not.toHaveBeenCalled();

        await act(async () => {
            root.render(
                <CustomSelect
                    value="en"
                    onChange={onChange}
                    searchable
                    options={[
                        { value: 'en', label: 'English' },
                        { value: 'fa', label: 'فارسی', subLabel: 'Persian' },
                    ]}
                />
            );
        });

        await act(async () => {
            container.querySelector<HTMLButtonElement>('.cselect-btn')?.click();
        });

        const searchableList = document.body.querySelector<HTMLDivElement>('.cselect-list');
        expect(searchableList?.classList.contains('searchable')).toBe(true);

        const searchInput = document.body.querySelector<HTMLInputElement>('.cselect-search input');
        searchInput?.focus();
        await act(async () => {
            searchInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        });
        const searchableTrigger = container.querySelector<HTMLButtonElement>('.cselect-btn');
        expect(searchableTrigger?.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(searchableTrigger);

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('ColorPicker validates/converts HEX-HSL and renders custom trigger + popover without native color input', async () => {
        expect(isValidHex('#4f8cff')).toBe(true);
        expect(isValidHex('#fff')).toBe(false);
        expect(isValidHex('not-a-hex')).toBe(false);

        const hsl = hexToHsl('#4f8cff');
        expect(hsl.h).toBeGreaterThanOrEqual(210);
        expect(hsl.h).toBeLessThanOrEqual(230);
        expect(isValidHex(hslToHex(hsl.h, hsl.s, hsl.l))).toBe(true);

        const onChange = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(<ColorPicker value="#4f8cff" defaultValue="#4f8cff" onChange={onChange} />);
        });

        expect(container.querySelector('input[type="color"]')).toBeNull();
        const trigger = container.querySelector<HTMLButtonElement>('.cpicker-trigger');
        expect(trigger).toBeTruthy();
        expect(trigger?.textContent).toContain('#4F8CFF');

        await act(async () => {
            trigger?.click();
        });

        const popover = document.body.querySelector<HTMLDivElement>('.cpicker-popover');
        expect(popover).toBeTruthy();

        const ranges = popover?.querySelectorAll<HTMLInputElement>('input[type="range"]') ?? [];
        expect(ranges.length).toBe(3);
        ranges.forEach((r) => expect(r.getAttribute('dir')).toBe('ltr'));

        const emeraldBtn = popover?.querySelector<HTMLButtonElement>('button[aria-label="Emerald"]');
        await act(async () => {
            emeraldBtn?.click();
        });
        expect(onChange).toHaveBeenCalledWith('#10b981');

        await act(async () => {
            root.render(<ColorPicker value=" #10b981 " defaultValue="#4f8cff" onChange={onChange} />);
        });
        const resetBtn = document.body.querySelector<HTMLButtonElement>('.cpicker-reset');
        expect(resetBtn).toBeTruthy();
        await act(async () => {
            resetBtn?.click();
        });
        expect(onChange).toHaveBeenCalledWith('#4f8cff');

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });
});
