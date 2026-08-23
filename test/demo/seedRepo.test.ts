import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../../src/defaultWorkflow.js';
import { DEMO_FIXED_SOURCE, DEMO_SOURCE_FILENAME, DEMO_TEST_COMMAND } from '../../src/demo/fixtures.js';
import { demoWorkflowYaml, seedDemoRepo } from '../../src/demo/seedRepo.js';
import { WORKFLOW_RELATIVE_PATH } from '../../src/workflow/load.js';
import { workflowFromYaml } from '../helpers.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trimEnd();
}

/** `node --test` exits non-zero on failure, so execFileSync throws rather than returning a status. */
function demoTestExitCode(dir: string): number {
  try {
    execFileSync('sh', ['-c', DEMO_TEST_COMMAND], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return status ?? 1;
  }
}

const created: string[] = [];

afterEach(() => {
  created.length = 0;
});

describe('seedDemoRepo', () => {
  it('is a git repository with exactly one commit and a clean tree', () => {
    const { dir } = seedDemoRepo();
    created.push(dir);
    expect(git(dir, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('seeds a workflow file that loads through buildWorkflow with no problems', () => {
    const { dir } = seedDemoRepo();
    created.push(dir);
    const yaml = execFileSync('cat', [join(dir, WORKFLOW_RELATIVE_PATH)]).toString();
    expect(() => workflowFromYaml(yaml)).not.toThrow();
  });

  it('pre-sets the Test node commands and changes nothing else in the default scaffold', () => {
    const yaml = demoWorkflowYaml();
    expect(yaml).toContain(`commands: ["${DEMO_TEST_COMMAND}"]`);
    const addedLines = yaml.split('\n').length - DEFAULT_WORKFLOW_YAML.split('\n').length;
    expect(addedLines).toBe(2); // "config:" + "commands: [...]", nothing else inserted or removed
  });

  it('is anchored to the current default scaffold, so a drifted Test node block breaks loudly', () => {
    expect(DEFAULT_WORKFLOW_YAML).toContain('  - id: test\n    type: test\n\n  - id: validate');
  });

  it('the seeded test fails before the fix and passes after — asserted directly, not through the engine', () => {
    const { dir } = seedDemoRepo();
    created.push(dir);
    expect(demoTestExitCode(dir)).not.toBe(0);

    writeFileSync(join(dir, DEMO_SOURCE_FILENAME), DEMO_FIXED_SOURCE);
    expect(demoTestExitCode(dir)).toBe(0);
  });
});
