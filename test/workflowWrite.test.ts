import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../src/defaultWorkflow.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import {
  setNodeBudgetTokens,
  setNodeConfigString,
  setNodeModel,
  setNodeSkills,
  WorkflowWriteError,
} from '../src/workflow/write.js';

/**
 * `<repoRoot>/.flow-code/workflow.yaml` — the real shape (see
 * WORKFLOW_RELATIVE_PATH), which matters now that re-validation anchors
 * skill resolution two directories up from the file, not at process.cwd().
 */
function tempWorkflowFile(yaml: string): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-write-test-'));
  const path = join(repoRoot, '.flow-code', 'workflow.yaml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml);
  return path;
}

/** Plants a minimal discoverable skill under the workflow's own repo root. */
function addFixtureSkill(workflowPath: string, id: string): void {
  const dir = join(dirname(dirname(workflowPath)), '.claude', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: fixture skill\n---\ndo the thing\n');
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

describe('setNodeSkills', () => {
  it('sets config.skills on a node that already has a config block', () => {
    const path = tempWorkflowFile(FIXTURE);
    addFixtureSkill(path, 'demo-skill');
    setNodeSkills(path, 'a', ['demo-skill']);
    const out = readFileSync(path, 'utf8');
    expect(out).toContain('instructions: do a');
    expect(out).toMatch(/skills:\n\s+- demo-skill/);
    // Untouched node and top-level settings survive.
    expect(out).toContain('instructions: do b');
    expect(out).toContain('# top-of-file comment');
    const node = loadWorkflowFromString(out, { repoRoot: dirname(dirname(path)) }).nodes.find(
      (n) => n.id === 'a',
    );
    expect(node?.config).toMatchObject({ skills: ['demo-skill'] });
    expect(node?.skills.map((s) => s.id)).toEqual(['demo-skill']);
  });

  it('creates the config mapping on a node that has none', () => {
    const path = tempWorkflowFile(FIXTURE);
    addFixtureSkill(path, 'demo-skill');
    setNodeSkills(path, 'c', ['demo-skill']);
    const out = readFileSync(path, 'utf8');
    expect(out).toMatch(/id: c\n\s+type: review\n\s+config:\n\s+skills:\n\s+- demo-skill/);
    const workflow = loadWorkflowFromString(out, { repoRoot: dirname(dirname(path)) });
    expect(workflow.nodes.find((n) => n.id === 'c')?.config).toMatchObject({ skills: ['demo-skill'] });
  });

  it('clears config.skills, and the config mapping if it becomes empty', () => {
    const path = tempWorkflowFile(FIXTURE);
    addFixtureSkill(path, 'demo-skill');
    setNodeSkills(path, 'b', ['demo-skill']);
    setNodeSkills(path, 'b', []);
    const out = readFileSync(path, 'utf8');
    expect(out).not.toContain('demo-skill');
    // `model: opus` was already on node b's config, so the mapping survives.
    expect(out).toContain('instructions: do b');
    expect(out).toContain('model: opus');
  });

  it('deletes the config mapping entirely when skills was its only field', () => {
    const path = tempWorkflowFile(FIXTURE);
    addFixtureSkill(path, 'demo-skill');
    setNodeSkills(path, 'c', ['demo-skill']);
    setNodeSkills(path, 'c', []);
    // Node c started with no config block at all — round-trips back to that.
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  it('throws on an unknown node id and leaves the file untouched', () => {
    const path = tempWorkflowFile(FIXTURE);
    addFixtureSkill(path, 'demo-skill');
    expect(() => setNodeSkills(path, 'nope', ['demo-skill'])).toThrow(WorkflowWriteError);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });

  it('writes skills onto a Test node, which now accepts them via its optional agent step', () => {
    const yaml = `nodes:\n  - id: t\n    type: test\n    config:\n      commands: [echo hi]\n`;
    const path = tempWorkflowFile(yaml);
    addFixtureSkill(path, 'demo-skill');
    setNodeSkills(path, 't', ['demo-skill']);
    const out = readFileSync(path, 'utf8');
    expect(out).toMatch(/skills:\n\s+- demo-skill/);
    const wf = loadWorkflowFromString(out, {
      repoRoot: dirname(dirname(path)),
    });
    expect(wf.nodes[0]!.skills.map((s) => s.id)).toEqual(['demo-skill']);
  });

  it('refuses to write an undiscoverable skill id, leaving the file untouched', () => {
    const path = tempWorkflowFile(FIXTURE);
    expect(() => setNodeSkills(path, 'a', ['no-such-skill'])).toThrow(WorkflowWriteError);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });
});

describe('setNodeBudgetTokens', () => {
  it('adds a budget beside config, not inside it', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeBudgetTokens(path, 'a', 50_000);
    const out = readFileSync(path, 'utf8');
    expect(out).toMatch(/id: a\n\s+type: implement\n\s+config:/);
    expect(out).toMatch(/budget:\n\s+tokens: 50000/);
    expect(loadWorkflowFromString(out).nodes.find((n) => n.id === 'a')?.budget).toEqual({
      tokens: 50_000,
    });
    // The config block is untouched, comment and all.
    expect(out).toMatch(/# explains what a does\n\s+instructions: do a/);
  });

  it('sets a budget on a node with no config block at all', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeBudgetTokens(path, 'c', 1_000);
    const out = readFileSync(path, 'utf8');
    expect(loadWorkflowFromString(out).nodes.find((n) => n.id === 'c')?.budget).toEqual({
      tokens: 1_000,
    });
  });

  it('clearing the tokens removes the empty budget mapping with it', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeBudgetTokens(path, 'a', 50_000);
    setNodeBudgetTokens(path, 'a', null);
    const out = readFileSync(path, 'utf8');
    expect(out).not.toContain('budget');
    expect(loadWorkflowFromString(out).nodes.find((n) => n.id === 'a')?.budget).toBeUndefined();
  });

  it('refuses a budget that would not load, leaving the file untouched', () => {
    const path = tempWorkflowFile(FIXTURE);
    expect(() => setNodeBudgetTokens(path, 'a', 0)).toThrow(WorkflowWriteError);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });
});

describe('setNodeConfigString', () => {
  it('sets and clears an arbitrary string config field', () => {
    const path = tempWorkflowFile(FIXTURE);
    setNodeConfigString(path, 'a', 'instructions', 'do something else');
    expect(readFileSync(path, 'utf8')).toContain('instructions: do something else');

    setNodeConfigString(path, 'c', 'instructions', 'review hard');
    expect(readFileSync(path, 'utf8')).toMatch(/id: c\n\s+type: review\n\s+config:\n\s+instructions: review hard/);
    setNodeConfigString(path, 'c', 'instructions', null);
    expect(readFileSync(path, 'utf8')).toMatch(/id: c\n\s+type: review\n/);
  });

  it('refuses to clear a field the node type requires, leaving the file untouched', () => {
    const path = tempWorkflowFile(FIXTURE);
    // Implement's `instructions` is required, so clearing it must not land.
    expect(() => setNodeConfigString(path, 'a', 'instructions', null)).toThrow(WorkflowWriteError);
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE);
  });
});
