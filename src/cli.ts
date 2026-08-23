#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from './cli/context.js';

/*
 * Every subcommand is imported dynamically, and that is a performance
 * requirement rather than a style preference.
 *
 * Two of these commands are called by another program on a hot path: `hook
 * pretooluse` runs once before *every* tool call in a host session, and
 * `status` is re-run by a status line on every event. Static imports made both
 * of them pay for the whole program — Ink, React, the engine, the agent SDK,
 * the MCP server — to answer a question that reads one JSON file. Measured on
 * the machine this was written on: 27ms to start node, 940ms to import the
 * entry point, so the hook cost ~0.72s per tool call and a node doing thirty
 * calls paid twenty seconds for nothing.
 *
 * Keep it this way. A static `import` of a command module at the top of this
 * file re-couples every command to every other one, and the cost lands on the
 * two paths least able to afford it.
 */

const HELP = `flow-code — terminal node-graph interface for agentic coding workflows

Usage:
  flow-code try               Run the real default graph against a seeded temporary repository —
                              no repository, configuration, or credential needed. Every agent
                              session is scripted; the engine, gates, and UI are the real ones.
                              Pauses for a real approval at both gates, same as \`flow-code run\`
  flow-code init [--preset <name>]
                              Scaffold .flow-code/workflow.yaml with the default graph, set up
                              its test command(s), and pick the provider/model for the project
                              (re-run any time — already-configured steps ask before redoing)
  flow-code run [--allow-dirty] [--no-splash] [--no-notify] [--no-bell] [--no-alerts]
                              Run the workflow (a dirty tree is asked about, not refused;
                              --allow-dirty skips the question and snapshots it as the baseline)
                              —no-splash skips the startup animation (or set FLOW_CODE_NO_SPLASH)
                              —no-notify / --no-bell / --no-alerts control OS popups & terminal bell
  flow-code run --resume, -r [runId]
                              Resume a run interrupted by ctrl+c/SIGTERM (defaults to the
                              most recent one); completed nodes are kept, the rest re-run,
                              and an interrupted Discuss conversation picks back up with
                              full history
  flow-code runs              List past runs in this repo (id, when, status, node tally) —
                              use a listed id with \`flow-code run --resume\` or \`flow-code watch\`
  flow-code watch [runId] [--no-splash]
                              Follow a run started elsewhere — same graph, read-only, fed by the
                              run's state file. Defaults to whichever run is currently being
                              written, and picks up a run started after the viewer was opened
  flow-code status [--line] [--json] [--script] [--width N] [--dir <path>]
                              Summarize the current run in one or two rows — what it needs, how
                              far it is, what it has spent. Read-only, and cheap enough to run on
                              every event of whatever displays it. --line emits a single row for
                              embedding in a status bar you already have; --script prints a
                              ready-made one for a host that has none
  flow-code node <sub> …      Report progress through the graph from an agent flow-code is not
                              running — open a run, then report each node started/done/failed,
                              and the graph fills in beside your own session. \`flow-code node\`
                              on its own lists the subcommands
  flow-code connect [--check] Install flow-code's reporting surface into this project's agent
                              configuration (MCP server, workflow skill, instructions section,
                              enforcement hook, and a status row for the host's status line).
                              --check reports what is installed and whether it is still current;
                              --status-line installs only the status row, which is the one piece
                              the Claude Code plugin cannot install for you
  flow-code reconcile [runId] [--json]
                              Check a run's claims against the repository — which completed nodes
                              reported work the tree does not show. Read-only and advisory; exits
                              non-zero when the repository contradicts the run
  flow-code validate          Check .flow-code/workflow.yaml without running it — reports every
                              problem it can find, and which checks a failure stopped it reaching
  flow-code node-types        List built-in node types, capabilities, config and output shapes
  flow-code skills            List skills attachable to a node, and where each was found
  flow-code doctor [--yes]    List/remove orphaned worktrees from crashed runs
  flow-code --version, -v     Print the installed version
`;

/**
 * The version this build was published as, read from the package manifest
 * rather than baked in by the build — release-please bumps package.json and
 * nothing else, so anything baked in would drift the moment it did.
 *
 * `../package.json` resolves to the package root from `dist/cli.js` and to the
 * repo root from `src/cli.ts`, so the same expression is right compiled or not.
 */
export function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const version = (manifest as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'try':
      return (await import('./cli/try.js')).cmdTry();
    case 'init':
      return (await import('./cli/init.js')).cmdInit(args);
    case 'run':
      return (await import('./cli/run.js')).cmdRun(args);
    case 'runs':
      return (await import('./cli/runs.js')).cmdRuns();
    case 'watch':
      return (await import('./cli/watch.js')).cmdWatch(args);
    case 'status':
      return (await import('./cli/status.js')).cmdStatus(args);
    case 'node':
      return (await import('./cli/node.js')).cmdNode(args);
    case 'connect':
      return (await import('./cli/connect.js')).cmdConnect(args);
    case 'mcp':
      return (await import('./cli/mcp.js')).cmdMcp();
    case 'hook':
      return (await import('./cli/hook.js')).cmdHook(args);
    case 'reconcile':
      return (await import('./cli/reconcile.js')).cmdReconcile(args);
    case 'validate':
      return (await import('./cli/validate.js')).cmdValidate();
    case 'node-types':
      return (await import('./cli/nodeTypes.js')).cmdNodeTypes();
    case 'skills':
      return (await import('./cli/skills.js')).cmdSkills();
    case 'doctor':
      return (await import('./cli/doctor.js')).cmdDoctor(args);
    // The first thing anyone types after `npx @easonliuuuuu/flow-code`, to
    // find out what they just fetched. Reading the manifest costs one small
    // synchronous file read and pulls in no command module, so it stays off
    // the hot paths this file's dynamic imports exist to protect.
    case '--version':
    case '-v':
    case 'version':
      console.log(packageVersion());
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      fail(`unknown command \`${command}\`\n\n${HELP}`);
  }
}

// Only run when invoked directly (the published bin), not when imported —
// e.g. by tests importing a command module for direct coverage. Compared via
// realpath since the published bin is a symlink (e.g. nvm's bin dir):
// process.argv[1] is the symlink path, but import.meta.url is resolved to the
// symlink target, so a direct string comparison never matches and the CLI
// silently no-ops.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`flow-code: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
