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
const CODE_COLOR = 'yellow';
const MARKER_COLOR = 'cyan';
/** Style props only, for spreading onto an Ink `<Text>`. */
export function segmentStyle(segment) {
    const { text: _text, ...style } = segment;
    return style;
}
const STYLE_KEYS = [
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'dimColor',
    'color',
];
function sameStyle(a, b) {
    return STYLE_KEYS.every((k) => a[k] === b[k]);
}
/** Appends text, merging into the previous segment when the style is identical. */
function push(segments, text, style) {
    if (text.length === 0)
        return;
    const last = segments.at(-1);
    if (last && sameStyle(segmentStyle(last), style))
        last.text += text;
    else
        segments.push({ text, ...style });
}
// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
/**
 * Emphasis, code spans, strikethrough and links within one block's text.
 * Code spans are matched first and consume their contents verbatim, so
 * `` `a_b_c` `` does not come back italicised.
 */
export function parseInline(text, base = {}) {
    const segments = [];
    let plain = '';
    let i = 0;
    const flush = () => {
        push(segments, plain, base);
        plain = '';
    };
    const nested = (inner, style) => {
        for (const seg of parseInline(inner, style))
            push(segments, seg.text, segmentStyle(seg));
    };
    while (i < text.length) {
        const rest = text.slice(i);
        // Code span: `code`, or ``code containing a ` `` .
        const code = /^(`+)([\s\S]*?)\1/.exec(rest);
        if (code) {
            flush();
            push(segments, code[2], { ...base, color: CODE_COLOR });
            i += code[0].length;
            continue;
        }
        // Link: the label carries the emphasis, the target trails it dimmed.
        const link = /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
        if (link) {
            flush();
            nested(link[1], { ...base, underline: true });
            push(segments, ` (${link[2]})`, { ...base, dimColor: true });
            i += link[0].length;
            continue;
        }
        const strike = /^~~(?=\S)([\s\S]+?)~~/.exec(rest);
        if (strike) {
            flush();
            nested(strike[1], { ...base, strikethrough: true });
            i += strike[0].length;
            continue;
        }
        const strong = /^(\*\*|__)(?=\S)([\s\S]+?)\1/.exec(rest);
        if (strong) {
            flush();
            nested(strong[2], { ...base, bold: true });
            i += strong[0].length;
            continue;
        }
        const em = /^(\*|_)(?=\S)([\s\S]+?)\1/.exec(rest);
        if (em) {
            flush();
            nested(em[2], { ...base, italic: true });
            i += em[0].length;
            continue;
        }
        plain += text[i];
        i++;
    }
    flush();
    return segments;
}
/**
 * Splits styled segments into space-delimited tokens. Only whitespace ends a
 * token — a style change does not, or emphasis butted against a word would let
 * the wrapper break inside that word.
 */
function tokenize(segments) {
    const tokens = [];
    let current = null;
    for (const segment of segments) {
        const style = segmentStyle(segment);
        for (const [idx, part] of segment.text.split(/ +/).entries()) {
            if (idx > 0)
                current = null; // a space separated this part from the last
            if (part.length === 0)
                continue;
            if (!current) {
                current = { segments: [], length: 0 };
                tokens.push(current);
            }
            push(current.segments, part, style);
            current.length += part.length;
        }
    }
    return tokens;
}
/**
 * Greedy word wrap over styled tokens. `prefix` is drawn on the first line (a
 * bullet, a quote bar) and `indent` — the same display width — on the rest, so
 * continuation lines hang under the text rather than under the marker.
 */
function wrapSegments(segments, width, prefix, indent) {
    const inner = Math.max(1, width - (prefix?.text.length ?? 0));
    const lines = [];
    let current = [];
    let length = 0;
    const emit = () => {
        lines.push({ segments: current });
        current = [];
        length = 0;
    };
    const append = (token) => {
        for (const seg of token.segments)
            push(current, seg.text, segmentStyle(seg));
        length += token.length;
    };
    for (const token of tokenize(segments)) {
        // A token wider than the line (a URL, a long path) is hard-split rather
        // than left to overflow the panel.
        if (token.length > inner) {
            if (length > 0)
                emit();
            for (const seg of token.segments) {
                const style = segmentStyle(seg);
                let text = seg.text;
                while (text.length > 0) {
                    const room = inner - length;
                    push(current, text.slice(0, room), style);
                    length += Math.min(room, text.length);
                    text = text.slice(room);
                    if (length >= inner)
                        emit();
                }
            }
            continue;
        }
        if (length === 0) {
            append(token);
        }
        else if (length + 1 + token.length <= inner) {
            push(current, ' ', {});
            length += 1;
            append(token);
        }
        else {
            emit();
            append(token);
        }
    }
    if (current.length > 0 || lines.length === 0)
        emit();
    return lines.map((line, idx) => {
        if (idx === 0 && prefix)
            return { segments: [prefix, ...line.segments] };
        if (idx > 0 && indent.length > 0)
            return { segments: [{ text: indent }, ...line.segments] };
        return line;
    });
}
/** Code is not prose: hard-chunk it so indentation and alignment survive. */
function chunk(text, width, style, indent) {
    const inner = Math.max(1, width - indent.length);
    const lines = [];
    let rest = text;
    do {
        lines.push({ segments: [{ text: indent }, { text: rest.slice(0, inner), ...style }] });
        rest = rest.slice(inner);
    } while (rest.length > 0);
    return lines;
}
// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
/** Terminals render a tab as several columns; wrapping has to count them the same way. */
function expandTabs(text) {
    return text.replace(/\t/g, '    ');
}
/**
 * Renders markdown as styled lines, each already no wider than `width`.
 * Unrecognised syntax falls through to a plain paragraph, so nothing is ever
 * dropped from the transcript.
 */
export function renderMarkdown(text, width) {
    const w = Math.max(4, width);
    const lines = [];
    let inFence = false;
    for (const raw of expandTabs(text).split('\n')) {
        if (FENCE.test(raw)) {
            // The delimiter itself carries no content worth a transcript row.
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            lines.push(...chunk(raw, w, { color: CODE_COLOR, dimColor: true }, '  '));
            continue;
        }
        if (raw.trim().length === 0) {
            lines.push({ segments: [] });
            continue;
        }
        const heading = HEADING.exec(raw);
        if (heading) {
            lines.push(...wrapSegments(parseInline(heading[2], { bold: true, color: MARKER_COLOR }), w, null, ''));
            continue;
        }
        if (RULE.test(raw)) {
            lines.push({ segments: [{ text: '─'.repeat(w), dimColor: true }] });
            continue;
        }
        const quote = QUOTE.exec(raw);
        if (quote) {
            lines.push(...wrapSegments(parseInline(quote[1], { dimColor: true }), w, { text: '│ ', dimColor: true }, '│ '));
            continue;
        }
        const bullet = BULLET.exec(raw);
        if (bullet) {
            const pad = bullet[1];
            lines.push(...wrapSegments(parseInline(bullet[2]), w, { text: `${pad}• `, color: MARKER_COLOR }, `${pad}  `));
            continue;
        }
        const ordered = ORDERED.exec(raw);
        if (ordered) {
            const marker = `${ordered[1]}${ordered[2]}. `;
            lines.push(...wrapSegments(parseInline(ordered[3]), w, { text: marker, color: MARKER_COLOR }, ' '.repeat(marker.length)));
            continue;
        }
        lines.push(...wrapSegments(parseInline(raw.trim()), w, null, ''));
    }
    return lines;
}
/** Plain text (the user's own messages) as wrapped, unstyled lines. */
export function renderPlain(text, width) {
    const w = Math.max(4, width);
    return expandTabs(text)
        .split('\n')
        .flatMap((line) => line.length === 0 ? [{ segments: [] }] : wrapSegments([{ text: line }], w, null, ''));
}
//# sourceMappingURL=markdown.js.map