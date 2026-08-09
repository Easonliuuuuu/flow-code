import { describe, expect, it, vi } from 'vitest';
import { resolvePresetSkills, type SkillScaffoldAction } from '../src/cli/presetSetup.js';
import { getPreset, DEFAULT_PRESET } from '../src/presets.js';

const OPENSPEC = getPreset('openspec')!;
const SPEC_KIT = getPreset('spec-kit')!;

function deps(opts: { missing?: string[]; action?: SkillScaffoldAction | undefined; scaffoldOk?: boolean }) {
  const missingSkillNames = vi.fn().mockReturnValue(opts.missing ?? []);
  const runScaffold = vi.fn().mockResolvedValue(opts.scaffoldOk ?? true);
  const promptAction = vi.fn().mockResolvedValue(opts.action);
  return { missingSkillNames, runScaffold, promptAction };
}

describe('resolvePresetSkills', () => {
  it('does nothing when the preset has no scaffold command', async () => {
    const d = deps({ missing: ['some-skill'] });
    await resolvePresetSkills(DEFAULT_PRESET, '/repo', d);
    expect(d.missingSkillNames).not.toHaveBeenCalled();
    expect(d.promptAction).not.toHaveBeenCalled();
  });

  it('does nothing when the preset has a scaffold command but no required skills are missing', async () => {
    const d = deps({ missing: [] });
    await resolvePresetSkills(OPENSPEC, '/repo', d);
    expect(d.missingSkillNames).toHaveBeenCalledWith(OPENSPEC, '/repo');
    expect(d.promptAction).not.toHaveBeenCalled();
    expect(d.runScaffold).not.toHaveBeenCalled();
  });

  it('prompts and runs the scaffold command (with repoRoot appended) when the user accepts', async () => {
    const d = deps({ missing: ['openspec-explore', 'openspec-propose'], action: 'run', scaffoldOk: true });
    await resolvePresetSkills(OPENSPEC, '/repo', d);
    expect(d.promptAction).toHaveBeenCalledWith(OPENSPEC, ['openspec-explore', 'openspec-propose']);
    expect(d.runScaffold).toHaveBeenCalledWith({ command: 'openspec', args: ['init', '--tools', 'claude', '/repo'] });
  });

  it('does not run the scaffold command when the user skips', async () => {
    const d = deps({ missing: ['openspec-explore'], action: 'skip' });
    await resolvePresetSkills(OPENSPEC, '/repo', d);
    expect(d.runScaffold).not.toHaveBeenCalled();
  });

  it('does not run the scaffold command when the prompt is cancelled (Esc/Ctrl+C)', async () => {
    const d = deps({ missing: ['openspec-explore'], action: undefined });
    await resolvePresetSkills(OPENSPEC, '/repo', d);
    expect(d.runScaffold).not.toHaveBeenCalled();
  });

  it('never throws when the scaffold command itself fails', async () => {
    const d = deps({ missing: ['openspec-explore'], action: 'run', scaffoldOk: false });
    await expect(resolvePresetSkills(OPENSPEC, '/repo', d)).resolves.toBeUndefined();
  });

  it('is a no-op for spec-kit, which has no skills to scaffold', async () => {
    const d = deps({ missing: [] });
    await resolvePresetSkills(SPEC_KIT, '/repo', d);
    expect(d.missingSkillNames).not.toHaveBeenCalled();
  });
});
