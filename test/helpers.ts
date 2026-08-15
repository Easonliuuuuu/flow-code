import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSessionRequest,
  ApprovalRequest,
  ConvergenceRequest,
  InteractionPorts,
  InteractiveAgentSession,
  SessionRunner,
  TestCommandsRequest,
} from '../src/engine/types.js';
import type { DiscussTranscriptEntry, RunOwner, RunState } from '../src/runstate/types.js';
import { RunStateStore } from '../src/runstate/store.js';
import { loadWorkflowFromString, type Workflow } from '../src/workflow/load.js';
import { recordGraph } from '../src/workflow/record.js';

/**
 * A pid no process can hold — well above every platform's maximum, so a run
 * stamped with it reads as driven by something that is gone.
 */
export const DEAD_PID = 0x7ffffffe;

export function liveOwner(): RunOwner {
  return { pid: process.pid, host: hostname(), token: 'test-owner', claimedAt: '2026-08-11T12:00:00.000Z' };
}

export function deadOwner(): RunOwner {
  return { ...liveOwner(), pid: DEAD_PID };
}

/** An owner on some other machine: its pid is unanswerable from here. */
export function foreignOwner(): RunOwner {
  return { ...liveOwner(), host: `${hostname()}-elsewhere` };
}

/**
 * Make an existing run read as abandoned by moving its owner's pid, rather
 * than by replacing the owner. Replacing it would change the ownership token
 * too, which is what the persister refuses — the fixture wants a dead driver,
 * not a second writer.
 */
export function markDriverDead<T extends RunState>(state: T): T {
  if (state.owner) (state.owner as { pid: number }).pid = DEAD_PID;
  return state;
}

export function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-code-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

export function repoGit(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trimEnd();
}

export function workflowFromYaml(yaml: string): Workflow {
  return loadWorkflowFromString(yaml);
}

export function storeFor(workflow: Workflow, repoRoot: string): RunStateStore {
  return new RunStateStore({ repoRoot, graph: recordGraph(workflow) });
}

export interface FakePortOptions {
  approve?: 'approve' | 'reject' | ((req: ApprovalRequest) => 'approve' | 'reject');
  select?: string[] | ((req: ConvergenceRequest) => string[]);
  userMessages?: string[];
  /** What to answer a Test node asking what to run; null skips. */
  testCommands?: string[] | null | ((req: TestCommandsRequest) => Promise<string[] | null> | string[] | null);
}

export function fakePorts(opts: FakePortOptions = {}): InteractionPorts & {
  approvalRequests: ApprovalRequest[];
  convergenceRequests: ConvergenceRequest[];
  testCommandRequests: TestCommandsRequest[];
  assistantTexts: string[];
  beginCalls: Array<{ nodeId: string; topic: string | undefined; seedTranscript: DiscussTranscriptEntry[] }>;
} {
  const approvalRequests: ApprovalRequest[] = [];
  const convergenceRequests: ConvergenceRequest[] = [];
  const testCommandRequests: TestCommandsRequest[] = [];
  const assistantTexts: string[] = [];
  const beginCalls: Array<{
    nodeId: string;
    topic: string | undefined;
    seedTranscript: DiscussTranscriptEntry[];
  }> = [];
  const remainingMessages = [...(opts.userMessages ?? [])];
  return {
    approvalRequests,
    convergenceRequests,
    testCommandRequests,
    assistantTexts,
    beginCalls,
    approval: {
      async request(req) {
        approvalRequests.push(req);
        const a = opts.approve ?? 'approve';
        return typeof a === 'function' ? a(req) : a;
      },
    },
    testCommands: {
      async request(req) {
        testCommandRequests.push(req);
        const t = opts.testCommands ?? null;
        return typeof t === 'function' ? t(req) : t;
      },
    },
    convergence: {
      async select(req) {
        convergenceRequests.push(req);
        const s = opts.select ?? [req.branches[0]!.instanceId];
        return typeof s === 'function' ? s(req) : s;
      },
    },
    discuss: {
      begin(nodeId, topic, seedTranscript = []) {
        beginCalls.push({ nodeId, topic, seedTranscript });
      },
      postAssistant(_nodeId, text) {
        assistantTexts.push(text);
      },
      async nextUserMessage() {
        return remainingMessages.shift() ?? null;
      },
      end() {},
    },
  };
}

/** SessionRunner whose behavior is a function of the request; no SDK, no API. */
export function fakeSessions(
  handler: (req: AgentSessionRequest) => Promise<string> | string,
): SessionRunner & { requests: AgentSessionRequest[] } {
  const requests: AgentSessionRequest[] = [];
  return {
    requests,
    async run(req) {
      requests.push(req);
      return { finalText: await handler(req) };
    },
    async openInteractive(req): Promise<InteractiveAgentSession> {
      requests.push(req);
      // The real runner reports the session id it opened, which is what lets a
      // node resume rather than start over. Without this the harness can never
      // reach the resume path a live run takes.
      req.onSessionId?.(`fake-sess-${req.nodeId}-${requests.length}`);
      return {
        send: async (text) => handler({ ...req, prompt: text }),
        end: async () => {},
      };
    },
  };
}

export function throwingSessions(): SessionRunner {
  return {
    run() {
      throw new Error('no agent session expected in this test');
    },
    openInteractive() {
      throw new Error('no interactive session expected in this test');
    },
  };
}
