import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPreset, listPresets, presetScaffoldCommand, type WorkflowPreset } from '../presets.js';
import { isCliAvailable } from '../init/cliInstall.js';
import { defaultSkillRoots, discoverSkills, type SkillRoots } from '../skills/discover.js';
import type { CompanionHost } from '../guest/host.js';
import {
  loadWorkflow,
  loadWorkflowFromString,
  WorkflowValidationError,
  type Workflow,
  type LoadOptions,
} from './load.js';

export interface WorkflowSelection {
  graph?: string;
  preset?: string;
  host?: CompanionHost;
}

export interface SelectedWorkflow {
  workflow: Workflow;
  preset?: WorkflowPreset;
  graph?: string;
}

function missingSkills(preset: WorkflowPreset, roots: SkillRoots): string[] {
  if (preset.requiredSkills.length === 0) return [];
  const available = new Set(discoverSkills(roots).map((skill) => skill.id));
  return preset.requiredSkills.filter((name) => !available.has(name));
}

export function missingProjectPaths(preset: WorkflowPreset, repoRoot: string): string[] {
  return (preset.requiredPaths ?? []).filter((path) => !existsSync(join(repoRoot, path)));
}

function skillProblems(preset: WorkflowPreset, roots: SkillRoots, repoRoot: string, host?: CompanionHost): string[] {
  const missing = missingSkills(preset, roots);
  const missingPaths = missingProjectPaths(preset, repoRoot);
  const scaffold = presetScaffoldCommand(preset, host);
  const remedy = scaffold !== undefined
    ? ` — run \`${[scaffold.command, ...scaffold.args, '.'].join(' ')}\``
    : ' — initialize the project before opening this preset';
  return [
    ...(missing.length > 0
      ? [`preset \`${preset.name}\` is missing skill(s): ${missing.join(', ')}${remedy}`]
      : []),
    ...(missingPaths.length > 0
      ? [`preset \`${preset.name}\` is not initialized in this project; missing: ${missingPaths.join(', ')}${remedy}`]
      : []),
  ];
}

async function cliProblem(preset: WorkflowPreset): Promise<string | undefined> {
  if (preset.cli === undefined || (await isCliAvailable(preset.cli.command))) return undefined;
  const install = `${preset.cli.install.command} ${preset.cli.install.args.join(' ')}`;
  return `preset \`${preset.name}\` requires the \`${preset.cli.command}\` CLI — install it with \`${install}\``;
}

export function presetNamesForSelection(): string[] {
  return listPresets().map((preset) => preset.name);
}

export async function selectWorkflow(
  repoRoot: string,
  selection: WorkflowSelection = {},
  options: { skillRoots?: SkillRoots; isCliAvailable?: (command: string) => Promise<boolean> } = {},
): Promise<SelectedWorkflow> {
  if (selection.graph !== undefined && selection.preset !== undefined) {
    throw new WorkflowValidationError(
      ['`graph` and `preset` cannot be selected together — choose one workflow source'],
      'file-schema',
    );
  }

  if (selection.preset === undefined) {
    const roots = options.skillRoots ?? defaultSkillRoots(repoRoot, undefined, selection.host);
    const loadOptions: LoadOptions = {
      ...(selection.graph !== undefined ? { graph: selection.graph } : {}),
      skillRoots: roots,
    };
    return {
      workflow: loadWorkflow(repoRoot, loadOptions),
      ...(selection.graph !== undefined ? { graph: selection.graph } : {}),
    };
  }

  const preset = getPreset(selection.preset);
  if (preset === undefined) {
    throw new WorkflowValidationError(
      [`unknown preset \`${selection.preset}\` — available: ${presetNamesForSelection().join(', ')}`],
      'file-schema',
    );
  }
  const roots = options.skillRoots ?? defaultSkillRoots(repoRoot, undefined, selection.host);
  const problems = skillProblems(preset, roots, repoRoot, selection.host);
  const cliIssue = await (options.isCliAvailable === undefined
    ? cliProblem(preset)
    : preset.cli !== undefined && !(await options.isCliAvailable(preset.cli.command))
      ? `preset \`${preset.name}\` requires the \`${preset.cli.command}\` CLI — install it with \`${preset.cli.install.command} ${preset.cli.install.args.join(' ')}\``
      : undefined);
  if (cliIssue !== undefined) problems.unshift(cliIssue);
  if (problems.length > 0) throw new WorkflowValidationError(problems, 'declarations');

  return { workflow: loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots }), preset };
}
