import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureGitExclude } from '../git/exclude.js';
import { isCliAvailable, runCliInstall } from '../init/cliInstall.js';
import { selectFromList } from '../init/SelectList.js';
import { DEFAULT_PRESET, listPresets } from '../presets.js';
import type { WorkflowPreset } from '../presets.js';
import { defaultSkillRoots, discoverSkills } from '../skills/discover.js';
import { WORKFLOW_RELATIVE_PATH } from '../workflow/load.js';

/** Which of `preset.requiredSkills` aren't discoverable from this repo yet. */
export function missingSkillNames(preset: WorkflowPreset, repoRoot: string): string[] {
  if (preset.requiredSkills.length === 0) return [];
  const available = new Set(discoverSkills(defaultSkillRoots(repoRoot)).map((s) => s.id));
  return preset.requiredSkills.filter((name) => !available.has(name));
}

/**
 * A preset references skills by name; whether they are installed is a property
 * of the machine, not of the preset. Report what is missing and where it is
 * expected rather than refusing to scaffold — the file is still the right
 * starting point, and the run would fail with the same names anyway. This is
 * the fallback for whatever `resolvePresetSkills` didn't (or couldn't) fix.
 */
function missingPresetSkills(preset: WorkflowPreset, repoRoot: string): string[] {
  const missing = missingSkillNames(preset, repoRoot);
  if (missing.length === 0) return [];
  const roots = defaultSkillRoots(repoRoot);
  return [
    `  Warning: ${missing.length} skill(s) this preset uses are not installed: ${missing.join(', ')}`,
    `    Expected in ${roots.project}, ${roots.user}, or an installed plugin.`,
    '    Install them, or edit the `skills:` entries in the scaffolded file.',
  ];
}

export interface ScaffoldResult {
  justScaffolded: boolean;
  overwrote: boolean;
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
export async function scaffoldWorkflow(
  repoRoot: string,
  path: string,
  preset: WorkflowPreset,
  presetExplicit: boolean,
  confirmOverwrite: () => Promise<boolean>,
): Promise<ScaffoldResult> {
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
    for (const line of missingPresetSkills(preset, repoRoot)) console.log(line);
  } else {
    console.log(`flow-code: ${WORKFLOW_RELATIVE_PATH} already exists — leaving it untouched.`);
  }
  return { justScaffolded, overwrote: overwrite };
}

export type CliInstallAction = 'install' | 'back';

/**
 * True if `preset` is ready to scaffold: it has no external CLI dependency,
 * that CLI is already on PATH, or the user just installed it successfully.
 * Takes its I/O as injected deps so it's testable without spawning a real
 * process or mounting Ink — the same seam `scaffoldWorkflow` uses for
 * `confirmOverwrite`.
 */
export async function resolvePresetCli(
  preset: WorkflowPreset,
  deps: {
    isCliAvailable: (command: string) => Promise<boolean>;
    runInstall: (install: { command: string; args: string[] }) => Promise<boolean>;
    promptAction: (preset: WorkflowPreset) => Promise<CliInstallAction | undefined>;
  },
): Promise<boolean> {
  if (!preset.cli) return true;
  if (await deps.isCliAvailable(preset.cli.command)) return true;

  const action = await deps.promptAction(preset);
  if (action !== 'install') return false; // 'back', or Esc/Ctrl+C on the prompt

  const installed = await deps.runInstall(preset.cli.install);
  return installed && (await deps.isCliAvailable(preset.cli.command));
}

/** Yes/No picker (not a `[Y/n]` text prompt) for installing a preset's missing CLI dependency. */
function promptCliInstallAction(preset: WorkflowPreset): Promise<CliInstallAction | undefined> {
  const { command, install } = preset.cli!;
  const installCmd = `${install.command} ${install.args.join(' ')}`;
  return selectFromList(
    [
      { label: `Install now (${installCmd})`, value: 'install' as const },
      { label: 'Go back', value: 'back' as const },
    ],
    { prompt: `\`${command}\` CLI not found on PATH — the \`${preset.name}\` preset needs it.` },
  );
}

