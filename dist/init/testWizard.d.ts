import type { SessionRunner } from '../engine/types.js';
export interface TestSetupOptions {
    /**
     * The configured provider's runner, used only for the fallback. Absent when
     * no provider is configured, which skips the fallback rather than failing —
     * `init` still has to finish.
     */
    sessions?: SessionRunner;
    model?: string;
}
/** Writes `commands` into the `test` node's config, preserving the rest of the file (comments included). */
export declare function writeTestCommands(workflowPath: string, commands: string[]): void;
/**
 * Walks the user through the Test node's command(s) right after scaffolding
 * `.flow-code/workflow.yaml`: shows anything auto-detected (package.json
 * scripts, a Makefile target, pytest/go/cargo) for them to accept or skip,
 * then offers to add more by hand — useful for a second test level
 * (integration/e2e) detection won't have found, or a project with no test
 * command yet, which just leaves the scaffolded placeholder untouched.
 */
export declare function runTestSetupWizard(repoRoot: string, workflowPath: string, opts?: TestSetupOptions): Promise<void>;
