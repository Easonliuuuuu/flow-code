/**
 * A Plan node growing the graph on the reported path.
 *
 * The property that matters most here is the one about refusals. An expansion
 * is the only report that can fail *after* the transition itself is legal —
 * the node is running, the output matches the schema, and the proposal still
 * does not build. When that happens the run must be exactly where it was, so
 * the agent can propose again; a run left with a `done` Plan node and an
 * unexpanded graph would be a run with nowhere to go and no way to say so.
 *
 * The other property is parity: the recorded graph a guest produces has to be
 * the one the engine produces, or a proposal accepted from a Claude Code
 * session would be one `flow-code run` refuses.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuestReportError, acceptPlan, openGuestRun, proposePlan, reportTransition } from '../src/guest/report.js';
import { runFilePath } from '../src/runstate/persist.js';
import { latestRunState } from '../src/runstate/watch.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { expandRecordedGraph } from '../src/workflow/record.js';
import type { PlanProposal } from '../src/workflow/splice.js';
import { makeTempGitRepo } from './helpers.js';

/**
 * A graph whose only fixed steps are the gate and the git write behind it —
 * the shape the `planned` preset has, and the one that makes the dominance
 * rule load-bearing: everything between them is whatever gets proposed.
 */
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

const GOOD_PROPOSAL: PlanProposal = {
  nodes: [
    { id: 'impl', type: 'implement', config: { instructions: 'build it' } },
    { id: 'check', type: 'test', config: { commands: ['echo ok'] } },
  ],
  edges: [{ from: 'impl', to: 'check' }],
};

function repoWithPlannedWorkflow(yaml = PLANNED): string {
  const repo = makeTempGitRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), yaml);
  return repo;
}

function rawDocument(repo: string, runId: string): string {
  return readFileSync(runFilePath(repo, runId), 'utf8');
}

/** Open a run and get its Plan node to the point where it can be completed. */
async function runAtPlan(yaml = PLANNED): Promise<{ repo: string; runId: string }> {
  const repo = repoWithPlannedWorkflow(yaml);
  const { runId } = await openGuestRun(repo, { surface: 'cli' });
  reportTransition(repo, runId, { nodeId: 'plan', kind: 'start' });
  return { repo, runId };
}

function acceptProposal(repo: string, runId: string, proposal: PlanProposal = GOOD_PROPOSAL) {
  proposePlan(repo, runId, 'plan', proposal);
  return acceptPlan(repo, runId, 'plan');
}

describe('a reported Plan node expands the run', () => {
  it('splices the proposal into the recorded graph, between plan and its successors', async () => {
    const { repo, runId } = await runAtPlan();

    acceptProposal(repo, runId);

    const state = latestRunState(repo)!;
    expect(state.graph!.nodes.map((n) => n.id).sort()).toEqual([
      'check',
      'gate',
      'impl',
      'plan',
      'ship',
    ]);
    // Spliced *between*, not appended: the gate still guards `ship`, and the
    // proposal now stands where the plan node's own edge to it used to.
    expect(state.graph!.edges).toContainEqual({ from: 'plan', to: 'impl' });
    expect(state.graph!.edges).toContainEqual({ from: 'check', to: 'gate' });
    expect(state.graph!.edges).not.toContainEqual({ from: 'plan', to: 'gate' });
  });

  it('records the plan node done with its proposal, and seeds the new nodes idle', async () => {
    const { repo, runId } = await runAtPlan();

    acceptProposal(repo, runId);

    const state = latestRunState(repo)!;
    expect(state.nodes.plan!.status).toBe('done');
    expect(state.nodes.plan!.output).toMatchObject({ nodes: expect.any(Array) });
    expect(state.nodes.impl!.status).toBe('idle');
    expect(state.nodes.check!.status).toBe('idle');
    // Nodes the run already had are untouched — the expansion adds, it does
    // not reset.
    expect(state.nodes.gate!.status).toBe('idle');
    expect(state.nodes.ship!.status).toBe('idle');
  });

  it('returns the node ids the run now holds, in graph order', async () => {
    const { repo, runId } = await runAtPlan();

    const outcome = acceptProposal(repo, runId);

    expect(outcome.order).toEqual(['plan', 'impl', 'check', 'gate', 'ship']);
  });

  it('says nothing about an order for a report that did not expand anything', async () => {
    const { repo, runId } = await runAtPlan();
    acceptProposal(repo, runId);

    const outcome = reportTransition(repo, runId, { nodeId: 'impl', kind: 'start' });

    expect(outcome.order).toBeUndefined();
  });

  it('lets the run report against a node that exists only because the proposal added it', async () => {
    const { repo, runId } = await runAtPlan();
    // Before expansion this id is not in the graph at all, and validation
    // rejects it as unknown — the state this whole change exists to leave.
    expect(() => reportTransition(repo, runId, { nodeId: 'impl', kind: 'start' })).toThrow(
      /unknown node `impl`/,
    );

    acceptProposal(repo, runId);
    reportTransition(repo, runId, { nodeId: 'impl', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'impl',
      kind: 'done',
      output: { changedFiles: ['src/a.ts'], diff: '@@ -1 +1 @@' },
    });

    expect(latestRunState(repo)!.nodes.impl!.status).toBe('done');
  });

  it('keeps the run walking the graph it was opened against', async () => {
    const repo = repoWithPlannedWorkflow(`
graphs:
  ship:
${PLANNED.replace(/^/gm, '    ').replace(/^\s+$/gm, '')}
`);
    const { runId } = await openGuestRun(repo, { surface: 'cli', graph: 'ship' });
    reportTransition(repo, runId, { nodeId: 'plan', kind: 'start' });
    expect(latestRunState(repo)!.graph!.selected).toBe('ship');

    acceptProposal(repo, runId);

    // The name identifies the run wherever it is displayed (`flow-code runs`,
    // the viewer's header). Losing it on expansion would make a run that had
    // been walking `ship` suddenly walk nothing in particular.
    expect(latestRunState(repo)!.graph!.selected).toBe('ship');
  });

  it('leaves the tier and its absent guarantees exactly as they were', async () => {
    const { repo, runId } = await runAtPlan();
    const before = latestRunState(repo)!.enforcement;

    acceptProposal(repo, runId);

    // Expanding is not an escalation: a run reported at `reported` before the
    // graph grew is reported at `reported` after it.
    expect(latestRunState(repo)!.enforcement).toEqual(before);
  });
});

