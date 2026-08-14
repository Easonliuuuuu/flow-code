/**
 * Enforcement inside a session flow-code did not start.
 *
 * The interesting cases are all failures. An enforcement layer that works when
 * everything is in order is easy; what decides whether the `hooks` tier is an
 * honest claim is what happens when the run cannot be read, when no step is in
 * progress, and when the layer itself breaks — because every one of those, if
 * it resolved to "allow", would leave a run recording a guarantee nobody
 * delivered.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPreToolUseHook } from '../src/cli/hook.js';
import {
  enforcementLive,
  enforceCall,
  HEARTBEAT_FILE,
  recordHeartbeat,
} from '../src/guest/enforce.js';

import {
  closeGuestRun,
  currentGuestRun,
  openGuestRun,
  reportTransition,
} from '../src/guest/report.js';
import { listRunStates, runFilePath } from '../src/runstate/persist.js';
import { latestRunState } from '../src/runstate/watch.js';
import { capabilitySet, type Capability } from '../src/capabilities.js';
import { capabilitiesForNode } from '../src/guest/enforce.js';
import { decideCall } from '../src/harness/intercept.js';
import { makeTempGitRepo, workflowFromYaml } from './helpers.js';

// `review` has read but not edit; `implement` has edit; `ship` has git-write
// and sits behind an approval gate.
const YAML = `
nodes:
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: review
    type: review
    config: { instructions: review it }
  - id: gate
    type: approval-gate
    config: {}
  - id: ship
    type: git-ops
    config: { commitMessage: ship it }
edges:
  - { from: implement, to: review }
  - { from: review, to: gate }
  - { from: gate, to: ship }
`;

function repoWithWorkflow(yaml: string = YAML): string {
  const repo = makeTempGitRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), yaml);
  return repo;
}

const WRITE = { toolName: 'Write', toolInput: { file_path: 'src/a.ts', content: 'x' } };
const READ = { toolName: 'Read', toolInput: { file_path: 'src/a.ts' } };

describe('when nothing is being enforced', () => {
  it('permits everything, so an ordinary session is unaffected by the plugin', () => {
    const repo = repoWithWorkflow();
    expect(enforceCall(repo, WRITE).kind).toBe('not-in-force');
  });

  it('permits flow-code\'s own reporting tools, which must never be blocked', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'mcp' });
    // Denying `start_node` would be a deadlock, not a restriction: the envelope
    // is defined by the current node, and only this call can establish one.
    expect(
      enforceCall(repo, { toolName: 'mcp__flow-code__start_node', toolInput: {} }).kind,
    ).toBe('not-in-force');
  });

  // Both spellings observed from a real Claude Code session: the first from a
  // per-project `.mcp.json` (what `flow-code connect` writes), the second from
  // the same server installed as a plugin, which namespaces it again. Matching
  // only the first deadlocked every plugin install on its own first step.
  it.each([
    ['per-project server', 'mcp__flow-code__start_node'],
    ['plugin-namespaced server', 'mcp__plugin_flow-code_flow-code__start_node'],
  ])('permits reporting tools however the host namespaces them (%s)', async (_label, toolName) => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'mcp' });
    expect(enforceCall(repo, { toolName, toolInput: {} }).kind).toBe('not-in-force');
  });

  it('does not exempt another server\'s tools just because they are named alike', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'mcp' });
    // No step is in progress, so anything not ours must fail closed rather than
    // ride in on a tool name it happens to share.
    expect(
      enforceCall(repo, { toolName: 'mcp__other__start_node', toolInput: {} }).kind,
    ).toBe('failed');
  });

  it('permits everything again once the run is closed', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    expect(enforceCall(repo, WRITE).kind).toBe('allow');

    closeGuestRun(repo, runId);
    expect(enforceCall(repo, WRITE).kind).toBe('not-in-force');
  });
});

describe('the current node decides what is permitted', () => {
  it('permits a call inside the node\'s capability set', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    const outcome = enforceCall(repo, WRITE);
    expect(outcome).toMatchObject({ kind: 'allow', nodeId: 'implement' });
  });

  it('denies a call outside it, naming the missing capability', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });

    const outcome = enforceCall(repo, WRITE);
    expect(outcome.kind).toBe('deny');
    if (outcome.kind !== 'deny') return;
    expect(outcome.decision.missingCapability).toBe('edit');
    // A reviewer that can edit the code is the author — the exact failure the
    // graph exists to prevent.
    expect(enforceCall(repo, READ).kind).toBe('allow');
  });

  it('moves the envelope as the run advances, with no session restart', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    expect(enforceCall(repo, WRITE).kind).toBe('allow');

    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });

    // Same session, same process, different answer — the envelope belongs to
    // the run's position, not to how the session was started.
    expect(enforceCall(repo, WRITE).kind).toBe('deny');
  });
});

describe('git writes behind an approval gate', () => {
  /** Walk to `ship` with the gate resolved however the test needs. */
  async function runToShip(repo: string, gate: 'approved' | 'rejected'): Promise<string> {
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'review',
      kind: 'done',
      output: { verdict: 'pass', findings: [] },
    });
    reportTransition(repo, runId, { nodeId: 'gate', kind: 'start' });
    // Answered through the gate surface, which is the only route to a decision
    // — see the approval-gate tests below.
    reportTransition(repo, runId, {
      nodeId: 'gate',
      kind: 'gate',
      decision: gate,
      surface: 'terminal',
    });
    if (gate === 'approved') reportTransition(repo, runId, { nodeId: 'ship', kind: 'start' });
    return runId;
  }

  /** Walk as far as the gate, leaving it unanswered. */
  async function runToGate(repo: string): Promise<string> {
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'review',
      kind: 'done',
      output: { verdict: 'pass', findings: [] },
    });
    reportTransition(repo, runId, { nodeId: 'gate', kind: 'start' });
    return runId;
  }

  /**
   * Force node statuses directly, bypassing the transition rules — the point of
   * these cases is a run that reached a state ordering validation would never
   * have produced, so the fixture has to produce it some other way.
   */
  function forceStatuses(repo: string, runId: string, statuses: Record<string, string>): void {
    const path = runFilePath(repo, runId);
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      nodes: Record<string, { status: string }>;
    };
    for (const [id, status] of Object.entries(statuses)) state.nodes[id]!.status = status;
    writeFileSync(path, JSON.stringify(state));
  }

  it('are permitted once the gate is approved', async () => {
    const repo = repoWithWorkflow();
    await runToShip(repo, 'approved');
    expect(enforceCall(repo, { toolName: 'Bash', toolInput: { command: 'git commit -m x' } }).kind).toBe(
      'allow',
    );
  });

  it('stay denied while the gate is still unanswered, and say which gate', async () => {
    const repo = repoWithWorkflow();
    const runId = await runToGate(repo);
    // The document is edited to put `ship` in progress with the gate still
    // waiting — a state ordering validation would refuse to produce. That is
    // the point: this layer guards the *call*, so a run that reached this
    // state some other way still cannot write to the repository.
    forceStatuses(repo, runId, { gate: 'idle', ship: 'running' });

    const outcome = enforceCall(repo, { toolName: 'Bash', toolInput: { command: 'git push' } });
    expect(outcome.kind).toBe('deny');
    if (outcome.kind !== 'deny') return;
    expect(outcome.decision.missingCapability).toBe('approval-gate');
    expect(outcome.decision.message).toContain('gate');
  });

  it('leave read-only git alone while the gate is waiting', async () => {
    const repo = repoWithWorkflow();
    const runId = await runToGate(repo);
    forceStatuses(repo, runId, { gate: 'idle', ship: 'running' });
    expect(enforceCall(repo, { toolName: 'Bash', toolInput: { command: 'git status' } }).kind).toBe(
      'allow',
    );
  });
});

