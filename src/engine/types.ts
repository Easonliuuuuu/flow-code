import type { CapabilitySet } from '../capabilities.js';
import type { SlotPool } from './slots.js';
import type { RunStateStore } from '../runstate/store.js';
import type { DiscussTranscriptEntry, NodeStatus, RunBaseline } from '../runstate/types.js';
import type { Workflow, WorkflowNode } from '../workflow/load.js';
import type { RunSettings } from '../workflow/schema.js';
import type { PlanProposal } from '../workflow/splice.js';

/** Events every node execution yields; consumed centrally by the engine. */
export type StatusEvent =
  | { type: 'status'; status: Exclude<NodeStatus, 'idle' | 'skipped'>; detail?: string }
  | { type: 'output'; text: string }
  | { type: 'result'; output: unknown };

export interface UpstreamInput {
  nodeId: string;
  typeId: string;
  /** JSON-serialized output, possibly truncated (then `truncated` is true). */
  outputJson: string;
  truncated: boolean;
  /** True when this reached the node through a context-transparent dependency. */
  forwarded?: boolean;
  /** True when this is the failure that caused the node to run again. */
  retryReason?: boolean;
}

/** Request to run one non-interactive agent session under the harness. */
export interface AgentSessionRequest {
  nodeId: string;
  instanceId?: string;
  capabilities: CapabilitySet;
  rolePrompt: string;
  prompt: string;
  workingDir: string;
  model?: string;
  onText?: (chunk: string) => void;
  /** Aborted when the run is interrupted (e.g. ctrl+c); cancels the underlying session/tool calls. */
  signal?: AbortSignal;
  /** Reported once the underlying session id is known, so it can be persisted for `--resume`. */
  onSessionId?: (sessionId: string) => void;
  /** Continue a previously interrupted session with full history, instead of starting fresh. */
  resumeSessionId?: string;
  /**
   * Whether this session may delegate to subagents. False compiles to an empty
   * registry, which the interception check refuses like any unknown type —
   * so disabling delegation needs no separate branch.
   */
  subagents?: boolean;
  /** Run-wide slot pool subagents draw from; absent refuses every spawn. */
  subagentPool?: SlotPool;
}

/** Thrown (or used to reject a pending port) when a run is interrupted mid-flight. */
export class RunInterruptedError extends Error {
  constructor(message = 'run interrupted') {
    super(message);
  }
}

export interface InteractiveAgentSession {
  /** Send a user message; resolves with the assistant's reply for that turn. */
  send(userText: string): Promise<string>;
  end(): Promise<void>;
}

/**
 * Injectable boundary to the Claude Agent SDK, so the engine and executors
 * are testable (and could later run against other runners).
 */
export interface SessionRunner {
  run(req: AgentSessionRequest, store: RunStateStore): Promise<{ finalText: string }>;
  openInteractive(req: AgentSessionRequest, store: RunStateStore): Promise<InteractiveAgentSession>;
}

export interface ApprovalRequest {
  nodeId: string;
  title: string;
  /** One diff on the plain path; one per selected branch after a convergence. */
  diffs: Array<{ label?: string; diff: string }>;
  /**
   * The non-diff subject of a decision — prose to read rather than a diff to
   * scan. Always derived from a direct dependency's result (a Spec node's
   * file, today); never something a gate is configured to point at, so a
   * gate placed after a document-producing node needs no config to show what
   * it is gating.
   */
  documents?: Array<{ label: string; body: string }>;
  upstreamSummaries: Array<{ nodeId: string; summary: string }>;
  /** Present when a push-configured Git-ops node is downstream of this gate. */
  pushTarget?: { nodeId: string; remote: string; branch: string };
  /** Set only when the gate's optional agent step ran (`agent`/`skills` configured). */
  agentSummary?: string;
}

export interface ConvergenceRequest {
  nodeId: string;
  mode: 'compare' | 'parallelize';
  branches: Array<{
    instanceId: string;
    branch: string;
    status: 'done' | 'error';
    summary: string;
    diffSummary: string;
  }>;
}

