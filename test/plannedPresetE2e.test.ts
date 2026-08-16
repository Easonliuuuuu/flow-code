import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { scaffoldWorkflow } from '../src/cli/presetSetup.js';
import { driveEngine } from '../src/cli/run.js';
import { Engine } from '../src/engine/engine.js';
import type { AgentSessionRequest, SessionRunner } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import { createInterceptor } from '../src/harness/intercept.js';
import { getPreset } from '../src/presets.js';
import { RunStateStore } from '../src/runstate/store.js';
import { loadWorkflow, WORKFLOW_RELATIVE_PATH } from '../src/workflow/load.js';
import { writeKeptWorkflow } from '../src/workflow/write.js';
import { fakePorts, makeTempGitRepo } from './helpers.js';

/** Same harness fidelity as test/e2e.test.ts: real interception, real shell/write calls. */
function harnessedSessions(script: (req: AgentSessionRequest) => string): SessionRunner {
  const write = (req: AgentSessionRequest, relPath: string, content: string, store: RunStateStore): void => {
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      capabilities: capabilitySet(...req.capabilities),
      workingDir: req.workingDir,
      store,
    });
    const target = join(req.workingDir, relPath);
    const decision = interceptor.check('Write', { file_path: target });
    if (decision.behavior === 'deny') throw new Error(`write denied for ${req.nodeId}`);
    writeFileSync(target, content);
  };
  const bash = (req: AgentSessionRequest, command: string, store: RunStateStore): void => {
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      capabilities: capabilitySet(...req.capabilities),
      workingDir: req.workingDir,
      store,
    });
    const id = randomUUID();
    const decision = interceptor.check('Bash', { command }, { toolUseID: id });
    if (decision.behavior === 'deny') throw new Error(`bash denied for ${req.nodeId}: ${command}`);
    execFileSync('sh', ['-c', command], { cwd: req.workingDir });
    interceptor.complete(id, { exitStatus: 0 });
  };
  return {
    async run(req, store) {
      if (req.nodeId === 'impl') write(req, 'greeting.txt', 'hello from the negotiated graph\n', store);
      if (req.nodeId === 'git-ops') {
        bash(req, 'git add -A', store);
        bash(req, 'git commit -m "add greeting"', store);
      }
      return { finalText: script(req) };
    },
    async openInteractive(req) {
      return { send: async (text) => script({ ...req, prompt: text }), end: async () => {} };
    },
  };
}

const PLAN_PROPOSAL = {
  nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'write a greeting file' } }],
  edges: [],
};

function script(req: AgentSessionRequest): string {
  switch (req.nodeId) {
    case 'plan':
      return `Proposing a small graph.\n<<<PLAN\n${JSON.stringify(PLAN_PROPOSAL)}\n>>>`;
    case 'impl':
      return JSON.stringify({ changedFiles: ['greeting.txt'], diff: 'd', summary: 'added greeting.txt' });
    case 'git-ops':
      return JSON.stringify({ committed: true, pushed: false });
    default:
      throw new Error(`unexpected agent session for node ${req.nodeId}`);
  }
}

describe('end-to-end: the planned preset', () => {
  it('scaffolds, negotiates, runs to the gate, and — kept — runs static on the next load', async () => {
    const repo = makeTempGitRepo();
    const workflowPath = join(repo, WORKFLOW_RELATIVE_PATH);

    // 1. Scaffold the preset — the same path `flow-code init --preset planned` takes.
    const result = await scaffoldWorkflow(repo, workflowPath, getPreset('planned')!, true, async () => true);
    expect(result.justScaffolded).toBe(true);
    expect(existsSync(workflowPath)).toBe(true);

    // 2. Load it — three nodes, nothing negotiated yet.
    const spine = loadWorkflow(repo);
    expect(spine.order).toEqual(['plan', 'gate', 'git-ops']);

    // 3. Plan, accept, and run through to a finished graph.
    const store = new RunStateStore({
      repoRoot: repo,
      graph: {
        settings: spine.settings,
        nodes: spine.nodes.map((n) => ({ id: n.id, type: n.type.id, config: n.config })),
        edges: spine.edges,
      },
    });
    const baseline = await recordBaseline(repo, false);
    store.setBaseline(baseline);
    const ports = fakePorts({ approve: 'approve', planTurns: ['accept'] });
    const sessions = harnessedSessions(script);
    const newEngine = (wf: typeof spine): Engine =>
      new Engine({ workflow: wf, store, repoRoot: repo, baseline, ports, sessions, executors: builtinExecutors });

    const finalWorkflow = await driveEngine(newEngine(spine), spine, { store, repoRoot: repo, newEngine });

    for (const id of ['plan', 'impl', 'gate', 'git-ops']) {
      expect(store.node(id).status, id).toBe('done');
    }
    expect(execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString()).toContain('add greeting');
    expect(finalWorkflow).not.toBe(spine);
    expect(finalWorkflow.order).toEqual(['plan', 'impl', 'gate', 'git-ops']);

    // 4. Keep the negotiated graph.
    writeKeptWorkflow(workflowPath, finalWorkflow);
    const onDisk = readFileSync(workflowPath, 'utf8');
    expect(onDisk).not.toContain('type: plan');

    // 5. The next run needs no planning session: no Plan node, no interactive node at all.
    const nextRun = loadWorkflow(repo);
    expect(nextRun.order).toEqual(['impl', 'gate', 'git-ops']);
    expect(nextRun.nodes.some((n) => n.type.interactive)).toBe(false);
  });
});
