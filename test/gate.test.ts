import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionRequest, ExecuteContext } from '../src/engine/types.js';
import { executeApprovalGate } from '../src/executors/gate.js';
import { RunStateStore } from '../src/runstate/store.js';
import { fakePorts, makeTempGitRepo, repoGit, storeFor, workflowFromYaml } from './helpers.js';
import type { Workflow } from '../src/workflow/load.js';

function baselineFor(repoRoot: string): { commit: string; tree: string; dirtyOverride: false } {
  const commit = repoGit(repoRoot, 'rev-parse', 'HEAD');
  const tree = repoGit(repoRoot, 'rev-parse', 'HEAD^{tree}');
  return { commit, tree, dirtyOverride: false };
}

const WF = workflowFromYaml(`
nodes:
  - id: spec
    type: spec
    config: { acceptanceCriteria: ['it works'] }
  - id: gate
    type: approval-gate
edges:
  - { from: spec, to: gate }
`);

/** A gate with no document-producing dependency at all. */
const WF_NO_SPEC = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
edges:
  - { from: impl, to: gate }
`);

function writeSpecFile(repoRoot: string, specPath: string, body: string): void {
  const absolute = join(repoRoot, specPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

function gateContext(
  workflow: Workflow,
  store: RunStateStore,
  repoRoot: string,
  ports = fakePorts(),
): ExecuteContext {
  return {
    runId: 'run-1234',
    node: workflow.nodes.find((n) => n.id === 'gate')!,
    workflow,
    repoRoot,
    workingDir: repoRoot,
    baseline: baselineFor(repoRoot),
    settings: { concurrency: 1 },
    upstream: [],
    store,
    ports,
    sessions: {
      async run(_req: AgentSessionRequest) {
        throw new Error('not used');
      },
      async openInteractive() {
        throw new Error('not used');
      },
    },
    acquireSessionSlot: async () => () => {},
    signal: new AbortController().signal,
  } as unknown as ExecuteContext;
}

async function runGate(ctx: ExecuteContext): Promise<unknown> {
  let output: unknown;
  for await (const event of executeApprovalGate(ctx)) {
    if (event.type === 'result') output = event.output;
  }
  return output;
}

describe('Approval-Gate document derivation', () => {
  it('reads a spec dependency’s file from disk, labelled with its node id', async () => {
    const repoRoot = makeTempGitRepo();
    const store = storeFor(WF, repoRoot);
    const specPath = join('.flow-code', 'specs', 'run-1234.md');
    writeSpecFile(repoRoot, specPath, '# Title\n\n- **AC1** — it works\n');
    store.setOutput('spec', { specPath, title: 'Title', requirements: [], acceptanceCriteria: [] });

    const ports = fakePorts();
    await runGate(gateContext(WF, store, repoRoot, ports));

    expect(ports.approvalRequests[0]!.documents).toEqual([
      { label: 'spec', body: '# Title\n\n- **AC1** — it works\n' },
    ]);
  });

  it('reflects a rewritten file on a second pass', async () => {
    const repoRoot = makeTempGitRepo();
    const store = storeFor(WF, repoRoot);
    const specPath = join('.flow-code', 'specs', 'run-1234.md');
    writeSpecFile(repoRoot, specPath, 'first draft');
    store.setOutput('spec', { specPath, title: 'T', requirements: [], acceptanceCriteria: [] });

    const first = fakePorts();
    await runGate(gateContext(WF, store, repoRoot, first));
    expect(first.approvalRequests[0]!.documents).toEqual([{ label: 'spec', body: 'first draft' }]);

    writeSpecFile(repoRoot, specPath, 'second draft, rewritten after rejection');
    const second = fakePorts();
    await runGate(gateContext(WF, store, repoRoot, second));
    expect(second.approvalRequests[0]!.documents).toEqual([
      { label: 'spec', body: 'second draft, rewritten after rejection' },
    ]);
  });

  it('yields no documents, and no error, when nothing upstream produces one', async () => {
    const repoRoot = makeTempGitRepo();
    const store = storeFor(WF_NO_SPEC, repoRoot);
    store.setOutput('impl', { changedFiles: [], diff: '', summary: 's' });

    const ports = fakePorts();
    await runGate(gateContext(WF_NO_SPEC, store, repoRoot, ports));

    expect(ports.approvalRequests[0]!.documents).toBeUndefined();
  });

  it('degrades rather than fails when the document path cannot be read', async () => {
    const repoRoot = makeTempGitRepo();
    const store = storeFor(WF, repoRoot);
    const specPath = join('.flow-code', 'specs', 'does-not-exist.md');
    store.setOutput('spec', { specPath, title: 'T', requirements: [], acceptanceCriteria: [] });

    const ports = fakePorts();
    const output = await runGate(gateContext(WF, store, repoRoot, ports));

    expect((output as { decision: string }).decision).toBe('approved');
    expect(ports.approvalRequests[0]!.documents).toHaveLength(1);
    expect(ports.approvalRequests[0]!.documents![0]!.body).toContain('Could not read');
  });
});
