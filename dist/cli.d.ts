#!/usr/bin/env node
import { type ProviderId } from './engine/providers.js';
import type { SessionRunner } from './engine/types.js';
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
