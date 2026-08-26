/**
 * Every command the CLI accepts, as data.
 *
 * `flow-code help` and the README's command table are both rendered from this
 * one list, which is the whole point: the table used to be hand-maintained and
 * had drifted — `runs`, `--resume`, `--allow-dirty` and `doctor --yes` were all
 * missing from it, so the entire crash-recovery story was reachable only by
 * running the binary and reading its help text. A reader who never gets that
 * far never learns it exists.
 *
 * Deliberately dependency-free. This module is one of the few things `cli.ts`
 * imports statically, and that file's dynamic-import discipline exists to keep
 * `hook` and `status` off the cost of loading the whole program. Data only, no
 * imports: the preset names below are spelled out rather than read from
 * `presets.ts`, and `cli.commands.test.ts` asserts they match the registry.
 */
export interface CliCommand {
  /** How the command is invoked, flags included. */
  usage: string;
  /** One line. Shown first in `help`, and as the README table's description. */
  summary: string;
  /**
   * Everything else worth knowing, shown only in `help` — the table stays one
   * row per command. Prose, not lines: `renderHelp` wraps it, so nobody has to
   * re-flow this file by hand to keep the terminal output tidy.
   */
  detail?: string;
}

export const CLI_COMMANDS: CliCommand[] = [
  {
    usage: 'flow-code try',
    summary: 'Run the real default graph against a seeded temporary repository',
    detail:
      'No repository, configuration, or credential needed. Every agent session is scripted, ' +
      'but the engine, the loop-back, the gates and the UI are the real ones — it pauses for ' +
      'a real approval twice, exactly as `flow-code run` does.',
  },
  {
    usage: 'flow-code init [--preset <name>]',
    summary: 'Scaffold .flow-code/workflow.yaml and configure the project',
    detail:
      'Sets up the graph, its test command(s), and the provider and model to run it with. ' +
      'Re-run it any time — already-configured steps ask before redoing anything. ' +
      'Presets: default, openspec, spec-kit, frugal, planned.',
  },
  {
    usage: 'flow-code run [--allow-dirty] [--graph <name>]',
    summary: 'Execute the workflow graph',
    detail:
      'A dirty tree is asked about, not refused; --allow-dirty skips the question and ' +
      'snapshots it as the baseline. --graph picks one of several named graphs without ' +
      'being asked. Also takes --no-splash (or FLOW_CODE_NO_SPLASH) to skip the startup ' +
      'animation, and --no-bell / --no-notify / --no-alerts to quiet the terminal bell and ' +
      'OS notifications.',
  },
  {
    usage: 'flow-code run --resume, -r [runId]',
    summary: 'Resume a run interrupted by ctrl+c or SIGTERM',
    detail:
      'Defaults to the most recent run. Completed nodes are kept and the rest re-run, and ' +
      'an interrupted Discuss conversation picks back up with its full history.',
  },
  {
    usage: 'flow-code runs',
    summary: 'List past runs in this repo — id, when, status, node tally',
    detail: 'Use a listed id with `flow-code run --resume` or `flow-code watch`.',
  },
  {
    usage: 'flow-code watch [runId]',
    summary: 'Follow a run started elsewhere — same graph, read-only',
    detail:
      "Fed by the run's state file, so it works from anywhere that can read the repo. " +
      'Defaults to whichever run is currently being written, and picks up a run started ' +
      'after the viewer was opened.',
  },
  {
    usage: 'flow-code status [--line] [--json] [--script] [--width N] [--dir <path>]',
    summary: 'Summarize the current run in one or two rows',
    detail:
      'What it needs, how far it is, what it has spent. Read-only, and cheap enough to run ' +
      'on every event of whatever displays it. --line emits a single row for a status bar ' +
      'you already have; --script prints a ready-made one for a host that has none.',
  },
  {
    usage: 'flow-code node <sub> …',
    summary: 'Report graph progress from an agent flow-code is not running',
    detail:
      'Open a run, then report each node started, done or failed, and the graph fills in ' +
      'beside your own session. `flow-code node` on its own lists the subcommands.',
  },
  {
    usage: 'flow-code connect [--host claude|codex|all] [--check] [--status-line]',
    summary: "Install the reporting surface into this project's agent config",
    detail:
      'Without --host, installs the Claude Code MCP server, workflow skill, instructions, ' +
      'enforcement hook, and status row. --host codex installs the project Codex MCP config, ' +
      'PreToolUse hook, AGENTS.md section, and .agents skill. --host all installs both. ' +
      '--check reports what is installed; --status-line is Claude-only.',
  },
  {
    usage: 'flow-code mcp',
    summary: 'Serve the reporting tools over MCP',
    detail: 'Launched by a host agent that `connect` configured, not run by hand.',
  },
  {
    usage: 'flow-code hook <event>',
    summary: "Apply the current step's capabilities to a host tool call",
    detail: 'Launched by the host agent on every tool call, not run by hand.',
  },
  {
    usage: 'flow-code reconcile [runId] [--json]',
    summary: "Check a run's claims against the repository",
    detail:
      'Reports which completed nodes claimed work the tree does not show. Read-only and ' +
      'advisory; exits non-zero when the repository contradicts the run.',
  },
  {
    usage: 'flow-code validate',
    summary: 'Check .flow-code/workflow.yaml without running it',
    detail:
      'Reports every problem it can find, and which checks a failure stopped it reaching.',
  },
  {
    usage: 'flow-code node-types',
    summary: 'List built-in node types, capabilities, config and output shapes',
  },
  {
    usage: 'flow-code skills',
    summary: 'List skills attachable to a node, and where each was found',
  },
  {
    usage: 'flow-code doctor [--yes]',
    summary: 'Diagnose environment, tools, credentials; clear stale worktrees',
    detail: '--yes removes the worktrees left behind by crashed runs without asking.',
  },
  {
    usage: 'flow-code help',
    summary: 'Show this command reference',
  },
  {
    usage: 'flow-code --version, -v',
    summary: 'Print the installed version',
  },
];

