import { describe, expect, it } from 'vitest';
import { parseInline, renderMarkdown, renderPlain, type MdLine } from '../src/ui/markdown.js';

/** The visible text of a rendered line, markers and all styling stripped. */
function textOf(line: MdLine): string {
  return line.segments.map((s) => s.text).join('');
}

function textsOf(lines: MdLine[]): string[] {
  return lines.map(textOf);
}

describe('parseInline', () => {
  it('styles bold, italic and strikethrough without leaking their markers', () => {
    expect(parseInline('a **b** c *d* e ~~f~~')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c ' },
      { text: 'd', italic: true },
      { text: ' e ' },
      { text: 'f', strikethrough: true },
    ]);
  });

  it('colours code spans and leaves their contents verbatim', () => {
    const segments = parseInline('call `a_b_c(**x**)` now');
    expect(segments[1]).toEqual({ text: 'a_b_c(**x**)', color: 'yellow' });
  });

  it('underlines a link label and trails the target dimmed', () => {
    expect(parseInline('[docs](https://x.dev)')).toEqual([
      { text: 'docs', underline: true },
      { text: ' (https://x.dev)', dimColor: true },
    ]);
  });

  it('nests styles rather than dropping the outer one', () => {
    expect(parseInline('**bold and _also italic_**')).toEqual([
      { text: 'bold and ', bold: true },
      { text: 'also italic', bold: true, italic: true },
    ]);
  });

  it('leaves a lone asterisk alone', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }]);
  });
});

describe('renderMarkdown', () => {
  it('renders headings bold, without the hashes', () => {
    const [line] = renderMarkdown('## Plan', 40);
    expect(textOf(line!)).toBe('Plan');
    expect(line!.segments[0]).toMatchObject({ bold: true });
  });

  it('turns list markers into bullets and hangs continuation lines under the text', () => {
    expect(textsOf(renderMarkdown('- one two three four five', 12))).toEqual([
      '• one two',
      '  three four',
      '  five',
    ]);
  });

  it('numbers ordered lists and indents continuations to match', () => {
    expect(textsOf(renderMarkdown('1. alpha beta gamma', 12))).toEqual(['1. alpha', '   beta', '   gamma']);
  });

  it('preserves nested list indentation', () => {
    expect(textsOf(renderMarkdown('  - nested', 40))).toEqual(['  • nested']);
  });

  it('drops fence delimiters and keeps code lines verbatim', () => {
    const lines = renderMarkdown('text\n```ts\nconst a = 1;\n```\nafter', 40);
    expect(textsOf(lines)).toEqual(['text', '  const a = 1;', 'after']);
    expect(lines[1]!.segments[1]).toMatchObject({ color: 'yellow' });
  });

  it('does not word-wrap code: it hard-chunks so alignment survives', () => {
    expect(textsOf(renderMarkdown('```\nab cd ef gh\n```', 8))).toEqual(['  ab cd ', '  ef gh']);
  });

  it('renders a horizontal rule at the full width', () => {
    expect(textOf(renderMarkdown('---', 10)[0]!)).toBe('─'.repeat(10));
  });

  it('marks block quotes with a bar', () => {
    expect(textsOf(renderMarkdown('> quoted', 40))).toEqual(['│ quoted']);
  });

  it('keeps blank lines as paragraph breaks', () => {
    expect(textsOf(renderMarkdown('a\n\nb', 40))).toEqual(['a', '', 'b']);
  });

  it('never emits a line wider than the width', () => {
    const text =
      '# A heading that is quite long indeed\n\n' +
      '- a bullet with **bold** and `code` and a [link](https://example.com/very/long/path)\n' +
      '> a quoted sentence that also runs on for a while\n' +
      'https://example.com/an/extremely/long/url/that/cannot/be/broken/on/a/space';
    for (const width of [12, 20, 33, 80]) {
      for (const line of renderMarkdown(text, width)) {
        expect(textOf(line).length, `width ${width}: ${textOf(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('never breaks a word where a style changes', () => {
    // `**bold**able` is one word; wrapping must not split it into two lines.
    expect(textsOf(renderMarkdown('xx **bold**able', 12))).toEqual(['xx boldable']);
  });

  it('expands tabs in code, where they are columns a terminal draws and not collapsible space', () => {
    expect(textsOf(renderMarkdown('```\nif x:\n\treturn 1\n```', 40))).toEqual([
      '  if x:',
      '      return 1',
    ]);
  });

  it('falls through to plain text rather than dropping unrecognised syntax', () => {
    expect(textsOf(renderMarkdown('| a | b |', 40))).toEqual(['| a | b |']);
  });
});

describe('renderPlain', () => {
  it('leaves markdown markers as the literal characters the user typed', () => {
    expect(textsOf(renderPlain('use **stars** here', 40))).toEqual(['use **stars** here']);
    expect(renderPlain('use **stars** here', 40)[0]!.segments[0]).toEqual({
      text: 'use **stars** here',
    });
  });

  it('wraps to the width and keeps blank lines', () => {
    expect(textsOf(renderPlain('one two three\n\nfour', 8))).toEqual(['one two', 'three', '', 'four']);
  });
});
