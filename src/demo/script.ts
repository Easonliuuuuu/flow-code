import {
  DEMO_ACCEPTANCE_CRITERIA,
  DEMO_SPEC_REQUIREMENTS,
  DEMO_SPEC_TITLE,
} from './fixtures.js';

/**
 * Every agent-driven node in the default graph that produces structured
 * output asks for it the same way: a prompt ending "Respond with ONLY a
 * JSON object". Detecting that phrase — rather than tracking which numbered
 * turn a session is on — is what lets one scripted reply function serve
 * `discuss`'s four different prompt shapes (opening, reopening, a plain
 * turn, the closing request) without the runner needing to parse or care
 * which one it received.
 */
export function looksLikeJsonRequest(prompt: string): boolean {
  return prompt.includes('Respond with ONLY a JSON object');
}

/** `spec`'s scripted response — the contract `validate`'s script is written to satisfy. */
export function specResponseJson(): string {
  return JSON.stringify({
    title: DEMO_SPEC_TITLE,
    requirements: DEMO_SPEC_REQUIREMENTS,
    acceptanceCriteria: DEMO_ACCEPTANCE_CRITERIA,
  });
}

/**
 * `validate`'s scripted response. Reports every criterion from
 * `DEMO_ACCEPTANCE_CRITERIA` met, with ids assigned the same way `spec.ts`'s
 * `withIds` assigns them (positional: `AC1`, `AC2`, …) — the ids have to
 * agree for `withCriteriaVerdict` to compute a pass rather than treating an
 * unrecognised id as unmet.
 */
export function validateResponseJson(): string {
  return JSON.stringify({
    verdict: 'pass',
    notes: 'Both acceptance criteria are met: add(a, b) returns the correct sum and the test suite passes.',
    criteria: DEMO_ACCEPTANCE_CRITERIA.map((text, i) => ({
      id: `AC${i + 1}`,
      met: true,
      evidence: `Checked against: ${text}`,
    })),
  });
}

/** `review`'s scripted response — nothing to flag, so its own loop-back never fires. */
export function reviewResponseJson(): string {
  return JSON.stringify({ verdict: 'pass', findings: [] });
}

/**
 * `discuss`/`revise`'s scripted conclusion. Prefixed with a disclosure line
 * so the one place the demo genuinely diverges from a live run — a scripted
 * conversation standing in for one the user would normally hold — says so at
 * the point it happens, not only in the run's header banner.
 */
export function discussConclusionJson(): string {
  return JSON.stringify({
    conclusion:
      '(scripted for flow-code try — see the banner above) ' +
      'Add add(a, b) to math.js, matching the test already in math.test.js.',
    constraints: ['Keep the change to math.js only.'],
  });
}

/** A generic acknowledgment for every non-concluding turn of a scripted Discuss/Revise conversation. */
export function discussReplyText(): string {
  return "Got it — I'll write add(a, b) in math.js to match the existing test, then hand off to implementation.";
}

/** `implement`'s scripted summary; the file it writes is the demo's real output, this is just the session's last word. */
export function implementSummaryText(attempt: number): string {
  return attempt === 1
    ? 'Implemented add(a, b) in math.js.'
    : 'The test failure showed the previous attempt was off by one — corrected add(a, b) in math.js.';
}
