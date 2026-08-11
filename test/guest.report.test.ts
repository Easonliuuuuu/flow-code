/**
 * The writer behind both reporting surfaces.
 *
 * Two properties carry most of the weight here, and both are about what does
 * *not* happen: a refused report leaves the document byte-identical, and a run
 * an engine is driving is never written by anything else. Everything a
 * reported graph is worth depends on those holding under a reporter that is
 * wrong rather than malicious.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeGuestRun,
  currentGuestRun,
  GuestReportError,
  openGuestRun,
  reportTransition,
} from '../src/guest/report.js';
import { FileRunStatePersister, listRunStates, runFilePath } from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { RunState } from '../src/runstate/types.js';
import { latestRunState } from '../src/runstate/watch.js';
import { recordGraph } from '../src/workflow/record.js';
import { makeTempGitRepo, workflowFromYaml } from './helpers.js';

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

function repoWithWorkflow(): string {
  const repo = makeTempGitRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), YAML);
  return repo;
}

function rawDocument(repo: string, runId: string): string {
  return readFileSync(runFilePath(repo, runId), 'utf8');
}

const IMPLEMENT_OUTPUT = { changedFiles: ['src/a.ts'], diff: '@@ -1 +1 @@' };

describe('opening a reported run', () => {
  it('records the reported tier, the surface, and the guarantees it does not provide', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });

    const state = latestRunState(repo)!;
    expect(state.runId).toBe(runId);
    expect(state.enforcement).toMatchObject({ tier: 'reported', surface: 'cli' });
    // Enumerated rather than implied: a consumer reads what is missing, it
    // does not derive it from the tier name and a table of its own.
    expect(state.enforcement!.absent).toContain('capability-enforcement');
    expect(state.enforcement!.absent).toContain('token-accounting');
  });

  it('starts every node idle, with the graph recorded, so a viewer draws the shape immediately', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'cli' });

    const state = latestRunState(repo)!;
    expect(Object.keys(state.nodes).sort()).toEqual(['check', 'implement']);
    expect(Object.values(state.nodes).every((n) => n.status === 'idle')).toBe(true);
    expect(state.graph?.nodes.map((n) => n.id)).toEqual(['implement', 'check']);
  });

  it('records no driver pid, because the session doing the work is not one we can see', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'cli' });

    // The reporting process exits between transitions. Stamping its pid would
    // make a healthy run read as abandoned the moment the command returned.
    expect(latestRunState(repo)!.owner?.pid).toBe(0);
  });

  it('carries no activity log or token counts, so absent guarantees are not faked as data', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'done', output: IMPLEMENT_OUTPUT });

    const state = latestRunState(repo)!;
    expect(state.activity).toEqual([]);
    expect(state.nodes.implement!.tokens).toBeUndefined();
    expect(state.nodes.implement!.denials).toBe(0);
  });
});

describe('reporting transitions', () => {
  it('walks a whole graph and closes it', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });

    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    expect(latestRunState(repo)!.nodes.implement!.status).toBe('running');
    expect(latestRunState(repo)!.nodes.implement!.startedAt).toBeDefined();

    reportTransition(repo, runId, { nodeId: 'implement', kind: 'done', output: IMPLEMENT_OUTPUT });
    reportTransition(repo, runId, { nodeId: 'check', kind: 'start' });
    reportTransition(repo, runId, {
      nodeId: 'check',
      kind: 'done',
      output: { passed: true, commands: [] },
    });
    closeGuestRun(repo, runId);

    const state = latestRunState(repo)!;
    expect(state.nodes.check!.status).toBe('done');
    expect(state.nodes.implement!.output).toEqual(IMPLEMENT_OUTPUT);
    expect(state.finishedAt).toBeDefined();
    // A closed run is finished, not abandoned — the distinction a viewer draws
    // between "it ended" and "whatever was driving it disappeared".
    expect(state.interrupted).toBe(false);
  });

  it('leaves the document byte-identical when a report is refused', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    const before = rawDocument(repo, runId);

    expect(() => reportTransition(repo, runId, { nodeId: 'check', kind: 'start' })).toThrow(
      GuestReportError,
    );
    expect(() =>
      reportTransition(repo, runId, { nodeId: 'implement', kind: 'done', output: { wrong: true } }),
    ).toThrow(GuestReportError);
    expect(() => reportTransition(repo, runId, { nodeId: 'nope', kind: 'start' })).toThrow(
      GuestReportError,
    );

    expect(rawDocument(repo, runId)).toBe(before);
  });

  it('counts a re-entered node as a further attempt', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'fail', reason: 'wrong approach' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    const node = latestRunState(repo)!.nodes.implement!;
    expect(node.attempt).toBe(2);
    expect(node.status).toBe('running');
    // The failure's detail belonged to the attempt that failed.
    expect(node.statusDetail).toBeUndefined();
  });

  it('refuses to report into a run that has been closed', async () => {
    const repo = repoWithWorkflow();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    closeGuestRun(repo, runId);
    expect(() => reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' })).toThrow(
      /already closed/,
    );
  });
});

describe('a run the engine is driving', () => {
  /** An engine-owned run, written by a store in this process — so its owner is live. */
  function engineRun(repo: string): RunState {
    const store = new RunStateStore({ repoRoot: repo, graph: recordGraph(workflowFromYaml(YAML)) });
    store.attachPersister(new FileRunStatePersister(repo));
    store.setStatus('implement', 'running');
    return store.snapshot();
  }

  it('records the engine tier with nothing absent', () => {
    const repo = repoWithWorkflow();
    const state = engineRun(repo);
    expect(state.enforcement).toEqual({ tier: 'engine', surface: 'engine', absent: [] });
  });

  it('refuses a report against it, and leaves its document byte-identical', () => {
    const repo = repoWithWorkflow();
    const engine = engineRun(repo);
    const before = rawDocument(repo, engine.runId);

    expect(() =>
      reportTransition(repo, engine.runId, { nodeId: 'implement', kind: 'fail', reason: 'nope' }),
    ).toThrow(/being driven/);
    expect(rawDocument(repo, engine.runId)).toBe(before);
  });

  it('is never what an unnamed report targets, even when it is the newest run', async () => {
    const repo = repoWithWorkflow();
    await openGuestRun(repo, { surface: 'cli' });
    const engine = engineRun(repo);

    // The engine's run is newer and unfinished; the reported one is what a
    // surface with no explicit run id means.
    const current = currentGuestRun(repo, listRunStates(repo));
    expect(current?.runId).not.toBe(engine.runId);
    expect(current?.enforcement?.tier).toBe('reported');
  });

  it('gets its own document when a guest opens a run alongside it', async () => {
    const repo = repoWithWorkflow();
    const engine = engineRun(repo);
    const { runId } = await openGuestRun(repo, { surface: 'cli' });

    expect(runId).not.toBe(engine.runId);
    // The engine's claims and the guest's are never merged into one history.
    expect(listRunStates(repo)).toHaveLength(2);
  });
});

