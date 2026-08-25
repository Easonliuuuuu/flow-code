import { getPreset, listPresets, type WorkflowPreset } from '../presets.js';
import { isCliAvailable } from '../init/cliInstall.js';
import { defaultSkillRoots, discoverSkills, type SkillRoots } from '../skills/discover.js';
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

function skillProblems(preset: WorkflowPreset, roots: SkillRoots): string[] {
  const missing = missingSkills(preset, roots);
  if (missing.length === 0) return [];
  const scaffold = preset.cli?.scaffoldSkills;
  return [
    `preset \`${preset.name}\` is missing skill(s): ${missing.join(', ')}` +
      (scaffold !== undefined
        ? ` — run \`${[scaffold.command, ...scaffold.args, '.'].join(' ')}\` to scaffold them`
        : ' — install them before opening this preset'),
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
    const loadOptions: LoadOptions = selection.graph !== undefined ? { graph: selection.graph } : {};
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
  const roots = options.skillRoots ?? defaultSkillRoots(repoRoot);
  const problems = skillProblems(preset, roots);
  const cliIssue = await (options.isCliAvailable === undefined
    ? cliProblem(preset)
    : preset.cli !== undefined && !(await options.isCliAvailable(preset.cli.command))
      ? `preset \`${preset.name}\` requires the \`${preset.cli.command}\` CLI — install it with \`${preset.cli.install.command} ${preset.cli.install.args.join(' ')}\``
      : undefined);
  if (cliIssue !== undefined) problems.unshift(cliIssue);
  if (problems.length > 0) throw new WorkflowValidationError(problems, 'declarations');

  return { workflow: loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots }), preset };
}
