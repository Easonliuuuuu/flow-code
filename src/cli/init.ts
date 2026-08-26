import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCredentials } from '../engine/credentials.js';
import { providerInfo } from '../engine/providers.js';
import { runProviderWizard } from '../init/providerWizard.js';
import { confirm } from '../init/prompts.js';
import { DEFAULT_PRESET, getPreset, presetNames } from '../presets.js';
import type { WorkflowPreset } from '../presets.js';
import { WORKFLOW_RELATIVE_PATH } from '../workflow/load.js';
import { fail, repoRootFromCwd } from './context.js';
import { preparePreset, scaffoldWorkflow, selectPresetInteractively } from './presetSetup.js';
import { liveHeartbeat } from '../guest/enforce.js';

export async function cmdInit(args: string[]): Promise<void> {
  const presetIdx = args.indexOf('--preset');
  const presetName = presetIdx >= 0 ? args[presetIdx + 1] : undefined;
  // An unknown preset fails before anything is written: a half-scaffolded repo
  // is worse than no scaffold at all.
  if (presetIdx >= 0 && (!presetName || !getPreset(presetName))) {
    fail(
      `unknown preset \`${presetName ?? ''}\` — available: ${presetNames().join(', ')}`,
    );
  }

  const repoRoot = await repoRootFromCwd();
  const host = liveHeartbeat(repoRoot)?.host;
  const path = join(repoRoot, WORKFLOW_RELATIVE_PATH);

  let preset: WorkflowPreset;
  if (presetName) {
    preset = getPreset(presetName)!;
    // An explicit --preset always scaffolds regardless of what happens here
    // (see below) — this just gives it the same CLI/skill prompts the
    // interactive picker gets, when there's a terminal to show them on.
    if (process.stdin.isTTY) {
      await preparePreset(preset, repoRoot, host);
    }
  } else if (!existsSync(path) && process.stdin.isTTY) {
    const chosen = await selectPresetInteractively(repoRoot, host);
    if (!chosen) {
      console.log('flow-code: setup cancelled — run `flow-code init` again when ready.');
      process.exit(0);
    }
    preset = chosen;
  } else {
    preset = DEFAULT_PRESET;
  }

  const { justScaffolded } = await scaffoldWorkflow(
    repoRoot,
    path,
    preset,
    presetIdx >= 0,
    () => confirm(`  Overwrite it with the \`${preset.name}\` preset? Existing content will be replaced.`),
    host,
  );

  const existing = loadCredentials(repoRoot);
  let runWizard = !existing;
  if (existing) {
    console.log(
      `flow-code: provider already configured (${providerInfo(existing.provider).label}, model ${existing.model}).`,
    );
    runWizard = await confirm('  Reconfigure the provider/model?');
  }

  if (runWizard) {
    if (!process.stdin.isTTY) {
      console.log('flow-code: no TTY detected — skipping interactive provider setup.');
      console.log(
        '  Set ANTHROPIC_API_KEY / CODEX_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or re-run `flow-code init` from an interactive terminal.',
      );
      process.exit(0);
    }
    const result = await runProviderWizard(repoRoot);
    if (!result) {
      console.log('flow-code: setup cancelled — run `flow-code init` again when ready.');
      process.exit(0);
    }
    console.log(`flow-code: configured ${providerInfo(result.provider).label} / ${result.model} for this project.`);
  }

  // The test command is deliberately not asked about here. The Test node
  // asks for itself, in the run UI, the first time it executes still holding
  // the placeholder — by which point the Discuss node has established what is
  // being built, which is context both the user and the discovery agent want.
  if (justScaffolded) {
    console.log(
      "  Test command: left as the scaffolded placeholder — the Test node will ask what to run when " +
        'it first executes, or edit `nodes: test: config: commands` in .flow-code/workflow.yaml directly.',
    );
  }

  console.log('  Start a run with: flow-code run');
  // Explicit rather than relying on the event loop draining naturally: see
  // the comment atop prompts.ts on why these two don't mix reliably.
  process.exit(0);
}
