import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/engine.js';
import type { ExecuteContext, NodeExecutor } from '../../src/engine/types.js';
import { builtinExecutors } from '../../src/executors/index.js';
import {
  parseNodeOutput,
  readsAsQuestionToUser,
  UnmetOutputContractError,
} from '../../src/executors/helpers.js';
import { reviewOutput, type NodeTypeId } from '../../src/registry/index.js';
import type { RunBaseline } from '../../src/runstate/types.js';
import { fakePorts, fakeSessions, storeFor, workflowFromYaml } from '../helpers.js';

const BASELINE: RunBaseline = { commit: 'c0', tree: 't0', dirtyOverride: false };

function contextFor(typeId: 'review' | 'discuss'): ExecuteContext {
  const wf = workflowFromYaml(
    typeId === 'review'
      ? 'nodes:\n  - id: n\n    type: review\nedges: []\n'
      : 'nodes:\n  - id: n\n    type: discuss\nedges: []\n',
  );
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-contract-'));
  return {
    node: wf.nodes[0]!,
    store: storeFor(wf, repoRoot),
  } as unknown as ExecuteContext;
}

describe('readsAsQuestionToUser', () => {
  it.each([
    ['Which database should I target?', true],
    ['I need more detail — could you tell me which module to change?', true],
    ['Let me know how you want this handled.', true],
    ['Should I proceed with the rename?', true],
    ['I reviewed the diff and found two issues.', false],
    ['', false],
    ['Is this a question? Yes. Here is the verdict: pass.', false],
  ])('classifies %j as %s', (text, expected) => {
    expect(readsAsQuestionToUser(text)).toBe(expected);
  });
});

describe('parseNodeOutput', () => {
  it('returns parsed output when the response conforms', () => {
    const ctx = contextFor('review');

    const parsed = parseNodeOutput(ctx, reviewOutput, '{"verdict":"pass","findings":[]}');

    expect(parsed.verdict).toBe('pass');
  });

  it('reports a question from a non-interactive node as the interactivity cause', () => {
    const ctx = contextFor('review');

    try {
      parseNodeOutput(ctx, reviewOutput, 'Which of the two modules should I review?');
      throw new Error('expected a failure');
    } catch (err) {
      expect(err).toBeInstanceOf(UnmetOutputContractError);
      expect((err as UnmetOutputContractError).cause).toBe('question');
      expect((err as Error).message).toContain('not interactive');
      expect((err as Error).message).toContain('`n` (review)');
    }
  });

  it('reports non-conforming output that is not a question as malformed', () => {
    const ctx = contextFor('review');

    try {
      parseNodeOutput(ctx, reviewOutput, '{"verdict":"maybe","findings":[]}');
      throw new Error('expected a failure');
    } catch (err) {
      expect((err as UnmetOutputContractError).cause).toBe('malformed');
      expect((err as Error).message).toContain('review output schema');
    }
  });

  it('never blames interactivity on an interactive node', () => {
    const ctx = contextFor('discuss');

    try {
      parseNodeOutput(ctx, reviewOutput, 'What would you like me to do?');
      throw new Error('expected a failure');
    } catch (err) {
      expect((err as UnmetOutputContractError).cause).toBe('malformed');
    }
  });

  it('retains the session response so the user can read what was said', () => {
    const ctx = contextFor('review');

    expect(() =>
      parseNodeOutput(ctx, reviewOutput, 'Which module should I review?'),
    ).toThrow();

    expect(ctx.store.liveOutputFor('n')).toContain('Which module should I review?');
  });
});

describe('an interactivity failure routes through a loop-back', () => {
  const YAML = `
nodes:
  - id: impl
    type: implement
    config: { instructions: build it }
  - id: check
    type: review
edges:
  - { from: impl, to: check }
  - { from: check, to: impl, loopback: { maxAttempts: 2 } }
`;

  it('re-runs the loop-back target, then gives up at the attempt bound', async () => {
    const workflow = workflowFromYaml(YAML);
    const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-contract-loop-'));
    const store = storeFor(workflow, repoRoot);

    // Review always ends by asking a question; Implement always succeeds.
    const sessions = fakeSessions((req) =>
      req.nodeId === 'check' ? 'Which module should I review?' : 'done',
    );
    const implFake: NodeExecutor = async function* () {
      yield { type: 'status', status: 'running' };
      yield { type: 'result', output: { changedFiles: [], diff: '', summary: 's' } };
      yield { type: 'status', status: 'done' };
    };
    const executors = {
      ...builtinExecutors,
      implement: implFake,
    } as Record<NodeTypeId, NodeExecutor>;

    await new Engine({
      workflow,
      store,
      repoRoot,
      baseline: BASELINE,
      ports: fakePorts(),
      sessions,
      executors,
    }).run();

    const check = store.node('check');
    expect(check.status).toBe('error');
    expect(check.statusDetail).toContain('not interactive');
    // The bound was honoured: two attempts, then the failure stands.
    expect(check.attempt).toBe(2);
    expect(store.node('impl').attempt).toBe(2);
  });
});
