import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { compileToolPolicy } from '../src/harness/compile.js';
import { classifyCommand } from '../src/harness/gitCommands.js';
import { createInterceptor } from '../src/harness/intercept.js';
import { nodeTypeRegistry, type NodeTypeId } from '../src/registry/index.js';
import { RunStateStore } from '../src/runstate/store.js';

function kindsOf(command: string): string[] {
  return classifyCommand(command).map((s) => s.kind);
}

describe('git command classification', () => {
  it('classifies mutating git commands as git-write', () => {
    for (const cmd of [
      'git push',
      'git push origin main',
      'git commit -m "x"',
      'git merge feature',
      'git reset --hard HEAD~1',
      'git rebase main',
      'git checkout -b x',
      'git branch -D x',
      'git tag v1',
      'git stash',
      'git fetch origin',
      'git remote set-url origin http://x',
      'git config user.name evil',
      'git worktree add ../x',
    ]) {
      expect(kindsOf(cmd), cmd).toContain('git-write');
    }
  });

  it('classifies read-only git commands as git-read', () => {
    for (const cmd of [
      'git status',
      'git log --oneline',
      'git diff HEAD',
      'git show abc123',
      'git rev-parse HEAD',
      'git branch',
      'git branch --list',
      'git tag -l',
      'git remote -v',
      'git stash list',
      'git worktree list',
      'git config --get user.name',
      'git blame file.ts',
    ]) {
      expect(kindsOf(cmd), cmd).toEqual(['git-read']);
    }
  });

  it('classifies non-git commands as non-git', () => {
    expect(kindsOf('npm test')).toEqual(['non-git']);
    expect(kindsOf('echo hello')).toEqual(['non-git']);
  });

  it('finds git-write inside compound commands', () => {
    expect(kindsOf('echo done && git push origin main')).toEqual(['non-git', 'git-write']);
    expect(kindsOf('npm test; git commit -m x')).toEqual(['non-git', 'git-write']);
    expect(kindsOf('git log | head')).toEqual(['git-read', 'non-git']);
  });

  it('finds git-write inside command substitution and sh -c', () => {
    expect(kindsOf('echo $(git push origin main)')).toContain('git-write');
    expect(kindsOf('echo `git commit -m x`')).toContain('git-write');
    expect(kindsOf("sh -c 'git push origin main'")).toContain('git-write');
  });

  it('sees through env assignments, wrappers, and git global flags', () => {
    expect(kindsOf('FOO=bar git push')).toContain('git-write');
    expect(kindsOf('env git push')).toContain('git-write');
    expect(kindsOf('git -C /elsewhere push')).toContain('git-write');
    expect(kindsOf('git -c core.pager=cat log')).toEqual(['git-read']);
  });
});

function harnessFor(typeId: NodeTypeId, workingDir = '/repo') {
  const type = nodeTypeRegistry.get(typeId)!;
  const store = new RunStateStore({ repoRoot: workingDir, nodeIds: ['n1'] });
  const interceptor = createInterceptor({
    nodeId: 'n1',
    capabilities: capabilitySet(...type.capabilities),
    workingDir,
    store,
  });
  return { interceptor, store };
}

