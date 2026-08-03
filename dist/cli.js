#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine/engine.js';
import { loadCredentials } from './engine/credentials.js';
import { preflight, PreflightError, defaultCredentialsResolver } from './engine/preflight.js';
import { PROVIDERS, providerInfo } from './engine/providers.js';
import { NvidiaSessionRunner, OpenAiSessionRunner, OpenRouterSessionRunner, SdkSessionRunner, } from './executors/index.js';
import { builtinExecutors } from './executors/index.js';
import { ensureGitExclude } from './git/exclude.js';
import { git, recordBaseline, removeWorktree } from './git/ops.js';
import { runProviderWizard } from './init/providerWizard.js';
import { confirm } from './init/prompts.js';
import { selectFromList } from './init/SelectList.js';
import { runTestSetupWizard } from './init/testWizard.js';
import { listNodeTypes } from './registry/index.js';
import { defaultSkillRoots, discoverSkills } from './skills/discover.js';
import { formatSkillsListing, skillCompatibilityNotes } from './skills/report.js';
import { FileRunStatePersister, findInterruptedRun, findLatestInterruptedRun, } from './runstate/persist.js';
import { RunStateStore } from './runstate/store.js';
import { runUi, UiInteractionPorts } from './ui/index.js';
import { DEFAULT_PRESET, getPreset, listPresets, presetNames } from './presets.js';
import { loadWorkflow, WORKFLOW_RELATIVE_PATH, WorkflowValidationError } from './workflow/load.js';
import { findOrphanedWorktrees, removeOrphanedWorktrees } from './worktrees/reconcile.js';
async function repoRootFromCwd() {
    try {
        return await git(['rev-parse', '--show-toplevel'], process.cwd());
    }
    catch {
        fail('not inside a git repository — flow-code runs per-repo.');
    }
}
function fail(message) {
    console.error(`flow-code: ${message}`);
    process.exit(1);
}
/**
 * Determines which provider backs every agent-driven node in this run, and
 * makes sure its API key ends up in the environment. Order of preference: a
 * previously saved per-repo choice (from `flow-code init`), then an
 * already-set env var for any provider, then the Claude Agent SDK's own
 * credential resolution. Never prompts — `flow-code init` is where that
 * happens now; a workflow with agent-driven nodes and nothing configured
 * fails fast with a pointer to it. A workflow with no agent-driven nodes at
 * all returns undefined, since no provider is ever actually needed.
 */
