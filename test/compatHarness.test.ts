import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { createCompatInterceptor } from '../src/harness/compatIntercept.js';
import { compatBoundaryPrompt, toolsForCapabilities } from '../src/harness/compatTools.js';
import {
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from '../src/executors/compatToolExec.js';
import { RunStateStore } from '../src/runstate/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-compat-test-'));
}

describe('toolsForCapabilities', () => {
  it('offers read tools only when read is granted', () => {
    const names = toolsForCapabilities(capabilitySet('read')).map((t) => t.function.name);
    expect(names).toEqual(['read_file', 'list_dir', 'glob', 'grep']);
  });

  it('offers edit tools only when edit is granted', () => {
    const names = toolsForCapabilities(capabilitySet('read', 'edit')).map((t) => t.function.name);
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
  });

  it('offers run_shell when exec, git-read, or git-write is granted', () => {
    expect(toolsForCapabilities(capabilitySet('exec')).map((t) => t.function.name)).toContain('run_shell');
    expect(toolsForCapabilities(capabilitySet('git-read')).map((t) => t.function.name)).toContain('run_shell');
    expect(toolsForCapabilities(capabilitySet('git-write')).map((t) => t.function.name)).toContain('run_shell');
    expect(toolsForCapabilities(capabilitySet('read')).map((t) => t.function.name)).not.toContain('run_shell');
  });

  it('offers nothing for an empty capability set (Approval-Gate style)', () => {
    expect(toolsForCapabilities(capabilitySet())).toEqual([]);
  });
});

describe('compatBoundaryPrompt', () => {
  it('states the working directory and no-edit boundary', () => {
    const prompt = compatBoundaryPrompt(capabilitySet('read'), '/repo');
    expect(prompt).toContain('/repo');
    expect(prompt).toContain('cannot create, edit, or delete files');
    expect(prompt).toContain('cannot run shell commands');
  });

  it('states the git-write boundary for exec-capable nodes', () => {
    const prompt = compatBoundaryPrompt(capabilitySet('read', 'edit', 'exec'), '/repo');
    expect(prompt).toContain('git commands that mutate history, refs, or remotes are denied');
  });
});

function interceptorFor(caps: ReturnType<typeof capabilitySet>, workingDir = '/repo') {
  const store = new RunStateStore({ repoRoot: workingDir, nodeIds: ['n1'] });
  const interceptor = createCompatInterceptor({ nodeId: 'n1', capabilities: caps, workingDir, store });
  return { interceptor, store };
}

describe('OpenAI-compat capability enforcement (parity with the Claude-path harness)', () => {
  it('denies write_file/edit_file without edit, allows with it', () => {
    const { interceptor } = interceptorFor(capabilitySet('read'));
    expect(interceptor.check('write_file', { path: 'a.ts' }, 't1').behavior).toBe('deny');
    const { interceptor: withEdit } = interceptorFor(capabilitySet('read', 'edit'));
    expect(withEdit.check('write_file', { path: 'a.ts' }, 't1').behavior).toBe('allow');
  });

  it('anchors the control directory exactly as the Claude-path harness does', () => {
    const { interceptor } = interceptorFor(capabilitySet('read', 'edit', 'exec'));
    expect(interceptor.check('write_file', { path: '.flow-code/workflow.yaml' }, 't1').behavior).toBe(
      'deny',
    );
    expect(
      interceptor.check('run_shell', { command: 'sed -i s/a/b/ .flow-code/workflow.yaml' }, 't2')
        .behavior,
    ).toBe('deny');
    // Reading stays available; ordinary work is untouched.
    expect(interceptor.check('read_file', { path: '.flow-code/specs/r.md' }, 't3').behavior).toBe(
      'allow',
    );
    expect(interceptor.check('write_file', { path: 'src/a.ts' }, 't4').behavior).toBe('allow');
  });

  it('denies run_shell without exec/git-read/git-write, allows with exec', () => {
    const { interceptor } = interceptorFor(capabilitySet('read'));
    expect(interceptor.check('run_shell', { command: 'echo hi' }, 't1').behavior).toBe('deny');
    const { interceptor: withExec } = interceptorFor(capabilitySet('read', 'exec'));
    expect(withExec.check('run_shell', { command: 'echo hi' }, 't1').behavior).toBe('allow');
  });

  it('denies a git-write shell command without git-write, matching classifyCommand', () => {
    const { interceptor } = interceptorFor(capabilitySet('read', 'exec'));
    const decision = interceptor.check('run_shell', { command: 'git push origin main' }, 't1');
    expect(decision.behavior).toBe('deny');
  });

  it('allows git commit/push for git-ops-style capabilities', () => {
    const { interceptor } = interceptorFor(capabilitySet('read', 'git-read', 'git-write'));
    expect(interceptor.check('run_shell', { command: 'git commit -m x' }, 't1').behavior).toBe('allow');
    expect(interceptor.check('run_shell', { command: 'git push origin main' }, 't1').behavior).toBe('allow');
    expect(interceptor.check('run_shell', { command: 'npm install' }, 't1').behavior).toBe('deny');
  });

  it('denies file operations resolving outside the working directory', () => {
    const { interceptor, store } = interceptorFor(capabilitySet('read', 'edit'), '/repo');
    expect(interceptor.check('read_file', { path: '/etc/passwd' }, 't1').behavior).toBe('deny');
    expect(interceptor.check('write_file', { path: '../outside.txt' }, 't2').behavior).toBe('deny');
    expect(interceptor.check('read_file', { path: 'src/inside.ts' }, 't3').behavior).toBe('allow');
    const denials = store.activityFor('n1').filter((e) => e.decision === 'denied');
    expect(denials.every((e) => e.missingCapability === 'working-directory')).toBe(true);
  });

  it('denies a tool name outside the offered vocabulary', () => {
    const { interceptor } = interceptorFor(capabilitySet('read'));
    expect(interceptor.check('delete_repo', {}, 't1').behavior).toBe('deny');
  });

  it('logs every call to the activity log, same shape as the Claude path', () => {
    const { interceptor, store } = interceptorFor(capabilitySet('read'));
    interceptor.check('read_file', { path: 'a.ts' }, 'call-1');
    interceptor.check('write_file', { path: 'b.ts' }, 'call-2');
    const entries = store.activityFor('n1');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tool: 'read_file', decision: 'allowed', toolUseId: 'call-1' });
    expect(entries[1]).toMatchObject({ tool: 'write_file', decision: 'denied', missingCapability: 'edit' });
    expect(store.node('n1').denials).toBe(1);
  });

  it('completes an allowed entry with duration and exit status', () => {
    const { interceptor, store } = interceptorFor(capabilitySet('read', 'exec'));
    interceptor.check('run_shell', { command: 'echo hi' }, 'call-1');
    interceptor.complete('call-1', { durationMs: 12, exitStatus: 0 });
    const entry = store.activityFor('n1')[0]!;
    expect(entry.durationMs).toBe(12);
    expect(entry.exitStatus).toBe(0);
  });
});

