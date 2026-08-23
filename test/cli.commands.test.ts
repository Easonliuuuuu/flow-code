import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, renderHelp } from '../src/cli/commands.js';
import { presetNames } from '../src/presets.js';

/**
 * `CLI_COMMANDS` is the single source for `flow-code help` and the README's
 * command table, so what has to hold is that it stays level with the code:
 * every command the CLI dispatches is described, and nothing describes a
 * command that no longer exists. The README table used to be maintained by
 * hand and had silently lost four entries, which is the failure these
 * assertions exist to make impossible rather than merely unlikely.
 */

const cliSource = readFileSync(
  fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
  'utf8',
);

/** Every `case '…'` the command switch dispatches on. */
function dispatchedCommands(): string[] {
  return [...cliSource.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]!);
}

/**
 * The word a usage string dispatches on — `flow-code run --resume` → `run`.
 * The trailing comma comes off `flow-code --version, -v`, whose second word
 * carries the separator for the alias listed after it.
 */
function dispatchWordOf(usage: string): string {
  return usage.split(/\s+/)[1]!.replace(/,$/, '');
}

/**
 * Spellings the switch accepts that are not their own command: short flags and
 * the bare-word forms of `--version`/`--help`. Each is listed beside the entry
 * it is an alias for, so removing that entry surfaces the alias too.
 */
const ALIASES: Record<string, string> = {
  '-v': '--version',
  version: '--version',
  '--help': 'help',
  '-h': 'help',
};

describe('CLI_COMMANDS', () => {
  it('describes every command the switch dispatches, aliases aside', () => {
    const dispatched = new Set(
      dispatchedCommands().map((c) => ALIASES[c] ?? c),
    );
    const described = new Set(CLI_COMMANDS.map((c) => dispatchWordOf(c.usage)));

    expect([...dispatched].sort()).toEqual([...described].sort());
  });

  it('describes no command the CLI cannot run', () => {
    const dispatched = new Set([
      ...dispatchedCommands(),
      ...Object.values(ALIASES),
    ]);

    for (const command of CLI_COMMANDS) {
      expect(dispatched.has(dispatchWordOf(command.usage))).toBe(true);
    }
  });

  it('lists the presets `init` actually accepts', () => {
    const init = CLI_COMMANDS.find((c) => c.usage.startsWith('flow-code init'))!;
    const listed = init
      .detail!.match(/Presets: ([^.]+)\./)![1]!
      .split(',')
      .map((name) => name.trim());

    // `default` is the preset you get by passing no `--preset` at all, so it
    // is offered in the help without being in the registry.
    expect(listed).toEqual(['default', ...presetNames()]);
  });

  it('gives every command a one-line summary — the README table has one cell for it', () => {
    for (const command of CLI_COMMANDS) {
      expect(command.summary).not.toContain('\n');
      expect(command.summary.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('renderHelp', () => {
  const help = renderHelp();

  it('names every command, with its summary intact on one line', () => {
    for (const command of CLI_COMMANDS) {
      expect(help).toContain(command.usage);
      // Verbatim: a summary long enough to wrap would be split across two
      // lines here while the README table still showed it whole.
      expect(help).toContain(command.summary);
    }
  });

  it('keeps every line inside a conventional terminal width', () => {
    for (const line of help.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('puts the description on its own lines when the usage is too wide to share a row', () => {
    const lines = help.split('\n');
    const wide = lines.indexOf('  flow-code init [--preset <name>]');

    expect(wide).toBeGreaterThan(-1);
    expect(lines[wide]).toBe('  flow-code init [--preset <name>]');
    expect(lines[wide + 1]).toMatch(/^ {30}Scaffold/);
  });
});
