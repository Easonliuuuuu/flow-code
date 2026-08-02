import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, render, useInput } from 'ink';
import React, { useState } from 'react';
/**
 * Computes the visible slice `[start, end)` of a list given the cursor
 * position, keeping the cursor centered where possible and clamping to the
 * list's bounds. Exported standalone so the scrolling math is unit-testable
 * without mounting Ink.
 */
export function windowFor(cursor, total, windowSize) {
    if (total <= windowSize)
        return { start: 0, end: total };
    const half = Math.floor(windowSize / 2);
    const start = Math.min(Math.max(0, cursor - half), total - windowSize);
    return { start, end: start + windowSize };
}
export function SelectList({ items, prompt, windowSize = 12, onSelect, onCancel, }) {
    const [cursor, setCursor] = useState(0);
    const count = items.length;
    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            onCancel();
            return;
        }
        if (key.escape) {
            onCancel();
            return;
        }
        if (key.upArrow || input === 'k') {
            setCursor((c) => (c + count - 1) % count);
        }
        else if (key.downArrow || input === 'j') {
            setCursor((c) => (c + 1) % count);
        }
        else if (key.return) {
            const item = items[cursor];
            if (item)
                onSelect(item.value);
        }
    });
    const { start, end } = windowFor(cursor, count, windowSize);
    const visible = items.slice(start, end);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: prompt }), start > 0 && _jsxs(Text, { dimColor: true, children: ["  \u2191 ", start, " more above"] }), visible.map((item, i) => {
                const idx = start + i;
                const selected = idx === cursor;
                return (_jsxs(Text, { ...(selected ? { color: 'cyan' } : {}), bold: selected, children: [selected ? '❯ ' : '  ', item.label] }, idx));
            }), end < count && _jsxs(Text, { dimColor: true, children: ["  \u2193 ", count - end, " more below"] })] }));
}
/** Mounts a SelectList and resolves with the chosen value, or undefined on cancel. */
export function selectFromList(items, opts) {
    return new Promise((resolve) => {
        const instance = render(React.createElement((SelectList), {
            items,
            prompt: opts.prompt,
            ...(opts.windowSize !== undefined ? { windowSize: opts.windowSize } : {}),
            onSelect: (value) => {
                instance.unmount();
                resolve(value);
            },
            onCancel: () => {
                instance.unmount();
                resolve(undefined);
            },
        }), { exitOnCtrlC: false });
    });
}
//# sourceMappingURL=SelectList.js.map