describe('capability enforcement per node type', () => {
  it('Implement cannot push (git-write denied), but can edit and run commands', () => {
    const { interceptor, store } = harnessFor('implement');
    expect(
      interceptor.check('Bash', { command: 'git push origin main' }).behavior,
    ).toBe('deny');
    expect(interceptor.check('Edit', { file_path: '/repo/src/a.ts' }).behavior).toBe('allow');
    expect(interceptor.check('Bash', { command: 'npm test' }).behavior).toBe('allow');
    expect(interceptor.check('Bash', { command: 'git status' }).behavior).toBe('allow');
    const denied = store.activityFor('n1').filter((e) => e.decision === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.missingCapability).toBe('git-write');
  });

  it('Review cannot edit and cannot exec', () => {
    const { interceptor } = harnessFor('review');
    expect(interceptor.check('Edit', { file_path: '/repo/a.ts' }).behavior).toBe('deny');
    expect(interceptor.check('Write', { file_path: '/repo/a.ts' }).behavior).toBe('deny');
    expect(interceptor.check('Bash', { command: 'echo hi' }).behavior).toBe('deny');
    expect(interceptor.check('Read', { file_path: '/repo/a.ts' }).behavior).toBe('allow');
  });

  it('Validate cannot edit but can run commands', () => {
    const { interceptor } = harnessFor('validate');
    expect(interceptor.check('Write', { file_path: '/repo/a.ts' }).behavior).toBe('deny');
    expect(interceptor.check('Bash', { command: 'npm test' }).behavior).toBe('allow');
    expect(interceptor.check('Bash', { command: 'git commit -m x' }).behavior).toBe('deny');
  });

  it('Git-ops cannot edit and cannot run non-git commands, but can commit and push', () => {
    const { interceptor } = harnessFor('git-ops');
    expect(interceptor.check('Edit', { file_path: '/repo/a.ts' }).behavior).toBe('deny');
    expect(interceptor.check('Bash', { command: 'npm install' }).behavior).toBe('deny');
    expect(interceptor.check('Bash', { command: 'git commit -m "ship"' }).behavior).toBe('allow');
    expect(interceptor.check('Bash', { command: 'git push origin main' }).behavior).toBe('allow');
    expect(interceptor.check('Bash', { command: 'git status' }).behavior).toBe('allow');
  });

  it('network tools are denied for every type', () => {
    for (const typeId of ['discuss', 'implement', 'validate', 'review', 'git-ops'] as const) {
      const { interceptor } = harnessFor(typeId);
      expect(interceptor.check('WebFetch', { url: 'https://x' }).behavior).toBe('deny');
      expect(interceptor.check('WebSearch', { query: 'x' }).behavior).toBe('deny');
    }
  });

  it('denies file operations resolving outside the working directory', () => {
    const { interceptor, store } = harnessFor('implement', '/repo');
    expect(interceptor.check('Read', { file_path: '/etc/passwd' }).behavior).toBe('deny');
    expect(interceptor.check('Write', { file_path: '../outside.txt' }).behavior).toBe('deny');
    expect(interceptor.check('Read', { file_path: 'src/inside.ts' }).behavior).toBe('allow');
    expect(interceptor.check('Read', { file_path: '/repo/deep/file.ts' }).behavior).toBe('allow');
    const denials = store.activityFor('n1').filter((e) => e.decision === 'denied');
    expect(denials.every((e) => e.missingCapability === 'working-directory')).toBe(true);
  });
});

describe('the control directory is an anchor no node can move', () => {
  it('refuses every write into .flow-code, however it is spelled', () => {
    const { interceptor, store } = harnessFor('implement', '/repo');
    for (const target of [
      '.flow-code/workflow.yaml',
      '/repo/.flow-code/workflow.yaml',
      '.flow-code/specs/run-1.md',
      'src/../.flow-code/credentials.json',
    ]) {
      expect(interceptor.check('Write', { file_path: target }).behavior, target).toBe('deny');
    }
    const denials = store.activityFor('n1').filter((e) => e.decision === 'denied');
    expect(denials).toHaveLength(4);
    expect(denials.every((e) => e.missingCapability === 'control-directory')).toBe(true);
  });

  it('refuses shell commands that name a control artifact, whatever they do to it', () => {
    const { interceptor } = harnessFor('implement', '/repo');
    for (const command of [
      "sed -i 's/maxAttempts: 3/maxAttempts: 99/' .flow-code/workflow.yaml",
      'echo "commands: [true]" > .flow-code/workflow.yaml',
      'cat .flow-code/credentials.json | tee /tmp/stolen',
      'rm .flow-code/specs/run-1.md',
    ]) {
      expect(interceptor.check('Bash', { command }).behavior, command).toBe('deny');
    }
  });

  it('still lets a node read the control directory, and work everywhere else', () => {
    const { interceptor } = harnessFor('implement', '/repo');
    // Reading is fine: the spec is meant to be read.
    expect(interceptor.check('Read', { file_path: '.flow-code/specs/run-1.md' }).behavior).toBe(
      'allow',
    );
    // A file that merely mentions the name is not the control directory.
    expect(interceptor.check('Write', { file_path: 'src/flow-code-notes.md' }).behavior).toBe(
      'allow',
    );
    expect(interceptor.check('Bash', { command: 'npm test' }).behavior).toBe('allow');
  });

  it('leaves a Worktree-Agent instance free inside its own worktree', () => {
    // A worktree lives *under* the repo's .flow-code, so an absolute-path rule
    // would condemn everything the instance does. The rule is relative to the
    // node's own working directory instead.
    const workingDir = '/repo/.flow-code/worktrees/run-a-impl-1';
    const { interceptor } = harnessFor('implement', workingDir);
    expect(interceptor.check('Write', { file_path: 'src/a.ts' }).behavior).toBe('allow');
    expect(interceptor.check('Bash', { command: 'npm test' }).behavior).toBe('allow');
    // Its own checkout's control directory is still off-limits.
    expect(interceptor.check('Write', { file_path: '.flow-code/workflow.yaml' }).behavior).toBe(
      'deny',
    );
  });
});

