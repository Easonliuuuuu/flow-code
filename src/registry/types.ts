import type { ZodType } from 'zod';
import type { Capability } from '../capabilities.js';

export const NODE_TYPE_IDS = [
  'discuss',
  'implement',
  'test',
  'validate',
  'review',
  'git-ops',
  'worktree-agent',
  'approval-gate',
] as const;

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
  /** Default role prompt for agent-driven types; empty otherwise. */
  rolePrompt: string;
  configSchema: ZodType;
  outputSchema: ZodType;
  /** Human-readable one-line description of the config shape, for `node-types`. */
  configSummary: string;
  /** Human-readable one-line description of the output shape, for `node-types`. */
  outputSummary: string;
}
