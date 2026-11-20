// @vitest-environment jsdom
// @ts-expect-error global flag for react act
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, MenuEntry } from '../popup/Overlays';
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
});
