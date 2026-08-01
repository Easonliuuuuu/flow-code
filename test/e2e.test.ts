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
    case 'implement': {
      // The conclusion from Discuss must be visible to Implement.
      if (!req.prompt.includes('greeting file')) {
        throw new Error('implement did not receive the discussion conclusion');
      }
      tools.write('greeting.txt', 'hello (blue)\n');
      // A well-intentioned overstep: the harness must block this and log it.
      const push = tools.bash('git push origin main');
      if (!push.denied) throw new Error('implement was allowed to push!');
      return 'Created greeting.txt; my push attempt was denied by the harness.';
    }
    case 'validate':
      return JSON.stringify({ verdict: 'pass', notes: 'greeting.txt exists with expected content' });
    case 'review':
      return JSON.stringify({
        verdict: 'pass',
        findings: [{ location: 'greeting.txt:1', description: 'fine', severity: 'info' }],
      });
    case 'git-ops': {
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

    for (const id of ['discuss', 'implement', 'test', 'validate', 'review', 'gate', 'git-ops']) {
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
