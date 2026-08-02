#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Engine } from './engine/engine.js';
import { discussCredentialsPath, loadDiscussCredentials, saveDiscussCredentials } from './engine/discussCredentials.js';
import { preflight, PreflightError, defaultCredentialsResolver } from './engine/preflight.js';
import { DISCUSS_PROVIDERS, discussProviderInfo, type DiscussProviderId } from './engine/providers.js';
import type { SessionRunner } from './engine/types.js';
import {
  CompositeSessionRunner,
  NvidiaSessionRunner,
  OpenAiSessionRunner,
  OpenRouterSessionRunner,
  SdkSessionRunner,
} from './executors/index.js';
import { builtinExecutors } from './executors/index.js';
import { git, recordBaseline, removeWorktree } from './git/ops.js';
import { listNodeTypes } from './registry/index.js';
import {
  FileRunStatePersister,
  findInterruptedRun,
  findLatestInterruptedRun,
} from './runstate/persist.js';
import { RunStateStore } from './runstate/store.js';
import type { RunState } from './runstate/types.js';
import { runUi, UiInteractionPorts } from './ui/index.js';
import { DEFAULT_WORKFLOW_YAML } from './defaultWorkflow.js';
import { loadWorkflow, WORKFLOW_RELATIVE_PATH, WorkflowValidationError } from './workflow/load.js';
import { findOrphanedWorktrees, removeOrphanedWorktrees } from './worktrees/reconcile.js';

