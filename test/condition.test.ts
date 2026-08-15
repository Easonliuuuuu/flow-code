import { describe, expect, it } from 'vitest';
import {
  ConditionParseError,
  evaluateCondition,
  parseCondition,
  resolvePath,
} from '../src/workflow/condition.js';
import { loadWorkflowFromString, WorkflowValidationError } from '../src/workflow/load.js';

describe('parseCondition', () => {
  it('parses a comparison against each literal kind', () => {
    expect(parseCondition("review.verdict == 'fail'")).toMatchObject({
      nodeId: 'review',
      path: ['verdict'],
      operator: '==',
      value: 'fail',
    });
    expect(parseCondition('test.passed == false')).toMatchObject({ operator: '==', value: false });
    expect(parseCondition('review.findings.length > 0')).toMatchObject({
      path: ['findings', 'length'],
      operator: '>',
      value: 0,
    });
    expect(parseCondition('implement.summary != null')).toMatchObject({
      operator: '!=',
      value: null,
    });
  });

  it('reads `>=` as itself rather than as a bare `>`', () => {
    expect(parseCondition('review.findings.length >= 2')).toMatchObject({
      operator: '>=',
      value: 2,
    });
  });

  it('parses the unary operators', () => {
    expect(parseCondition('implement.changedFiles isNotEmpty')).toMatchObject({
      nodeId: 'implement',
      path: ['changedFiles'],
      operator: 'isNotEmpty',
    });
    expect(parseCondition('implement.changedFiles isEmpty')).toMatchObject({ operator: 'isEmpty' });
  });

  it('does not split on an operator inside a quoted value', () => {
    const parsed = parseCondition("validate.notes contains '>= threshold'");
    expect(parsed.operator).toBe('contains');
    expect(parsed.value).toBe('>= threshold');
  });

  it('rejects what it cannot parse, so a typo fails the load', () => {
    expect(() => parseCondition('review.verdict')).toThrow(ConditionParseError);
    expect(() => parseCondition('review verdict == 1')).toThrow(ConditionParseError);
    expect(() => parseCondition("== 'fail'")).toThrow(ConditionParseError);
    expect(() => parseCondition('review.verdict == fail')).toThrow(ConditionParseError);
  });
});