export type SkillScaffoldAction = 'run' | 'skip';

/**
 * True whether or not the scaffold actually ran — this never blocks `init`.
 * The CLI being on PATH says nothing about whether it has been pointed at
 * *this* project yet (e.g. `openspec init`, which is what actually writes
 * `.claude/skills/openspec-*`); this is the step that closes that gap.
 * Declining, having no `scaffoldSkills` command, or the scaffold itself
 * failing all fall through to `missingPresetSkills`' warning instead.
 */
export async function resolvePresetSkills(
  preset: WorkflowPreset,
  repoRoot: string,
  deps: {
    missingSkillNames: (preset: WorkflowPreset, repoRoot: string) => string[];
    runScaffold: (command: { command: string; args: string[] }) => Promise<boolean>;
    promptAction: (preset: WorkflowPreset, missing: string[]) => Promise<SkillScaffoldAction | undefined>;
  },
): Promise<void> {
  if (!preset.cli?.scaffoldSkills) return;
  const missing = deps.missingSkillNames(preset, repoRoot);
  if (missing.length === 0) return;
  const action = await deps.promptAction(preset, missing);
  if (action !== 'run') return;
  await deps.runScaffold({ ...preset.cli.scaffoldSkills, args: [...preset.cli.scaffoldSkills.args, repoRoot] });
}

/** Yes/No picker for scaffolding a preset's missing skills via its CLI (e.g. `openspec init`). */
function promptSkillScaffoldAction(preset: WorkflowPreset, missing: string[]): Promise<SkillScaffoldAction | undefined> {
  const { command, args } = preset.cli!.scaffoldSkills!;
  const scaffoldCmd = `${command} ${args.join(' ')}`;
  return selectFromList(
    [
      { label: `Run now (${scaffoldCmd})`, value: 'run' as const },
      { label: 'Skip — install manually later', value: 'skip' as const },
    ],
    {
      prompt: `\`${preset.name}\` preset needs ${missing.length} skill(s) not yet set up in this project: ${missing.join(', ')}.`,
    },
  );
}

/**
 * The default wiring for `resolvePresetCli`/`resolvePresetSkills`: real PATH
 * lookups, real installs, real Ink pickers. Both entry points into `init`
 * (explicit `--preset` and the interactive picker) run the same two steps, so
 * they share one implementation rather than repeating the dependency literals.
 */
export async function preparePreset(preset: WorkflowPreset, repoRoot: string): Promise<boolean> {
  const ready = await resolvePresetCli(preset, {
    isCliAvailable,
    runInstall: runCliInstall,
    promptAction: promptCliInstallAction,
  });
  if (!ready) return false;
  await resolvePresetSkills(preset, repoRoot, {
    missingSkillNames,
    runScaffold: runCliInstall,
    promptAction: promptSkillScaffoldAction,
  });
  return true;
}

/**
 * Shown only when there's an actual choice to make: no `--preset` flag and no
 * workflow.yaml yet. An already-scaffolded repo is left untouched by a bare
 * `init` regardless of TTY, so this never fires on a reconfigure-only run.
 *
 * Loops back to the same list on "Go back" (or an install that still leaves
 * the CLI missing) rather than bailing out of `init` — the user just picks
 * again, same as if that preset had no CLI dependency at all.
 */
export async function selectPresetInteractively(repoRoot: string): Promise<WorkflowPreset | undefined> {
  const presets = [DEFAULT_PRESET, ...listPresets()];
  for (;;) {
    const chosen = await selectFromList(
      presets.map((p) => ({
        label: p.name === 'default' ? `${p.name} — ${p.summary} (customize afterward)` : `${p.name} — ${p.summary}`,
        value: p,
      })),
      { prompt: 'Starting workflow:' },
    );
    if (!chosen) return undefined; // Esc/Ctrl+C on the picker itself still cancels init
    if (!(await preparePreset(chosen, repoRoot))) {
      console.log(`flow-code: \`${chosen.cli!.command}\` still not found on PATH — pick another preset or install it manually.`);
      continue;
    }
    return chosen;
  }
}