describe('failing closed', () => {
  it('denies when no step is in progress, and says what to do about it', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'mcp' });

    // A run open with nothing started has no envelope. Permitting here would
    // make the whole tier escapable by simply never reporting a step.
    const outcome = enforceCall(repo, WRITE);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('started');
  });

  it('denies when the run document cannot be understood', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    // A graph naming a node type this build does not have: readable JSON, but
    // not something an envelope can be derived from.
    const state = JSON.parse(readFileSync(runFilePath(repo, runId), 'utf8')) as {
      graph: { nodes: { type: string }[] };
    };
    state.graph.nodes[0]!.type = 'no-such-type';
    writeFileSync(runFilePath(repo, runId), JSON.stringify(state));

    expect(enforceCall(repo, WRITE).kind).toBe('failed');
  });

  it('reports a failure distinctly from a capability denial', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'mcp' });

    const hook = hookOutput(repo, { tool_name: 'Write', tool_input: WRITE.toolInput });
    expect(hook.permissionDecision).toBe('deny');
    // "You may not do that" and "flow-code could not work out whether you may"
    // are different facts; an agent that cannot tell them apart routes around
    // the wrong one.
    expect(hook.permissionDecisionReason).toContain('could not determine');
  });
});

/** Run the hook over a payload and parse what a host would read back. */
function hookOutput(
  repo: string,
  payload: Record<string, unknown>,
): { permissionDecision?: string; permissionDecisionReason?: string } {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    runPreToolUseHook(JSON.stringify({ cwd: repo, ...payload }));
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
  const parsed = JSON.parse(chunks.join('')) as {
    hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return parsed.hookSpecificOutput;
}

describe('the hook as a host invokes it', () => {
  it('says nothing about a permitted call, rather than approving it', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    // An explicit `allow` would bypass the user's own permission settings —
    // flow-code narrows what a node may do, it never widens it.
    expect(hookOutput(repo, { tool_name: 'Write', tool_input: WRITE.toolInput })
      .permissionDecision).toBeUndefined();
  });

  it('denies with the same reason an engine-driven run gives', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });

    const out = hookOutput(repo, { tool_name: 'Write', tool_input: WRITE.toolInput });
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('`edit` capability');
  });

  it('records the denial on the run, like any other denial', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });
    hookOutput(repo, { tool_name: 'Write', tool_input: WRITE.toolInput, tool_use_id: 't1' });

    const state = latestRunState(repo)!;
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]).toMatchObject({
      nodeId: 'review',
      tool: 'Write',
      decision: 'denied',
      missingCapability: 'edit',
    });
    // The counter the node card and the status line both read.
    expect(state.nodes.review!.denials).toBe(1);
  });

  it('permits everything outside a flow-code project', () => {
    const bare = makeTempGitRepo();
    expect(hookOutput(bare, { tool_name: 'Write', tool_input: WRITE.toolInput })
      .permissionDecision).toBeUndefined();
  });

  it('permits rather than blocks when the host sends something it cannot parse', () => {
    const repo = repoWithWorkflow();
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (c: string): boolean => (chunks.push(String(c)), true);
    try {
      runPreToolUseHook('not json');
    } finally {
      (process.stdout as { write: unknown }).write = write;
    }
    // A host contract changing under us must cost the enforcement *and* the
    // claim of it — but it must not brick a session, and at this point we
    // cannot even tell whether a run is open.
    const out = JSON.parse(chunks.join('')) as { hookSpecificOutput: { permissionDecision?: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(repo).toBeTruthy();
  });
});