/** Column the description starts in. */
const DESCRIPTION_COLUMN = 30;

/** Total width the help text wraps to — narrow enough for a split terminal. */
const HELP_WIDTH = 96;

/** Greedy word wrap. Long unbreakable tokens overhang rather than being cut. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }

  if (line !== '') lines.push(line);
  return lines;
}

/**
 * Help for one command, for `flow-code <command> --help`.
 *
 * Returns undefined for a command this registry does not describe, so the
 * caller can fall back to the full help rather than printing nothing.
 *
 * A command can appear here more than once (`run` and `run --resume` are
 * separate rows), and all of its rows are shown: they are alternative ways to
 * invoke the same word, and someone asking about `run` wants both.
 */
export function renderCommandHelp(name: string): string | undefined {
  const prefix = `flow-code ${name}`;
  const matches = CLI_COMMANDS.filter(
    (c) => c.usage === prefix || c.usage.startsWith(`${prefix} `),
  );
  if (matches.length === 0) return undefined;

  const lines: string[] = [];
  for (const command of matches) {
    lines.push(
      command.usage,
      '',
      ...wrap(command.summary, HELP_WIDTH - 2).map((line) => `  ${line}`),
    );
    if (command.detail) {
      lines.push('', ...wrap(command.detail, HELP_WIDTH - 2).map((line) => `  ${line}`));
    }
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

/**
 * The full `flow-code help` output. A usage too wide to share a row with its
 * description gets the description on the lines below it instead of a ragged
 * second column — the same shape the hand-written help had.
 */
export function renderHelp(): string {
  const lines = [
    'flow-code — terminal node-graph interface for agentic coding workflows',
    '',
    'Usage:',
  ];
  const indent = ' '.repeat(DESCRIPTION_COLUMN);
  const bodyWidth = HELP_WIDTH - DESCRIPTION_COLUMN;

  for (const command of CLI_COMMANDS) {
    const usage = `  ${command.usage}`;
    const body = [
      ...wrap(command.summary, bodyWidth),
      ...(command.detail ? wrap(command.detail, bodyWidth) : []),
    ];

    if (usage.length < DESCRIPTION_COLUMN) {
      lines.push(usage.padEnd(DESCRIPTION_COLUMN) + body[0]);
      lines.push(...body.slice(1).map((line) => indent + line));
    } else {
      lines.push(usage, ...body.map((line) => indent + line));
    }
  }

  return `${lines.join('\n')}\n`;
}
