import { capabilitySet } from '../capabilities.js';
import type { ExecuteContext, NodeExecutor } from '../engine/types.js';
import { captureTree, diffNamesBetweenTrees, diffTrees, headCommit } from '../git/ops.js';
import {
  reviewOutput,
  validateOutput,
  type GitOpsConfig,
  type ImplementConfig,
  type ReviewConfig,
  type ValidateConfig,
  type ValidateOutput,
} from '../registry/index.js';
import type { Capability } from '../capabilities.js';
import {
  acceptanceCriteriaFrom,
  nodeModel,
  parseNodeOutput,
  runNodeSession,
  truncateText,
  upstreamPreamble,
} from './helpers.js';

/** Every node type below spends its session with exactly its own declared capability set. */
function ownCapabilities(ctx: ExecuteContext) {
  return capabilitySet(...(ctx.node.type.capabilities as Capability[]));
}

export const executeImplement: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  const config = ctx.node.config as ImplementConfig;
  const preTree = await captureTree(ctx.workingDir);
  const prompt = `${upstreamPreamble(ctx.upstream)}## Task\n\n${config.instructions}`;
  const finalText = await runNodeSession(ctx, ownCapabilities(ctx), prompt, nodeModel(ctx, config.model));
  const postTree = await captureTree(ctx.workingDir);
  const diff = await diffTrees(ctx.workingDir, preTree, postTree);
  const changedFiles = await diffNamesBetweenTrees(ctx.workingDir, preTree, postTree);
  yield {
    type: 'result',
    output: { changedFiles, diff, summary: truncateText(finalText, 2000) },
  };
  yield { type: 'status', status: 'done' };
};

export const executeValidate: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  const config = ctx.node.config as ValidateConfig;
  const criteria = acceptanceCriteriaFrom(ctx.upstream);

  // With a spec upstream, validation is a checklist against a contract that
  // was fixed before the work started. Without one it stays what it was: a
  // judgement about intent.
  const task = criteria.length > 0
    ? `Check the work in this working directory against each acceptance criterion below. ` +
      `These were fixed before the work began and are the contract it is judged against — ` +
      `do not reinterpret them to fit what was built.\n\n` +
      criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n') +
      (config.instructions ? `\n\nAlso: ${config.instructions}` : '')
    : (config.instructions ??
      'Check whether the work described in the upstream context has actually been carried out in this working directory, and satisfies its intent.');

  const shape = criteria.length > 0
    ? `{"verdict": "pass" | "fail", "notes": "<summary>", "criteria": [{"id": "<criterion id>", "met": true | false, "evidence": "<what you checked, and where>"}]}\n\n` +
      `Include one entry per criterion (${criteria.map((c) => c.id).join(', ')}). ` +
      `Report what you found; the verdict is computed from your entries.`
    : `{"verdict": "pass" | "fail", "notes": "<what you checked and what you found>"}`;

  const prompt =
    `${upstreamPreamble(ctx.upstream)}## Validation task\n\n${task}\n\n` +
    `When you are done, respond with ONLY a JSON object:\n${shape}`;

  const finalText = await runNodeSession(ctx, ownCapabilities(ctx), prompt, nodeModel(ctx, config.model));
  const parsed = parseNodeOutput(ctx, validateOutput, finalText);
  // No terminal status here: the type's `failsWhen` predicate decides whether
  // this verdict is a pass or a failure.
  yield { type: 'result', output: withCriteriaVerdict(parsed, criteria) };
};

/**
 * The verdict of a spec-backed validation is computed, never asserted: any
 * criterion reported unmet — or simply not reported at all — is a fail,
 * whatever the model concluded in prose. This is what makes a spec a stop
 * rule rather than a suggestion.
 */
function withCriteriaVerdict(
  parsed: ValidateOutput,
  criteria: Array<{ id: string; text: string }>,
): ValidateOutput {
  if (criteria.length === 0) return parsed;
  const reported = new Map(parsed.criteria.map((c) => [c.id, c]));
  const filled = criteria.map(
    (c) =>
      reported.get(c.id) ?? {
        id: c.id,
        met: false,
        evidence: 'not reported by the validation step',
      },
  );
  const unmet = filled.filter((c) => !c.met);
  return {
    ...parsed,
    criteria: filled,
    verdict: unmet.length > 0 ? 'fail' : 'pass',
    notes:
      unmet.length > 0
        ? `${unmet.length} of ${filled.length} acceptance criteria unmet (${unmet
            .map((c) => c.id)
            .join(', ')}). ${parsed.notes}`
        : parsed.notes,
  };
}

export const executeReview: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  const config = ctx.node.config as ReviewConfig;
  const prompt =
    `${upstreamPreamble(ctx.upstream)}## Review task\n\n` +
    `${config.instructions ?? 'Review the pending changes described in the upstream context for correctness, clarity, and risk.'}\n\n` +
    `When you are done, respond with ONLY a JSON object:\n` +
    `{"verdict": "pass" | "fail", "findings": [{"location": "<file:line or area>", "description": "<finding>", "severity": "info" | "minor" | "major"}]}`;
  const finalText = await runNodeSession(ctx, ownCapabilities(ctx), prompt, nodeModel(ctx, config.model));
  const parsed = parseNodeOutput(ctx, reviewOutput, finalText);
  // No terminal status here: see executeValidate.
  yield { type: 'result', output: parsed };
};

export const executeGitOps: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  const config = ctx.node.config as GitOpsConfig;

  let preHead: string;
  try {
    preHead = await headCommit(ctx.workingDir);
  } catch {
    preHead = '';
  }

  const steps: string[] = [
    `Commit all pending changes in this working directory with the commit message: ${JSON.stringify(
      config.commitMessage ?? 'flow-code: apply workflow changes',
    )}.`,
    'If there is nothing to commit, say so and stop.',
  ];
  if (config.push) {
    steps.push(
      `After committing, push the current branch to remote \`${config.push.remote}\`, branch \`${config.push.branch}\` (git push ${config.push.remote} HEAD:${config.push.branch}).`,
    );
  } else {
    steps.push('Do NOT push to any remote.');
  }
  const prompt = `${upstreamPreamble(ctx.upstream)}## Git operations\n\n${steps.join('\n')}`;

  await runNodeSession(ctx, ownCapabilities(ctx), prompt, nodeModel(ctx, config.model));

  let postHead: string;
  try {
    postHead = await headCommit(ctx.workingDir);
  } catch {
    postHead = '';
  }
  const committed = postHead !== '' && postHead !== preHead;

  // The activity log is the source of truth for what actually ran.
  const pushed =
    config.push !== undefined &&
    ctx.store
      .activityFor(ctx.node.id)
      .some(
        (e) =>
          e.decision === 'allowed' &&
          /(^|[\s;&|])git\s+([^|;&]*\s)?push(\s|$)/.test(e.summary) &&
          (e.exitStatus === 0 || e.exitStatus === undefined || e.exitStatus === null) &&
          e.error === undefined,
      );

  yield {
    type: 'result',
    output: {
      committed,
      ...(committed ? { commit: postHead } : {}),
      pushed,
      ...(config.push ? { remote: config.push.remote, branch: config.push.branch } : {}),
    },
  };
  yield { type: 'status', status: 'done' };
};
