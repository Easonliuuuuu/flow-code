import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/runstate/store.js';
import { defaultSkillRoots } from '../src/skills/discover.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { RecordedGraphError, recordGraph, rehydrateGraph } from '../src/workflow/record.js';
import { setNodeModel } from '../src/workflow/write.js';

// Loop-backs, a per-node budget, a routing condition, and settings that are
// not the defaults — everything a run would need to come back identical.
const GRAPH = `
settings:
  concurrency: 1
  subagents: false
  budget:
    tokensPerRun: 1000
nodes:
  - id: impl
    type: implement
    config: { instructions: build it }
    budget: { tokens: 500 }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
  - id: review
    type: review
  - id: gate
    type: approval-gate
edges:
  - { from: impl, to: check }
  - { from: check, to: review }
  - { from: review, to: gate }
  - { from: check, to: impl, loopback: { maxAttempts: 2 } }
  - { from: review, to: gate, when: "review.verdict == 'pass'" }
`;

describe('recording a graph in the run document', () => {
  it('projects to something JSON can hold', () => {
    const recorded = recordGraph(loadWorkflowFromString(GRAPH));
    const roundTripped = JSON.parse(JSON.stringify(recorded));
    expect(roundTripped).toEqual(recorded);

    // The node type is recorded as its registry id, not its definition —
    // a definition carries zod schemas and predicate functions.
    expect(recorded.nodes.map((n) => n.type)).toEqual([
      'implement',
      'test',
      'review',
      'approval-gate',
    ]);
    // Derived structure is rebuilt on read rather than serialized.
    expect(recorded).not.toHaveProperty('graph');
    expect(recorded).not.toHaveProperty('order');
  });

  it('round-trips to a workflow that runs identically', () => {
    const original = loadWorkflowFromString(GRAPH);
    const rebuilt = rehydrateGraph(JSON.parse(JSON.stringify(recordGraph(original))), {
      repoRoot: process.cwd(),
    });

    expect(rebuilt.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id));
    expect(rebuilt.nodes.map((n) => n.type.id)).toEqual(original.nodes.map((n) => n.type.id));
    expect(rebuilt.nodes.map((n) => n.config)).toEqual(original.nodes.map((n) => n.config));
    expect(rebuilt.nodes.map((n) => n.budget)).toEqual(original.nodes.map((n) => n.budget));
    expect(rebuilt.edges).toEqual(original.edges);
    expect(rebuilt.settings).toEqual(original.settings);

    // The derived halves are recomputed, and agree.
    expect(rebuilt.order).toEqual(original.order);
    expect([...rebuilt.graph.ancestorsOf('gate')]).toEqual([...original.graph.ancestorsOf('gate')]);
    expect(rebuilt.graph.allLoopbacks()).toEqual(original.graph.allLoopbacks());
  });

  it('carries the selected graph name when there is one', () => {
    expect(recordGraph(loadWorkflowFromString(GRAPH), 'hardened').selected).toBe('hardened');
    expect(recordGraph(loadWorkflowFromString(GRAPH)).selected).toBeUndefined();
  });

  it('names the node and the type when a recorded type no longer exists', () => {
    // What a run interrupted under one build and resumed under another hits.
    const recorded = recordGraph(loadWorkflowFromString(GRAPH));
    recorded.nodes[1]!.type = 'retired-node-type';

    expect(() => rehydrateGraph(recorded, { repoRoot: process.cwd() })).toThrow(RecordedGraphError);
    try {
      rehydrateGraph(recorded, { repoRoot: process.cwd() });
    } catch (err) {
      expect((err as RecordedGraphError).problems.join('\n')).toContain('check');
      expect((err as RecordedGraphError).problems.join('\n')).toContain('retired-node-type');
    }
  });

  it('resolves skills against the machine reading the graph, not the one that recorded it', () => {
    // Where a skill lives is a property of the machine. The recorded config
    // names it; the reader finds it — which is what lets a run recorded on one
    // checkout be read on another.
    const base = mkdtempSync(join(tmpdir(), 'flow-code-record-skills-'));
    const repoRoot = join(base, 'repo');
    const roots = defaultSkillRoots(repoRoot, join(base, 'home'));
    const dir = join(roots.project, 'a-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: a-skill\ndescription: d\n---\n\nbody\n');

    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x, skills: [a-skill] }
`;
    const recorded = recordGraph(loadWorkflowFromString(yaml, { repoRoot, skillRoots: roots }));
    const rebuilt = rehydrateGraph(recorded, { repoRoot, skillRoots: roots });

    expect(rebuilt.nodes[0]!.skills.map((s) => s.id)).toEqual(['a-skill']);
  });

  it('does not change when the workflow file is edited mid-run', () => {
    // The property the whole recording exists for: this run keeps describing
    // what it is executing, and the edit applies to the next run instead.
    const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-record-edit-'));
    const path = join(repoRoot, 'workflow.yaml');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(path, GRAPH);

    const store = new RunStateStore({
      repoRoot,
      graph: recordGraph(loadWorkflowFromString(GRAPH)),
    });
    const before = JSON.parse(JSON.stringify(store.snapshot().graph));

    setNodeModel(path, 'impl', 'some-other-model');

    expect(store.snapshot().graph).toEqual(before);
    expect(readFileSync(path, 'utf8')).toContain('some-other-model');
  });

  it('resumes what was recorded, not what a completely different current workflow file would load', () => {
    // What `--resume` relies on: rehydrating never reads `workflow.yaml` at
    // all, so a file that has since changed shape entirely (fewer nodes, a
    // different structure) cannot leak into a resumed run.
    const recorded = recordGraph(loadWorkflowFromString(GRAPH));

    const DIVERGED = `
nodes:
  - id: solo
    type: implement
    config: { instructions: something else entirely }
`;
    const currentFileWorkflow = loadWorkflowFromString(DIVERGED);
    expect(currentFileWorkflow.nodes.map((n) => n.id)).toEqual(['solo']);

    const rebuilt = rehydrateGraph(recorded, { repoRoot: process.cwd() });
    expect(rebuilt.nodes.map((n) => n.id)).toEqual(['impl', 'check', 'review', 'gate']);
  });

  it('is on the run document before any node can leave idle', () => {
    const recorded = recordGraph(loadWorkflowFromString(GRAPH));
    const store = new RunStateStore({ repoRoot: process.cwd(), graph: recorded });
    const state = store.snapshot();

    expect(state.graph).toEqual(recorded);
    expect(Object.keys(state.nodes)).toEqual(['impl', 'check', 'review', 'gate']);
    expect(Object.values(state.nodes).every((n) => n.status === 'idle')).toBe(true);
  });
});
