import { Box, Text, render, useInput } from 'ink';
import React, { useState } from 'react';

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
export function windowFor(
  cursor: number,
  total: number,
  windowSize: number,
): { start: number; end: number } {
  if (total <= windowSize) return { start: 0, end: total };
  const half = Math.floor(windowSize / 2);
  const start = Math.min(Math.max(0, cursor - half), total - windowSize);
  return { start, end: start + windowSize };
}

export function SelectList<T>({
  items,
  prompt,
  windowSize = 12,
  onSelect,
  onCancel,
}: SelectListProps<T>): React.ReactElement {
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
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % count);
    } else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.value);
    }
  });

  const { start, end } = windowFor(cursor, count, windowSize);
  const visible = items.slice(start, end);

  return (
    <Box flexDirection="column">
      <Text>{prompt}</Text>
      {start > 0 && <Text dimColor>  ↑ {start} more above</Text>}
      {visible.map((item, i) => {
        const idx = start + i;
        const selected = idx === cursor;
        return (
          <Text key={idx} {...(selected ? { color: 'cyan' } : {})} bold={selected}>
            {selected ? '❯ ' : '  '}
            {item.label}
          </Text>
        );
      })}
      {end < count && <Text dimColor>  ↓ {count - end} more below</Text>}
    </Box>
  );
}

/** Mounts a SelectList and resolves with the chosen value, or undefined on cancel. */
export function selectFromList<T>(
  items: SelectListItem<T>[],
  opts: { prompt: string; windowSize?: number },
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(SelectList<T>, {
        items,
        prompt: opts.prompt,
        ...(opts.windowSize !== undefined ? { windowSize: opts.windowSize } : {}),
        onSelect: (value: T) => {
          instance.unmount();
          resolve(value);
        },
        onCancel: () => {
          instance.unmount();
          resolve(undefined);
        },
      }),
      { exitOnCtrlC: false },
    );
  });
}