describe('a run claims only the enforcement it can demonstrate', () => {
  it('records the reported tier when the hook has never run', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'mcp' });
    // An installed plugin proves nothing: hooks can be disabled after install.
    expect(latestRunState(repo)!.enforcement).toMatchObject({ tier: 'reported' });
  });

  it('records the hooks tier when the hook demonstrably just ran', async () => {
    const repo = repoWithWorkflow();
    recordHeartbeat(repo, 'session-1');
    await openGuestRun(repo, { surface: 'mcp' });
    expect(latestRunState(repo)!.enforcement).toMatchObject({ tier: 'hooks' });
    // And the guarantees a host session still cannot give are enumerated.
    expect(latestRunState(repo)!.enforcement!.absent).toContain('process-guards');
    expect(latestRunState(repo)!.enforcement!.absent).not.toContain('capability-enforcement');
  });

  it('treats a stale heartbeat as no enforcement', () => {
    const repo = repoWithWorkflow();
    writeFileSync(
      join(repo, HEARTBEAT_FILE),
      JSON.stringify({ at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), pid: 1 }),
    );
    expect(enforcementLive(repo)).toBe(false);
  });

  it('records a downgrade when enforcement stops mid-run, rather than rewriting the tier', async () => {
    const repo = repoWithWorkflow();
    recordHeartbeat(repo);
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    expect(latestRunState(repo)!.enforcement!.tier).toBe('hooks');

    rmSync(join(repo, HEARTBEAT_FILE));
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    const enforcement = latestRunState(repo)!.enforcement!;
    // The opening tier is kept: the earlier part of the run really did have it.
    expect(enforcement.tier).toBe('hooks');
    expect(enforcement.downgrades).toHaveLength(1);
    expect(enforcement.downgrades![0]).toMatchObject({ from: 'hooks', to: 'reported' });
  });
});