describe('the two surfaces are the same writer', () => {
  it('produces equivalent run-state apart from run id, timestamps, and the recorded surface', async () => {
    /** Drive the identical sequence, recording it as having come from `surface`. */
    const drive = async (surface: 'cli' | 'mcp'): Promise<RunState> => {
      const repo = repoWithWorkflow();
      const { runId } = await openGuestRun(repo, { surface });
      reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
      reportTransition(repo, runId, {
        nodeId: 'implement',
        kind: 'done',
        output: IMPLEMENT_OUTPUT,
      });
      reportTransition(repo, runId, { nodeId: 'check', kind: 'start' });
      reportTransition(repo, runId, { nodeId: 'check', kind: 'fail', reason: 'one test failed' });
      return closeGuestRun(repo, runId);
    };

    const normalize = (state: RunState): unknown =>
      JSON.parse(
        JSON.stringify(state, (key, value) =>
          ['runId', 'createdAt', 'repoRoot', 'owner', 'startedAt', 'endedAt', 'finishedAt', 'surface', 'baseline'].includes(
            key,
          )
            ? '<normalized>'
            : (value as unknown),
        ),
      ) as unknown;

    expect(normalize(await drive('cli'))).toEqual(normalize(await drive('mcp')));
  });
});

describe('a loop-back the agent walks', () => {
  const LOOPING = `
nodes:
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
edges:
  - { from: implement, to: check }
  - { from: check, to: implement, loopback: { maxAttempts: 2 } }
`;

  function loopingRepo(): string {
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), LOOPING);
    return repo;
  }

  it('sends the re-run segment back to idle and keeps what each attempt did', async () => {
    const repo = loopingRepo();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });

    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'done', output: IMPLEMENT_OUTPUT });
    reportTransition(repo, runId, { nodeId: 'check', kind: 'start' });
    reportTransition(repo, runId, { nodeId: 'check', kind: 'fail', reason: 'one test failed' });

    // This is the exact call the generated instructions tell the agent to make.
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });

    const state = latestRunState(repo)!;
    expect(state.nodes.implement!.status).toBe('running');
    expect(state.nodes.implement!.attempt).toBe(2);
    // A stale output would read as this attempt's work.
    expect(state.nodes.implement!.output).toBeUndefined();
    expect(state.nodes.check!.status).toBe('idle');
    // What the failed attempt did is kept, which is how a viewer can show that
    // the run has been round this loop before.
    expect(state.nodes.check!.priorAttempts).toEqual([
      expect.objectContaining({ status: 'error', detail: 'one test failed' }),
    ]);
  });

  it('stops the loop once the failing step has spent its attempts', async () => {
    const repo = loopingRepo();
    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    const fail = (): void => {
      reportTransition(repo, runId, { nodeId: 'check', kind: 'start' });
      reportTransition(repo, runId, { nodeId: 'check', kind: 'fail', reason: 'still failing' });
    };

    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'done', output: IMPLEMENT_OUTPUT });
    fail();
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' });
    reportTransition(repo, runId, { nodeId: 'implement', kind: 'done', output: IMPLEMENT_OUTPUT });
    fail();

    expect(() => reportTransition(repo, runId, { nodeId: 'implement', kind: 'start' })).toThrow(
      /all 2 of its attempts/,
    );
  });
});
