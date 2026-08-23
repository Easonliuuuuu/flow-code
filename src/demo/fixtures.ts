/**
 * The demo project's content, in one place so the seeded repository
 * (`seedRepo.ts`) and the scripted session runner (`DemoSessionRunner.ts`,
 * `script.ts`) agree on exactly what "buggy" and "fixed" mean without
 * duplicating either string. There is one bug, one fix, one test — enough to
 * make the loop-back real without needing a reader to hold more than that in
 * their head.
 */

export const DEMO_SOURCE_FILENAME = 'math.js';
export const DEMO_TEST_FILENAME = 'math.test.js';
export const DEMO_TEST_COMMAND = 'node --test';

/**
 * The repository's committed starting point: a function that has not been
 * written yet. This is what a stranger's `flow-code try` repo looks like
 * before any node has run — closer to a real unstarted task than a
 * pre-broken one would be.
 */
export const DEMO_STUB_SOURCE = `'use strict';

function add(a, b) {
  throw new Error('not implemented');
}

module.exports = { add };
`;

/**
 * What the scripted \`implement\` node writes on its first attempt — plausible,
 * and wrong. Off-by-one on purpose: close enough that the failure it produces
 * reads as a real bug, not a script announcing itself.
 */
export const DEMO_BUGGY_SOURCE = `'use strict';

function add(a, b) {
  return a + b + 1;
}

module.exports = { add };
`;

/** What the scripted \`implement\` node writes on its second attempt, reached only via the loop-back. */
export const DEMO_FIXED_SOURCE = `'use strict';

function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

export const DEMO_TEST_SOURCE = `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./${DEMO_SOURCE_FILENAME}');

test('add sums two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});
`;

/**
 * How long each scripted step pauses before returning, so the run is legible
 * rather than instantaneous. Tests pass 0 to run at full speed.
 */
export const DEMO_STEP_DELAY_MS = 400;

/** The Discuss node's single scripted user turn — enough to give `spec` something to write from. */
export const DEMO_DISCUSS_USER_MESSAGE =
  "Add a function that adds two numbers together, with a test proving it's correct. Keep it small.";

/** `revise`'s scripted user turn, used only if a curious user rejects a gate. */
export const DEMO_REVISE_USER_MESSAGE = 'Looks right — go ahead as planned.';

export const DEMO_SPEC_TITLE = 'Add a two-number add function';
export const DEMO_SPEC_REQUIREMENTS = ['Implement `add(a, b)` in `math.js`, exported for `math.test.js` to use.'];

/**
 * Acceptance criteria text, in the order `spec`'s script reports them and
 * `validate`'s script reports them met — `withIds` assigns `AC1`, `AC2`, …
 * positionally, so the two scripts staying in the same order is what keeps
 * validate's computed verdict a pass rather than an accident of numbering.
 */
export const DEMO_ACCEPTANCE_CRITERIA = [
  'add(a, b) returns the sum of a and b for at least one non-trivial case',
  'the existing test in math.test.js passes',
];
