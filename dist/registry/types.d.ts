import type { ZodType } from 'zod';
import type { Capability } from '../capabilities.js';
export declare const NODE_TYPE_IDS: readonly ["discuss", "spec", "implement", "test", "validate", "review", "git-ops", "worktree-agent", "approval-gate"];
export type NodeTypeId = (typeof NODE_TYPE_IDS)[number];
/**
 * A built-in node type is defined by the triple (capability set, default role
 * prompt, output schema) plus its config schema. The capability set is what
 * makes types structurally different — it is compiled into enforced session
 * restrictions by the harness, never left as a prompt instruction.
 */
export interface NodeTypeDefinition {
    id: NodeTypeId;
    displayName: string;
    description: string;
    capabilities: readonly Capability[];
    /** False for Test (deterministic commands) and Approval-Gate (no session). */
    agentDriven: boolean;
    /**
     * True when the type holds at `waiting` and consumes user turns during its
     * session — Discuss and nothing else. Not a switch: it records which session
     * API the executor uses (`openInteractive` vs `run`), and a non-interactive
     * node is given no channel to block on, so it cannot wait for a user even if
     * its instructions tell it to.
     */
    interactive: boolean;
    /**
     * True when the type's config schema carries a single top-level `model`
     * field the run UI's model picker can read and write. False for every
     * `agentDriven: false` type, and also for Worktree-Agent: its `compare`
     * mode sets a model per fan-out instance, not once for the node, so there
     * is no single value for the picker to show or edit.
     */
    hasModelField: boolean;
    /** Default role prompt for agent-driven types; empty otherwise. */
    rolePrompt: string;
    configSchema: ZodType;
    outputSchema: ZodType;
    /** Human-readable one-line description of the config shape, for `node-types`. */
    configSummary: string;
    /** Human-readable one-line description of the output shape, for `node-types`. */
    outputSummary: string;
    /**
     * Predicate over this type's own validated output: when it holds, the node
     * ends in `error` rather than `done`. Lives on the type, never on an edge —
     * whether a node succeeded is knowledge the node type owns, and the graph
     * only routes the answer.
     */
    failsWhen?: (output: unknown) => boolean;
    /**
     * A context-transparent node forwards its own dependencies' outputs
     * alongside its recorded output, so inserting one into the graph does not
     * sever the context chain across it. Context stays bounded by fan-in.
     */
    contextTransparent?: boolean;
}
