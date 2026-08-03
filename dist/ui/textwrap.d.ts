/**
 * Truncate to `width`, marking the cut with an ellipsis. A bare `slice` is
 * what node cards used to do, and it reads as a rendering bug rather than as
 * elided text — `3 acceptance criteri` looks broken in a way `3 acceptance…`
 * does not.
 */
export declare function fitText(text: string, width: number): string;
/** Greedy word-wrap, preserving existing newlines as paragraph breaks. */
export declare function wrapText(text: string, width: number): string[];