export interface DiscussPort {
  /** Called when the discussion opens; `seedTranscript` replays a resumed conversation into the UI. */
  begin(nodeId: string, topic: string | undefined, seedTranscript?: DiscussTranscriptEntry[]): void;
  /** Assistant text to show the user; `options` are choices to present alongside it. */
  postAssistant(nodeId: string, text: string, options?: string[] | null): void;
  /** Next user message; resolve null when the user signals the discussion is done. */
  nextUserMessage(nodeId: string): Promise<string | null>;
  end(nodeId: string): void;
}

/**
 * The Plan node's interaction surface: the same shape as `DiscussPort`, but
 * a turn is one of three things rather than text-or-null, because "the user
 * stopped talking" and "the user accepted a graph" are not the same event —
 * the node must be able to tell them apart to know whether it completed or
 * merely ended.
 */
export interface PlanPort {
  begin(nodeId: string, topic: string | undefined, seedTranscript?: DiscussTranscriptEntry[]): void;
  /** Assistant text; `proposal` is the graph it proposed in this reply, if this reply proposed one. */
  postAssistant(nodeId: string, text: string, proposal: PlanProposal | null): void;
  /**
   * The user's next turn. `null` means the session ended without the user
   * accepting anything — the node errors rather than completing.
   */
  nextTurn(nodeId: string): Promise<{ text: string } | { accept: true } | null>;
  end(nodeId: string): void;
}

/**
 * What both discovery passes turned up, run before the user is asked anything
 * so the picker opens on an answer rather than an empty list.
 */
export interface TestCommandsFindings {
  /** Commands found by offline heuristics — free, instant, usually right. */
  detected: string[];
  /** What the `read`-only agent pass proposed, each with its evidence. */
  proposals: Array<{ command: string; rationale: string }>;
  /** Why the agent pass produced nothing, when it failed rather than declined. */
  discoverError?: string;
}

/**
 * A Test node that reached execution with no command list, presenting what it
 * worked out for confirmation. Nothing here has been executed: these commands
 * run through `sh -c` outside the capability harness, so the confirmation is
 * the only thing standing between a proposal and a shell.
 *
 * `discover` is handed over as a callback rather than run by the UI: re-reading
 * the repo costs another agent session, and the executor is what holds the
 * session runner. The UI decides *whether* to spend it; the executor knows how.
 */
export interface TestCommandsRequest extends TestCommandsFindings {
  nodeId: string;
  /** Run the agent pass again, when the user asks for another look. */
  discover(): Promise<Array<{ command: string; rationale: string }>>;
}

/** UI bridge for the interactions a run can require. Headless-substitutable. */
export interface InteractionPorts {
  approval: { request(req: ApprovalRequest): Promise<'approve' | 'reject'> };
  convergence: { select(req: ConvergenceRequest): Promise<string[]> };
  discuss: DiscussPort;
  plan: PlanPort;
  /** Resolve null to run no tests at all; the node passes and says so. */
  testCommands: { request(req: TestCommandsRequest): Promise<string[] | null> };
}

export interface ExecuteContext {
  runId: string;
  node: WorkflowNode;
  workflow: Workflow;
  repoRoot: string;
  /** The directory this node operates in (main checkout or a converged worktree). */
  workingDir: string;
  baseline: RunBaseline;
  settings: RunSettings;
  upstream: UpstreamInput[];
  store: RunStateStore;
  ports: InteractionPorts;
  sessions: SessionRunner;
  /** Acquire a slot under the run-wide agent-session concurrency cap. */
  acquireSessionSlot(): Promise<() => void>;
  /**
   * The same cap, for subagents — which take slots without waiting for one.
   * See `SlotPool`.
   */
  subagentPool: SlotPool;
  /** Aborted when the run is interrupted (e.g. ctrl+c). */
  signal: AbortSignal;
}

/** The contract every node type implements. */
export type NodeExecutor = (ctx: ExecuteContext) => AsyncGenerator<StatusEvent, void, void>;
