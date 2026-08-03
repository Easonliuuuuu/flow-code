import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../../src/defaultWorkflow.js';
import { writeTestCommands } from '../../src/init/testWizard.js';
import { loadWorkflowFromString } from '../../src/workflow/load.js';

function tempWorkflowFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-code-testwizard-'));
  const path = join(dir, 'workflow.yaml');
  writeFileSync(path, DEFAULT_WORKFLOW_YAML);
  return path;
}

describe('writeTestCommands', () => {
  it('replaces the placeholder commands on the test node', () => {
    const path = tempWorkflowFile();
    writeTestCommands(path, ['npm test']);
    const workflow = loadWorkflowFromString(readFileSync(path, 'utf8'));
    const testNode = workflow.nodes.find((n) => n.id === 'test')!;
    expect(testNode.config).toMatchObject({ commands: ['npm test'] });
  });

  it('writes multiple commands in order, for multi-level test setups', () => {
    const path = tempWorkflowFile();
    writeTestCommands(path, ['npm run test:unit', 'npm run test:integration']);
    const workflow = loadWorkflowFromString(readFileSync(path, 'utf8'));
    const testNode = workflow.nodes.find((n) => n.id === 'test')!;
    expect(testNode.config).toMatchObject({
      commands: ['npm run test:unit', 'npm run test:integration'],
    });
  });

  it('leaves every other node and the surrounding comments untouched', () => {
    const path = tempWorkflowFile();
    writeTestCommands(path, ['npm test']);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# flow-code workflow — checked into your repo, edit as needed.');
    expect(text).toContain('id: implement');
    expect(text).toContain('topic: What should this change accomplish?');
    const workflow = loadWorkflowFromString(text);
    expect(workflow.order).toEqual([
      'discuss',
      'spec',
      'implement',
      'test',
      'validate',
      'review',
      'gate',
      'git-ops',
    ]);
  });
});