describe('one policy, two callers', () => {
  it('reaches the same verdict per node as an engine-driven run does', async () => {
    // The claim the `hooks` tier rests on is that a host session is held to the
    // *same* envelope, not a similar one. Both paths call `decideCall`; this
    // pins that they are handed the same capability set too, across every node
    // type and a battery of calls that straddle each boundary.
    const repo = repoWithWorkflow();
    const workflow = workflowFromYaml(YAML);
    const calls: { tool: string; input: Record<string, unknown> }[] = [
      { tool: 'Read', input: { file_path: join(repo, 'a.ts') } },
      { tool: 'Write', input: { file_path: join(repo, 'a.ts') } },
      { tool: 'Bash', input: { command: 'npm test' } },
      { tool: 'Bash', input: { command: 'git status' } },
      { tool: 'Bash', input: { command: 'git push' } },
      { tool: 'WebFetch', input: { url: 'https://example.com' } },
      { tool: 'Write', input: { file_path: join(repo, '.flow-code', 'workflow.yaml') } },
    ];

    for (const node of workflow.nodes) {
      // What the engine's executors compute for a node's session…
      const engineCaps = capabilitySet(...(node.type.capabilities as Capability[]));
      // …and what the hook resolves from the run document.
      const hookCaps = capabilitiesForNode(node);
      expect([...hookCaps].sort()).toEqual([...engineCaps].sort());

      for (const call of calls) {
        const viaEngine = decideCall({ capabilities: engineCaps, workingDir: repo }, call.tool, call.input);
        const viaHook = decideCall({ capabilities: hookCaps, workingDir: repo }, call.tool, call.input);
        expect(`${node.id}:${call.tool}:${viaHook.behavior}:${viaHook.missingCapability ?? ''}`).toBe(
          `${node.id}:${call.tool}:${viaEngine.behavior}:${viaEngine.missingCapability ?? ''}`,
        );
      }
    }
  });
});

describe('an approval gate is answered by a person', () => {
  async function atGate(repo: string): Promise<string> {
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'review',
      kind: 'done',
      output: { verdict: 'pass', findings: [] },
    });
    reportTransition(repo, runId, { nodeId: 'gate', kind: 'start' });
    return runId;
  }

  it('cannot be completed through the ordinary reporting path', async () => {
    const repo = repoWithWorkflow();
    const runId = await atGate(repo);

    // `complete_node` is what an agent calls when it decides a step is
    // finished. A gate an agent can finish is not a gate.
    expect(() =>
      reportTransition(repo, runId, {
        nodeId: 'gate',
        kind: 'done',
        output: { decision: 'approved', decidedAt: new Date().toISOString() },
      }),
    ).toThrow(/answered by the person/);
    expect(latestRunState(repo)!.nodes.gate!.status).toBe('running');
  });

  it('records which surface collected the decision', async () => {
    const repo = repoWithWorkflow();
    const runId = await atGate(repo);
    reportTransition(repo, runId, {
      nodeId: 'gate',
      kind: 'gate',
      decision: 'approved',
      surface: 'permission-prompt',
    });

    const gate = latestRunState(repo)!.nodes.gate!;
    expect(gate.status).toBe('done');
    // Which surface is the whole of the guarantee — an approval whose
    // provenance is unknown is not one anybody can rely on afterwards.
    expect(gate.gateDecision).toMatchObject({
      decision: 'approved',
      surface: 'permission-prompt',
    });
  });

  it('refuses a decision that names no surface at all', async () => {
    const repo = repoWithWorkflow();
    const runId = await atGate(repo);
    expect(() =>
      reportTransition(repo, runId, { nodeId: 'gate', kind: 'gate', decision: 'approved' }),
    ).toThrow(/surface/);
  });

  it('stops the run below it when rejected', async () => {
    const repo = repoWithWorkflow();
    const runId = await atGate(repo);
    reportTransition(repo, runId, {
      nodeId: 'gate',
      kind: 'gate',
      decision: 'rejected',
      surface: 'terminal',
    });

    expect(latestRunState(repo)!.nodes.gate!.status).toBe('error');
    // Downstream cannot proceed: a rejected gate is not a satisfied upstream.
    expect(() => reportTransition(repo, runId, { nodeId: 'ship', kind: 'start' })).toThrow(
      /upstream is unfinished/,
    );
  });
});

