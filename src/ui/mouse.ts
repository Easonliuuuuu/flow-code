/**
 * SGR (1006) mouse protocol support. Mouse is an enhancement layer only:
 * terminals that never send these sequences simply never produce events,
 * and every interaction stays fully keyboard-operable.
 */

export interface MouseEvent {
  kind: 'press' | 'drag' | 'release' | 'scroll';
  /** 0-based cell coordinates. */
  x: number;
  y: number;
  button: number;
  /** Ctrl held. Distinguishes zooming from panning on the wheel. */
  ctrl: boolean;
  /** Shift held. On the wheel, turns a vertical scroll into a sideways one. */
  shift: boolean;
  /**
   * Only set when kind is 'scroll'. A trackpad's sideways swipe (and a tilt
   * wheel) arrives as its own pair of button codes rather than as a modifier,
   * so the axis is part of the direction rather than something the reader has
   * to infer.
   */
  direction?: 'up' | 'down' | 'left' | 'right';
}

const ENABLE = '\x1b[?1002h\x1b[?1006h';
const DISABLE = '\x1b[?1002l\x1b[?1006l';

export function enableMouse(stdout: NodeJS.WriteStream): void {
  stdout.write(ENABLE);
}

export function disableMouse(stdout: NodeJS.WriteStream): void {
  stdout.write(DISABLE);
}

const SGR_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Bit 6 of the SGR button code marks wheel events (button numbers 64-67). */
const WHEEL_BIT = 64;

/**
 * The four wheel button codes, in order: 64 up, 65 down, 66 left, 67 right.
 * The last two are what a trackpad's sideways swipe and a tilt wheel emit;
 * read as a plain vertical pair (`code & 1`) they land as spurious up/down
 * scrolls, which is a canvas that drifts vertically when you swipe sideways.
 */
const WHEEL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

/**
 * Modifier bits the terminal ORs into the button code: 4 shift, 8 meta, 16
 * ctrl. Ctrl separates a zoom from a pan on the wheel; shift turns a vertical
 * scroll sideways, the same as it does in a browser — for terminals that
 * report modifiers on the wheel but have no sideways wheel of their own. Note
 * that several terminals (iTerm2, GNOME Terminal, Windows Terminal) bind
 * ctrl+wheel to their own font sizing and never forward these, which is why
 * zoom stays reachable from the keyboard as well.
 */
const CTRL_BIT = 16;
const SHIFT_BIT = 4;

/** Matches a bare SGR mouse sequence once ink has stripped its leading ESC. */
export const LEAKED_MOUSE_SEQUENCE = /^\[<\d+;\d+;\d+[Mm]$/;

export function parseMouseEvents(data: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of data.matchAll(SGR_PATTERN)) {
    const code = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    const release = match[4] === 'm';
    const ctrl = (code & CTRL_BIT) !== 0;
    const shift = (code & SHIFT_BIT) !== 0;
    if ((code & WHEEL_BIT) !== 0) {
      const button = code & 0b11;
      // `button` is masked to 0-3, which indexes WHEEL_DIRECTIONS exactly.
      events.push({ kind: 'scroll', x, y, button, ctrl, shift, direction: WHEEL_DIRECTIONS[button]! });
      continue;
    }
    const button = code & 0b11;
    const motion = (code & 32) !== 0;
    events.push({ kind: release ? 'release' : motion ? 'drag' : 'press', x, y, button, ctrl, shift });
  }
  return events;
}
