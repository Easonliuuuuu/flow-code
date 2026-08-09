import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffoldWorkflow } from '../src/cli/presetSetup.js';
import { DEFAULT_PRESET, getPreset } from '../src/presets.js';

function tempRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-cli-scaffold-'));
  mkdirSync(join(repoRoot, '.flow-code'), { recursive: true });
  return repoRoot;
}

const OPENSPEC = getPreset('openspec')!;

describe('scaffoldWorkflow', () => {
  it('writes the preset on a fresh repo without prompting', async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, '.flow-code', 'workflow.yaml');
    let asked = false;

    const result = await scaffoldWorkflow(repoRoot, path, OPENSPEC, true, async () => {
      asked = true;
      return true;
    });

    expect(asked).toBe(false);
    expect(result).toEqual({ justScaffolded: true, overwrote: false });
    expect(readFileSync(path, 'utf8')).toBe(OPENSPEC.yaml);
  });

  it('leaves an existing workflow untouched on a bare init re-run (no --preset)', async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, '.flow-code', 'workflow.yaml');
    writeFileSync(path, 'nodes: []\n');
    let asked = false;

    const result = await scaffoldWorkflow(repoRoot, path, DEFAULT_PRESET, false, async () => {
      asked = true;
      return true;
    });

    expect(asked).toBe(false);
    expect(result).toEqual({ justScaffolded: false, overwrote: false });
    expect(readFileSync(path, 'utf8')).toBe('nodes: []\n');
  });

  it('prompts and leaves the file untouched when an explicit --preset is declined', async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, '.flow-code', 'workflow.yaml');
    writeFileSync(path, 'nodes: []\n');
    let asked = false;

    const result = await scaffoldWorkflow(repoRoot, path, OPENSPEC, true, async () => {
      asked = true;
      return false;
    });

    expect(asked).toBe(true);
    expect(result).toEqual({ justScaffolded: false, overwrote: false });
    expect(readFileSync(path, 'utf8')).toBe('nodes: []\n');
  });

  it('prompts and overwrites when an explicit --preset is confirmed', async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, '.flow-code', 'workflow.yaml');
    writeFileSync(path, 'nodes: []\n');
    let asked = false;

    const result = await scaffoldWorkflow(repoRoot, path, OPENSPEC, true, async () => {
      asked = true;
      return true;
    });

    expect(asked).toBe(true);
    expect(result).toEqual({ justScaffolded: true, overwrote: true });
    expect(readFileSync(path, 'utf8')).toBe(OPENSPEC.yaml);
  });

  it('excludes the workflow directory from git even on an overwrite', async () => {
    const repoRoot = tempRepo();
    execSync('git init -q', { cwd: repoRoot });
    const path = join(repoRoot, '.flow-code', 'workflow.yaml');
    writeFileSync(path, 'nodes: []\n');

    await scaffoldWorkflow(repoRoot, path, OPENSPEC, true, async () => true);

    expect(existsSync(join(repoRoot, '.git', 'info', 'exclude'))).toBe(true);
  });
});
