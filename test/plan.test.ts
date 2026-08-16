import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecuteContext, InteractiveAgentSession, SessionRunner } from '../src/engine/types.js';
import { executePlan } from '../src/executors/plan.js';
import { RunStateStore } from '../src/runstate/store.js';
import { fakePorts, workflowFromYaml } from './helpers.js';

/**
 * plan is the spine's sole root; gate dominates git-ops exactly as the
 * default scaffold does, so every splice test below is checking the
 * invariant against a graph shaped like a real one, not a toy.
 */
const SPINE = `
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: git-ops }
`;

function planBlock(nodes: unknown[], edges: unknown[] = []): string {
  return `Here is my proposal.\n<<<PLAN\n${JSON.stringify({ nodes, edges })}\n>>>`;
}

/** send() returns each reply in order; records every prompt it was sent. */
function scriptedSessions(replies: string[]): SessionRunner & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    async run(): Promise<{ finalText: string }> {
      throw new Error('not used');
    },
    async openInteractive(req): Promise<InteractiveAgentSession> {
      req.onSessionId?.('fake-plan-session');
      return {
        async send(text: string): Promise<string> {
          prompts.push(text);
          const reply = replies[i] ?? '';
          i++;
          return reply;
        },
        async end(): Promise<void> {},
      };
    },
  };
}

function contextFor(
  yaml: string,
  sessions: SessionRunner,
  ports: ReturnType<typeof fakePorts>,
): { ctx: ExecuteContext; store: RunStateStore; repoRoot: string } {
  const workflow = workflowFromYaml(yaml);
  const node = workflow.nodes.find((n) => n.type.id === 'plan')!;
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-plan-'));
  const store = new RunStateStore({ repoRoot, nodeIds: workflow.nodes.map((n) => n.id) });
  const ctx = {
    runId: 'run-1234',
    node,
    workflow,
    repoRoot,
    workingDir: repoRoot,
    baseline: { commit: 'c', tree: 't', dirtyOverride: false },
    settings: workflow.settings,
    upstream: [],
    store,
    ports,
    sessions,
    acquireSessionSlot: async () => () => {},
    subagentPool: { tryAcquire: () => null, release: () => {} },
    signal: new AbortController().signal,
  } as unknown as ExecuteContext;
  return { ctx, store, repoRoot };
}

async function run(
  ctx: ExecuteContext,
): Promise<{ status: string; detail: string | undefined; output: unknown }> {
  let status = 'unknown';
  let detail: string | undefined;
  let output: unknown;
  for await (const event of executePlan(ctx)) {
    if (event.type === 'status') {
      status = event.status;
      if (event.detail !== undefined) detail = event.detail;
    }
    if (event.type === 'result') output = event.output;
  }
  return { status, detail, output };
}

describe('Plan node', () => {
  it('completes only once the user accepts a proposed graph', async () => {
    const sessions = scriptedSessions([
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }]),
    ]);
    const ports = fakePorts({ planTurns: ['accept'] });
    const { ctx } = contextFor(SPINE, sessions, ports);

    const result = await run(ctx);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }],
      edges: [],
    });
    expect(ports.planEnded).toEqual(['plan']);
  });

  it('lets the user amend before accepting, without completing on the superseded proposal', async () => {
    const sessions = scriptedSessions([
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'first draft' } }]),
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'revised' } }]),
    ]);
    const ports = fakePorts({ planTurns: ['make it different', 'accept'] });
    const { ctx } = contextFor(SPINE, sessions, ports);

    const result = await run(ctx);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'revised' } }],
      edges: [],
    });
    // Both drafts were shown to the user; only the second was ever accepted.
    expect(ports.planAssistantProposals).toHaveLength(2);
    expect(ports.planAssistantProposals[0]!.nodes[0]!.config).toEqual({ instructions: 'first draft' });
    expect(ports.planAssistantProposals[1]!.nodes[0]!.config).toEqual({ instructions: 'revised' });
  });

  it('errors, and skips downstream, when the session ends without an acceptance', async () => {
    const sessions = scriptedSessions([
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }]),
    ]);
    const ports = fakePorts({ planTurns: [] });
    const { ctx } = contextFor(SPINE, sessions, ports);

    const result = await run(ctx);

    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/without.*accepting/);
    expect(result.output).toBeUndefined();
  });

  it('rejects a proposal naming an unregistered node type, and reproposes rather than completing', async () => {
    const sessions = scriptedSessions([
      planBlock([{ id: 'impl', type: 'no-such-type', config: {} }]),
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }]),
    ]);
    const ports = fakePorts({ planTurns: ['accept', 'accept'] });
    const { ctx } = contextFor(SPINE, sessions, ports);

    const result = await run(ctx);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }],
      edges: [],
    });
    // The rejection was fed back into the session as the next turn, not hidden.
    expect(sessions.prompts.some((p) => p.includes('invalid') && p.includes('no-such-type'))).toBe(
      true,
    );
  });

  it('rejects a proposal that routes a git-writing node around the gate, and reproposes', async () => {
    const sessions = scriptedSessions([
      planBlock(
        [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
        [{ from: 'impl', to: 'git-ops' }],
      ),
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'x' } }]),
    ]);
    const ports = fakePorts({ planTurns: ['accept', 'accept'] });
    const { ctx } = contextFor(SPINE, sessions, ports);

    const result = await run(ctx);

    expect(result.status).toBe('done');
    expect(sessions.prompts.some((p) => p.includes('invalid') && p.includes('git-write'))).toBe(true);
    expect(sessions.prompts.some((p) => p.includes('Approval-Gate'))).toBe(true);
  });

  it('never treats an invalid proposal as accepted, however many times validation fails', async () => {
    const sessions = scriptedSessions([
      planBlock([{ id: 'impl', type: 'nope-1', config: {} }]),
      planBlock([{ id: 'impl', type: 'nope-2', config: {} }]),
      planBlock([{ id: 'impl', type: 'implement', config: { instructions: 'ok' } }]),
    ]);
    const ports = fakePorts({ planTurns: ['accept', 'accept', 'accept'] });
    const { ctx } = contextFor(SPINE, sessions, ports);

    const result = await run(ctx);

    expect(result.status).toBe('done');
    expect((result.output as { nodes: Array<{ type: string }> }).nodes[0]!.type).toBe('implement');
  });
});
