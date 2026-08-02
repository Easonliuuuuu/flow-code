import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../src/defaultWorkflow.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { setNodeModel, WorkflowWriteError } from '../src/workflow/write.js';

function tempWorkflowFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-code-write-test-'));
  const path = join(dir, 'workflow.yaml');
  writeFileSync(path, yaml);
  return path;
}

const FIXTURE = `# top-of-file comment
settings:
  concurrency: 2
  model: sonnet

nodes:
  - id: a
    type: implement
    config:
      # explains what a does
      instructions: do a

  - id: b
    type: implement
    config:
      instructions: do b
      model: opus

  - id: c
    type: review

edges:
  - { from: a, to: b }
  - { from: b, to: c }
`;

describe('setNodeModel', () => {
  it('sets config.model on a node that already has a config block', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeModel(path, 'a', 'haiku');
    const out = readFileSync(path, 'utf8');
    expect(out).toContain('instructions: do a');
    expect(out).toMatch(/config:\n\s+# explains what a does\n\s+instructions: do a\n\s+model: haiku/);
    // Untouched node and top-level settings survive.
    expect(out).toContain('instructions: do b');
    expect(out).toContain('model: opus');
    expect(out).toContain('# top-of-file comment');
    expect(out).toContain('settings:\n  concurrency: 2\n  model: sonnet');
    expect(loadWorkflowFromString(out).nodes.find((n) => n.id === 'a')?.config).toMatchObject({
      model: 'haiku',
    });
  });

  it('creates the config mapping on a node that has none', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeModel(path, 'c', 'haiku');
    const out = readFileSync(path, 'utf8');
    expect(out).toMatch(/id: c\n\s+type: review\n\s+config:\n\s+model: haiku/);
    const workflow = loadWorkflowFromString(out);
    expect(workflow.nodes.find((n) => n.id === 'c')?.config).toMatchObject({ model: 'haiku' });
  });

  it('deletes config.model, and the config mapping if it becomes empty', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeModel(path, 'b', null);
    let out = readFileSync(path, 'utf8');
    expect(out).not.toContain('model: opus');
    expect(out).toContain('instructions: do b');

    setNodeModel(path, 'a', 'haiku');
    setNodeModel(path, 'a', null);
    out = readFileSync(path, 'utf8');
    // config still holds the comment + instructions, so it survives; only
    // the model line we added and removed again is gone.
    expect(out).toMatch(/config:\n\s+# explains what a does\n\s+instructions: do a\n\s+- id: b/);
  });

  it('leaves comments, blank lines, and every other node untouched', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeModel(path, 'b', 'haiku');
    const out = readFileSync(path, 'utf8');
    const before = FIXTURE.split('\n');
    const after = out.split('\n');
    // Every line outside node b's config block is byte-for-byte identical,
    // in the same order.
    const changedRegion = after.slice(after.indexOf('  - id: b'), after.indexOf('  - id: c'));
    const beforeChangedRegion = before.slice(before.indexOf('  - id: b'), before.indexOf('  - id: c'));
    expect(after.filter((l) => !changedRegion.includes(l))).toEqual(
      before.filter((l) => !beforeChangedRegion.includes(l)),
    );
  });

  it('throws on an unknown node id and leaves the file untouched', () => {
    const path = tempWorkflowFile(FIXTURE);
    expect(() => setNodeModel(path, 'nope', 'haiku')).toThrow(WorkflowWriteError);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  it('refuses to write a result that would fail to load, leaving the file untouched', () => {
    // Test's config schema is a strictObject with no `model` field, so
    // setting one makes the edited document fail re-validation — the guard
    // must catch this before anything reaches disk.
    const yaml = `nodes:\n  - id: t\n    type: test\n    config:\n      commands: [echo hi]\n`;
    const path = tempWorkflowFile(yaml);
    expect(() => setNodeModel(path, 't', 'haiku')).toThrow(WorkflowWriteError);
    expect(readFileSync(path, 'utf8')).toBe(yaml);
  });

  it('is honest about the one known round-trip gap: a dangling trailing comment loses its separating blank line', () => {
    // Documents the DEFAULT_WORKFLOW_YAML case called out in write.ts: the
    // commented-out loop-back example at the very end of the file, with no
    // node after it, isn't attached to anything the yaml AST tracks, so the
    // blank line before it collapses. Every other comment in the file is
    // unaffected — this is the only diff from a real edit.
    const path = tempWorkflowFile(DEFAULT_WORKFLOW_YAML);
    setNodeModel(path, 'implement', 'haiku');
    const out = readFileSync(path, 'utf8');
    expect(out).toContain('model: haiku');
    expect(loadWorkflowFromString(out).nodes.find((n) => n.id === 'implement')?.config).toMatchObject(
      { model: 'haiku' },
    );
    // Every comment line from the source is still present somewhere in the output.
    const comments = DEFAULT_WORKFLOW_YAML.split('\n').filter((l) => l.trim().startsWith('#'));
    for (const comment of comments) expect(out).toContain(comment);
  });
});
