#!/usr/bin/env node
import { type ProviderId } from './engine/providers.js';
import type { SessionRunner } from './engine/types.js';
import type { WorkflowPreset } from './presets.js';
import { type Workflow } from './workflow/load.js';
/**
 * Determines which provider backs every agent-driven node in this run, and
 * makes sure its API key ends up in the environment. Order of preference: a
 * previously saved per-repo choice (from `flow-code init`), then an
 * already-set env var for any provider, then the Claude Agent SDK's own
 * credential resolution. Never prompts — `flow-code init` is where that
 * happens now; a workflow with agent-driven nodes and nothing configured
 * fails fast with a pointer to it. A workflow with no agent-driven nodes at
 * all returns undefined, since no provider is ever actually needed.
 */
export declare function resolveProvider(repoRoot: string, workflow: Workflow): Promise<{
    provider: ProviderId;
    model?: string;
} | undefined>;
export declare function buildRunner(provider: ProviderId): SessionRunner;
export interface ScaffoldResult {
    justScaffolded: boolean;
    overwrote: boolean;
}
/**
 * Writes the preset's workflow.yaml when the repo has none yet, or when the
 * caller explicitly named `--preset` on an already-scaffolded repo and
 * `confirmOverwrite` approves replacing it. A bare `init` re-run (no
 * `--preset`) never overwrites — that's most often just "reconfigure the
 * provider," and this repo's workflow.yaml may carry manual edits.
 * `confirmOverwrite` is only invoked when there's actually a decision to
 * make, so a caller that always answers "no" never sees a prompt on a fresh
 * repo.
 */
export declare function scaffoldWorkflow(repoRoot: string, path: string, preset: WorkflowPreset, presetExplicit: boolean, confirmOverwrite: () => Promise<boolean>): Promise<ScaffoldResult>;
