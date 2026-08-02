export declare class WorkflowWriteError extends Error {
    constructor(message: string);
}
/**
 * Sets (or, with `model: null`, clears) one node's `config.model` in the
 * workflow file on disk, preserving every comment, blank line, and key order
 * the `yaml` package's Document AST can carry across an edit — this file is
 * checked in and hand-edited, so a writer that re-emits it from a parsed
 * object would destroy that on the first save.
 *
 * Known gap: a comment block at the very end of a sequence with no node
 * after it (a "dangling" comment, e.g. the commented-out loop-back example
 * at the end of the scaffolded workflow) loses the blank line that used to
 * separate it from the preceding item — a `yaml` limitation, not something
 * this function works around. Every other comment, including ones attached
 * to a node or a key, round-trips untouched.
 *
 * Re-reads the file fresh rather than working from a document parsed earlier
 * in the run, so an edit made outside the UI while the run was live isn't
 * clobbered. The result is re-validated as a workflow before anything is
 * written; on any failure the file on disk is untouched.
 */
export declare function setNodeModel(path: string, nodeId: string, model: string | null): void;
