import { describe, expect, it, vi } from 'vitest';
import { resolvePresetCli, type CliInstallAction } from '../src/cli.js';
import { getPreset, DEFAULT_PRESET } from '../src/presets.js';

const OPENSPEC = getPreset('openspec')!;
const SPEC_KIT = getPreset('spec-kit')!;

function deps(opts: {
  available?: boolean;
  availableAfterInstall?: boolean;
  action?: CliInstallAction | undefined;
  installOk?: boolean;
}) {
  const isCliAvailable = vi
    .fn<(command: string) => Promise<boolean>>()
    .mockResolvedValueOnce(opts.available ?? false)
    .mockResolvedValue(opts.availableAfterInstall ?? false);
  const runInstall = vi.fn().mockResolvedValue(opts.installOk ?? false);
  const promptAction = vi.fn().mockResolvedValue(opts.action);
  return { isCliAvailable, runInstall, promptAction };
}

describe('resolvePresetCli', () => {
  it('is ready immediately when the preset has no CLI dependency', async () => {
    const d = deps({});
    const ready = await resolvePresetCli(DEFAULT_PRESET, d);
    expect(ready).toBe(true);
    expect(d.isCliAvailable).not.toHaveBeenCalled();
    expect(d.promptAction).not.toHaveBeenCalled();
  });

  it('is ready immediately when the CLI is already on PATH', async () => {
    const d = deps({ available: true });
    const ready = await resolvePresetCli(OPENSPEC, d);
    expect(ready).toBe(true);
    expect(d.promptAction).not.toHaveBeenCalled();
    expect(d.runInstall).not.toHaveBeenCalled();
  });

  it('is not ready when the user goes back', async () => {
    const d = deps({ action: 'back' });
    const ready = await resolvePresetCli(OPENSPEC, d);
    expect(ready).toBe(false);
    expect(d.runInstall).not.toHaveBeenCalled();
  });

  it('is not ready when the prompt is cancelled (Esc/Ctrl+C)', async () => {
    const d = deps({ action: undefined });
    const ready = await resolvePresetCli(OPENSPEC, d);
    expect(ready).toBe(false);
    expect(d.runInstall).not.toHaveBeenCalled();
  });

  it('is ready once the install succeeds and the CLI is then found', async () => {
    const d = deps({ action: 'install', installOk: true, availableAfterInstall: true });
    const ready = await resolvePresetCli(OPENSPEC, d);
    expect(ready).toBe(true);
    expect(d.runInstall).toHaveBeenCalledWith(OPENSPEC.cli!.install);
  });

  it('is not ready when the install exits 0 but the CLI is still missing', async () => {
    const d = deps({ action: 'install', installOk: true, availableAfterInstall: false });
    const ready = await resolvePresetCli(OPENSPEC, d);
    expect(ready).toBe(false);
  });

  it('is not ready when the install itself fails', async () => {
    const d = deps({ action: 'install', installOk: false, availableAfterInstall: false });
    const ready = await resolvePresetCli(OPENSPEC, d);
    expect(ready).toBe(false);
  });

  it('checks and installs the spec-kit CLI the same way as openspec', async () => {
    const d = deps({ action: 'install', installOk: true, availableAfterInstall: true });
    const ready = await resolvePresetCli(SPEC_KIT, d);
    expect(ready).toBe(true);
    expect(d.isCliAvailable).toHaveBeenCalledWith('specify');
    expect(d.runInstall).toHaveBeenCalledWith(SPEC_KIT.cli!.install);
  });
});
