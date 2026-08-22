import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { builtinExecutors } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import { PLACEHOLDER_TEST_COMMAND } from '../src/registry/index.js';
import type { TestOutput, ApprovalGateOutput } from '../src/registry/index.js';
import { RunStateStore } from '../src/runstate/store.js';
import { WORKFLOW_RELATIVE_PATH } from '../src/workflow/load.js';
import {
  fakePorts,
  fakeSessions,
  makeTempGitRepo,
  storeFor,
  throwingSessions,
  workflowFromYaml,
} from './helpers.js';
import type { FakePortOptions } from './helpers.js';

async function runReal(
  yaml: string,
  repo: string,
  opts: {
    ports?: ReturnType<typeof fakePorts>;
    sessions?: ReturnType<typeof fakeSessions>;
    portOpts?: FakePortOptions;
    store?: RunStateStore;
  } = {},
) {
  const workflow = workflowFromYaml(yaml);
  const store = opts.store ?? storeFor(workflow, repo);
  const baseline = await recordBaseline(repo, false);
  const ports = opts.ports ?? fakePorts(opts.portOpts ?? {});
  const engine = new Engine({
    workflow,
    store,
    repoRoot: repo,
    baseline,
    ports,
    sessions: opts.sessions ?? (throwingSessions() as never),
    executors: builtinExecutors,
  });
  await engine.run();
  return { store, ports, workflow, baseline };
}

