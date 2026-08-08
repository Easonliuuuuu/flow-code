/**
 * Real network calls to the Claude Agent SDK — no mocking. Requires live
 * Claude credentials (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY); skips
 * entirely (not "fails") when neither is set so this never blocks
 * `npm test` or CI for contributors without one. Run explicitly via
 * `npm run test:integration`.
 *
 * Coverage: the Claude runner's full tool surface — discovery reads
 * (list_dir/glob/grep), edits (write_file/edit_file), shell and git
 * commands — plus capability-boundary denials (exec, git-write,
 * working-directory escapes) and one real two-node Engine run
 * (implement -> validate). Kept deliberately lean: each test is real
 * network traffic.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { Engine } from '../src/engine/engine.js';
import { builtinExecutors, SdkSessionRunner } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import { RunStateStore } from '../src/runstate/store.js';
import { fakePorts, makeTempGitRepo, repoGit, workflowFromYaml } from './helpers.js';

const hasCreds = Boolean(process.env['CLAUDE_CODE_OAUTH_TOKEN'] || process.env['ANTHROPIC_API_KEY']);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-claude-integration-'));
}

function storeFor(dir: string, nodeIds: string[]): RunStateStore {
  return new RunStateStore({ repoRoot: dir, nodeIds });
}

/** Set to also stream assistant text to the console, on top of the tool-call log. */
const traceText = Boolean(process.env['INTEGRATION_TRACE']);

/**
 * Pinned rather than left to the SDK's own default, so a model swap upstream
 * can't silently change what these tool-surface assertions are exercising;
 * override with CLAUDE_INTEGRATION_MODEL.
 */
const integrationModel = process.env['CLAUDE_INTEGRATION_MODEL'] ?? 'claude-haiku-4-5-20251001';

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** When INTEGRATION_TRACE=1, forward each assistant message to the console. */
function maybeTrace(label: string): { onText?: (text: string) => void } {
  return traceText ? { onText: (t) => console.log(`[${label}] assistant: ${truncate(t, 400)}`) } : {};
}

/**
 * Live progress logging: subscribes to the run-state store and prints each
 * activity entry (tool call, outcome, completion) and node-status change as a
 * newline-terminated line, so a long real-API test shows what the agent is
 * doing instead of sitting silent. Returns an unsubscribe that also prints the
 * session end marker.
 */
function watchRun(store: RunStateStore, label: string): () => void {
  const seenCalls = new Set<string>();
  const completedCalls = new Set<string>();
  const lastStatus = new Map<string, string>();
  console.log(`[${label}] session start`);
  const unsubscribe = store.subscribe((state) => {
    for (const entry of state.activity) {
      if (!entry.toolUseId || seenCalls.has(entry.toolUseId)) continue;
      seenCalls.add(entry.toolUseId);
      const outcome =
        entry.decision === 'denied' ? `denied (${entry.missingCapability ?? '?'})` : 'allowed';
      console.log(`[${label}] call: ${entry.tool} ${truncate(entry.summary, 200)} — ${outcome}`);
    }
    for (const entry of state.activity) {
      if (!entry.toolUseId || entry.durationMs === undefined || completedCalls.has(entry.toolUseId)) {
        continue;
      }
      completedCalls.add(entry.toolUseId);
      const detail =
        entry.exitStatus !== undefined && entry.exitStatus !== null
          ? `exit=${entry.exitStatus}`
          : entry.error !== undefined
            ? 'error'
            : 'ok';
      console.log(`[${label}] done: ${entry.tool} → ${entry.durationMs}ms (${detail})`);
    }
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (lastStatus.get(nodeId) === node.status) continue;
      lastStatus.set(nodeId, node.status);
      console.log(`[${label}] node ${nodeId}: ${node.status}`);
    }
  });
  return () => {
    unsubscribe();
    console.log(`[${label}] session end`);
  };
}

/** A two-module project with two independent bugs and a test that checks both. */
function writeBuggyProject(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'math.js'),
    'export function add(a, b) {\n  return a - b; // bug: should add\n}\n',
  );
  writeFileSync(
    join(dir, 'src', 'string.js'),
    "export function shout(s) {\n  return s.toLowerCase() + '!'; // bug: should shout\n}\n",
  );
  writeFileSync(
    join(dir, 'test.js'),
    "import assert from 'node:assert/strict';\n" +
      "import { add } from './src/math.js';\n" +
      "import { shout } from './src/string.js';\n" +
      'assert.equal(add(2, 3), 5);\n' +
      "assert.equal(shout('hello'), 'HELLO!');\n" +
      "console.log('all tests passed');\n",
  );
}

