import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionRequest, ExecuteContext } from '../src/engine/types.js';
import { executeSpec, specRelativePath } from '../src/executors/spec.js';
import { executeValidate } from '../src/executors/agents.js';
import { acceptanceCriteriaFrom } from '../src/executors/helpers.js';
import { getNodeType } from '../src/registry/index.js';
import { RunStateStore } from '../src/runstate/store.js';
import { fakePorts } from './helpers.js';

/** Minimal context for driving one executor directly. */
function contextFor(
  typeId: 'spec' | 'validate',
  config: unknown,
  reply: (req: AgentSessionRequest) => string,
  upstream: ExecuteContext['upstream'] = [],
): { ctx: ExecuteContext; store: RunStateStore; repoRoot: string; prompts: string[] } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-spec-'));
  const node = { id: typeId, type: getNodeType(typeId)!, config, skills: [] };
  const store = new RunStateStore({ repoRoot, nodeIds: [node.id] });
  const prompts: string[] = [];
  const ctx = {
    runId: 'run-1234',
    node,
    workflow: { settings: {}, nodes: [node], edges: [], order: [node.id] },
    repoRoot,
    workingDir: repoRoot,
    baseline: { commit: 'c', tree: 't', dirtyOverride: false },
    settings: { concurrency: 1 },
    upstream,
    store,
    ports: fakePorts(),
    sessions: {
      async run(req: AgentSessionRequest) {
        prompts.push(req.prompt);
        return { finalText: reply(req) };
      },
      async openInteractive() {
        throw new Error('not used');
      },
    },
    acquireSessionSlot: async () => () => {},
    signal: new AbortController().signal,
  } as unknown as ExecuteContext;
  return { ctx, store, repoRoot, prompts };
}

async function collectResult(ctx: ExecuteContext, executor: typeof executeSpec): Promise<unknown> {
  let output: unknown;
  for await (const event of executor(ctx)) {
    if (event.type === 'result') output = event.output;
  }
  return output;
}

function upstreamOf(nodeId: string, typeId: string, output: unknown) {
  return { nodeId, typeId, outputJson: JSON.stringify(output, null, 2), truncated: false };
}

describe('Spec node', () => {
  it('writes the spec to the control directory and numbers the criteria', async () => {
    const { ctx, repoRoot } = contextFor('spec', {}, () =>
      JSON.stringify({
        title: 'Token meter',
        requirements: ['show tokens per node'],
        acceptanceCriteria: ['A running node shows a live token count', 'The header shows a run total'],
      }),
    );

    const output = (await collectResult(ctx, executeSpec)) as {
      specPath: string;
      acceptanceCriteria: Array<{ id: string; text: string }>;
    };

    expect(output.specPath).toBe(specRelativePath('run-1234'));
    expect(output.acceptanceCriteria.map((c) => c.id)).toEqual(['AC1', 'AC2']);

    const written = readFileSync(join(repoRoot, output.specPath), 'utf8');
    expect(written).toContain('# Token meter');
    expect(written).toContain('**AC1** — A running node shows a live token count');
    expect(written).toContain('cannot edit this file');
  });

  it('spends nothing when the criteria are written by hand', async () => {
    let sessions = 0;
    const { ctx, repoRoot } = contextFor(
      'spec',
      { title: 'Given', acceptanceCriteria: ['`foo --bar` exits 0'] },
      () => {
        sessions++;
        return '{}';
      },
    );

    const output = (await collectResult(ctx, executeSpec)) as {
      specPath: string;
      title: string;
      acceptanceCriteria: Array<{ id: string; text: string }>;
    };

    expect(sessions).toBe(0);
    expect(output.title).toBe('Given');
    expect(output.acceptanceCriteria).toEqual([{ id: 'AC1', text: '`foo --bar` exits 0' }]);
    expect(readFileSync(join(repoRoot, output.specPath), 'utf8')).toContain('`foo --bar` exits 0');
  });

  it('keeps configured requirements verbatim and ahead of the agent’s', async () => {
    const { ctx } = contextFor('spec', { requirements: ['must stay ASCII'] }, () =>
      JSON.stringify({
        title: 'T',
        requirements: ['also be fast'],
        acceptanceCriteria: ['it works'],
      }),
    );
    const output = (await collectResult(ctx, executeSpec)) as { requirements: string[] };
    expect(output.requirements).toEqual(['must stay ASCII', 'also be fast']);
  });
});

