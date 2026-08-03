export declare class WorkflowWriteError extends Error {
    constructor(message: string);
}
/** Sets (or, with `model: null`, clears) one node's `config.model` in the workflow file on disk. */
export declare function setNodeModel(path: string, nodeId: string, model: string | null): void;
/** Sets (or, with an empty array, clears) one node's `config.skills` in the workflow file on disk. */
export declare function setNodeSkills(path: string, nodeId: string, skills: string[]): void;
