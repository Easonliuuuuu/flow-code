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
export declare const BINARY_OPERATORS: readonly ["==", "!=", ">=", "<=", ">", "<", "contains"];
export declare const UNARY_OPERATORS: readonly ["isEmpty", "isNotEmpty"];
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
export declare class ConditionParseError extends Error {
}
/**
 * `implement.changedFiles isNotEmpty`, `review.verdict == 'fail'`,
 * `review.findings.length > 0`.
 */
export declare function parseCondition(source: string): Condition;
/** Walk a dot path into a recorded output, understanding `.length`. */
export declare function resolvePath(output: unknown, path: string[]): unknown;
/**
 * Evaluate against the referenced node's recorded output. A path that does not
 * exist reads as `undefined` rather than throwing: an edge condition is a
 * routing question, and "the field isn't there" is a legitimate answer to it
 * (`isEmpty` holds, every comparison fails).
 */
export declare function evaluateCondition(condition: Condition, output: unknown): boolean;
