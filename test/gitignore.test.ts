import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureFlowCodeGitignore,
  FLOW_CODE_GITIGNORE,
} from '../src/workflow/gitignore.js';

function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-gitignore-'));
}

/**
 * `.flow-code/` holds a plaintext API key and verbatim Discuss transcripts
 * next to the one file in there that is meant to be committed. What has to
 * hold is that the guard exists before anything sensitive is written beside
 * it, that it denies by default so a state directory added later is covered
 * on the day it lands, and that it never overwrites a project's own edits.
 */
describe('ensureFlowCodeGitignore', () => {
  it('creates the directory and the guard together', () => {
    const repoRoot = emptyRepo();

    ensureFlowCodeGitignore(repoRoot);

    expect(readFileSync(join(repoRoot, '.flow-code', '.gitignore'), 'utf8')).toBe(
      FLOW_CODE_GITIGNORE,
    );
  });

  it('denies by default, so state added later is covered without an edit', () => {
    const lines = FLOW_CODE_GITIGNORE.split('\n').filter((l) => l && !l.startsWith('#'));

    expect(lines[0]).toBe('*');
    expect(lines).toContain('!workflow.yaml');
    expect(lines).toContain('!.gitignore');
    // Nothing else is exempt: an allowlist that names `runs/` or
    // `credentials.json` would be a denylist again, and would miss the next one.
    expect(lines.filter((l) => l.startsWith('!'))).toHaveLength(2);
  });

  it('leaves an existing guard alone — a project that added a rule keeps it', () => {
    const repoRoot = emptyRepo();
    mkdirSync(join(repoRoot, '.flow-code'), { recursive: true });
    const path = join(repoRoot, '.flow-code', '.gitignore');
    writeFileSync(path, '*\n!.gitignore\n!workflow.yaml\n!presets/\n');

    ensureFlowCodeGitignore(repoRoot);

    expect(readFileSync(path, 'utf8')).toContain('!presets/');
  });

  it('is safe to call repeatedly', () => {
    const repoRoot = emptyRepo();

    ensureFlowCodeGitignore(repoRoot);
    ensureFlowCodeGitignore(repoRoot);

    expect(existsSync(join(repoRoot, '.flow-code', '.gitignore'))).toBe(true);
  });
});