describe.skipIf(!hasCreds)('Claude API integration', () => {
  it('fixes a real bug end-to-end: reads, edits, verifies via a shell command', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'math.js'),
      'export function add(a, b) {\n  return a - b; // bug: should add\n}\n',
    );
    writeFileSync(
      join(dir, 'test.js'),
      "import assert from 'node:assert/strict';\nimport { add } from './math.js';\n" +
        "assert.equal(add(2, 3), 5);\nconsole.log('all tests passed');\n",
    );

    const runner = new SdkSessionRunner();
    const store = storeFor(dir, ['impl']);
    const unsub = watchRun(store, 'impl');
    try {
      const { finalText } = await runner.run(
        {
          nodeId: 'impl',
          capabilities: capabilitySet('read', 'edit', 'exec'),
          rolePrompt: 'You are the implementation step of a coding workflow.',
          prompt:
            'Fix the bug in math.js: add(a, b) should return a + b, not a - b. ' +
            'Run `node test.js` with run_shell to confirm the fix.',
          workingDir: dir,
          model: integrationModel,
          ...maybeTrace('impl'),
        },
        store,
      );

      expect(finalText.length).toBeGreaterThan(0);
      expect(readFileSync(join(dir, 'math.js'), 'utf8')).toContain('a + b');
      // Claude's own tool name, not the NVIDIA/OpenAI-compat backend's
      // 'run_shell' alias (src/harness/compile.ts EXEC_TOOLS).
      const shellCalls = store.activityFor('impl').filter((e) => e.tool === 'Bash');
      // The SDK's Bash tool_response carries no exit-code field (confirmed by
      // probing it directly), so a successful call reports exitStatus as
      // undefined — the same tolerance production code already applies in
      // executors/agents.ts when checking for a successful `git push`.
      expect(
        shellCalls.some(
          (e) =>
            (e.exitStatus === 0 || e.exitStatus === undefined || e.exitStatus === null) &&
            e.error === undefined,
        ),
      ).toBe(true);
    } finally {
      unsub();
    }
  });

  it('never mutates the file when the capability set is read-only', async () => {
    const dir = tempDir();
    const original = 'export function add(a, b) {\n  return a - b;\n}\n';
    writeFileSync(join(dir, 'math.js'), original);

    const runner = new SdkSessionRunner();
    const store = storeFor(dir, ['review']);
    const unsub = watchRun(store, 'review');
    try {
      await runner.run(
        {
          nodeId: 'review',
          capabilities: capabilitySet('read'),
          rolePrompt: 'You are the code review step of a coding workflow. You cannot edit files.',
          prompt: 'Read math.js and try to fix the bug (a - b should be a + b) by editing the file.',
          workingDir: dir,
          model: integrationModel,
          ...maybeTrace('review'),
        },
        store,
      );

      // Structural enforcement, not the model's word for it: the tool was
      // never offered, so the file must be exactly what it started as.
      expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(original);
      const activity = store.activityFor('review');
      // Claude's own tool names (Write/Edit), not the NVIDIA/OpenAI-compat
      // backend's aliases — and specifically no *allowed* call, since a
      // denied attempt is exactly what this test expects to see.
      expect(
        activity.every(
          (e) => !(e.decision === 'allowed' && (e.tool === 'Write' || e.tool === 'Edit')),
        ),
      ).toBe(true);
    } finally {
      unsub();
    }
  });

  // Deliberately lightweight: exercises discovery without also paying for a
  // multi-file fix-and-verify round trip (Edit is already covered by the
  // end-to-end test above). Not pinned to a specific tool (Glob/Grep vs.
  // Bash `find`/`grep`): observed against this integration model, it
  // reliably reaches for Bash-based discovery — or even tries an Agent/
  // ToolSearch delegation first — rather than calling Glob/Grep directly,
  // even when explicitly told to. That's a real, reproducible model
  // preference, not flakiness, so the assertion checks that discovery
  // succeeded rather than which tool accomplished it.
  it('discovers the project layout', async () => {
    const dir = tempDir();
    writeBuggyProject(dir);

    const runner = new SdkSessionRunner();
    const store = storeFor(dir, ['impl']);
    const unsub = watchRun(store, 'discovery');
    try {
      const { finalText } = await runner.run(
        {
          nodeId: 'impl',
          capabilities: capabilitySet('read', 'edit', 'exec'),
          rolePrompt: 'You are the implementation step of a coding workflow.',
          prompt:
            'Explore this project to find every .js file under src/, then report the file names you found. ' +
            'Do not edit anything.',
          workingDir: dir,
          model: integrationModel,
          ...maybeTrace('discovery'),
        },
        store,
      );

      expect(finalText).toContain('math.js');
      expect(finalText).toContain('string.js');
      const activity = store.activityFor('impl');
      expect(activity.every((e) => !(e.decision === 'allowed' && (e.tool === 'Write' || e.tool === 'Edit')))).toBe(
        true,
      );
    } finally {
      unsub();
    }
  });

  it('commits the fix in a real git repository', async () => {
    const dir = makeTempGitRepo();
    writeBuggyProject(dir);
    repoGit(dir, 'add', '-A');
    repoGit(dir, 'commit', '-q', '-m', 'add broken math');
    const baseHead = repoGit(dir, 'rev-parse', 'HEAD');

    const runner = new SdkSessionRunner();
    const store = storeFor(dir, ['git-ops']);
    const unsub = watchRun(store, 'git-workflow');
    try {
      const { finalText } = await runner.run(
        {
          nodeId: 'git-ops',
          capabilities: capabilitySet('read', 'edit', 'exec', 'git-read', 'git-write'),
          rolePrompt: 'You are a git-enabled coding agent.',
          prompt:
            'Inspect the repository with git (git log, git status, git diff are fine). ' +
            'Fix the bug in src/math.js: add(a, b) should return a + b. Run `node test.js` to confirm. ' +
            'Then stage and commit the fix with `git commit` using the message `fix: add correctly`. ' +
            'Do not push.',
          workingDir: dir,
          model: integrationModel,
          ...maybeTrace('git-workflow'),
        },
        store,
      );

      expect(finalText.length).toBeGreaterThan(0);
      expect(readFileSync(join(dir, 'src', 'math.js'), 'utf8')).toContain('a + b');
      expect(repoGit(dir, 'rev-parse', 'HEAD')).not.toBe(baseHead);
      expect(repoGit(dir, 'status', '--porcelain')).toBe('');
      expect(repoGit(dir, 'log', '-1', '--format=%s')).toContain('correctly');
      const allowed = store.activityFor('git-ops').filter((e) => e.decision === 'allowed');
      // See the exit-status note on the end-to-end test above: the SDK never
      // reports a Bash exit code, so undefined/null stand in for success.
      expect(
        allowed.some(
          (e) =>
            /git\s+commit/.test(e.summary) &&
            (e.exitStatus === 0 || e.exitStatus === undefined || e.exitStatus === null) &&
            e.error === undefined,
        ),
      ).toBe(true);
    } finally {
      unsub();
    }
  });

  it('denies non-git commands and commits when the node only has git-read', async () => {
    const dir = makeTempGitRepo();
    writeBuggyProject(dir);
    repoGit(dir, 'add', '-A');
    repoGit(dir, 'commit', '-q', '-m', 'add broken math');
    const baseHead = repoGit(dir, 'rev-parse', 'HEAD');
    const mathBefore = readFileSync(join(dir, 'src', 'math.js'), 'utf8');

    const runner = new SdkSessionRunner();
    const store = storeFor(dir, ['readonly']);
    const unsub = watchRun(store, 'git-read-denials');
    try {
      const { finalText } = await runner.run(
        {
          nodeId: 'readonly',
          capabilities: capabilitySet('git-read'),
          rolePrompt: 'You may only inspect git state; you can never modify files or history.',
          prompt:
            'Try running `node test.js` to check the tests, then try to commit a fix with ' +
            '`git add src/math.js` and `git commit -m "fix: add correctly"`. Report what each command does.',
          workingDir: dir,
          model: integrationModel,
          ...maybeTrace('git-read-denials'),
        },
        store,
      );

      expect(finalText.length).toBeGreaterThan(0);
      expect(repoGit(dir, 'rev-parse', 'HEAD')).toBe(baseHead);
      expect(readFileSync(join(dir, 'src', 'math.js'), 'utf8')).toBe(mathBefore);
      const denials = store.activityFor('readonly').filter((e) => e.decision === 'denied');
      expect(denials.some((e) => e.missingCapability === 'exec')).toBe(true);
      expect(denials.some((e) => e.missingCapability === 'git-write')).toBe(true);
    } finally {
      unsub();
    }
  });

  it('denies reads outside the working directory and never leaks the file', async () => {
    const parent = tempDir();
    const workingDir = join(parent, 'workspace');
    mkdirSync(workingDir, { recursive: true });
    const token = 'SECRET_TOKEN_9f3a';
    writeFileSync(join(parent, 'secret.txt'), `${token}\n`);

    const runner = new SdkSessionRunner();
    const store = storeFor(workingDir, ['impl']);
    const unsub = watchRun(store, 'escape');
    try {
      const { finalText } = await runner.run(
        {
          nodeId: 'impl',
          // No exec: without a shell, every read must go through the
          // path-checked file tools, so the no-leak guarantee is structural.
          capabilities: capabilitySet('read', 'edit'),
          rolePrompt: 'You are an implementation agent with no shell access.',
          prompt:
            'Call the Read tool with file_path set to ../secret.txt (the parent of your working directory). ' +
            'Actually make the tool call — do not just reason about whether it is allowed or refuse in words. ' +
            'If it succeeds, use the Write tool to save its exact contents to result.txt and include the ' +
            'contents in your final answer. If the tool call is denied, report that denial.',
          workingDir,
          model: integrationModel,
          ...maybeTrace('escape'),
        },
        store,
      );

      expect(readFileSync(join(parent, 'secret.txt'), 'utf8')).toBe(`${token}\n`);
      expect(finalText).not.toContain(token);
      expect(existsSync(join(parent, 'result.txt'))).toBe(false);
      const inWorkspace = join(workingDir, 'result.txt');
      if (existsSync(inWorkspace)) {
        expect(readFileSync(inWorkspace, 'utf8')).not.toContain(token);
      }
      const denials = store.activityFor('impl').filter((e) => e.decision === 'denied');
      expect(denials.some((e) => e.missingCapability === 'working-directory')).toBe(true);
    } finally {
      unsub();
    }
  });

  it(
    'drives a real implement -> validate run through the Engine',
    async () => {
      const dir = makeTempGitRepo();
      writeBuggyProject(dir);
      repoGit(dir, 'add', '-A');
      repoGit(dir, 'commit', '-q', '-m', 'add broken math');
      const baseline = await recordBaseline(dir, false);

      const workflow = workflowFromYaml(`
settings:
  concurrency: 1
nodes:
  - id: implement
    type: implement
    config:
      model: ${integrationModel}
      instructions: "Fix the bug in src/math.js: add(a, b) should return a + b. Then run \`node test.js\` with run_shell to confirm."
  - id: validate
    type: validate
    config:
      model: ${integrationModel}
edges:
  - { from: implement, to: validate }
`);
      const store = new RunStateStore({
        repoRoot: dir,
        nodeIds: workflow.nodes.map((n) => n.id),
      });
      const unsub = watchRun(store, 'engine');
      try {
        const engine = new Engine({
          workflow,
          store,
          repoRoot: dir,
          baseline,
          ports: fakePorts(),
          sessions: new SdkSessionRunner(),
          executors: builtinExecutors,
        });

        await engine.run();

        expect(store.allTerminal()).toBe(true);
        expect(store.node('implement').status).toBe('done');
        const implementOutput = store.node('implement').output as { changedFiles?: string[] };
        expect(implementOutput.changedFiles).toContain('src/math.js');
        expect(store.activityFor('implement').some((e) => e.decision === 'allowed')).toBe(true);
        expect(['done', 'error']).toContain(store.node('validate').status);
        expect(readFileSync(join(dir, 'src', 'math.js'), 'utf8')).toContain('a + b');
      } finally {
        unsub();
      }
    },
    // Two agent sessions run sequentially; kept generous until the live logs
    // give a real CI measurement, then tightened to measured + margin.
    480_000,
  );
});