describe('denials are events, not silence', () => {
  it('records every denial in the activity log and bumps the node denial count', () => {
    const { interceptor, store } = harnessFor('review');
    interceptor.check('Bash', { command: 'git push' }, { toolUseID: 't1' });
    interceptor.check('Edit', { file_path: '/repo/a.ts' }, { toolUseID: 't2' });
    const entries = store.activityFor('n1');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.decision === 'denied')).toBe(true);
    expect(entries[0]!.summary).toBe('git push');
    expect(store.node('n1').denials).toBe(2);
    expect(store.node('n1').status).toBe('idle');
  });

  it('completes allowed entries with duration and exit status', () => {
    const { interceptor, store } = harnessFor('implement');
    interceptor.check('Bash', { command: 'echo hi' }, { toolUseID: 'call-1' });
    interceptor.complete('call-1', { durationMs: 42, exitStatus: 0 });
    const entry = store.activityFor('n1')[0]!;
    expect(entry.decision).toBe('allowed');
    expect(entry.durationMs).toBe(42);
    expect(entry.exitStatus).toBe(0);
  });

  it('promptCheck records denials but not repeat-allows', () => {
    const { interceptor, store } = harnessFor('implement');
    expect(interceptor.promptCheck('Bash', { command: 'echo hi' }).behavior).toBe('allow');
    expect(store.activityFor('n1')).toHaveLength(0);
    expect(
      interceptor.promptCheck('Bash', { command: 'ls' }, { blockedPath: '/etc' }).behavior,
    ).toBe('deny');
    expect(store.activityFor('n1')).toHaveLength(1);
  });
});

describe('tool policy compilation', () => {
  it('review sessions get no edit, exec, or network tools at all', () => {
    const policy = compileToolPolicy(capabilitySet('read'), '/repo');
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task']) {
      expect(policy.disallowedTools).toContain(tool);
    }
    expect(policy.disallowedTools).not.toContain('Read');
  });

  it('non-git-write sessions get the env-scoped pushurl block', () => {
    const policy = compileToolPolicy(capabilitySet('read', 'edit', 'exec'), '/repo');
    expect(policy.env['GIT_CONFIG_COUNT']).toBe('1');
    expect(policy.env['GIT_CONFIG_KEY_0']).toBe('remote.origin.pushurl');
    expect(policy.env['GIT_CONFIG_VALUE_0']).toContain('invalid');
  });

  it('git-ops sessions do not get the pushurl block, and keep Bash', () => {
    const policy = compileToolPolicy(capabilitySet('read', 'git-read', 'git-write'), '/repo');
    expect(policy.env['GIT_CONFIG_COUNT']).toBeUndefined();
    expect(policy.disallowedTools).not.toContain('Bash');
    expect(policy.disallowedTools).toContain('Write');
  });

  it('states the boundary in the system prompt', () => {
    const policy = compileToolPolicy(capabilitySet('read'), '/repo');
    expect(policy.boundaryPrompt).toContain('/repo');
    expect(policy.boundaryPrompt).toContain('cannot run shell commands');
  });
});
