import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_WORKFLOW_YAML } from '../defaultWorkflow.js';
import { WORKFLOW_RELATIVE_PATH } from '../workflow/load.js';
import {
  DEMO_SOURCE_FILENAME,
  DEMO_STUB_SOURCE,
  DEMO_TEST_COMMAND,
  DEMO_TEST_FILENAME,
  DEMO_TEST_SOURCE,
} from './fixtures.js';

export interface SeededDemoRepo {
  dir: string;
}

/**
 * The one place the seeded workflow file differs from what `flow-code init`
 * scaffolds: the Test node's commands are pre-set, so the demo needs no
 * discovery prompt and never re-runs `TEST_COMMANDS_AUTO`, which the loader
 * refuses to pair with a loop-back that can re-run the node (this graph has
 * exactly that loop-back). Everything else — every comment, every other node
 * — is the literal default scaffold.
 *
 * The replacement is anchored to the Test node's exact current text and
 * throws if it does not match, rather than silently no-opping. That is what
 * keeps this demo from drifting out of sync with `defaultWorkflow.ts`: a
 * future edit to that block breaks this loudly instead of quietly reverting
 * the demo to a discovery prompt it cannot answer.
 */
export function demoWorkflowYaml(): string {
  const anchor = '  - id: test\n    type: test\n\n  - id: validate';
  if (!DEFAULT_WORKFLOW_YAML.includes(anchor)) {
    throw new Error(
      "demoWorkflowYaml: the default scaffold's Test node no longer matches " +
        'what this demo expects — update the anchor in src/demo/seedRepo.ts',
    );
  }
  const replacement =
    '  - id: test\n' +
    '    type: test\n' +
    '    config:\n' +
    `      commands: ["${DEMO_TEST_COMMAND}"]\n` +
    '\n  - id: validate';
  return DEFAULT_WORKFLOW_YAML.replace(anchor, replacement);
}

/**
 * Creates a throwaway git repository seeded with a failing test and the real
 * default workflow. Synchronous and side-effect-only — there is nothing to
 * await. The caller decides whether to remove it; `try` does not, so what the
 * demo produced stays inspectable after it ends.
 */
export function seedDemoRepo(): SeededDemoRepo {
  const dir = mkdtempSync(join(tmpdir(), 'flow-code-try-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@flow-code.invalid');
  git('config', 'user.name', 'flow-code demo');

  writeFileSync(join(dir, DEMO_SOURCE_FILENAME), DEMO_STUB_SOURCE);
  writeFileSync(join(dir, DEMO_TEST_FILENAME), DEMO_TEST_SOURCE);

  const workflowPath = join(dir, WORKFLOW_RELATIVE_PATH);
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, demoWorkflowYaml());

  git('add', '-A');
  git('commit', '-q', '-m', 'flow-code try: seed');

  return { dir };
}
