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
    /** Only set when kind is 'scroll'. */
    direction?: 'up' | 'down';
}
export declare function enableMouse(stdout: NodeJS.WriteStream): void;
export declare function disableMouse(stdout: NodeJS.WriteStream): void;
/** Matches a bare SGR mouse sequence once ink has stripped its leading ESC. */
export declare const LEAKED_MOUSE_SEQUENCE: RegExp;
export declare function parseMouseEvents(data: string): MouseEvent[];
