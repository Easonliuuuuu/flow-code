import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { Engine } from '../src/engine/engine.js';
import type { AgentSessionRequest, SessionRunner } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import { createInterceptor } from '../src/harness/intercept.js';
import { DEFAULT_WORKFLOW_YAML } from '../src/defaultWorkflow.js';
import { FileRunStatePersister, readRunState, runFilePath } from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { GitOpsOutput } from '../src/registry/index.js';
import { fakePorts, makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * Session runner that mimics the real SDK path: every tool call goes through
 * the real interceptor (recording allows/denials in the activity log), and
 * allowed shell commands actually execute in the session's working directory.
 */
interface HarnessTools {
  bash(command: string): { denied: boolean; output: string };
  write(relPath: string, content: string): { denied: boolean };
}

function harnessedSessions(
  script: (req: AgentSessionRequest, tools: HarnessTools) => string,
): SessionRunner {
  const make = (req: AgentSessionRequest, store: RunStateStore): HarnessTools => {
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      capabilities: capabilitySet(...req.capabilities),
      workingDir: req.workingDir,
      store,
    });
    return {
      bash(command) {
        const id = randomUUID();
        const decision = interceptor.check('Bash', { command }, { toolUseID: id });
        if (decision.behavior === 'deny') return { denied: true, output: decision.message ?? '' };
        let output = '';
        let exitStatus = 0;
        try {
          output = execFileSync('sh', ['-c', command], { cwd: req.workingDir }).toString();
        } catch (err) {
          exitStatus = (err as { status?: number }).status ?? 1;
        }
        interceptor.complete(id, { exitStatus });
        return { denied: false, output };
      },
      write(relPath, content) {
        const target = join(req.workingDir, relPath);
        const decision = interceptor.check('Write', { file_path: target });
        if (decision.behavior === 'deny') return { denied: true };
        writeFileSync(target, content);
        return { denied: false };
      },
    };
  };

  return {
    async run(req, store) {
      return { finalText: script(req, make(req, store)) };
    },
    async openInteractive(req, store) {
      const tools = make(req, store);
      return {
        send: async (text) => script({ ...req, prompt: text }, tools),
        end: async () => {},
      };
    },
  };
}

/** Plays every role in the default workflow, by node id. */
function defaultWorkflowScript(req: AgentSessionRequest, tools: HarnessTools): string {
  switch (req.nodeId) {
    case 'discuss':
      if (req.prompt.includes('JSON object recording')) {
        return JSON.stringify({
          conclusion: 'Add a greeting file saying hello in blue.',
          constraints: ['keep it to one file'],
        });
      }
      return 'Understood — what color should the greeting be?';
    case 'spec': {
      // The conclusion from Discuss must reach the Spec node.
      if (!req.prompt.includes('greeting file')) {
        throw new Error('spec did not receive the discussion conclusion');
      }
      return JSON.stringify({
        title: 'Blue greeting file',
        requirements: ['one file only'],
        acceptanceCriteria: ['greeting.txt exists and says hello in blue'],
      });
    }
    case 'implement': {
      // The spec — not the raw transcript — is what Implement works from.
      if (!req.prompt.includes('greeting.txt exists and says hello in blue')) {
        throw new Error('implement did not receive the spec acceptance criteria');
      }
      tools.write('greeting.txt', 'hello (blue)\n');
      // A well-intentioned overstep: the harness must block this and log it.
      const push = tools.bash('git push origin main');
      if (!push.denied) throw new Error('implement was allowed to push!');
      return 'Created greeting.txt; my push attempt was denied by the harness.';
    }
    case 'validate':
      // Criteria arrive from the Spec node, and are answered one by one.
      if (!req.prompt.includes('AC1')) {
        throw new Error('validate did not receive the acceptance criteria checklist');
      }
      return JSON.stringify({
        verdict: 'pass',
        notes: 'greeting.txt exists with expected content',
        criteria: [{ id: 'AC1', met: true, evidence: 'greeting.txt line 1 reads "hello (blue)"' }],
      });
    case 'review':
      return JSON.stringify({
        verdict: 'pass',
        findings: [{ location: 'greeting.txt:1', description: 'fine', severity: 'info' }],
      });
    case 'git-ops': {
      // Git-ops sits after the Approval-Gate: it must still see what was
      // reviewed, not just the gate's decision.
      if (!req.prompt.includes('"verdict"')) {
        throw new Error('git-ops did not receive the review context through the gate');
      }
      tools.bash('git add -A');
      tools.bash('git commit -m "add greeting"');
      const denied = tools.write('sneaky.txt', 'git-ops must not edit');
      if (!denied.denied) throw new Error('git-ops was allowed to edit a file!');
      return 'Committed.';
    }
    default:
      throw new Error(`unexpected agent session for node ${req.nodeId}`);
  }
}

