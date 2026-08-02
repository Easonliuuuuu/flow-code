/**
 * Minimal markdown → styled terminal lines, for the Discuss transcript.
 *
 * Agents answer in markdown whether or not you ask them to, so a transcript
 * that renders it as literal text is showing the user `**this**` instead of
 * emphasis. This covers the subset agents actually emit — headings, lists,
 * fenced and inline code, emphasis, block quotes, rules, links — and leaves
 * anything else as plain text rather than guessing.
 *
 * Output is already wrapped to `width`: styling and wrapping cannot be done
 * independently, because a wrapper that sees only a string would break
 * `**bold text**` in the middle of its markers.
 */
/** A run of text sharing one set of Ink `<Text>` style props. */
export interface MdSegment {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    dimColor?: boolean;
    color?: string;
}
export interface MdLine {
    segments: MdSegment[];
}
type Style = Omit<MdSegment, 'text'>;
/** Style props only, for spreading onto an Ink `<Text>`. */
export declare function segmentStyle(segment: MdSegment): Style;
/**
 * Emphasis, code spans, strikethrough and links within one block's text.
 * Code spans are matched first and consume their contents verbatim, so
 * `` `a_b_c` `` does not come back italicised.
 */
export declare function parseInline(text: string, base?: Style): MdSegment[];
/**
 * Renders markdown as styled lines, each already no wider than `width`.
 * Unrecognised syntax falls through to a plain paragraph, so nothing is ever
 * dropped from the transcript.
 */
export declare function renderMarkdown(text: string, width: number): MdLine[];
/** Plain text (the user's own messages) as wrapped, unstyled lines. */
export declare function renderPlain(text: string, width: number): MdLine[];
export {};