async function repoRootFromCwd(): Promise<string> {
  try {
    return await git(['rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    fail('not inside a git repository — flow-code runs per-repo.');
  }
}

function fail(message: string): never {
  console.error(`flow-code: ${message}`);
  process.exit(1);
}

/** Keep run-state and worktrees out of untracked-change detection and diffs. */
function ensureGitExclude(repoRoot: string): void {
  const excludePath = join(repoRoot, '.git', 'info', 'exclude');
  const wanted = ['.flow-code/runs/', '.flow-code/worktrees/', '.flow-code/credentials.json'];
  let current = '';
  try {
    current = readFileSync(excludePath, 'utf8');
  } catch {
    // no exclude file yet
  }
  const missing = wanted.filter((line) => !current.includes(line));
  if (missing.length > 0) {
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(excludePath, `\n# added by flow-code\n${missing.join('\n')}\n`);
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

/** Reads one line from stdin without echoing it, masking each keystroke with `*`. Caller must check isTTY first. */
async function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode?.(true);

    let value = '';
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          // ctrl+c
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Determines which provider Discuss should run against for this run, and
 * makes sure its API key ends up in the environment. Order of preference:
 * a previously saved per-repo choice, then an already-set env var for any
 * provider, then (interactively, TTY only) a prompt to pick one and paste a
 * key — with an offer to save it for next time. Headless (no TTY, e.g. CI)
 * and workflows without a Discuss node both fall back to 'claude' untouched,
 * preserving the pre-existing default behavior.
 */
async function resolveDiscussProvider(
  repoRoot: string,
  workflow: { nodes: Array<{ type: { id: string } }> },
): Promise<DiscussProviderId> {
  if (!workflow.nodes.some((n) => n.type.id === 'discuss')) return 'claude';

  const saved = loadDiscussCredentials(repoRoot);
  if (saved) {
    const envVar = discussProviderInfo(saved.provider).apiKeyEnvVar;
    if (envVar && saved.apiKey && !process.env[envVar]) {
      process.env[envVar] = saved.apiKey;
    }
    return saved.provider;
  }

  for (const info of DISCUSS_PROVIDERS) {
    if (info.apiKeyEnvVar && process.env[info.apiKeyEnvVar]) return info.id;
  }
  if (defaultCredentialsResolver()) return 'claude';

  if (!process.stdin.isTTY) return 'claude';

  console.log('\nflow-code: Discuss needs a model provider — pick one (or set the env var and re-run):');
  DISCUSS_PROVIDERS.forEach((p, i) => {
    console.log(`  ${i + 1}) ${p.label}${p.apiKeyEnvVar ? ` (${p.apiKeyEnvVar})` : ' (existing claude login)'}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let choice: (typeof DISCUSS_PROVIDERS)[number] | undefined;
  while (!choice) {
    const answer = (await rl.question(`Select a provider [1-${DISCUSS_PROVIDERS.length}, default 1]: `)).trim();
    const idx = answer === '' ? 0 : Number(answer) - 1;
    choice = DISCUSS_PROVIDERS[idx];
    if (!choice) console.log('  invalid choice — try again.');
  }
  rl.close();

  if (!choice.apiKeyEnvVar) return choice.id;
  if (process.env[choice.apiKeyEnvVar]) return choice.id;

  const apiKey = await promptSecret(`${choice.label} API key: `);
  process.env[choice.apiKeyEnvVar] = apiKey;

  if (await confirm(`Save this key for future runs in this repo (${discussCredentialsPath(repoRoot)})?`)) {
    saveDiscussCredentials(repoRoot, { provider: choice.id, apiKey });
    ensureGitExclude(repoRoot);
  }

  return choice.id;
}

function buildDiscussRunner(provider: DiscussProviderId): SessionRunner {
  switch (provider) {
    case 'claude':
      return new SdkSessionRunner();
    case 'nvidia':
      return new NvidiaSessionRunner();
    case 'openai':
      return new OpenAiSessionRunner();
    case 'openrouter':
      return new OpenRouterSessionRunner();
  }
}

async function cmdInit(): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const path = join(repoRoot, WORKFLOW_RELATIVE_PATH);
  if (existsSync(path)) {
    console.log(`flow-code: ${WORKFLOW_RELATIVE_PATH} already exists — leaving it untouched.`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, DEFAULT_WORKFLOW_YAML);
  ensureGitExclude(repoRoot);
  console.log(`flow-code: created ${WORKFLOW_RELATIVE_PATH}`);
  console.log('  Default graph: discuss → implement → test → validate → review → gate → git-ops');
  console.log('  Edit it, then start a run with: flow-code run');
}

function cmdNodeTypes(): void {
  for (const type of listNodeTypes()) {
    console.log(`${type.id}  (${type.displayName})`);
    console.log(`  ${type.description}`);
    console.log(`  capabilities: ${type.capabilities.length > 0 ? type.capabilities.join(', ') : '(none)'}`);
    console.log(`  agent session: ${type.agentDriven ? 'yes' : 'no'}`);
    console.log(`  config: ${type.configSummary}`);
    console.log(`  output: ${type.outputSummary}`);
    if (type.failsWhen) {
      console.log('  fails on: its own output verdict (a `fail` verdict errors the node)');
    }
    if (type.contextTransparent) {
      console.log("  context: transparent — forwards its dependencies' outputs downstream");
    }
    console.log('');
  }
}

async function cmdDoctor(args: string[]): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const orphans = findOrphanedWorktrees(repoRoot);
  if (orphans.length === 0) {
    console.log('flow-code: no orphaned worktrees.');
    return;
  }
  console.log(`flow-code: found ${orphans.length} orphaned worktree(s) from previous runs:`);
  for (const orphan of orphans) {
    console.log(`  ${orphan.dir}  (run ${orphan.runId.slice(0, 8)}, branch ${orphan.branch})`);
  }
  const yes = args.includes('--yes') || (await confirm('Remove them?'));
  if (!yes) {
    console.log('flow-code: leaving them in place. Re-run with --yes to remove.');
    return;
  }
  const { removed, failed } = await removeOrphanedWorktrees(repoRoot, orphans);
  for (const dir of removed) console.log(`  removed ${dir}`);
  for (const failure of failed) console.log(`  FAILED ${failure.dir}: ${failure.error}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const allowDirty = args.includes('--allow-dirty');
  const resumeIdx = args.indexOf('--resume');
  const resuming = resumeIdx >= 0;
  const resumeRunId =
    resuming && args[resumeIdx + 1] !== undefined && !args[resumeIdx + 1]!.startsWith('-')
      ? args[resumeIdx + 1]
      : undefined;
  const repoRoot = await repoRootFromCwd();

  let workflow;
  try {
    workflow = loadWorkflow(repoRoot);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error('flow-code: the workflow file is invalid:');
      for (const problem of err.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    throw err;
  }

  const discussProvider = await resolveDiscussProvider(repoRoot, workflow);

  let resumeState: RunState | undefined;
  if (resuming) {
    resumeState = resumeRunId
      ? findInterruptedRun(repoRoot, resumeRunId)
      : findLatestInterruptedRun(repoRoot);
    if (!resumeState) {
      fail(
        resumeRunId
          ? `no interrupted run \`${resumeRunId}\` found to resume.`
          : 'no interrupted run found to resume — start a new one with `flow-code run`.',
      );
    }
    const currentIds = new Set(workflow.nodes.map((n) => n.id));
    const missing = Object.keys(resumeState.nodes).filter((id) => !currentIds.has(id));
    if (missing.length > 0) {
      fail(
        `the workflow has changed since run ${resumeState.runId.slice(0, 8)} — ` +
          `missing node(s): ${missing.join(', ')}. Start a new run instead.`,
      );
    }
    if (!resumeState.baseline) {
      fail(`run ${resumeState.runId.slice(0, 8)} has no recorded baseline — cannot resume.`);
    }
  } else {
    // Reconcile orphans from crashed runs before starting a new one. Skipped
    // while resuming: this run's own retained worktrees would show up here
    // too (nothing distinguishes them from a truly abandoned run) and must
    // not be offered up for deletion.
    const orphans = findOrphanedWorktrees(repoRoot);
    if (orphans.length > 0) {
      console.log(`flow-code: ${orphans.length} orphaned worktree(s) found from a previous run.`);
      if (await confirm('Clean them up before starting?')) {
        await removeOrphanedWorktrees(repoRoot, orphans);
      } else {
        console.log('flow-code: continuing; run `flow-code doctor` to clean up later.');
      }
    }
  }

  try {
    // A resumed tree is expected to carry the interrupted work's uncommitted
    // changes — the normal dirty-tree refusal doesn't apply here.
    await preflight(workflow, repoRoot, { allowDirty: allowDirty || resuming, discussProvider });
  } catch (err) {
    if (err instanceof PreflightError) fail(err.message);
    throw err;
  }

  ensureGitExclude(repoRoot);

  let baseline;
  let store: RunStateStore;
  if (resumeState) {
    baseline = resumeState.baseline!;
    // Any node not already `done` restarts from scratch; clear its old
    // worktree (if any) first so the retry doesn't collide with the same
    // dir/branch the interrupted attempt used.
    const resetNodeIds = new Set(
      Object.entries(resumeState.nodes)
        .filter(([, n]) => n.status !== 'done')
        .map(([id]) => id),
    );
    for (const wt of resumeState.worktrees) {
      if (wt.removed || !resetNodeIds.has(wt.nodeId)) continue;
      if (existsSync(wt.dir)) {
        try {
          await removeWorktree(repoRoot, wt.dir);
        } catch {
          // best-effort — addWorktree will surface a real problem below
        }
      }
      // addWorktree re-creates this branch with `-b`, which fails outright
      // if it already exists from the interrupted attempt.
      try {
        await git(['branch', '-D', wt.branch], repoRoot);
      } catch {
        // never existed, or already gone — fine either way
      }
      wt.removed = true;
    }
    store = new RunStateStore({
      repoRoot,
      nodeIds: workflow.nodes.map((n) => n.id),
      resumeFrom: resumeState,
    });
    console.log(`flow-code: resuming run ${store.runId.slice(0, 8)}.`);
  } else {
    baseline = await recordBaseline(repoRoot, allowDirty);
    store = new RunStateStore({ repoRoot, nodeIds: workflow.nodes.map((n) => n.id) });
  }
  store.attachPersister(new FileRunStatePersister(repoRoot));
  store.setBaseline(baseline);

  const abortController = new AbortController();
  const ports = new UiInteractionPorts(abortController.signal);
  const engine = new Engine({
    workflow,
    store,
    repoRoot,
    baseline,
    ports,
    sessions: new CompositeSessionRunner(workflow, buildDiscussRunner(discussProvider), new NvidiaSessionRunner()),
    executors: builtinExecutors,
    signal: abortController.signal,
  });

  // ctrl+c (via the UI) or a real SIGINT/SIGTERM (piped stdin, `kill`, a
  // second ctrl+c once the terminal has left raw mode) both land here.
  // First call aborts the run and gives in-flight nodes a chance to unwind
  // cleanly; a second forces an immediate exit in case something is stuck.
  let interruptCount = 0;
  const triggerInterrupt = (): void => {
    interruptCount += 1;
    if (interruptCount > 1) {
      console.error('\nflow-code: forcing exit.');
      process.exit(130);
    }
    console.error(
      '\nflow-code: interrupting — finishing cleanly (press ctrl+c again to force quit)…',
    );
    abortController.abort();
    // Safety net: if some code path fails to respect the signal and hangs,
    // don't leave the terminal stuck. unref so it never delays a clean exit.
    setTimeout(() => {
      console.error('flow-code: cleanup took too long — forcing exit.');
      process.exit(130);
    }, 10_000).unref();
  };
  process.on('SIGINT', triggerInterrupt);
  process.on('SIGTERM', triggerInterrupt);

  const enginePromise = engine.run().then(async () => {
    // The run reached a terminal state: retained (converged) worktrees can
    // go now; their branches keep the work reachable.
    for (const wt of store.snapshot().worktrees) {
      if (!wt.removed && existsSync(wt.dir)) {
        try {
          await removeWorktree(repoRoot, wt.dir);
          store.updateWorktree(wt.dir, { removed: true });
        } catch {
          // leave it for doctor
        }
      }
    }
  });

  await runUi({ workflow, store, ports, onInterrupt: triggerInterrupt });
  await enginePromise;
  process.off('SIGINT', triggerInterrupt);
  process.off('SIGTERM', triggerInterrupt);

  const nodes = store.snapshot().nodes;
  const failedNodes = Object.entries(nodes).filter(([, n]) => n.status === 'error');
  const interrupted = abortController.signal.aborted;
  console.log(
    `flow-code: run ${store.runId.slice(0, 8)} ${interrupted ? 'interrupted' : 'finished'} — ` +
      Object.entries(
        Object.values(nodes).reduce<Record<string, number>>(
          (acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }),
          {},
        ),
      )
        .map(([s, c]) => `${c} ${s}`)
        .join(', '),
  );
  process.exit(interrupted ? 130 : failedNodes.length > 0 ? 1 : 0);
}

const HELP = `flow-code — terminal node-graph interface for agentic coding workflows

Usage:
  flow-code init              Scaffold .flow-code/workflow.yaml with the default graph
  flow-code run [--allow-dirty]
                              Run the workflow (refuses a dirty tree unless overridden)
  flow-code run --resume [runId]
                              Resume a run interrupted by ctrl+c/SIGTERM (defaults to the
                              most recent one); completed nodes are kept, the rest re-run,
                              and an interrupted Discuss conversation picks back up with
                              full history
  flow-code node-types        List built-in node types, capabilities, config and output shapes
  flow-code doctor [--yes]    List/remove orphaned worktrees from crashed runs
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'init':
      return cmdInit();
    case 'run':
      return cmdRun(args);
    case 'node-types':
      return cmdNodeTypes();
    case 'doctor':
      return cmdDoctor(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      fail(`unknown command \`${command}\`\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(`flow-code: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