describe('acceptanceCriteriaFrom', () => {
  it('finds criteria in an upstream spec output', () => {
    const criteria = acceptanceCriteriaFrom([
      upstreamOf('test', 'test', { passed: true }),
      upstreamOf('spec', 'spec', { acceptanceCriteria: [{ id: 'AC1', text: 'it works' }] }),
    ]);
    expect(criteria).toEqual([{ id: 'AC1', text: 'it works' }]);
  });

  it('ignores a truncated output — half a contract is worse than none', () => {
    expect(
      acceptanceCriteriaFrom([
        {
          nodeId: 'spec',
          typeId: 'spec',
          outputJson: JSON.stringify({ acceptanceCriteria: [{ id: 'AC1', text: 'x' }] }),
          truncated: true,
        },
      ]),
    ).toEqual([]);
  });

  it('returns nothing when no upstream node carries criteria', () => {
    expect(acceptanceCriteriaFrom([upstreamOf('impl', 'implement', { changedFiles: [] })])).toEqual(
      [],
    );
  });
});

describe('Validate against acceptance criteria', () => {
  const withSpec = [
    upstreamOf('spec', 'spec', {
      acceptanceCriteria: [
        { id: 'AC1', text: 'a live token count' },
        { id: 'AC2', text: 'a run total' },
      ],
    }),
  ];

  it('asks for one answer per criterion, quoting them', async () => {
    const { ctx, prompts } = contextFor(
      'validate',
      {},
      () =>
        JSON.stringify({
          verdict: 'pass',
          notes: 'both present',
          criteria: [
            { id: 'AC1', met: true, evidence: 'canvas.ts:170' },
            { id: 'AC2', met: true, evidence: 'App.tsx:660' },
          ],
        }),
      withSpec,
    );

    const output = (await collectResult(ctx, executeValidate)) as { verdict: string };

    expect(prompts[0]).toContain('AC1: a live token count');
    expect(prompts[0]).toContain('AC2: a run total');
    expect(output.verdict).toBe('pass');
  });

  it('computes a fail from an unmet criterion, whatever the model concluded', async () => {
    const { ctx } = contextFor(
      'validate',
      {},
      () =>
        JSON.stringify({
          // The model says pass; one criterion says otherwise, and it wins.
          verdict: 'pass',
          notes: 'looks good to me',
          criteria: [
            { id: 'AC1', met: true, evidence: 'present' },
            { id: 'AC2', met: false, evidence: 'no run total anywhere' },
          ],
        }),
      withSpec,
    );

    const output = (await collectResult(ctx, executeValidate)) as {
      verdict: string;
      notes: string;
    };

    expect(output.verdict).toBe('fail');
    expect(output.notes).toContain('1 of 2 acceptance criteria unmet (AC2)');
  });

  it('counts a criterion the model simply ignored as unmet', async () => {
    const { ctx } = contextFor(
      'validate',
      {},
      () =>
        JSON.stringify({
          verdict: 'pass',
          notes: 'fine',
          criteria: [{ id: 'AC1', met: true, evidence: 'present' }],
        }),
      withSpec,
    );

    const output = (await collectResult(ctx, executeValidate)) as {
      verdict: string;
      criteria: Array<{ id: string; met: boolean; evidence: string }>;
    };

    expect(output.verdict).toBe('fail');
    expect(output.criteria).toHaveLength(2);
    expect(output.criteria[1]).toMatchObject({ id: 'AC2', met: false });
  });

  it('leaves plain validation (no spec upstream) exactly as it was', async () => {
    const { ctx, prompts } = contextFor('validate', {}, () =>
      JSON.stringify({ verdict: 'pass', notes: 'intent satisfied' }),
    );

    const output = (await collectResult(ctx, executeValidate)) as {
      verdict: string;
      criteria: unknown[];
    };

    expect(prompts[0]).not.toContain('acceptance criterion');
    expect(output.verdict).toBe('pass');
    expect(output.criteria).toEqual([]);
  });
});
