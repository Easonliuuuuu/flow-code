/**
 * The reporting surface as an agent actually meets it: argv in, exit code and
 * a sentence out. The writer underneath is covered in `guest.report.test.ts`;
 * what is only reachable here is argument handling, run resolution when no id
 * is given, and the contract that a refusal exits non-zero — which is the
 * whole of how a shell-driven agent tells success from failure.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNode } from '../src/cli/node.js';
import { latestRunState } from '../src/runstate/watch.js';
import { makeTempGitRepo } from './helpers.js';

const YAML = `
nodes:
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
edges:
  - { from: implement, to: check }
`;

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  if (Object.prototype.hasOwnProperty.call(process.stdin, 'isTTY')) delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
});

function enableTty(): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
}

function repoWithWorkflow(): string {
  const repo = makeTempGitRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), YAML);
  return repo;
}

interface Run {
  out: string;
  err: string;
  exited: boolean;
}

/** Run a subcommand in `repo`, capturing what an agent would see. */
async function node(repo: string, ...args: string[]): Promise<Run> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  // `fail` exits the process; throwing stands in for that so the test can
  // continue, and `exited` records that a non-zero exit was taken.
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('__exit__');
  });
  process.chdir(repo);
  let exited = false;
  try {
    await cmdNode(args);
  } catch (err) {
    if (err instanceof Error && err.message === '__exit__') exited = true;
    else throw err;
  }
  const joined = (spy: typeof log): string => spy.mock.calls.map(([l]) => String(l)).join('\n');
  const result = { out: joined(log), err: joined(error), exited };
  log.mockRestore();
  error.mockRestore();
  exit.mockRestore();
  return result;
}

describe('a whole workflow driven over the CLI', () => {
  it('walks the graph and leaves a run a viewer can render', async () => {
    const repo = repoWithWorkflow();

    const opened = await node(repo, 'open', '--json');
    expect(opened.exited).toBe(false);
    const { runId, order } = JSON.parse(opened.out) as { runId: string; order: string[] };
    expect(order).toEqual(['implement', 'check']);

    // No run id passed to anything below: an agent working one graph in one
    // session should never have to carry it.
    expect((await node(repo, 'start', 'implement')).out).toContain('implement → running');
    await node(repo, 'done', 'implement', '--output', '{"changedFiles":["src/a.ts"],"diff":"@@"}');
    await node(repo, 'start', 'check');
    await node(repo, 'done', 'check', '--output', '{"passed":true,"commands":[]}');
    const closed = await node(repo, 'close');
    expect(closed.exited).toBe(false);

    // What `flow-code watch` reads is exactly this document.
    const state = latestRunState(repo)!;
    expect(state.runId).toBe(runId);
    expect(state.nodes.implement!.status).toBe('done');
    expect(state.nodes.check!.status).toBe('done');
    expect(state.finishedAt).toBeDefined();
    expect(state.enforcement).toMatchObject({ tier: 'reported', surface: 'cli' });
    // The graph travels with the run, so the viewer needs no workflow file.
    expect(state.graph?.nodes.map((n) => n.id)).toEqual(['implement', 'check']);
  });

  it('reports where the run is, so an agent can re-orient after losing its place', async () => {
    const repo = repoWithWorkflow();
    await node(repo, 'open');
    await node(repo, 'start', 'implement');

    const status = await node(repo, 'current');
    expect(status.out).toContain('running');
    expect(status.out).toContain('implement');
    expect(status.out).toContain('idle');
    expect(status.out).toContain('check');
  });
});

describe('refusals', () => {
  it('exit non-zero, with the reason on stderr', async () => {
    const repo = repoWithWorkflow();
    await node(repo, 'open');

    const outOfOrder = await node(repo, 'start', 'check');
    expect(outOfOrder.exited).toBe(true);
    expect(outOfOrder.err).toContain('implement');

    const unknown = await node(repo, 'start', 'deploy');
    expect(unknown.exited).toBe(true);
    expect(unknown.err).toContain('deploy');
  });

  it('reject output that is not JSON before it ever reaches the schema', async () => {
    const repo = repoWithWorkflow();
    await node(repo, 'open');
    await node(repo, 'start', 'implement');

    const bad = await node(repo, 'done', 'implement', '--output', 'not json');
    expect(bad.exited).toBe(true);
    // Reported as malformed input rather than as a shape mismatch, which would
    // send an agent looking for the wrong problem.
    expect(bad.err).toContain('not valid JSON');
  });

  it('name the offending field when output does not match the node type', async () => {
    const repo = repoWithWorkflow();
    await node(repo, 'open');
    await node(repo, 'start', 'implement');

    const bad = await node(repo, 'done', 'implement', '--output', '{"changedFiles":"src/a.ts"}');
    expect(bad.exited).toBe(true);
    expect(bad.err).toContain('changedFiles');
  });

  it('say what to do when no run is open at all', async () => {
    const repo = repoWithWorkflow();
    const orphan = await node(repo, 'start', 'implement');
    expect(orphan.exited).toBe(true);
    expect(orphan.err).toContain('flow-code node open');
  });
});

describe('a Plan node completed over the CLI', () => {
  const PLANNED = `
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: ship }
`;

  const PROPOSAL = JSON.stringify({
    nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'build it' } }],
    edges: [],
  });

  function plannedRepo(): string {
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), PLANNED);
    return repo;
  }

  it('prints the ids the run now holds, in graph order', async () => {
    const repo = plannedRepo();
    await node(repo, 'open');
    await node(repo, 'start', 'plan');

    await node(repo, 'propose-plan', 'plan', '--output', PROPOSAL);
    enableTty();
    const done = await node(repo, 'accept-plan', 'plan');

    expect(done.exited).toBe(false);
    expect(done.out).toContain('plan → done');
    // The proposed node appears in no instructions this session has read, so
    // the report is the only place it can come from.
    expect(done.out).toContain('plan → impl → gate → ship');
  });

  it('prints nothing extra for a step that did not grow the graph', async () => {
    const repo = plannedRepo();
    await node(repo, 'open');
    await node(repo, 'start', 'plan');
    await node(repo, 'propose-plan', 'plan', '--output', PROPOSAL);
    enableTty();
    await node(repo, 'accept-plan', 'plan');

    const started = await node(repo, 'start', 'impl');

    expect(started.out).toContain('impl → running');
    expect(started.out).not.toContain('the run now holds');
  });

  it('exits non-zero and leaves the step running when the proposal does not build', async () => {
    const repo = plannedRepo();
    await node(repo, 'open');
    await node(repo, 'start', 'plan');

    const bad = await node(
      repo,
      'propose-plan',
      'plan',
      '--output',
      JSON.stringify({ nodes: [{ id: 'sneak', type: 'git-ops', config: {} }], edges: [] }),
    );

    expect(bad.exited).toBe(true);
    expect(bad.err).toContain('Approval-Gate');
    expect(latestRunState(repo)!.nodes.plan!.status).toBe('running');
  });
});

describe('help', () => {
  it('lists the subcommands and states that nothing is enforced', async () => {
    const repo = repoWithWorkflow();
    const help = await node(repo);
    expect(help.out).toContain('flow-code node open');
    expect(help.out).toContain('`reported` tier');
  });
});