describe('Test node (deterministic command runner)', () => {
  it('runs commands in order, records results, and consumes no agent session', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands:
        - echo first
        - echo second
`,
      repo,
    );
    expect(store.node('t').status).toBe('done');
    const output = store.node('t').output as TestOutput;
    expect(output.passed).toBe(true);
    expect(output.commands.map((c) => c.exitStatus)).toEqual([0, 0]);
    expect(output.commands[0]!.output).toContain('first');
    const activity = store.activityFor('t');
    expect(activity).toHaveLength(2);
    expect(activity.every((e) => e.decision === 'allowed' && e.exitStatus === 0)).toBe(true);
  });

  it('rediscovers its commands under `commands: auto`, then runs them', async () => {
    const repo = makeTempGitRepo();
    const sessions = fakeSessions(() =>
      JSON.stringify({ commands: [{ command: 'echo discovered', rationale: 'a package script' }] }),
    );
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands: auto
`,
      repo,
      { sessions },
    );

    expect(store.node('t').status).toBe('done');
    const output = store.node('t').output as TestOutput;
    expect(output.commands.map((c) => c.command)).toEqual(['echo discovered']);
    expect(output.commands[0]!.output).toContain('discovered');
    // Exactly one session, and it asked for nothing but read access.
    expect(sessions.requests).toHaveLength(1);
    expect([...sessions.requests[0]!.capabilities]).toEqual(['read']);
  });

  it('errors under `commands: auto` when no command can be determined', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands: auto
`,
      repo,
      { sessions: fakeSessions(() => '{"commands": []}') },
    );

    expect(store.node('t').status).toBe('error');
    expect(store.node('t').statusDetail).toContain('no test command');
    expect((store.node('t').output as TestOutput).passed).toBe(false);
  });

  it('asks what to run when it still holds the placeholder, then runs and saves the answer', async () => {
    const repo = makeTempGitRepo();
    const workflowPath = join(repo, WORKFLOW_RELATIVE_PATH);
    const yaml = `
nodes:
  - id: t
    type: test
    config:
      commands:
        - ${JSON.stringify(PLACEHOLDER_TEST_COMMAND)}
`;
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, yaml);
    const { store, ports } = await runReal(yaml, repo, {
      portOpts: { testCommands: ['echo chosen'] },
    });

    expect(ports.testCommandRequests).toHaveLength(1);
    expect(ports.testCommandRequests[0]!.nodeId).toBe('t');
    expect(store.node('t').status).toBe('done');
    const output = store.node('t').output as TestOutput;
    expect(output.commands.map((c) => c.command)).toEqual(['echo chosen']);
    // Saved, so the next run of this project never asks again.
    expect(readFileSync(workflowPath, 'utf8')).toContain('echo chosen');
    expect(readFileSync(workflowPath, 'utf8')).not.toContain('replace me');
  });

  it('passes with nothing to run when the user skips the question', async () => {
    const repo = makeTempGitRepo();
    const workflowPath = join(repo, WORKFLOW_RELATIVE_PATH);
    const yaml = `
nodes:
  - id: t
    type: test
    config:
      commands:
        - ${JSON.stringify(PLACEHOLDER_TEST_COMMAND)}
  - id: after
    type: test
    config: { commands: ["echo x"] }
edges:
  - { from: t, to: after }
`;
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, yaml);
    const before = readFileSync(workflowPath, 'utf8');
    const { store } = await runReal(yaml, repo, { portOpts: { testCommands: null } });

    // A project with no test suite yet is a real project: skipping doesn't
    // fail the node, and the rest of the graph still runs.
    expect(store.node('t').status).toBe('done');
    expect(store.node('t').statusDetail).toContain('no test command configured');
    expect((store.node('t').output as TestOutput).passed).toBe(true);
    expect(store.node('after').status).toBe('done');
    expect(readFileSync(workflowPath, 'utf8')).toBe(before);
  });

  it('never asks once real commands are configured', async () => {
    const repo = makeTempGitRepo();
    const { ports } = await runReal(
      `
nodes:
  - id: t
    type: test
    config: { commands: ["echo real"] }
`,
      repo,
      { portOpts: { testCommands: ['echo chosen'] } },
    );
    expect(ports.testCommandRequests).toHaveLength(0);
  });

  it('offers heuristics up front and spends a session only when the request asks', async () => {
    const repo = makeTempGitRepo();
    const workflowPath = join(repo, WORKFLOW_RELATIVE_PATH);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const yaml = `
nodes:
  - id: t
    type: test
    config:
      commands:
        - ${JSON.stringify(PLACEHOLDER_TEST_COMMAND)}
`;
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, yaml);
    const sessions = fakeSessions(() =>
      JSON.stringify({ commands: [{ command: 'echo found', rationale: 'a package script' }] }),
    );
    const { store } = await runReal(yaml, repo, {
      sessions,
      portOpts: {
        testCommands: async (req) => {
          // Detection is offline and free, so it is already in hand.
          expect(req.detected).toContain('npm test');
          expect(sessions.requests).toHaveLength(0);
          const proposals = await req.discover();
          expect(proposals.map((p) => p.command)).toEqual(['echo found']);
          return ['echo found'];
        },
      },
    });

    expect(sessions.requests).toHaveLength(1);
    expect(store.node('t').status).toBe('done');
  });

  it('errors on a failing command, identifying it and its exit status, and skips downstream', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands:
        - echo before
        - exit 7
        - echo never
  - id: after
    type: test
    config: { commands: ["echo x"] }
edges:
  - { from: t, to: after }
`,
      repo,
    );
    expect(store.node('t').status).toBe('error');
    expect(store.node('t').statusDetail).toContain('exit 7');
    const output = store.node('t').output as TestOutput;
    expect(output.passed).toBe(false);
    expect(output.commands).toHaveLength(2);
    expect(output.commands[1]!.exitStatus).toBe(7);
    expect(store.node('after').status).toBe('skipped');
  });

  it('with `agent: true` and instructions, adds analysis without ever changing the real verdict', async () => {
    const repo = makeTempGitRepo();
    // Even a session that reads as "looks fine" cannot flip a failing exit
    // code to passed — the verdict is fixed before this session ever runs.
    const sessions = fakeSessions(() => 'looks fine to me, nothing to worry about');
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands:
        - echo before
        - exit 7
      agent: true
      instructions: summarize what broke
`,
      repo,
      { sessions },
    );
    expect(sessions.requests).toHaveLength(1);
    expect([...sessions.requests[0]!.capabilities]).toEqual(['read']);
    expect(store.node('t').status).toBe('error');
    const output = store.node('t').output as TestOutput;
    expect(output.passed).toBe(false);
    expect(output.analysis).toBe('looks fine to me, nothing to worry about');
  });

  it('with `agent: true` but nothing to say, spends no session at all', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands: ["echo hi"]
      agent: true
`,
      repo,
    );
    // throwingSessions is the default in runReal — this would already have
    // thrown if a session were attempted.
    expect(store.node('t').status).toBe('done');
    expect((store.node('t').output as TestOutput).analysis).toBeUndefined();
  });

  it('an explicit capabilities list overrides the read-only default', async () => {
    const repo = makeTempGitRepo();
    const sessions = fakeSessions(() => 'ok');
    await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands: ["echo hi"]
      agent: true
      instructions: check for flakiness
      capabilities: [read, edit]
`,
      repo,
      { sessions },
    );
    expect([...sessions.requests[0]!.capabilities].sort()).toEqual(['edit', 'read']);
  });
});

describe('Discuss node resume', () => {
  const DISCUSS_YAML = `
nodes:
  - id: talk
    type: discuss
    config: { topic: "the greeting color" }
`;

  it('continues an interrupted conversation instead of starting over', async () => {
    const repo = makeTempGitRepo();
    const workflow = workflowFromYaml(DISCUSS_YAML);

    // Simulate a run that was ctrl+c'd mid-discussion.
    const interrupted = new RunStateStore({
      repoRoot: repo,
      nodeIds: workflow.nodes.map((n) => n.id),
    });
    interrupted.setStatus('talk', 'waiting', 'in discussion');
    interrupted.appendDiscussMessage('talk', { role: 'assistant', text: 'what should we build?' });
    interrupted.appendDiscussMessage('talk', { role: 'user', text: 'a blue greeting' });
    interrupted.setSessionId('talk', 'sess-abc');
    interrupted.markFinished(true);

    const resumed = new RunStateStore({
      repoRoot: repo,
      nodeIds: workflow.nodes.map((n) => n.id),
      resumeFrom: interrupted.snapshot(),
    });
    expect(resumed.node('talk').status).toBe('idle');

    const sentPrompts: string[] = [];
    const sessions = fakeSessions((req) => {
      sentPrompts.push(req.prompt);
      if (req.prompt.includes('JSON object recording')) {
        return JSON.stringify({ conclusion: 'blue greeting', constraints: [] });
      }
      return 'continuing — anything else?';
    });
    // Empty queue: the user immediately ends the (resumed) discussion.
    const ports = fakePorts({ userMessages: [] });

    const { store } = await runReal(DISCUSS_YAML, repo, { store: resumed, sessions, ports });

    // Asked the SDK to resume the prior session, not start a fresh one.
    expect(sessions.requests[0]!.resumeSessionId).toBe('sess-abc');
    // No "opening" prompt on resume — only the closing conclusion request.
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain('JSON object recording');

    // The UI was seeded with the prior transcript, not a blank panel.
    expect(ports.beginCalls[0]!.seedTranscript).toEqual([
      { role: 'assistant', text: 'what should we build?' },
      { role: 'user', text: 'a blue greeting' },
    ]);

    expect(store.node('talk').status).toBe('done');
    expect(store.node('talk').output).toMatchObject({ conclusion: 'blue greeting' });
  });

  it('a fresh (non-resumed) discussion still sends the opening prompt', async () => {
    const repo = makeTempGitRepo();
    const sentPrompts: string[] = [];
    const sessions = fakeSessions((req) => {
      sentPrompts.push(req.prompt);
      if (req.prompt.includes('JSON object recording')) {
        return JSON.stringify({ conclusion: 'blue greeting', constraints: [] });
      }
      return 'what color?';
    });
    const ports = fakePorts({ userMessages: [] });
    const { store } = await runReal(DISCUSS_YAML, repo, { sessions, ports });

    expect(sessions.requests[0]!.resumeSessionId).toBeUndefined();
    expect(sentPrompts[0]).toContain('Open a discussion');
    expect(ports.beginCalls[0]!.seedTranscript).toEqual([]);
    expect(store.node('talk').status).toBe('done');
  });

  describe('tappable option blocks', () => {
    const reply = (text: string) =>
      fakeSessions((req) =>
        req.prompt.includes('JSON object recording')
          ? JSON.stringify({ conclusion: 'c', constraints: [] })
          : text,
      );

    it('offers the choices and keeps the markup out of the transcript', async () => {
      const repo = makeTempGitRepo();
      const ports = fakePorts({ userMessages: [] });
      await runReal(DISCUSS_YAML, repo, {
        sessions: reply('What colour?\n\n<<<OPTIONS\n["blue", "green"]\n>>>'),
        ports,
      });
      expect(ports.assistantOptions[0]).toEqual(['blue', 'green']);
      expect(ports.assistantTexts[0]).toBe('What colour?');
      expect(ports.assistantTexts[0]).not.toContain('OPTIONS');
    });

    it('handles two blocks in one reply without leaking either as raw text', async () => {
      // Agents do ask two questions at once, despite the prompt asking for one
      // block at the end. The end-anchored match used to swallow everything
      // between the first `<<<OPTIONS` and the last `>>>`, fail to parse it as
      // JSON, and dump the whole reply into the transcript as markup.
      const repo = makeTempGitRepo();
      const ports = fakePorts({ userMessages: [] });
      await runReal(DISCUSS_YAML, repo, {
        sessions: reply(
          '1. Language?\n2. Happy path or retry?\n\n' +
            '<<<OPTIONS\n["Python", "Bash"]\n>>>\n\n' +
            '<<<OPTIONS\n["Clean run", "Retry first"]\n>>>',
        ),
        ports,
      });
      // The first block is the one offered — it belongs to the first question.
      expect(ports.assistantOptions[0]).toEqual(['Python', 'Bash']);
      // Neither block survives as markup, but both questions still read as prose.
      expect(ports.assistantTexts[0]).not.toContain('OPTIONS');
      expect(ports.assistantTexts[0]).not.toContain('>>>');
      expect(ports.assistantTexts[0]).toContain('1. Language?');
      expect(ports.assistantTexts[0]).toContain('2. Happy path or retry?');
    });

    it('shows a malformed block as written rather than dropping it', async () => {
      const repo = makeTempGitRepo();
      const ports = fakePorts({ userMessages: [] });
      await runReal(DISCUSS_YAML, repo, {
        sessions: reply('Pick one\n\n<<<OPTIONS\nnot json at all\n>>>'),
        ports,
      });
      expect(ports.assistantOptions[0]).toBeNull();
      expect(ports.assistantTexts[0]).toContain('not json at all');
    });

    it('offers nothing when the reply is plain prose', async () => {
      const repo = makeTempGitRepo();
      const ports = fakePorts({ userMessages: [] });
      await runReal(DISCUSS_YAML, repo, { sessions: reply('Tell me more.'), ports });
      expect(ports.assistantOptions[0]).toBeNull();
      expect(ports.assistantTexts[0]).toBe('Tell me more.');
    });
  });

  // A loop-back preserves the transcript and session id, so the node resumes.
  // Resuming silently would hand the agent a conversation from before the work
  // it is being asked to reconsider — and the retry reason the engine recorded
  // would never be spoken.
  const LOOPED = `
nodes:
  - id: talk
    type: discuss
    config: { topic: "the greeting color" }
  - id: gate
    type: approval-gate
edges:
  - { from: talk, to: gate }
  - { from: gate, to: talk, loopback: { maxAttempts: 3 } }
`;

  it('tells a re-entered discussion why it is running again', async () => {
    const repo = makeTempGitRepo();
    const sentPrompts: string[] = [];
    const sessions = fakeSessions((req) => {
      sentPrompts.push(req.prompt);
      if (req.prompt.includes('JSON object recording')) {
        return JSON.stringify({ conclusion: 'blue greeting', constraints: [] });
      }
      return 'understood';
    });
    let decisions = 0;
    const ports = fakePorts({
      userMessages: [],
      approve: () => (++decisions === 1 ? 'reject' : 'approve'),
    });
    const { store } = await runReal(LOOPED, repo, { sessions, ports });

    // Two passes through the discussion: the opening, then the re-opening.
    const openings = sentPrompts.filter((p) => p.includes('Open a discussion'));
    const reopenings = sentPrompts.filter((p) => p.includes('sent back'));
    expect(openings).toHaveLength(1);
    expect(reopenings).toHaveLength(1);
    // The re-opening carries the retry reason the engine recorded, naming the
    // node that sent the work back.
    expect(reopenings[0]).toContain('running again because');
    expect(reopenings[0]).toContain('gate');
    expect(reopenings[0]).toContain('rejected');

    // It continued the same conversation rather than starting a second one.
    expect(sessions.requests[1]!.resumeSessionId).toBeDefined();
    expect(ports.beginCalls[1]!.seedTranscript!.length).toBeGreaterThan(0);

    expect(decisions).toBe(2);
    expect(store.node('gate').status).toBe('done');
    expect(store.node('gate').output).toMatchObject({ decision: 'approved' });
  });

  it('carries the current attempt into a second re-entry, not the first one', async () => {
    const repo = makeTempGitRepo();
    const sentPrompts: string[] = [];
    const sessions = fakeSessions((req) => {
      sentPrompts.push(req.prompt);
      if (req.prompt.includes('JSON object recording')) {
        return JSON.stringify({ conclusion: 'blue greeting', constraints: [] });
      }
      return 'understood';
    });
    let decisions = 0;
    const ports = fakePorts({
      userMessages: [],
      approve: () => (++decisions <= 2 ? 'reject' : 'approve'),
    });
    await runReal(LOOPED, repo, { sessions, ports });

    // Three decisions, so the node is re-entered twice — the attempt-2 case
    // where the surviving transcript would otherwise stand in for fresh context.
    expect(decisions).toBe(3);
    expect(sentPrompts.filter((p) => p.includes('sent back'))).toHaveLength(2);
  });

  // The scaffolded spec gate (add-spec-approval-gate) puts a Spec node
  // between the gate and the Discuss node its loop-back returns to — unlike
  // the `talk -> gate` fixture above, `discuss` is not the gate's direct
  // dependency. The resume mechanism above doesn't care (it only looks at
  // its own prior attempt), but the segment the loop-back resets does: this
  // proves `spec` reruns and rewrites its file too, which is the point of
  // routing the rejection back this far instead of straight to `implement`.
  it('rewrites the spec on a rejected pass, with a Spec node sitting between the gate and the discussion it reopens', async () => {
    const SPEC_GATE_YAML = `
nodes:
  - id: discuss
    type: discuss
    config: { topic: "what to build" }
  - id: spec
    type: spec
  - id: spec-gate
    type: approval-gate
edges:
  - { from: discuss, to: spec }
  - { from: spec, to: spec-gate }
  - { from: spec-gate, to: discuss, loopback: true }
`;
    const repo = makeTempGitRepo();
    const specTitles = ['First draft', 'Second draft'];
    let specCall = 0;
    const sentPrompts: string[] = [];
    const sessions = fakeSessions((req) => {
      sentPrompts.push(req.prompt);
      if (req.nodeId === 'spec') {
        const title = specTitles[specCall] ?? specTitles.at(-1)!;
        specCall++;
        return JSON.stringify({ title, requirements: [], acceptanceCriteria: ['it works'] });
      }
      if (req.prompt.includes('JSON object recording')) {
        return JSON.stringify({ conclusion: 'clarified', constraints: [] });
      }
      return 'understood';
    });
    let decisions = 0;
    const ports = fakePorts({
      userMessages: [],
      approve: () => (++decisions === 1 ? 'reject' : 'approve'),
    });
    const { store } = await runReal(SPEC_GATE_YAML, repo, { sessions, ports });

    expect(decisions).toBe(2);
    expect(specCall).toBe(2);

    // The rewritten file reflects the second pass, not the first — the
    // design's claim that a rejection loop-back "reads the rewritten file
    // with no cache to invalidate."
    const output = store.node('spec').output as { specPath: string; title: string };
    expect(output.title).toBe('Second draft');
    const written = readFileSync(join(repo, output.specPath), 'utf8');
    expect(written).toContain('# Second draft');
    expect(written).not.toContain('# First draft');

    // The reopened discussion — reached through spec, not directly from the
    // gate — still knew why it was running again.
    const reopenings = sentPrompts.filter((p) => p.includes('sent back'));
    expect(reopenings).toHaveLength(1);
    expect(reopenings[0]).toContain('spec-gate');
    expect(reopenings[0]).toContain('rejected');

    expect(store.node('spec-gate').status).toBe('done');
    expect(store.node('spec-gate').output).toMatchObject({ decision: 'approved' });
  });
});

describe('Approval-Gate node', () => {
  const GATED = `
nodes:
  - id: impl
    type: implement
    config: { instructions: write a file }
  - id: gate
    type: approval-gate
  - id: after
    type: test
    config: { commands: ["echo ran"] }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: after }
`;

  function implSessions(_repo: string) {
    return fakeSessions((req) => {
      writeFileSync(join(req.workingDir, 'agent-made.txt'), 'agent content\n');
      return 'done: wrote agent-made.txt';
    });
  }

  it('shows the diff against the run baseline and unblocks downstream on approval', async () => {
    const repo = makeTempGitRepo();
    const { store, ports } = await runReal(GATED, repo, {
      sessions: implSessions(repo),
      portOpts: { approve: 'approve' },
    });
    expect(ports.approvalRequests).toHaveLength(1);
    const req = ports.approvalRequests[0]!;
    expect(req.diffs[0]!.diff).toContain('agent-made.txt');
    expect(req.diffs[0]!.diff).toContain('agent content');
    expect(req.upstreamSummaries.map((u) => u.nodeId)).toEqual(['impl']);
    // No `agent: true` on this gate — no critique session, no agentSummary.
    expect(req.agentSummary).toBeUndefined();
    expect(store.node('gate').status).toBe('done');
    expect((store.node('gate').output as ApprovalGateOutput).decision).toBe('approved');
    expect(store.node('after').status).toBe('done');
  });

  it('with `agent: true`, adds a read-only-by-default critique without touching the decision', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: write a file }
  - id: gate
    type: approval-gate
    config:
      agent: true
      instructions: point out anything risky
  - id: after
    type: test
    config: { commands: ["echo ran"] }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: after }
`;
    const sessions = fakeSessions((req) => {
      if (req.nodeId === 'impl') {
        writeFileSync(join(req.workingDir, 'agent-made.txt'), 'agent content\n');
        return 'done: wrote agent-made.txt';
      }
      return 'looks reasonable; minor risk: no test for the new file';
    });
    const { store, ports } = await runReal(yaml, repo, { sessions, portOpts: { approve: 'approve' } });

    expect(sessions.requests).toHaveLength(2);
    const gateReq = sessions.requests.find((r) => r.nodeId === 'gate')!;
    expect([...gateReq.capabilities]).toEqual(['read']);
    expect(ports.approvalRequests[0]!.agentSummary).toBe(
      'looks reasonable; minor risk: no test for the new file',
    );
    // The critique is purely informational: the human's decision still stands.
    expect((store.node('gate').output as ApprovalGateOutput).decision).toBe('approved');
  });

  it('an explicit capabilities list overrides the gate critique steps read-only default', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: gate
    type: approval-gate
    config:
      agent: true
      instructions: check for anything risky
      capabilities: [read, edit]
`;
    const sessions = fakeSessions(() => 'ok');
    await runReal(yaml, repo, { sessions, portOpts: { approve: 'approve' } });
    expect([...sessions.requests[0]!.capabilities].sort()).toEqual(['edit', 'read']);
  });

  it('records the diff it was decided on, so the decision stays reviewable', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(GATED, repo, {
      sessions: implSessions(repo),
      portOpts: { approve: 'approve' },
    });
    // The schema has to carry `diffs` for this to survive: the engine records
    // the parsed output, and an unknown key would be stripped on the way in.
    const output = store.node('gate').output as ApprovalGateOutput;
    expect(output.diffs).toBeDefined();
    expect(output.diffs![0]!.diff).toContain('agent-made.txt');
  });

  it('records the document it was decided on, through the same schema round-trip diffs take', async () => {
    // Same trap `diffs` above guards against: `documents` has to be declared
    // in `approvalGateOutput` or the engine's `outputSchema.safeParse`
    // (engine.ts) silently drops it before `store.setOutput` ever sees it.
    const yaml = `
nodes:
  - id: spec
    type: spec
  - id: spec-gate
    type: approval-gate
edges:
  - { from: spec, to: spec-gate }
`;
    const repo = makeTempGitRepo();
    const sessions = fakeSessions(() =>
      JSON.stringify({ title: 'T', requirements: [], acceptanceCriteria: ['it works'] }),
    );
    const { store } = await runReal(yaml, repo, { sessions, portOpts: { approve: 'approve' } });

    const output = store.node('spec-gate').output as ApprovalGateOutput;
    expect(output.documents).toBeDefined();
    expect(output.documents![0]).toMatchObject({ label: 'spec' });
    expect(output.documents![0]!.body).toContain('# T');
    expect(output.documents![0]!.body).toContain('it works');
  });

  it('on reject: gate is done-but-rejected, downstream is skipped, independent branches still run', async () => {
    const repo = makeTempGitRepo();
    // Independent branch: `solo` depends only on impl, not on the gate.
    const withIndependent = `
nodes:
  - id: impl
    type: implement
    config: { instructions: write a file }
  - id: gate
    type: approval-gate
  - id: after
    type: test
    config: { commands: ["echo ran"] }
  - id: solo
    type: test
    config: { commands: ["echo independent"] }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: after }
  - { from: impl, to: solo }
