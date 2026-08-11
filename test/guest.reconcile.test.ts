/**
 * The check that a reported run is not merely self-consistent.
 *
 * Validation can prove a transition was legal; enforcement can narrow what a
 * session may do. Neither touches the question this answers: did the work
 * actually happen. The tree is the only witness that does not depend on the
 * reporting agent's honesty, so every case here is about what the repository
 * says versus what the run claims — including the case where the repository
 * cannot say anything, which must not read as agreement.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatReport,
  readReport,
  reconcileRun,
  writeReport,
} from '../src/guest/reconcile.js';
import { openGuestRun, reportTransition } from '../src/guest/report.js';
import { listRunStates, runFilePath } from '../src/runstate/persist.js';
import type { RunState } from '../src/runstate/types.js';
import { latestRunState } from '../src/runstate/watch.js';
import { rehydrateGraph } from '../src/workflow/record.js';
import { makeTempGitRepo } from './helpers.js';

const YAML = `
nodes:
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
  - id: review
    type: review
    config: { instructions: review it }
edges:
  - { from: implement, to: check }
  - { from: check, to: review }
`;

function repoWithWorkflow(): string {
  const repo = makeTempGitRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), YAML);
  return repo;
}

/** Reconcile whatever the repo's latest run is. */
async function check(repo: string, state?: RunState) {
  const run = state ?? latestRunState(repo)!;
  return reconcileRun(repo, run, rehydrateGraph(run.graph!, { repoRoot: repo }));
}

/** Walk to `implement` complete, claiming `changedFiles`. */
async function implementClaiming(repo: string, changedFiles: string[]): Promise<string> {
  const { runId } = await openGuestRun(repo, { surface: 'cli' });
  reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
  reportTransition(repo, runId, {
    nodeId: 'implement',
    kind: 'done',
    output: { changedFiles, diff: '@@' },
  });
  return runId;
}

describe('a claim the tree does not support', () => {
  it('is reported, naming the node and the file it did not find', async () => {
    const repo = repoWithWorkflow();
    // The baseline is captured at open; nothing is written afterwards.
    await implementClaiming(repo, ['src/a.ts']);

    const report = await check(repo);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.nodeId).toBe('implement');
    // Actionable: a person can check this claim in one command. "The tree
    // looks unchanged" would not be.
    expect(report.findings[0]!.detail).toContain('src/a.ts');
    expect(report.findings[0]!.detail).toContain('unchanged');
  });

  it('is not reported when the file really did change', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: ['src/a.ts'], diff: '@@' },
    });

    const report = await check(repo);
    expect(report.findings).toEqual([]);
    expect(report.supported).toContain('implement');
  });

  it('flags a node that claims nothing while the tree has not moved at all', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });

    const report = await check(repo);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.detail).toContain('nothing in the repository has changed');
    expect(runId).toBeTruthy();
  });
});

describe('nodes that modify nothing', () => {
  it('are skipped rather than flagged for leaving the tree alone', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: ['src/a.ts'], diff: '@@' },
    });
    reportTransition(repo, runId, { nodeId: 'check', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'check',
      kind: 'done',
      output: { passed: true, commands: [] },
    });
    reportTransition(repo, runId, { nodeId: 'review', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'review',
      kind: 'done',
      output: { verdict: 'pass', findings: [] },
    });

    const report = await check(repo);
    expect(report.findings).toEqual([]);
    // Test and Review hold neither `edit` nor `git-write`: flagging them for
    // not changing the repository would be flagging them for doing their job.
    expect(report.exempt.map((e) => e.nodeId).sort()).toEqual(['check', 'review']);
    expect(report.exempt[0]!.reason).toContain('does not modify the repository');
  });

  it('classifies by capability, so a new node type is right the day it is added', async () => {
    const repo = repoWithWorkflow();
    await implementClaiming(repo, ['src/a.ts']);
    const report = await check(repo);
    // `implement` holds `edit`, so it is checked rather than exempted.
    expect(report.exempt.map((e) => e.nodeId)).not.toContain('implement');
  });
});

describe('a run that cannot be checked', () => {
  it('says so, rather than reporting agreement', async () => {
    const repo = repoWithWorkflow();
    await implementClaiming(repo, ['src/a.ts']);
    const state = latestRunState(repo)!;

    const report = await reconcileRun(
      repo,
      { ...state, baseline: null },
      rehydrateGraph(state.graph!, { repoRoot: repo }),
    );
    // The difference between "nothing is wrong" and "nothing could be
    // examined" — letting the second read as the first turns an absent check
    // into a clean bill of health.
    expect(report.unreconcilable).toContain('no baseline');
    expect(report.findings).toEqual([]);
    expect(formatReport(report)).toContain('cannot be reconciled');
  });
});

