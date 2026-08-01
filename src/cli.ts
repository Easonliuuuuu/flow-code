#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Engine } from './engine/engine.js';
import { preflight, PreflightError } from './engine/preflight.js';
import { SdkSessionRunner } from './executors/index.js';
import { builtinExecutors } from './executors/index.js';
import { git, recordBaseline, removeWorktree } from './git/ops.js';
import { listNodeTypes } from './registry/index.js';
import { FileRunStatePersister } from './runstate/persist.js';
import { RunStateStore } from './runstate/store.js';
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
  const wanted = ['.flow-code/runs/', '.flow-code/worktrees/'];
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

  // Reconcile orphans from crashed runs before starting a new one.
  const orphans = findOrphanedWorktrees(repoRoot);
  if (orphans.length > 0) {
    console.log(`flow-code: ${orphans.length} orphaned worktree(s) found from a previous run.`);
    if (await confirm('Clean them up before starting?')) {
      await removeOrphanedWorktrees(repoRoot, orphans);
    } else {
      console.log('flow-code: continuing; run `flow-code doctor` to clean up later.');
    }
  }

  try {
    await preflight(workflow, repoRoot, { allowDirty });
  } catch (err) {
    if (err instanceof PreflightError) fail(err.message);
    throw err;
  }

  ensureGitExclude(repoRoot);
  const baseline = await recordBaseline(repoRoot, allowDirty);
  const store = new RunStateStore({ repoRoot, nodeIds: workflow.nodes.map((n) => n.id) });
  store.attachPersister(new FileRunStatePersister(repoRoot));
  store.setBaseline(baseline);

  const ports = new UiInteractionPorts();
  const engine = new Engine({
    workflow,
    store,
    repoRoot,
    baseline,
    ports,
    sessions: new SdkSessionRunner(),
    executors: builtinExecutors,
  });

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

  await runUi({ workflow, store, ports });
  await enginePromise;

  const nodes = store.snapshot().nodes;
  const failedNodes = Object.entries(nodes).filter(([, n]) => n.status === 'error');
  console.log(
    `flow-code: run ${store.runId.slice(0, 8)} finished — ` +
      Object.entries(
        Object.values(nodes).reduce<Record<string, number>>(
          (acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }),
          {},
        ),
      )
        .map(([s, c]) => `${c} ${s}`)
        .join(', '),
  );
  process.exit(failedNodes.length > 0 ? 1 : 0);
}

const HELP = `flow-code — terminal node-graph interface for agentic coding workflows

Usage:
  flow-code init              Scaffold .flow-code/workflow.yaml with the default graph
  flow-code run [--allow-dirty]
                              Run the workflow (refuses a dirty tree unless overridden)
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
