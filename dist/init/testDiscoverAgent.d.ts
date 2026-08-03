import type { SessionRunner } from '../engine/types.js';
/** One command the agent believes runs this project's tests, and why. */
export interface TestCommandProposal {
    command: string;
    /** One line naming what in the repo this was derived from. */
    rationale: string;
}
/**
 * The `read`-only agent fallback for test-command detection.
 *
 * It proposes, it never decides: nothing here is executed, and nothing reaches
 * the workflow file without the user accepting it first. That matters more
 * than usual because the Test node runs its commands through `sh -c` outside
 * the capability harness — an unreviewed command string there is not sandboxed
 * by anything.
 */
export declare function discoverTestCommandsWithAgent(opts: {
    repoRoot: string;
    sessions: SessionRunner;
    model?: string;
}): Promise<TestCommandProposal[]>;