describe('OpenAI-compat tool executors', () => {
  it('read_file / write_file / edit_file round-trip', () => {
    const dir = tempDir();
    writeFileTool(dir, { path: 'a.txt', content: 'hello' });
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileTool(dir, { path: 'a.txt' })).toBe('hello');
    editFileTool(dir, { path: 'a.txt', old_string: 'hello', new_string: 'world' });
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('world');
  });

  it('edit_file fails clearly when old_string is missing or not unique', () => {
    const dir = tempDir();
    writeFileTool(dir, { path: 'a.txt', content: 'aa' });
    expect(() => editFileTool(dir, { path: 'a.txt', old_string: 'zz', new_string: 'y' })).toThrow(
      /not found/,
    );
    expect(() => editFileTool(dir, { path: 'a.txt', old_string: 'a', new_string: 'y' })).toThrow(
      /not unique/,
    );
  });

  it('write_file creates parent directories', () => {
    const dir = tempDir();
    writeFileTool(dir, { path: 'nested/dir/file.txt', content: 'x' });
    expect(readFileSync(join(dir, 'nested', 'dir', 'file.txt'), 'utf8')).toBe('x');
  });

  it('list_dir and glob find files relative to the working directory', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), '');
    writeFileSync(join(dir, 'README.md'), '');
    expect(listDirTool(dir, {})).toContain('d src');
    expect(listDirTool(dir, {})).toContain('f README.md');
    expect(globTool(dir, { pattern: '**/*.ts' })).toBe('src/a.ts');
  });

  it('grep finds matching lines with file:line prefixes', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'foo\nbar\nfoobar\n');
    const result = grepTool(dir, { pattern: 'foo' });
    expect(result).toContain('a.txt:1: foo');
    expect(result).toContain('a.txt:3: foobar');
    expect(result).not.toContain('a.txt:2:');
  });

  it('run_shell captures stdout and a non-zero exit status without throwing', async () => {
    const dir = tempDir();
    const ok = await runShellTool(dir, { command: 'echo hi' });
    expect(ok.output).toContain('hi');
    expect(ok.exitStatus).toBe(0);
    const failing = await runShellTool(dir, { command: 'exit 3' });
    expect(failing.exitStatus).toBe(3);
  });

  it('run_shell applies extra env (the pushurl defense-in-depth block)', async () => {
    const dir = tempDir();
    const result = await runShellTool(dir, { command: 'git remote get-url origin || true' }, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
      GIT_CONFIG_VALUE_0: 'https://push-disabled-by-flow-code.invalid',
    });
    expect(result.exitStatus).toBe(0);
  });
});
