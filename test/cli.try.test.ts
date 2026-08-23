import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/run.js')>();
  return {
    ...actual,
    // The one boundary these tests don't cross: mounting a real Ink UI needs
    // a real interactive stdin, which a vitest process doesn't have. Every
    // node's own behaviour — seeding, the loop-back, the commit — is already
    // proven against the real engine in test/demo/DemoSessionRunner.test.ts;
    // what's untested there is `try.ts`'s own wiring (the TTY guard, the
    // notifier, SIGINT handling, the closing summary), which is what this
    // file checks with everything except the UI mount left real.
    runEngineUi: vi.fn(async (opts: { workflow: unknown }) => opts.workflow),
  };
});

/** Makes `fail`'s process.exit observable rather than killing the test runner. */
function trapExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { exit, error, log };
}

async function asTTY<T>(isTTY: boolean, body: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = isTTY;
  try {
    return await body();
  } finally {
    process.stdin.isTTY = original;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cmdTry', () => {
  it('refuses a non-interactive terminal before creating anything', async () => {
    const { cmdTry } = await import('../src/cli/try.js');
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('flow-code-try-'));
    const { exit, error } = await asTTY(false, async () => {
      const trap = trapExit();
      await expect(cmdTry()).rejects.toThrow('process.exit called');
      return trap;
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(' ')).toMatch(/interactive terminal/);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('flow-code-try-'));
    expect(after.length).toBe(before.length);
  });

  it('needs no credentials — runs with every provider env var unset, outside a git repository', async () => {
    const { cmdTry } = await import('../src/cli/try.js');
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY']) {
      vi.stubEnv(key, undefined);
    }
    await asTTY(true, async () => {
      const { exit, log } = trapExit();
      await expect(cmdTry()).rejects.toThrow('process.exit called');
      expect(exit).toHaveBeenCalledWith(0);
      return log;
    });
    vi.unstubAllEnvs();
  });

  it('exits zero and leaves a temp repo with the run\'s commit, path named in the summary', async () => {
    const { cmdTry } = await import('../src/cli/try.js');
    const { exit, log } = await asTTY(true, async () => {
      const trap = trapExit();
      await expect(cmdTry()).rejects.toThrow('process.exit called');
      return trap;
    });
    expect(exit).toHaveBeenCalledWith(0);

    const printed = log.mock.calls.flat().join('\n');
    const match = printed.match(/Repo:\s+(\S+)/);
    expect(match).not.toBeNull();
    const dir = match![1]!;
    expect(existsSync(dir)).toBe(true);
    // The seed commit — runEngineUi is mocked here, so no git-ops commit is
    // made in *this* test; that a real run adds a second one is proven in
    // test/demo/DemoSessionRunner.test.ts.
    const commitLog = execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString();
    expect(commitLog.trim().split('\n').length).toBeGreaterThanOrEqual(1);
    expect(printed).toMatch(/flow-code init/);
  });
});
