/**
 * The tiny predicate language behind an edge's `when:`.
 *
 * One condition per edge, of the form `<nodeId>.<path> <op> [<literal>]` —
 * deliberately not an expression language. There is no `eval`, no user
 * function call, and no boolean combinator: an edge answers exactly one
 * question about exactly one upstream node's recorded output, and a workflow
 * that needs "A and B" says so with two edges. Anything richer would put
 * program logic in a file whose whole value is being readable at a glance.
 *
 * Parsing happens at load time, so a typo is a workflow validation error
 * rather than an edge that silently never fires.
 */

export const BINARY_OPERATORS = ['==', '!=', '>=', '<=', '>', '<', 'contains'] as const;
export const UNARY_OPERATORS = ['isEmpty', 'isNotEmpty'] as const;

export type BinaryOperator = (typeof BINARY_OPERATORS)[number];
export type UnaryOperator = (typeof UNARY_OPERATORS)[number];

export type ConditionLiteral = string | number | boolean | null;

export interface Condition {
  /** The node whose recorded output the condition reads. */
  nodeId: string;
  /** Dot path into that output; `length` is understood on arrays and strings. */
  path: string[];
  operator: BinaryOperator | UnaryOperator;
  /** Absent for a unary operator. */
  value?: ConditionLiteral;
  /** The original text, for error messages and for rendering the edge. */
  source: string;
}

export class ConditionParseError extends Error {}

const REFERENCE = /^([A-Za-z0-9][A-Za-z0-9_-]*)((?:\.[A-Za-z0-9_]+)*)$/;

function parseLiteral(text: string): ConditionLiteral {
  if (
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2) ||
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  const asNumber = Number(text);
  if (text.length > 0 && !Number.isNaN(asNumber)) return asNumber;
  throw new ConditionParseError(
    `\`${text}\` is not a valid value — use a quoted string, a number, true, false, or null`,
  );
}

/**
 * `implement.changedFiles isNotEmpty`, `review.verdict == 'fail'`,
 * `review.findings.length > 0`.
 */
export function parseCondition(source: string): Condition {
  const text = source.trim();
  if (text.length === 0) throw new ConditionParseError('condition is empty');

  const unary = UNARY_OPERATORS.find((candidate) => text.endsWith(` ${candidate}`));
  if (unary) {
    const reference = text.slice(0, text.length - unary.length - 1).trim();
    return { ...parseReference(reference, source), operator: unary, source: text };
  }

  // Longest operator first, so `>=` is never read as a bare `>`.
  for (const operator of BINARY_OPERATORS) {
    // `contains` is a word and needs spaces around it; the symbolic operators
    // are punctuation and may sit flush against their operands.
    const needle = operator === 'contains' ? ` ${operator} ` : operator;
    const index = indexOfOutsideQuotes(text, needle);
    if (index < 0) continue;
    const lhs = text.slice(0, index).trim();
    const rhs = text.slice(index + needle.length).trim();
    if (lhs.length === 0) throw new ConditionParseError(`nothing to compare before \`${operator}\``);
    if (rhs.length === 0) throw new ConditionParseError(`nothing to compare after \`${operator}\``);
    return { ...parseReference(lhs, source), operator, value: parseLiteral(rhs), source: text };
  }

  throw new ConditionParseError(
    `no operator found — expected one of ${[...BINARY_OPERATORS, ...UNARY_OPERATORS]
      .map((o) => `\`${o}\``)
      .join(', ')}`,
  );
}

/**
 * Operator search that ignores quoted text, so `notes contains '>='` compares
 * against the string rather than splitting on the operator inside it.
 */
function indexOfOutsideQuotes(text: string, needle: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

function parseReference(text: string, source: string): { nodeId: string; path: string[] } {
  const match = REFERENCE.exec(text);
  if (!match) {
    throw new ConditionParseError(
      `\`${text}\` is not a \`<node>.<field>\` reference (in \`${source}\`)`,
    );
  }
  const [, nodeId, rest] = match;
  const path = (rest ?? '').split('.').filter((segment) => segment.length > 0);
  return { nodeId: nodeId!, path };
}

/** Walk a dot path into a recorded output, understanding `.length`. */
export function resolvePath(output: unknown, path: string[]): unknown {
  let current: unknown = output;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (segment === 'length' && (Array.isArray(current) || typeof current === 'string')) {
      current = current.length;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Evaluate against the referenced node's recorded output. A path that does not
 * exist reads as `undefined` rather than throwing: an edge condition is a
 * routing question, and "the field isn't there" is a legitimate answer to it
 * (`isEmpty` holds, every comparison fails).
 */
export function evaluateCondition(condition: Condition, output: unknown): boolean {
  const actual = resolvePath(output, condition.path);

  switch (condition.operator) {
    case 'isEmpty':
      return isEmptyValue(actual);
    case 'isNotEmpty':
      return !isEmptyValue(actual);
    case '==':
      // A `null` literal matches an absent field too — "no value" is one idea
      // to anyone writing a workflow, not two.
      return condition.value === null ? actual === null || actual === undefined : actual === condition.value;
    case '!=':
      return condition.value === null
        ? !(actual === null || actual === undefined)
        : actual !== condition.value;
    case 'contains': {
      if (Array.isArray(actual)) return actual.includes(condition.value);
      if (typeof actual === 'string' && typeof condition.value === 'string') {
        return actual.includes(condition.value);
      }
      return false;
    }
    default: {
      // Ordering comparisons are numeric; anything else is not ordered, and
      // guessing an order for it would make a workflow behave arbitrarily.
      if (typeof actual !== 'number' || typeof condition.value !== 'number') return false;
      switch (condition.operator) {
        case '>':
          return actual > condition.value;
        case '<':
          return actual < condition.value;
        case '>=':
          return actual >= condition.value;
        case '<=':
          return actual <= condition.value;
      }
      return false;
    }
  }
}