export async function resolveProvider(repoRoot, workflow) {
    const saved = loadCredentials(repoRoot);
    if (saved) {
        const envVar = providerInfo(saved.provider).apiKeyEnvVar;
        if (envVar && saved.apiKey && !process.env[envVar]) {
            process.env[envVar] = saved.apiKey;
        }
        if (envVar && saved.apiKey2 && !process.env[`${envVar}_2`]) {
            process.env[`${envVar}_2`] = saved.apiKey2;
        }
        return { provider: saved.provider, model: saved.model };
    }
    for (const info of PROVIDERS) {
        if (info.apiKeyEnvVar && process.env[info.apiKeyEnvVar])
            return { provider: info.id };
    }
    if (defaultCredentialsResolver())
        return { provider: 'claude' };
    if (workflow.nodes.some((n) => n.type.agentDriven)) {
        fail('no provider configured — run `flow-code init` to choose one, or set ' +
            'ANTHROPIC_API_KEY / NVIDIA_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY.');
    }
    return undefined;
}
export function buildRunner(provider) {
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
/**
 * A preset references skills by name; whether they are installed is a property
 * of the machine, not of the preset. Report what is missing and where it is
 * expected rather than refusing to scaffold — the file is still the right
 * starting point, and the run would fail with the same names anyway.
 */
function missingPresetSkills(preset, repoRoot) {
    if (preset.requiredSkills.length === 0)
        return [];
    const roots = defaultSkillRoots(repoRoot);
    const available = new Set(discoverSkills(roots).map((s) => s.id));
    const missing = preset.requiredSkills.filter((name) => !available.has(name));
    if (missing.length === 0)
        return [];
    return [
        `  Warning: ${missing.length} skill(s) this preset uses are not installed: ${missing.join(', ')}`,
        `    Expected in ${roots.project}, ${roots.user}, or an installed plugin.`,
        '    Install them, or edit the `skills:` entries in the scaffolded file.',
    ];
}
/**
 * Writes the preset's workflow.yaml when the repo has none yet, or when the
 * caller explicitly named `--preset` on an already-scaffolded repo and
 * `confirmOverwrite` approves replacing it. A bare `init` re-run (no
 * `--preset`) never overwrites — that's most often just "reconfigure the
 * provider," and this repo's workflow.yaml may carry manual edits.
 * `confirmOverwrite` is only invoked when there's actually a decision to
 * make, so a caller that always answers "no" never sees a prompt on a fresh
 * repo.
 */
export async function scaffoldWorkflow(repoRoot, path, preset, presetExplicit, confirmOverwrite) {
    const alreadyScaffolded = existsSync(path);
    let overwrite = false;
    if (alreadyScaffolded && presetExplicit) {
        console.log(`flow-code: ${WORKFLOW_RELATIVE_PATH} already exists.`);
        overwrite = await confirmOverwrite();
    }
    const justScaffolded = !alreadyScaffolded || overwrite;
    if (justScaffolded) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, preset.yaml);
        ensureGitExclude(repoRoot);
        console.log(`flow-code: ${overwrite ? 'overwrote' : 'created'} ${WORKFLOW_RELATIVE_PATH}`);
        console.log(`  ${preset.name === 'default' ? 'Default graph' : `Preset \`${preset.name}\``}: ${preset.summary}`);
        for (const line of missingPresetSkills(preset, repoRoot))
            console.log(line);
    }
    else {
        console.log(`flow-code: ${WORKFLOW_RELATIVE_PATH} already exists — leaving it untouched.`);
    }
    return { justScaffolded, overwrote: overwrite };
}
/**
 * Shown only when there's an actual choice to make: no `--preset` flag and no
 * workflow.yaml yet. An already-scaffolded repo is left untouched by a bare
 * `init` regardless of TTY, so this never fires on a reconfigure-only run.
 */
async function selectPresetInteractively() {
    const presets = [DEFAULT_PRESET, ...listPresets()];
    return selectFromList(presets.map((p) => ({
        label: p.name === 'default' ? `${p.name} — ${p.summary} (customize afterward)` : `${p.name} — ${p.summary}`,
        value: p,
    })), { prompt: 'Starting workflow:' });
}
async function cmdInit(args) {
    const presetIdx = args.indexOf('--preset');
    const presetName = presetIdx >= 0 ? args[presetIdx + 1] : undefined;
    // An unknown preset fails before anything is written: a half-scaffolded repo
    // is worse than no scaffold at all.
    if (presetIdx >= 0 && (!presetName || !getPreset(presetName))) {
        fail(`unknown preset \`${presetName ?? ''}\` — available: ${presetNames().join(', ')}`);
    }
    const repoRoot = await repoRootFromCwd();
    const path = join(repoRoot, WORKFLOW_RELATIVE_PATH);
    let preset;
    if (presetName) {
        preset = getPreset(presetName);
    }
    else if (!existsSync(path) && process.stdin.isTTY) {
        const chosen = await selectPresetInteractively();
        if (!chosen) {
            console.log('flow-code: setup cancelled — run `flow-code init` again when ready.');
            process.exit(0);
        }
        preset = chosen;
    }
    else {
        preset = DEFAULT_PRESET;
    }
    const { justScaffolded } = await scaffoldWorkflow(repoRoot, path, preset, presetIdx >= 0, () => confirm(`  Overwrite it with the \`${preset.name}\` preset? Existing content will be replaced.`));
    // Provider setup comes before the test-command step: when the heuristics
    // find nothing, that step falls back to a read-only agent session, which
    // needs a configured provider to exist.
    const existing = loadCredentials(repoRoot);
    let runWizard = !existing;
    if (existing) {
        console.log(`flow-code: provider already configured (${providerInfo(existing.provider).label}, model ${existing.model}).`);
        runWizard = await confirm('  Reconfigure the provider/model?');
    }
    let configured = existing;
    if (runWizard) {
        if (!process.stdin.isTTY) {
            console.log('flow-code: no TTY detected — skipping interactive provider setup.');
            console.log('  Set ANTHROPIC_API_KEY / NVIDIA_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or re-run `flow-code init` from an interactive terminal.');
            process.exit(0);
        }
        const result = await runProviderWizard(repoRoot);
        if (!result) {
            console.log('flow-code: setup cancelled — run `flow-code init` again when ready.');
            process.exit(0);
        }
        configured = result;
        console.log(`flow-code: configured ${providerInfo(result.provider).label} / ${result.model} for this project.`);
    }
    if (justScaffolded) {
        if (process.stdin.isTTY) {
            await runTestSetupWizard(repoRoot, path, {
                ...(configured ? { sessions: buildRunner(configured.provider), model: configured.model } : {}),
            });
        }
        else {
            console.log('  No TTY detected — leaving the placeholder test command in .flow-code/workflow.yaml; edit it directly, or re-run `flow-code init` from an interactive terminal.');
        }
    }
    console.log('  Start a run with: flow-code run');
    // Explicit rather than relying on the event loop draining naturally: see
    // the comment atop prompts.ts on why these two don't mix reliably.
    process.exit(0);
}
function cmdNodeTypes() {
    for (const type of listNodeTypes()) {
        console.log(`${type.id}  (${type.displayName})`);
        console.log(`  ${type.description}`);
        console.log(`  capabilities: ${type.capabilities.length > 0 ? type.capabilities.join(', ') : '(none)'}`);
        console.log(`  agent session: ${type.agentDriven ? 'yes' : 'no'}` +
            (type.agentDriven ? ` · interactive: ${type.interactive ? 'yes' : 'no'}` : ''));
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
async function cmdSkills() {
    const repoRoot = await repoRootFromCwd();
    const skills = discoverSkills(defaultSkillRoots(repoRoot));
    for (const line of formatSkillsListing(skills, repoRoot))
        console.log(line);
}
async function cmdDoctor(args) {
    const repoRoot = await repoRootFromCwd();
    const compatibility = skillCompatibilityNotes(discoverSkills(defaultSkillRoots(repoRoot)));
    if (compatibility.length > 0) {
        console.log('flow-code: discovered skills declaring an external dependency:');
        for (const note of compatibility)
            console.log(note);
        console.log('');
    }
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
        // Explicit rather than relying on the event loop draining naturally: see
        // the comment atop prompts.ts on why these two don't mix reliably.
        process.exit(0);
    }
    const { removed, failed } = await removeOrphanedWorktrees(repoRoot, orphans);
    for (const dir of removed)
        console.log(`  removed ${dir}`);
    for (const failure of failed)
        console.log(`  FAILED ${failure.dir}: ${failure.error}`);
    process.exit(0);
}
async function cmdRun(args) {
    const allowDirty = args.includes('--allow-dirty');
    const resumeIdx = args.indexOf('--resume');
    const resuming = resumeIdx >= 0;
    const resumeRunId = resuming && args[resumeIdx + 1] !== undefined && !args[resumeIdx + 1].startsWith('-')
        ? args[resumeIdx + 1]
        : undefined;
    const repoRoot = await repoRootFromCwd();
    let workflow;
    try {
        workflow = loadWorkflow(repoRoot);
    }
    catch (err) {
        if (err instanceof WorkflowValidationError) {
            console.error('flow-code: the workflow file is invalid:');
            for (const problem of err.problems)
                console.error(`  - ${problem}`);
            process.exit(1);
        }
        throw err;
    }
    // Captured before the fallback below can overwrite it, so the run UI can
    // still tell a node that inherits the workflow's own `settings.model` apart
    // from one that's only ever seeing the provider default plugged into it.
    const workflowSettingsModel = workflow.settings.model;
    const resolved = await resolveProvider(repoRoot, workflow);
    if (resolved?.model && !workflow.settings.model) {
        workflow.settings.model = resolved.model;
    }
    let resumeState;
    if (resuming) {
        resumeState = resumeRunId
            ? findInterruptedRun(repoRoot, resumeRunId)
            : findLatestInterruptedRun(repoRoot);
        if (!resumeState) {
            fail(resumeRunId
                ? `no interrupted run \`${resumeRunId}\` found to resume.`
                : 'no interrupted run found to resume — start a new one with `flow-code run`.');
        }
        const currentIds = new Set(workflow.nodes.map((n) => n.id));
        const missing = Object.keys(resumeState.nodes).filter((id) => !currentIds.has(id));
        if (missing.length > 0) {
            fail(`the workflow has changed since run ${resumeState.runId.slice(0, 8)} — ` +
                `missing node(s): ${missing.join(', ')}. Start a new run instead.`);
        }
        if (!resumeState.baseline) {
            fail(`run ${resumeState.runId.slice(0, 8)} has no recorded baseline — cannot resume.`);
        }
    }
    else {
        // Reconcile orphans from crashed runs before starting a new one. Skipped
        // while resuming: this run's own retained worktrees would show up here
        // too (nothing distinguishes them from a truly abandoned run) and must
        // not be offered up for deletion.
        const orphans = findOrphanedWorktrees(repoRoot);
        if (orphans.length > 0) {
            console.log(`flow-code: ${orphans.length} orphaned worktree(s) found from a previous run.`);
            if (await confirm('Clean them up before starting?')) {
                await removeOrphanedWorktrees(repoRoot, orphans);
            }
            else {
                console.log('flow-code: continuing; run `flow-code doctor` to clean up later.');
            }
        }
    }
    try {
        // A resumed tree is expected to carry the interrupted work's uncommitted
        // changes — the normal dirty-tree refusal doesn't apply here.
        await preflight(workflow, repoRoot, {
            allowDirty: allowDirty || resuming,
            ...(resolved ? { provider: resolved.provider } : {}),
            onWarning: (message) => console.warn(`flow-code: ${message}`),
        });
    }
    catch (err) {
        if (err instanceof PreflightError)
            fail(err.message);
        throw err;
    }
    ensureGitExclude(repoRoot);
    let baseline;
    let store;
    if (resumeState) {
        baseline = resumeState.baseline;
        // Any node not already `done` restarts from scratch; clear its old
        // worktree (if any) first so the retry doesn't collide with the same
        // dir/branch the interrupted attempt used.
        const resetNodeIds = new Set(Object.entries(resumeState.nodes)
            .filter(([, n]) => n.status !== 'done')
            .map(([id]) => id));
        for (const wt of resumeState.worktrees) {
            if (wt.removed || !resetNodeIds.has(wt.nodeId))
                continue;
            if (existsSync(wt.dir)) {
                try {
                    await removeWorktree(repoRoot, wt.dir);
                }
                catch {
                    // best-effort — addWorktree will surface a real problem below
                }
            }
            // addWorktree re-creates this branch with `-b`, which fails outright
            // if it already exists from the interrupted attempt.
            try {
                await git(['branch', '-D', wt.branch], repoRoot);
            }
            catch {
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
    }
    else {
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
        sessions: resolved ? buildRunner(resolved.provider) : new SdkSessionRunner(),
        executors: builtinExecutors,
        signal: abortController.signal,
    });
    // ctrl+c (via the UI) or a real SIGINT/SIGTERM (piped stdin, `kill`, a
    // second ctrl+c once the terminal has left raw mode) both land here.
    // First call aborts the run and gives in-flight nodes a chance to unwind
    // cleanly; a second forces an immediate exit in case something is stuck.
    let interruptCount = 0;
    const triggerInterrupt = () => {
        interruptCount += 1;
        if (interruptCount > 1) {
            console.error('\nflow-code: forcing exit.');
            process.exit(130);
        }
        console.error('\nflow-code: interrupting — finishing cleanly (press ctrl+c again to force quit)…');
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
                }
                catch {
                    // leave it for doctor
                }
            }
        }
    });
    await runUi({
        workflow,
        store,
        ports,
        onInterrupt: triggerInterrupt,
        modelContext: {
            providerId: resolved?.provider,
            providerDefaultModel: resolved?.model,
            workflowSettingsModel,
        },
    });
    await enginePromise;
    process.off('SIGINT', triggerInterrupt);
    process.off('SIGTERM', triggerInterrupt);
    const nodes = store.snapshot().nodes;
    const failedNodes = Object.entries(nodes).filter(([, n]) => n.status === 'error');
    const interrupted = abortController.signal.aborted;
    console.log(`flow-code: run ${store.runId.slice(0, 8)} ${interrupted ? 'interrupted' : 'finished'} — ` +
        Object.entries(Object.values(nodes).reduce((acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }), {}))
            .map(([s, c]) => `${c} ${s}`)
            .join(', '));
    process.exit(interrupted ? 130 : failedNodes.length > 0 ? 1 : 0);
}
const HELP = `flow-code — terminal node-graph interface for agentic coding workflows

Usage:
  flow-code init [--preset <name>]
                              Scaffold .flow-code/workflow.yaml with the default graph, set up
                              its test command(s), and pick the provider/model for the project
                              (re-run any time — already-configured steps ask before redoing)
  flow-code run [--allow-dirty]
                              Run the workflow (refuses a dirty tree unless overridden)
  flow-code run --resume [runId]
                              Resume a run interrupted by ctrl+c/SIGTERM (defaults to the
                              most recent one); completed nodes are kept, the rest re-run,
                              and an interrupted Discuss conversation picks back up with
                              full history
  flow-code node-types        List built-in node types, capabilities, config and output shapes
  flow-code skills            List skills attachable to a node, and where each was found
  flow-code doctor [--yes]    List/remove orphaned worktrees from crashed runs
`;
async function main() {
    const [command, ...args] = process.argv.slice(2);
    switch (command) {
        case 'init':
            return cmdInit(args);
        case 'run':
            return cmdRun(args);
        case 'node-types':
            return cmdNodeTypes();
        case 'skills':
            return cmdSkills();
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
// Only run when invoked directly (the published bin), not when imported —
// e.g. by tests importing resolveProvider/buildRunner for direct coverage.
// Compared via realpath since the published bin is a symlink (e.g. nvm's
// bin dir): process.argv[1] is the symlink path, but import.meta.url is
// resolved to the symlink target, so a direct string comparison never
// matches and the CLI silently no-ops.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(`flow-code: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
    });
}
//# sourceMappingURL=cli.js.map