describe('resolvePath', () => {
  it('walks objects and understands length on arrays and strings', () => {
    expect(resolvePath({ a: { b: 2 } }, ['a', 'b'])).toBe(2);
    expect(resolvePath({ files: ['x', 'y'] }, ['files', 'length'])).toBe(2);
    expect(resolvePath({ note: 'abc' }, ['note', 'length'])).toBe(3);
  });

  it('reads a missing path as undefined instead of throwing', () => {
    expect(resolvePath({ a: 1 }, ['b', 'c'])).toBeUndefined();
    expect(resolvePath(undefined, ['a'])).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  const check = (source: string, output: unknown): boolean =>
    evaluateCondition(parseCondition(source), output);

  it('compares equality, including a null literal matching an absent field', () => {
    expect(check("review.verdict == 'fail'", { verdict: 'fail' })).toBe(true);
    expect(check("review.verdict == 'fail'", { verdict: 'pass' })).toBe(false);
    expect(check('review.summary == null', {})).toBe(true);
    expect(check('review.summary != null', { summary: 'x' })).toBe(true);
  });

  it('orders numbers and refuses to order anything else', () => {
    expect(check('review.findings.length > 0', { findings: [{}] })).toBe(true);
    expect(check('review.findings.length > 0', { findings: [] })).toBe(false);
    expect(check('review.findings.length >= 1', { findings: [{}] })).toBe(true);
    // A string is not ordered against a number; guessing an order would make
    // the workflow behave arbitrarily.
    expect(check('review.verdict > 1', { verdict: 'fail' })).toBe(false);
  });

  it('tests membership in arrays and substrings in strings', () => {
    expect(check("implement.changedFiles contains 'a.ts'", { changedFiles: ['a.ts'] })).toBe(true);
    expect(check("implement.changedFiles contains 'b.ts'", { changedFiles: ['a.ts'] })).toBe(false);
    expect(check("validate.notes contains 'missing'", { notes: 'a thing is missing' })).toBe(true);
  });

  it('treats absent, empty string, empty array and empty object as empty', () => {
    expect(check('implement.changedFiles isEmpty', {})).toBe(true);
    expect(check('implement.changedFiles isEmpty', { changedFiles: [] })).toBe(true);
    expect(check('implement.changedFiles isNotEmpty', { changedFiles: ['a.ts'] })).toBe(true);
    expect(check('implement.summary isEmpty', { summary: '' })).toBe(true);
  });
});

describe('workflow validation of `when`', () => {
  const wf = (edges: string): string => `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: rev
    type: review
  - id: fix
    type: implement
    config: { instructions: y }
edges:
${edges}
`;

  it('accepts a condition on the edge source', () => {
    const workflow = loadWorkflowFromString(
      wf(`  - { from: impl, to: rev }\n  - { from: rev, to: fix, when: "rev.verdict == 'fail'" }`),
    );
    expect(workflow.graph.conditionsInto('fix')).toHaveLength(1);
    expect(workflow.graph.conditionsInto('rev')).toHaveLength(0);
  });

  it('accepts a condition on a node upstream of the source', () => {
    expect(() =>
      loadWorkflowFromString(
        wf(`  - { from: impl, to: rev }\n  - { from: rev, to: fix, when: "impl.changedFiles isNotEmpty" }`),
      ),
    ).not.toThrow();
  });

  it('rejects a condition reading a node whose output may not exist yet', () => {
    expect(() =>
      loadWorkflowFromString(
        wf(`  - { from: impl, to: rev }\n  - { from: impl, to: fix, when: "rev.verdict == 'fail'" }`),
      ),
    ).toThrow(/can only read `impl` or a node upstream of it/);
  });

  it('rejects an unparseable condition at load time', () => {
    expect(() =>
      loadWorkflowFromString(wf(`  - { from: impl, to: rev, when: "impl.changedFiles" }`)),
    ).toThrow(WorkflowValidationError);
  });

  it('rejects an unknown node in a condition', () => {
    expect(() =>
      loadWorkflowFromString(wf(`  - { from: impl, to: rev, when: "nope.verdict == 'fail'" }`)),
    ).toThrow(/references unknown node `nope`/);
  });

  it('refuses a `when` on a loop-back — a return path is taken because a node failed', () => {
    expect(() =>
      loadWorkflowFromString(
        wf(
          `  - { from: impl, to: rev }\n  - { from: rev, to: impl, loopback: true, when: "rev.verdict == 'fail'" }`,
        ),
      ),
    ).toThrow(/cannot carry a `when`/);
  });
});

describe('approved-condition synthesis on Approval-Gate out-edges', () => {
  const wf = (edges: string): string => `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
  - id: revise
    type: discuss
edges:
${edges}
`;

  it('conditions an unconditional gate out-edge on approval', () => {
    // The safety property: a workflow written before rejection branches existed
    // must not let a rejected change reach git.
    const workflow = loadWorkflowFromString(
      wf(`  - { from: impl, to: gate }\n  - { from: gate, to: ship }`),
    );
    const [condition] = workflow.graph.conditionsInto('ship');
    expect(condition!.condition.source).toBe("gate.decision == 'approved'");
  });

  it('leaves an explicitly conditioned gate out-edge exactly as written', () => {
    const workflow = loadWorkflowFromString(
      wf(
        `  - { from: impl, to: gate }\n  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }`,
      ),
    );
    const [condition] = workflow.graph.conditionsInto('revise');
    expect(condition!.condition.source).toBe("gate.decision == 'rejected'");
  });

  it('leaves edges out of other node types unconditional', () => {
    const workflow = loadWorkflowFromString(
      wf(`  - { from: impl, to: gate }\n  - { from: gate, to: ship }`),
    );
    expect(workflow.graph.conditionsInto('gate')).toHaveLength(0);
  });

  it('adds nothing to a loop-back out of a gate', () => {
    // A return path is taken because the source failed; that is its condition,
    // and the loader rejects a `when` on one outright.
    const workflow = loadWorkflowFromString(
      wf(
        `  - { from: impl, to: gate }\n  - { from: gate, to: ship }\n  - { from: gate, to: impl, loopback: true }`,
      ),
    );
    expect(workflow.graph.allLoopbacks()).toHaveLength(1);
    expect(workflow.edges.find((e) => e.loopback)!.when).toBeUndefined();
  });

  it('does not rewrite the workflow file the user wrote', () => {
    const source = wf(`  - { from: impl, to: gate }\n  - { from: gate, to: ship }`);
    loadWorkflowFromString(source);
    expect(source).not.toContain('approved');
  });
});