describe('work delegated to a subagent', () => {
  it('is held to the delegating node\'s capability set, not the subagent\'s own', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });

    // Identical to the same call made by the session directly: the envelope
    // belongs to the run's current node, so delegation cannot widen it.
    const direct = hookOutput(repo, { tool_name: 'Write', tool_input: WRITE.toolInput });
    const delegated = hookOutput(repo, {
      tool_name: 'Write',
      tool_input: WRITE.toolInput,
      agent_id: 'sub-1',
      agent_type: 'worker',
    });
    expect(delegated.permissionDecision).toBe('deny');
    expect(delegated.permissionDecisionReason).toBe(direct.permissionDecisionReason);
  });

  it('is attributed to the delegating node, and says which agent made it', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });
    hookOutput(repo, {
      tool_name: 'Write',
      tool_input: WRITE.toolInput,
      agent_id: 'sub-1',
      agent_type: 'worker',
    });

    const entry = latestRunState(repo)!.activity[0]!;
    expect(entry.nodeId).toBe('review');
    expect(entry.agentId).toBe('sub-1');
    expect(entry.agentType).toBe('worker');
  });

  // `start_node` tells the agent to run each step in a fresh subagent, and that
  // instruction is the only thing keeping Implement and Review out of one
  // context window. Denying the spawn did not make the run safer — it made the
  // agent do every step inline, which is the failure the graph exists to stop.
  it('permits the spawn the instructions ask for, whatever the host calls its agents', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    const spawn = hookOutput(repo, {
      tool_name: 'Agent',
      // A host's own agent type, which flow-code has no say in and cannot list.
      tool_input: { subagent_type: 'general-purpose', prompt: 'the brief' },
    });
    expect(spawn.permissionDecision).toBeUndefined();
  });

  it('still refuses to delegate when the workflow turned subagents off', async () => {
    const repo = repoWithWorkflow(`settings:\n  subagents: false\n${YAML}`);
    const { runId } = await openGuestRun(repo, { surface: 'mcp' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    const spawn = hookOutput(repo, {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose', prompt: 'the brief' },
    });
    expect(spawn.permissionDecision).toBe('deny');
    expect(spawn.permissionDecisionReason).toContain('subagents are disabled');
  });
});

describe('a run stays findable once enforcement is live', () => {
  it('is what an unnamed subcommand targets at either non-engine tier', async () => {
    // Regression: run resolution once tested for the `reported` tier
    // specifically, so the moment the enforcement layer started working every
    // subcommand lost track of the run it had just opened. Only reachable with
    // both halves present, which is why it survived until they were.
    const repo = repoWithWorkflow();
    recordHeartbeat(repo);
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    expect(latestRunState(repo)!.enforcement!.tier).toBe('hooks');

    expect(currentGuestRun(repo, listRunStates(repo))?.runId).toBe(runId);
    // And the transition it resolves to actually lands.
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    expect(latestRunState(repo)!.nodes.implement!.status).toBe('running');
  });
});
