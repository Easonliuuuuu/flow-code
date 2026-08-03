export declare class WorkflowWriteError extends Error {
    constructor(message: string);
}
/** Sets (or, with `model: null`, clears) one node's `config.model` in the workflow file on disk. */
export declare function setNodeModel(path: string, nodeId: string, model: string | null): void;
/**
 * Sets (or, with `value: null`, clears) one arbitrary string field of a
 * node's config. The editable set is decided by `editableFields` in the UI,
 * not here — this writer only has to put a string where it was asked to.
 */
export declare function setNodeConfigString(path: string, nodeId: string, field: string, value: string | null): void;
/**
 * Sets (or, with `tokens: null`, clears) one node's own token ceiling. The
 * budget is a sibling of `config`, so it can't go through `clearConfigField`.
 */
export declare function setNodeBudgetTokens(path: string, nodeId: string, tokens: number | null): void;
/**
 * Writes the command list a Test node runs. Used when a node reaches
 * execution still carrying the scaffolded placeholder and the user says what
 * it should run instead — the answer is kept so the question is asked once
 * per project rather than once per run.
 */
export declare function setNodeTestCommands(path: string, nodeId: string, commands: string[]): void;
/** Sets (or, with an empty array, clears) one node's `config.skills` in the workflow file on disk. */
export declare function setNodeSkills(path: string, nodeId: string, skills: string[]): void;
