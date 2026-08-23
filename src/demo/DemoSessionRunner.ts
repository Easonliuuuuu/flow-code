import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionRequest, InteractiveAgentSession, SessionRunner } from '../engine/types.js';
import { DEMO_BUGGY_SOURCE, DEMO_FIXED_SOURCE, DEMO_SOURCE_FILENAME, DEMO_STEP_DELAY_MS } from './fixtures.js';
import {
  discussConclusionJson,
  discussReplyText,
  implementSummaryText,
  looksLikeJsonRequest,
  reviewResponseJson,
  specResponseJson,
  validateResponseJson,
} from './script.js';

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('interrupted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('interrupted'));
      },
      { once: true },
    );
  });
}

/**
 * Commits whatever `implement` wrote, the same way a real git-ops session
 * would — a real `git commit`, not a description of one. `executeGitOps`
 * (`src/executors/agents.ts:126`) derives its entire output from the git
 * tree before and after this call, so nothing about what the demo's gate or
 * summary shows is scripted; it is computed from what actually happened on
 * disk.
 */
function commitPendingChanges(workingDir: string): string {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: workingDir }).toString();
  if (status.trim().length === 0) return 'Nothing to commit.';
  execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'feat(math): implement add(a, b)'], {
    cwd: workingDir,
    stdio: 'ignore',
  });
  return 'Committed the pending change.';
}

/**
 * Stands in for the Claude Agent SDK / Codex SDK / any live provider for
 * `flow-code try`: same `SessionRunner` boundary every real runner
 * implements (`src/cli/run.ts:344`), so the engine, executors, and gates
 * never know the difference. Keyed on `nodeId`; `implement` additionally
 * tracks its own attempt count, since what it writes on attempt two — the
 * fix — must only be reachable through the real loop-back firing, not
 * through this runner's own bookkeeping deciding to skip ahead.
 */
export class DemoSessionRunner implements SessionRunner {
  private readonly implementAttempts = new Map<string, number>();

  constructor(private readonly pacingMs: number = DEMO_STEP_DELAY_MS) {}

  async run(req: AgentSessionRequest): Promise<{ finalText: string }> {
    await delay(this.pacingMs, req.signal);
    switch (req.nodeId) {
      case 'spec':
        return { finalText: specResponseJson() };
      case 'implement': {
        const attempt = (this.implementAttempts.get(req.nodeId) ?? 0) + 1;
        this.implementAttempts.set(req.nodeId, attempt);
        writeFileSync(
          join(req.workingDir, DEMO_SOURCE_FILENAME),
          attempt === 1 ? DEMO_BUGGY_SOURCE : DEMO_FIXED_SOURCE,
        );
        return { finalText: implementSummaryText(attempt) };
      }
      case 'validate':
        return { finalText: validateResponseJson() };
      case 'review':
        return { finalText: reviewResponseJson() };
      case 'git-ops':
        return { finalText: commitPendingChanges(req.workingDir) };
      default:
        // Loud rather than a generic fallback: an uncovered node means the
        // demo graph has changed and this script has not been updated to
        // match, which is exactly what should fail a test rather than
        // silently produce a plausible-looking but meaningless reply.
        throw new Error(
          `DemoSessionRunner: no script for node "${req.nodeId}" — update src/demo/script.ts to cover it`,
        );
    }
  }

  async openInteractive(req: AgentSessionRequest): Promise<InteractiveAgentSession> {
    req.onSessionId?.(`demo-session-${req.nodeId}`);
    return {
      send: async (text: string): Promise<string> => {
        await delay(this.pacingMs, req.signal);
        return looksLikeJsonRequest(text) ? discussConclusionJson() : discussReplyText();
      },
      end: async (): Promise<void> => {},
    };
  }
}
