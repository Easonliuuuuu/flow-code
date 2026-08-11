#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cmdConnect } from './cli/connect.js';
import { cmdDoctor } from './cli/doctor.js';
import { cmdHook } from './cli/hook.js';
import { cmdInit } from './cli/init.js';
import { cmdMcp } from './cli/mcp.js';
import { cmdNode } from './cli/node.js';
import { cmdNodeTypes } from './cli/nodeTypes.js';
import { cmdRun } from './cli/run.js';
import { cmdRuns } from './cli/runs.js';
import { cmdSkills } from './cli/skills.js';
import { cmdStatus } from './cli/status.js';
import { cmdValidate } from './cli/validate.js';
import { cmdWatch } from './cli/watch.js';
import { fail } from './cli/context.js';

const HELP = `flow-code — terminal node-graph interface for agentic coding workflows

Usage:
  flow-code init [--preset <name>]
                              Scaffold .flow-code/workflow.yaml with the default graph, set up
                              its test command(s), and pick the provider/model for the project
                              (re-run any time — already-configured steps ask before redoing)
  flow-code run [--allow-dirty] [--no-splash]
                              Run the workflow (refuses a dirty tree unless overridden)
                              —no-splash skips the startup animation (or set FLOW_CODE_NO_SPLASH)
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
                              configuration (MCP server, workflow skill, instructions section).
                              --check reports what is installed and whether it is still current
  flow-code validate          Check .flow-code/workflow.yaml without running it — reports every
                              problem it can find, and which checks a failure stopped it reaching
  flow-code node-types        List built-in node types, capabilities, config and output shapes
  flow-code skills            List skills attachable to a node, and where each was found
  flow-code doctor [--yes]    List/remove orphaned worktrees from crashed runs
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'init':
      return cmdInit(args);
    case 'run':
      return cmdRun(args);
    case 'runs':
      return cmdRuns();
    case 'watch':
      return cmdWatch(args);
    case 'status':
      return cmdStatus(args);
    case 'node':
      return cmdNode(args);
    case 'connect':
      return cmdConnect(args);
    case 'mcp':
      return cmdMcp();
    case 'hook':
      return cmdHook(args);
    case 'validate':
      return cmdValidate();
    case 'node-types':
      return cmdNodeTypes();
    case 'skills':
      return cmdSkills();
    case 'doctor':
      return cmdDoctor(args);
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
