/**
 * The key map, as data.
 *
 * The bottom hint line is one row and truncates on a narrow terminal, and a
 * docked panel replaces it outright — which is exactly when the most keys are
 * in play. So the full list lives here, is rendered into a panel by `?`, and
 * is the single place a keybinding is described: the hint line advertises the
 * handful you need to get started, this says what everything does.
 *
 * Pure and Ink-free so the list can be asserted against the handlers in
 * `App.tsx` without mounting a terminal.
 */

export type HelpRow =
  | { kind: 'title'; text: string }
  | { kind: 'binding'; keys: string; what: string }
  | { kind: 'blank' };

interface HelpSection {
  title: string;
  bindings: Array<[keys: string, what: string]>;
}

/**
 * Grouped by where you are when you press it, not alphabetically: someone
 * opening this is asking "what can I do from here", and the answer is a
 * property of the panel they're looking at.
 */
function sections(watch: boolean): HelpSection[] {
  return [
    {
      title: 'Canvas',
      bindings: [
        ['tab / ⇧tab', 'focus the next / previous node'],
        ['enter', "open the focused node's details (esc closes)"],
        ['←→↑↓', 'pan — add ⇧ to pan from inside any panel'],
        ['z', 'zoom: full ↔ compact cards'],
        ['o', 'overview (one row per node) and back'],
        ['c', 'camera: centre on the focused node ↔ leave it where it is'],
        ['w', 'wrap a wide graph into bands, or lay it flat'],
        ['q', 'quit'],
      ],
    },
    {
      title: watch ? 'The focused node — disabled while watching' : 'The focused node',
      bindings: [
        ['e', 'settings (token budget, instructions, …)'],
        ['m', 'model'],
        ['s', 'attach or detach skills'],
      ],
    },
    {
      title: 'Panels',
      bindings: [
        ['PgUp / PgDn', 'scroll the activity log, or a diff'],
        ['⇧PgUp / ⇧PgDn', "scroll the agent's output above it"],
        ['ctrl+p', 'dock a panel you dragged loose back to the bottom'],
        ['esc', 'close the panel, or cancel what you were typing'],
      ],
    },
    {
      title: 'When a node asks you something',
      bindings: [
        ['a / r', 'approval gate: approve / reject'],
        ['↑↓, enter', 'discussion: pick an offered answer — or just type one'],
        ['esc, /done', 'discussion: finish it — the agent writes up what was agreed'],
        ['space, a, d', 'test commands: select · add one · let flow-code find them'],
        ['space, enter', 'convergence: select branches · confirm'],
      ],
    },
    {
      title: 'Mouse',
      bindings: [
        ['click / drag', 'focus a card · move it'],
        ['click a badge', "open that node's model or skill picker"],
        ['wheel', 'pan — ⇧wheel sideways, ctrl+wheel zooms'],
        ['drag ⠿ or an edge', 'move a panel · drag ⇲ to resize it'],
      ],
    },
    {
      title: 'Anywhere you type',
      bindings: [
        ['ctrl+w', 'delete the word behind the cursor'],
        ['ctrl+u', 'clear the line'],
      ],
    },
  ];
}

/** The key map as renderable rows, blank-separated, in section order. */
export function helpRows(opts: { watch?: boolean } = {}): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const section of sections(opts.watch ?? false)) {
    if (rows.length > 0) rows.push({ kind: 'blank' });
    rows.push({ kind: 'title', text: section.title });
    for (const [keys, what] of section.bindings) rows.push({ kind: 'binding', keys, what });
  }
  return rows;
}

/**
 * Width of the key column, so every description starts at the same place —
 * measured from the rows actually being drawn rather than hardcoded, since
 * `watch` changes which of them there are.
 */
export function helpKeyWidth(rows: HelpRow[]): number {
  return rows.reduce((max, row) => (row.kind === 'binding' ? Math.max(max, row.keys.length) : max), 0);
}