describe('a proposal that does not build is refused', () => {
  /** Report `proposal` and return both the refusal and whether the run moved. */
  async function refuse(proposal: PlanProposal): Promise<{ message: string; unchanged: boolean }> {
    const { repo, runId } = await runAtPlan();
    const before = rawDocument(repo, runId);
    let message = '';
    try {
    proposePlan(repo, runId, 'plan', proposal);
      throw new Error('expected the report to be refused');
    } catch (err) {
      if (!(err instanceof GuestReportError)) throw err;
      message = err.message;
    }
    return { message, unchanged: rawDocument(repo, runId) === before };
  }

  it('refuses a proposal that reaches a git write without passing the gate', async () => {
    // `sneak` holds git-write and hangs straight off the plan node, so a path
    // from the root reaches it with no gate in between. This is the failure an
    // agent-authored proposal is most likely to trip, and the one guarantee
    // that must survive on a path flow-code is not executing.
    const { message, unchanged } = await refuse({
      nodes: [{ id: 'sneak', type: 'git-ops', config: {} }],
      edges: [],
    });

    expect(message).toContain('sneak');
    expect(message).toContain('Approval-Gate');
    expect(unchanged).toBe(true);
  });

  it('refuses an unknown node type', async () => {
    const { message, unchanged } = await refuse({
      nodes: [{ id: 'x', type: 'not-a-node-type', config: {} }],
      edges: [],
    });

    expect(message).toContain('not-a-node-type');
    expect(unchanged).toBe(true);
  });

  it('refuses a proposal that duplicates a node the run already has', async () => {
    const { message, unchanged } = await refuse({
      nodes: [{ id: 'gate', type: 'implement', config: { instructions: 'x' } }],
      edges: [],
    });

    expect(message).toContain('gate');
    expect(unchanged).toBe(true);
  });

  it('refuses a second Plan node', async () => {
    const { message, unchanged } = await refuse({
      nodes: [{ id: 'plan2', type: 'plan', config: {} }],
      edges: [],
    });

    expect(message).toContain('plan');
    expect(unchanged).toBe(true);
  });

  it('refuses an edge to a node that does not exist', async () => {
    const { message, unchanged } = await refuse({
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
      edges: [{ from: 'impl', to: 'nowhere' }],
    });

    expect(message).toContain('nowhere');
    expect(unchanged).toBe(true);
  });

  it('leaves the plan node running, and takes a corrected proposal afterwards', async () => {
    const { repo, runId } = await runAtPlan();
    expect(() =>
    proposePlan(repo, runId, 'plan', { nodes: [{ id: 'sneak', type: 'git-ops', config: {} }], edges: [] }),
    ).toThrow(GuestReportError);

    // Still `running`, so `done` is a legal transition — which is what makes
    // "propose again" something the agent can actually do rather than advice.
    expect(latestRunState(repo)!.nodes.plan!.status).toBe('running');
    acceptProposal(repo, runId);
    expect(latestRunState(repo)!.nodes.plan!.status).toBe('done');
  });

  it('says which node proposed the graph and that it may propose again', async () => {
    const { message } = await refuse({
      nodes: [{ id: 'sneak', type: 'git-ops', config: {} }],
      edges: [],
    });

    expect(message).toContain('`plan`');
    expect(message).toContain('propose again');
  });
});

describe('the guest and the engine expand identically', () => {
  it('produces the recorded graph `driveEngine` would produce from the same proposal', async () => {
    const { repo, runId } = await runAtPlan();

    acceptProposal(repo, runId);
    const viaGuest = latestRunState(repo)!.graph!;

    // What `driveEngine` calls, with the same arguments it has to hand. If the
    // reported path ever grew a splice of its own, this is the test that would
    // fail first.
    const { graph: viaEngine } = expandRecordedGraph(
      loadWorkflowFromString(PLANNED, { repoRoot: repo }),
      'plan',
      GOOD_PROPOSAL,
      { repoRoot: repo },
    );

    expect(viaGuest).toEqual(viaEngine);
  });

  it('refuses on the same terms the engine does', async () => {
    const repo = repoWithPlannedWorkflow();
    const bad: PlanProposal = { nodes: [{ id: 'sneak', type: 'git-ops', config: {} }], edges: [] };

    let engineMessage = '';
    try {
      expandRecordedGraph(loadWorkflowFromString(PLANNED, { repoRoot: repo }), 'plan', bad, {
        repoRoot: repo,
      });
    } catch (err) {
      engineMessage = (err as Error).message;
    }

    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'plan', kind: 'start' });
    let guestMessage = '';
    try {
    proposePlan(repo, runId, 'plan', bad);
    } catch (err) {
      guestMessage = (err as Error).message;
    }

    // The guest wraps the build's message in context an agent needs; the
    // build's own account of what is wrong has to survive that wrapping
    // verbatim, or the two paths are telling different stories.
    const problems = engineMessage.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(problems.length).toBeGreaterThan(0);
    for (const line of problems) expect(guestMessage).toContain(line.trim().slice(2));
  });
});
