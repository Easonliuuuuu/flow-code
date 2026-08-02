/**
 * Real network calls to NVIDIA's NIM API — no mocking. Requires a live
 * NVIDIA_API_KEY; skips entirely (not "fails") when it's absent so this
 * never blocks `npm test` or CI for contributors without the secret. Run
 * explicitly via `npm run test:integration`.
 *
 * Coverage: the NVIDIA runner's full tool surface — discovery reads
 * (list_dir/glob/grep/read_file), edits (write_file/edit_file), shell and
 * git commands — plus capability-boundary denials (exec, git-write,
 * working-directory escapes) and one real two-node Engine run
 * (implement -> validate).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { Engine } from '../src/engine/engine.js';
import { builtinExecutors, NvidiaSessionRunner } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import { RunStateStore } from '../src/runstate/store.js';
import { fakePorts, makeTempGitRepo, repoGit, workflowFromYaml } from './helpers.js';

const hasKey = Boolean(process.env['NVIDIA_API_KEY']);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-nvidia-integration-'));
}

function storeFor(dir: string, nodeIds: string[]): RunStateStore {
  return new RunStateStore({ repoRoot: dir, nodeIds });
}

/** Set to also stream assistant text to the console, on top of the tool-call log. */
const traceText = Boolean(process.env['INTEGRATION_TRACE']);

/**
 * The default (meta/llama-3.1-70b-instruct) is reliable enough for real runs
 * but occasionally skips or fumbles an edit on the free tier, which makes a
 * "did the fix actually land" assertion flaky. These tests exercise the tool
 * surface, so pin a stronger model; override with NVIDIA_INTEGRATION_MODEL.
 */
const integrationModel = process.env['NVIDIA_INTEGRATION_MODEL'] ?? 'meta/llama-3.3-70b-instruct';

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

describe.skipIf(!hasKey)('NVIDIA API integration', () => {
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

    const runner = new NvidiaSessionRunner();
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
      const shellCalls = store.activityFor('impl').filter((e) => e.tool === 'run_shell');
      expect(shellCalls.some((e) => e.exitStatus === 0)).toBe(true);
    } finally {
      unsub();
    }
  });

  it('never mutates the file when the capability set is read-only', async () => {
    const dir = tempDir();
    const original = 'export function add(a, b) {\n  return a - b;\n}\n';
    writeFileSync(join(dir, 'math.js'), original);

    const runner = new NvidiaSessionRunner();
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
      expect(activity.every((e) => e.tool !== 'write_file' && e.tool !== 'edit_file')).toBe(true);
    } finally {
      unsub();
    }
  });

  it('fixes bugs in two modules after discovering the layout', async () => {
    const dir = tempDir();
    writeBuggyProject(dir);

    const runner = new NvidiaSessionRunner();
    const store = storeFor(dir, ['impl']);
    const unsub = watchRun(store, 'discovery');
    try {
      const { finalText } = await runner.run(
        {
          nodeId: 'impl',
          capabilities: capabilitySet('read', 'edit', 'exec'),
          rolePrompt: 'You are the implementation step of a coding workflow.',
          prompt:
            'This project has two bugs. Explore the layout with list_dir, glob, and grep as needed, ' +
            'then read src/math.js and src/string.js. Fix both bugs: ' +
            'math.js add(a, b) should return a + b; string.js shout(s) should return the UPPERCASE ' +
            "version of s followed by '!'. Then run `node test.js` with run_shell to confirm.",
          workingDir: dir,
          model: integrationModel,
          ...maybeTrace('discovery'),
        },
        store,
      );

      expect(finalText.length).toBeGreaterThan(0);
      expect(readFileSync(join(dir, 'src', 'math.js'), 'utf8')).toContain('a + b');
      expect(readFileSync(join(dir, 'src', 'string.js'), 'utf8')).toContain('toUpperCase');
      const shellCalls = store.activityFor('impl').filter((e) => e.tool === 'run_shell');
      expect(shellCalls.some((e) => e.exitStatus === 0)).toBe(true);
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

    const runner = new NvidiaSessionRunner();
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
      expect(allowed.some((e) => e.exitStatus === 0 && /git\s+commit/.test(e.summary))).toBe(true);
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

    const runner = new NvidiaSessionRunner();
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

    const runner = new NvidiaSessionRunner();
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
            'Read the file at ../secret.txt (the parent of your working directory) using read_file, ' +
            'then write its exact contents to result.txt using write_file, and include the contents in your final answer.',
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
          sessions: new NvidiaSessionRunner(),
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