async function runDefaultWorkflow(decision: 'approve' | 'reject') {
  const repo = makeTempGitRepo();
  const workflow = workflowFromYaml(DEFAULT_WORKFLOW_YAML);
  const store = storeFor(workflow, repo);
  store.attachPersister(new FileRunStatePersister(repo));
  const baseline = await recordBaseline(repo, false);
  store.setBaseline(baseline);
  const ports = fakePorts({ approve: decision, userMessages: ['blue please'] });
  const engine = new Engine({
    workflow,
    store,
    repoRoot: repo,
    baseline,
    ports,
    sessions: harnessedSessions(defaultWorkflowScript),
    executors: builtinExecutors,
  });
  await engine.run();
  return { repo, store, ports };
}

describe('end-to-end: default workflow on a sample repo', () => {
  it('runs discuss → implement → test → validate → review → gate → git-ops to completion', async () => {
    const { repo, store, ports } = await runDefaultWorkflow('approve');

    for (const id of ['discuss', 'spec', 'implement', 'test', 'validate', 'review', 'gate', 'git-ops']) {
      expect(store.node(id).status, id).toBe('done');
    }

    // Discussion produced a consumable conclusion.
    expect(store.node('discuss').output).toMatchObject({
      conclusion: expect.stringContaining('greeting'),
      constraints: ['keep it to one file'],
    });

    // Implement produced a diff of what it changed.
    expect(store.node('implement').output).toMatchObject({
      changedFiles: ['greeting.txt'],
    });

    // The capability denial is an event in the activity log, and the node
    // carries the blocked-action count — the run itself was not aborted.
    const denials = store.activityFor('implement').filter((e) => e.decision === 'denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]!.summary).toBe('git push origin main');
    expect(denials[0]!.missingCapability).toBe('git-write');
    expect(store.node('implement').denials).toBe(1);

    // The gate saw the diff and the push question never arose (commit-only).
    expect(ports.approvalRequests[0]!.diffs[0]!.diff).toContain('greeting.txt');
    expect(ports.approvalRequests[0]!.pushTarget).toBeUndefined();

    // Git-ops actually committed, and did not push.
    const gitOut = store.node('git-ops').output as GitOpsOutput;
    expect(gitOut.committed).toBe(true);
    expect(gitOut.pushed).toBe(false);
    expect(execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString()).toContain(
      'add greeting',
    );

    // Everything above survives in the persisted run-state file.
    const onDisk = readRunState(runFilePath(repo, store.runId));
    expect(onDisk.activity.some((e) => e.decision === 'denied')).toBe(true);
    expect(onDisk.baseline).not.toBeNull();
    expect(onDisk.nodes['git-ops']!.status).toBe('done');
  });

  it('a rejected gate halts git-ops while everything upstream stands', async () => {
    const { repo, store } = await runDefaultWorkflow('reject');
    expect(store.node('review').status).toBe('done');
    expect(store.node('gate').status).toBe('error');
    expect(store.node('git-ops').status).toBe('skipped');
    // Nothing was committed.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString();
    expect(log).not.toContain('add greeting');
    expect(log.trim().split('\n')).toHaveLength(1);
  });
});

/** The default graph, whose Validate → Implement loop-back ships enabled. */
const LOOPING_WORKFLOW_YAML = DEFAULT_WORKFLOW_YAML;

/**
 * Same roles as the default script, but Validate fails until Implement has run
 * `passOnImplementRun` times — the real "fix it and check again" loop.
 */
function loopingScript(passOnImplementRun: number): {
  script: (req: AgentSessionRequest, tools: HarnessTools) => string;
  implementRuns: () => number;
  specRuns: () => number;
  retryPrompts: () => string[];
} {
  let implementRuns = 0;
  let specRuns = 0;
  const retryPrompts: string[] = [];
  const script = (req: AgentSessionRequest, tools: HarnessTools): string => {
    switch (req.nodeId) {
      case 'discuss':
        return req.prompt.includes('JSON object recording')
          ? JSON.stringify({ conclusion: 'Add a greeting file.', constraints: [] })
          : 'Understood.';
      case 'spec':
        specRuns++;
        return JSON.stringify({
          title: 'Greeting file',
          requirements: [],
          acceptanceCriteria: ['greeting.txt exists with the right content'],
        });
      case 'implement':
        implementRuns++;
        if (req.prompt.includes('running again because')) retryPrompts.push(req.prompt);
        tools.write('greeting.txt', `hello (attempt ${implementRuns})\n`);
        return `Wrote greeting.txt on attempt ${implementRuns}.`;
      case 'validate': {
        const met = implementRuns >= passOnImplementRun;
        return JSON.stringify({
          verdict: met ? 'pass' : 'fail',
          notes: met ? 'greeting.txt is correct' : 'greeting.txt has the wrong content',
          criteria: [
            { id: 'AC1', met, evidence: met ? 'content matches' : 'content does not match' },
          ],
        });
      }
      case 'review':
        return JSON.stringify({ verdict: 'pass', findings: [] });
      case 'git-ops':
        tools.bash('git add -A');
        tools.bash('git commit -m "add greeting"');
        return 'Committed.';
      default:
        throw new Error(`unexpected agent session for node ${req.nodeId}`);
    }
  };
  return {
    script,
    implementRuns: () => implementRuns,
    specRuns: () => specRuns,
    retryPrompts: () => retryPrompts,
  };
}

async function runLoopingWorkflow(passOnImplementRun: number) {
  const repo = makeTempGitRepo();
  const workflow = workflowFromYaml(LOOPING_WORKFLOW_YAML);
  const store = storeFor(workflow, repo);
  store.attachPersister(new FileRunStatePersister(repo));
  const baseline = await recordBaseline(repo, false);
  store.setBaseline(baseline);
  const scripted = loopingScript(passOnImplementRun);
  const engine = new Engine({
    workflow,
    store,
    repoRoot: repo,
    baseline,
    ports: fakePorts({ approve: 'approve', userMessages: [] }),
    sessions: harnessedSessions(scripted.script),
    executors: builtinExecutors,
  });
  await engine.run();
  return { repo, store, scripted };
}

describe('end-to-end: iterating on a failed verdict', () => {
  it('loops back, fixes, and reaches git-ops', async () => {
    const { store, scripted } = await runLoopingWorkflow(2);

    // Implement ran twice: once badly, once after learning why it failed.
    expect(scripted.implementRuns()).toBe(2);
    expect(store.attemptOf('implement')).toBe(2);
    expect(store.attemptOf('validate')).toBe(2);
    // The retry was told what went wrong.
    expect(scripted.retryPrompts()).toHaveLength(1);
    expect(scripted.retryPrompts()[0]).toContain('wrong content');
    // The contract was written once and never rewritten: the second attempt
    // is judged against the same acceptance criteria as the first.
    expect(scripted.specRuns()).toBe(1);
    expect(store.attemptOf('spec')).toBe(1);

    for (const id of ['implement', 'validate', 'review', 'gate', 'git-ops']) {
      expect(store.node(id).status, id).toBe('done');
    }
    expect(store.node('validate').priorAttempts![0]!.status).toBe('error');
  });

  it('stops at the attempt bound and never reaches git-ops when it cannot converge', async () => {
    const { repo, store, scripted } = await runLoopingWorkflow(Number.MAX_SAFE_INTEGER);

    expect(scripted.implementRuns()).toBe(3);
    expect(store.node('validate').status).toBe('error');
    expect(store.node('validate').statusDetail).toContain('attempt limit');
    for (const id of ['review', 'gate', 'git-ops']) {
      expect(store.node(id).status, id).toBe('skipped');
    }
    // Nothing was committed: the loop gave up before the git-mutating step.
    expect(execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString().trim().split('\n')).toHaveLength(1);
    expect(store.snapshot().finishedAt).toBeDefined();
  });
});