describe('reconciliation never rewrites the run it checks', () => {
  it('leaves the run document byte-identical, findings or not', async () => {
    const repo = repoWithWorkflow();
    const runId = await implementClaiming(repo, ['src/a.ts']);
    const before = readFileSync(runFilePath(repo, runId), 'utf8');

    const report = await check(repo);
    expect(report.findings.length).toBeGreaterThan(0);
    writeReport(repo, report);

    // The run's own record of what was reported is not the place for someone
    // else's opinion of it.
    expect(readFileSync(runFilePath(repo, runId), 'utf8')).toBe(before);
  });

  it('puts its report beside the run, where a viewer can read it', async () => {
    const repo = repoWithWorkflow();
    const runId = await implementClaiming(repo, ['src/a.ts']);
    writeReport(repo, await check(repo));

    const report = readReport(repo, runId)!;
    expect(report.runId).toBe(runId);
    expect(report.findings[0]!.nodeId).toBe('implement');
  });

  it('reads as absent when no check has been run', async () => {
    const repo = repoWithWorkflow();
    const runId = await implementClaiming(repo, ['src/a.ts']);
    expect(readReport(repo, runId)).toBeUndefined();
  });
});

describe('a committing node', () => {
  it('is flagged when it claims a commit and HEAD has not moved', async () => {
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(
      join(repo, '.flow-code', 'workflow.yaml'),
      `
nodes:
  - id: ship
    type: git-ops
    config: { commitMessage: ship it }
edges: []
`,
    );
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'ship', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'ship',
      kind: 'done',
      output: { committed: true, pushed: false },
    });

    const report = await check(repo);
    expect(report.findings[0]!.detail).toContain('HEAD is still the run');
  });

  it('is satisfied once HEAD has actually moved', async () => {
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(
      join(repo, '.flow-code', 'workflow.yaml'),
      `
nodes:
  - id: ship
    type: git-ops
    config: { commitMessage: ship it }
edges: []
`,
    );
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'ship', kind: 'start' });
    writeFileSync(join(repo, 'NEW.md'), 'new\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'ship it'], { cwd: repo });
    reportTransition(repo, runId, {
      nodeId: 'ship',
      kind: 'done',
      output: { committed: true, pushed: false },
    });

    const report = await check(repo);
    expect(report.findings).toEqual([]);
    expect(report.supported).toContain('ship');
  });
});

describe('a report does not disturb the runs it describes', () => {
  it('is not itself picked up as a run', async () => {
    // Regression: reports were written as `<runId>.json.reconcile.json` inside
    // `runs/`, which every reader globs. The report was then read as a run
    // with no nodes — `watch` attached to it, `status` reported on it, and the
    // real run vanished from view. Found by running the command twice.
    const repo = repoWithWorkflow();
    const runId = await implementClaiming(repo, ['src/a.ts']);
    writeReport(repo, await check(repo));

    expect(listRunStates(repo).map((s) => s.runId)).toEqual([runId]);
    expect(latestRunState(repo)!.runId).toBe(runId);
    // And the run stays reconcilable a second time, which is what broke.
    expect((await check(repo)).findings).toHaveLength(1);
  });

  it('ignores anything in the runs directory that is not a run', async () => {
    const repo = repoWithWorkflow();
    const runId = await implementClaiming(repo, ['src/a.ts']);
    // Valid JSON, wrong shape — the readers used to take it at face value.
    writeFileSync(join(repo, '.flow-code', 'runs', 'notes.json'), '{"hello":"world"}');

    expect(listRunStates(repo).map((s) => s.runId)).toEqual([runId]);
    expect(latestRunState(repo)!.runId).toBe(runId);
  });
});

describe("flow-code's own bookkeeping is not mistaken for the agent's work", () => {
  it('does not let a written report make the tree look changed', async () => {
    // Reconciliation asks whether the tree moved since the baseline, and the
    // report is written *into* the repository. Left in the diff, the first
    // check would make every later one answer its own question — a node that
    // changed nothing would look supported from then on.
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });

    writeReport(repo, await check(repo));
    const second = await check(repo);
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]!.detail).toContain('nothing in the repository has changed');
  });
});