`;
    const { store } = await runReal(withIndependent, repo, {
      sessions: implSessions(repo),
      portOpts: { approve: 'reject' },
    });
    // A gate that got its answer completed; the rejection lives in the output,
    // not in the status.
    expect(store.node('gate').status).toBe('done');
    expect(store.node('gate').statusDetail).toContain('rejected');
    expect((store.node('gate').output as ApprovalGateOutput).decision).toBe('rejected');
    // `after` is held back by the approved-condition synthesized onto
    // `gate → after`, so it is skipped by routing rather than by a failure
    // cascade. The skip reason is the load-bearing difference: a `condition`
    // skip clears a dependency where an `upstream` skip does not.
    expect(store.node('after').status).toBe('skipped');
    expect(store.node('after').skipReason).toBe('condition');
    expect(store.node('solo').status).toBe('done');
  });

  it('surfaces the push target when a push-configured Git-ops node is downstream', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
    config:
      push: { remote: origin, branch: main }
edges:
  - { from: gate, to: ship }
`;
    const { ports } = await runReal(yaml, repo, {
      sessions: fakeSessions(() => 'ok'),
      portOpts: { approve: 'reject' },
    });
    expect(ports.approvalRequests[0]!.pushTarget).toEqual({
      nodeId: 'ship',
      remote: 'origin',
      branch: 'main',
    });
  });

  it('under the dirty-tree override, pre-existing changes never appear in the gate diff', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'user-wip.txt'), 'user work in progress\n');
    const workflow = workflowFromYaml(GATED);
    const store = storeFor(workflow, repo);
    const baseline = await recordBaseline(repo, true);
    const ports = fakePorts({ approve: 'approve' });
    const engine = new Engine({
      workflow,
      store,
      repoRoot: repo,
      baseline,
      ports,
      sessions: implSessions(repo),
      executors: builtinExecutors,
    });
    await engine.run();
    const diff = ports.approvalRequests[0]!.diffs[0]!.diff;
    expect(diff).toContain('agent-made.txt');
    expect(diff).not.toContain('user-wip');
  });
});

