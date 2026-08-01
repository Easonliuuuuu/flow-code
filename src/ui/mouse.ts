/**
 * SGR (1006) mouse protocol support. Mouse is an enhancement layer only:
 * terminals that never send these sequences simply never produce events,
 * and every interaction stays fully keyboard-operable.
 */

export interface MouseEvent {
  kind: 'press' | 'drag' | 'release';
  /** 0-based cell coordinates. */
  x: number;
  y: number;
  button: number;
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

export function parseMouseEvents(data: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of data.matchAll(SGR_PATTERN)) {
    const code = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    const release = match[4] === 'm';
    const button = code & 0b11;
    const motion = (code & 32) !== 0;
    events.push({ kind: release ? 'release' : motion ? 'drag' : 'press', x, y, button });
  }
  return events;
}
