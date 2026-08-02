/**
 * Shell-command classification for the interception check.
 *
 * Honest limit (see design.md): this is a guardrail against a well-intentioned
 * agent, not a sandbox against a hostile one — `eval`, exotic quoting, or
 * writing-then-running a script can defeat string inspection. The env-scoped
 * pushurl block underneath is the defense in depth.
 */
export type SegmentKind = 'non-git' | 'git-read' | 'git-write';
export interface CommandSegment {
    text: string;
    kind: SegmentKind;
}
/**
 * Tokenize one command segment into words, respecting single/double quotes.
 * Quote characters are stripped; escapes are handled naively.
 */
export declare function tokenize(segment: string): string[];
/**
 * Split a shell command into simple-command segments: on `&&`, `||`, `;`,
 * `|`, `&`, and newlines, plus the contents of `$(...)` and backticks
 * (which execute even inside double quotes).
 */
export declare function splitSegments(command: string): string[];
/** Classify every simple-command segment of a shell command string. */
export declare function classifyCommand(command: string): CommandSegment[];