describe('Git-ops node — how the commit message is decided', () => {
  const yamlFor = (config: string) => `
nodes:
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops${config}
edges:
  - { from: gate, to: ship }
`;

  /** The prompt the git-ops node actually handed its agent. */
  async function gitOpsPrompt(config: string): Promise<string> {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'touched.txt'), 'something to commit\n');
    const sessions = fakeSessions(() => 'committed');
    await runReal(yamlFor(config), repo, { sessions, portOpts: { approve: 'approve' } });
    const request = sessions.requests.find((r) => r.nodeId === 'ship');
    return request?.prompt ?? '';
  }

  it('passes a configured commitMessage through verbatim', async () => {
    const prompt = await gitOpsPrompt(`
    config:
      commitMessage: "chore(deps): bump vitest"`);
    expect(prompt).toContain('"chore(deps): bump vitest"');
    // A literal message is the whole instruction — it must not arrive alongside
    // guidance telling the agent to write its own.
    expect(prompt).not.toContain('Read the staged diff');
  });

  it('passes instructions through instead, leaving the wording to the agent', async () => {
    const prompt = await gitOpsPrompt(`
    config:
      instructions: "Reference the ticket id in the subject line."`);
    expect(prompt).toContain('Reference the ticket id in the subject line.');
    expect(prompt).not.toContain('Read the staged diff');
  });

  it('falls back to describing the diff, never a fixed string', async () => {
    const prompt = await gitOpsPrompt('');
    expect(prompt).toContain('Read the staged diff');
    expect(prompt).toContain('describes what actually changed');
    // The old behaviour: the same message on every commit of every run.
    expect(prompt).not.toContain('flow-code: apply workflow changes');
  });
});
