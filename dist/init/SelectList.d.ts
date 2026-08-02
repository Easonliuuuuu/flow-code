import React from 'react';
export interface SelectListItem<T> {
    label: string;
    value: T;
}
export interface SelectListProps<T> {
    items: SelectListItem<T>[];
    prompt: string;
    /** How many rows to show at once. Defaults to 12 — long lists (OpenRouter) scroll. */
    windowSize?: number;
    onSelect: (value: T) => void;
    onCancel: () => void;
}
/**
 * Computes the visible slice `[start, end)` of a list given the cursor
 * position, keeping the cursor centered where possible and clamping to the
 * list's bounds. Exported standalone so the scrolling math is unit-testable
 * without mounting Ink.
 */
export declare function windowFor(cursor: number, total: number, windowSize: number): {
    start: number;
    end: number;
};
export declare function SelectList<T>({ items, prompt, windowSize, onSelect, onCancel, }: SelectListProps<T>): React.ReactElement;
/** Mounts a SelectList and resolves with the chosen value, or undefined on cancel. */
export declare function selectFromList<T>(items: SelectListItem<T>[], opts: {
    prompt: string;
    windowSize?: number;
}): Promise<T | undefined>;
