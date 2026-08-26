import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cmdConnect,
  mergeCodexConfig,
  mergeCodexHooks,
} from '../src/cli/connect.js';
import { runPreToolUseHook } from '../src/cli/hook.js';
import { openGuestRun, reportTransition } from '../src/guest/report.js';
import { MCP_INSTRUCTIONS } from '../src/guest/mcp.js';
import { generateInstructions } from '../src/guest/instructions.js';
import { applyPatchPaths } from '../src/guest/hostTools.js';
import { liveHeartbeat, recordHeartbeat } from '../src/guest/enforce.js';
import { latestRunState } from '../src/runstate/watch.js';
import { renderLine, summarize } from '../src/cli/status.js';
import { makeTempGitRepo, workflowFromYaml } from './helpers.js';

const ENTRY = { command: 'flow-code', args: ['mcp'] };
const YAML = `
nodes:
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: review
    type: review
    config: { instructions: review it }
edges:
  - { from: implement, to: review }
`;

function repo(): string {
  const dir = makeTempGitRepo();
  mkdirSync(join(dir, '.flow-code'), { recursive: true });
  writeFileSync(join(dir, '.flow-code', 'workflow.yaml'), YAML);
  return dir;
}

function hookOutput(dir: string, payload: Record<string, unknown>): Record<string, unknown> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    runPreToolUseHook(JSON.stringify({ cwd: dir, ...payload }), 'codex');
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return (JSON.parse(chunks.join('')) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
}

describe('Codex project setup', () => {
  it('merges an owned TOML block without touching another server', () => {
    const merged = mergeCodexConfig('[mcp_servers.other]\ncommand = "other"\n', ENTRY)!;
    expect(merged).toContain('[mcp_servers.other]');
    expect(merged).toContain('[mcp_servers.flow-code]');
    expect(merged).toContain('default_tools_approval_mode = "approve"');
    expect(merged).toContain('approval_mode = "prompt"');
    expect(mergeCodexConfig(merged, ENTRY)).toBeUndefined();
  });

  it('refuses an unmanaged flow-code TOML section', () => {
    expect(() => mergeCodexConfig('[mcp_servers.flow-code]\ncommand = "mine"\n', ENTRY)).toThrow(
      /outside its managed section/,
    );
  });

  it('merges Codex hooks beside existing hooks and is idempotent', () => {
    const command = 'flow-code hook pretooluse --host codex';
    const existing = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } });
    const merged = mergeCodexHooks(existing, command)!;
    const parsed = JSON.parse(merged) as { hooks: { PreToolUse: unknown[] } };
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(mergeCodexHooks(merged, command)).toBeUndefined();
  });

  it('installs Codex files without installing Claude-only surfaces', async () => {
    const dir = repo();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.cwd();
    process.chdir(dir);
    try {
      await cmdConnect(['--host', 'codex']);
    } finally {
      process.chdir(previous);
      log.mockRestore();
    }
    expect(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.flow-code]');
    expect(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8')).toContain('--host codex');
    expect(readFileSync(join(dir, '.agents', 'skills', 'flow-code-workflow', 'SKILL.md'), 'utf8')).toContain(
      'hosted tools',
    );
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('Walking this project\'s flow-code graph');
    expect(() => readFileSync(join(dir, '.mcp.json'), 'utf8')).toThrow();
    expect(() => readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toThrow();
  });
});

describe('Codex tool adaptation', () => {
  it('checks every file declared by an apply_patch payload', () => {
    expect(
      applyPatchPaths({
        patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch',
      }),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('enforces an apply_patch call through the shared policy', async () => {
    const dir = repo();
    recordHeartbeat(dir, 'codex-session', 'codex');
    const { runId } = await openGuestRun(dir, { surface: 'mcp' });
    reportTransition(dir, runId, { nodeId: 'implement', kind: 'start' });
    expect(
      hookOutput(dir, {
        session_id: 'codex-session',
        tool_name: 'apply_patch',
        tool_input: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch' },
      }).permissionDecision,
    ).toBeUndefined();

    reportTransition(dir, runId, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    reportTransition(dir, runId, { nodeId: 'review', kind: 'start' });
    const denied = hookOutput(dir, {
      tool_name: 'apply_patch',
      tool_input: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch' },
    });
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('`edit` capability');
  });
});

describe('Codex companion disclosures', () => {
  it('records the host and hosted-tool limitation on a run', async () => {
    const dir = repo();
    recordHeartbeat(dir, 'codex-session', 'codex');
    await openGuestRun(dir, { surface: 'mcp' });
    expect(liveHeartbeat(dir)?.host).toBe('codex');
    const state = latestRunState(dir)!;
    expect(state.enforcement).toMatchObject({
      tier: 'hooks',
      host: 'codex',
      limitations: ['hosted-tools-unobserved'],
    });
    const summary = summarize(state);
    expect(summary.limitations).toEqual(['hosted-tools-unobserved']);
    expect(renderLine(summary, { width: 200 })).toContain('hosted tools unobserved');
  });

  it('names the limitation in generated instructions and MCP initialization guidance', () => {
    const text = generateInstructions(workflowFromYaml(YAML), { enforced: true, host: 'codex' });
    expect(text).toContain('Codex hosted tools');
    expect(text).toContain('not observed by flow-code');
    expect(MCP_INSTRUCTIONS).toContain('describe_workflow');
    expect(MCP_INSTRUCTIONS).toContain('explicit user approval');
  });
});
