#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from './cli/context.js';
import { renderCommandHelp, renderHelp } from './cli/commands.js';

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

/**
 * Rendered from `CLI_COMMANDS` rather than written out here, so the README's
 * command table and this help text cannot disagree — `npm run docs:check`
 * regenerates the table from the same list and fails CI when it is stale.
 */
const HELP = renderHelp();

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

  // `flow-code <command> --help` describes the command rather than running it.
  // Without this the flag falls through into the command's own arguments,
  // which every command but `node` ignores — so asking `connect` what it does
  // used to *do* it, writing five files into the project. A help flag must
  // never have an effect.
  // `node` is skipped: it has subcommands, and its own handler prints all of
  // them. The registry entry here is one row, so routing it through the
  // generic path would replace a reference with a summary.
  if (command !== undefined && command !== 'node' && (args.includes('--help') || args.includes('-h'))) {
    const help = renderCommandHelp(command);
    if (help !== undefined) {
      console.log(help);
      return;
    }
  }

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
