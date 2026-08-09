import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodeTypes } from '../src/cli/nodeTypes.js';
import { cmdSkills } from '../src/cli/skills.js';
import { listNodeTypes } from '../src/registry/index.js';

/** Everything the command printed, as one string. */
function captureLog(): { lines: () => string; spy: ReturnType<typeof vi.spyOn> } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map(([line]) => String(line ?? '')).join('\n'), spy };
}

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe('cmdNodeTypes', () => {
  it('lists every registered node type with its id and display name', () => {
    const { lines } = captureLog();
    cmdNodeTypes();
    const output = lines();
    for (const type of listNodeTypes()) {
      expect(output).toContain(`${type.id}  (${type.displayName})`);
    }
  });

  it('reports capabilities, and says `(none)` rather than printing an empty list', () => {
    const { lines } = captureLog();
    cmdNodeTypes();
    const output = lines();
    const withCaps = listNodeTypes().find((t) => t.capabilities.length > 0);
    const withoutCaps = listNodeTypes().find((t) => t.capabilities.length === 0);

    if (withCaps) expect(output).toContain(`capabilities: ${withCaps.capabilities.join(', ')}`);
    if (withoutCaps) expect(output).toContain('capabilities: (none)');
  });

  it('marks interactivity only on agent-driven types', () => {
    const { lines } = captureLog();
    cmdNodeTypes();
    const output = lines();
    // A non-agent type prints the bare "agent session: no" with no
    // interactive clause hanging off it.
    expect(output).toContain('agent session: no');
    expect(output).not.toContain('agent session: no · interactive');
    expect(output).toContain('agent session: yes · interactive:');
  });

  it('flags the fail-on-verdict and context-transparent types', () => {
    const { lines } = captureLog();
    cmdNodeTypes();
    const output = lines();
    if (listNodeTypes().some((t) => t.failsWhen)) {
      expect(output).toContain('fails on: its own output verdict');
    }
    if (listNodeTypes().some((t) => t.contextTransparent)) {
      expect(output).toContain('context: transparent');
    }
  });
});

describe('cmdSkills', () => {
  it('prints the skills listing for the repo the cwd sits in', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'flow-code-cli-skills-')));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    process.chdir(repo);

    const { lines } = captureLog();
    await cmdSkills();
    // The listing always leads with a count, whether or not any were found.
    expect(lines()).toMatch(/flow-code: (no skills|\d+ skill)/);
  });
});
