/**
 * `flow-code connect` — put the reporting surface where the user's own agent
 * will find it.
 *
 * The failure this exists to prevent is a half-installed integration. An MCP
 * server registered but no instructions means an agent with tools it never
 * reaches for; instructions installed but no server means an agent told to
 * call something that is not there. Both look like a working setup and produce
 * a viewer that stays blank, so all of it is installed by one command, and one
 * command reports what is present.
 *
 * Everything written is either a file this owns outright (the skill) or a
 * delimited section inside a file the user owns. Nothing else is touched, and
 * every path written is named in the output — an installer that edits an
 * agent's configuration silently is not one you can trust twice.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  describeDrift,
  installedSection,
  instructionsSection,
  instructionState,
  skillDocument,
  spliceSection,
  type InstructionState,
} from '../guest/instructions.js';
import type { Workflow } from '../workflow/load.js';
import { fail, loadWorkflowOrFail, repoRootFromCwd } from './context.js';

/** Agent instruction files this installs into, in the order it prefers them. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

const SKILL_PATH = join('.claude', 'skills', 'flow-code-workflow', 'SKILL.md');
const MCP_CONFIG = '.mcp.json';
const SERVER_NAME = 'flow-code';

/**
 * How a host should launch the MCP server.
 *
 * `flow-code` on PATH is the form worth writing into a file the project may
 * commit: it survives a reinstall, a version bump, and a different machine.
 * When it is not on PATH — a local checkout, an npx invocation — an absolute
 * path is the only thing that will actually start, and the install says so
 * rather than writing a command that silently fails at session start.
 */
export function serverCommand(): { command: string; args: string[]; portable: boolean } {
  try {
    // Invoked as an argument to `sh` rather than through `shell: true`, which
    // concatenates instead of escaping and is deprecated for that reason.
    execFileSync('/bin/sh', ['-c', 'command -v flow-code'], { stdio: 'ignore' });
    return { command: 'flow-code', args: ['mcp'], portable: true };
  } catch {
    // Fall back to the entry point that is actually running, rather than to a
    // path derived from where this module expects to have been built. The
    // derived version is wrong the moment the layout is anything but the
    // published `dist/` — running from source, a bundler, a linked checkout —
    // and it failed by throwing, which turned "your PATH is unusual" into
    // "connect crashes". `argv[1]` is the one path we know launched us.
    const entry = process.argv[1];
    if (entry !== undefined) {
      try {
        return { command: process.execPath, args: [realpathSync(entry), 'mcp'], portable: false };
      } catch {
        // Unreadable entry (a virtual path under some runners): fall through.
      }
    }
    // Nothing resolvable to point at. Write the portable form anyway — it is
    // the command the user will eventually have — and let the caller say that
    // it will not start until `flow-code` is on PATH.
    return { command: 'flow-code', args: ['mcp'], portable: false };
  }
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Add our server to an MCP config without disturbing anyone else's.
 *
 * Returns undefined when the file already says exactly this, so a re-install
 * leaves it byte-identical rather than rewriting it with different key order
 * or indentation.
 */
export function mergeMcpConfig(existing: string | undefined, entry: unknown): string | undefined {
  let config: McpConfig = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      config = JSON.parse(existing) as McpConfig;
    } catch {
      throw new Error(`${MCP_CONFIG} is not valid JSON — fix it before connecting.`);
    }
  }
  const servers = { ...(config.mcpServers ?? {}) };
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) return undefined;
  servers[SERVER_NAME] = entry;
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Write only when the content differs, so "installed twice" and "installed once" are the same file. */
function writeIfChanged(path: string, content: string): boolean {
  if (read(path) === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/** Instruction files that exist, or the one to create when none do. */
function instructionTargets(repoRoot: string): string[] {
  const present = INSTRUCTION_FILES.filter((f) => existsSync(join(repoRoot, f)));
  return present.length > 0 ? [...present] : ['AGENTS.md'];
}

export interface SurfaceReport {
  path: string;
  state: InstructionState;
  drift?: string[];
}

/** What is installed right now, without changing anything. */
export function inspect(repoRoot: string, workflow: Workflow): SurfaceReport[] {
  const reports: SurfaceReport[] = [];

  const skill = read(join(repoRoot, SKILL_PATH));
  reports.push({
    path: SKILL_PATH,
    state:
      skill === undefined ? 'absent' : skill === skillDocument(workflow) ? 'current' : 'stale',
  });

  for (const file of INSTRUCTION_FILES) {
    const text = read(join(repoRoot, file));
    if (text === undefined) continue;
    const section = installedSection(text);
    const state = instructionState(section, workflow);
    reports.push({
      path: file,
      state,
      ...(state === 'stale' && section ? { drift: describeDrift(section, workflow) } : {}),
    });
  }

  const mcp = read(join(repoRoot, MCP_CONFIG));
  const registered =
    mcp !== undefined && (JSON.parse(mcp) as McpConfig).mcpServers?.[SERVER_NAME] !== undefined;
  reports.push({ path: MCP_CONFIG, state: registered ? 'current' : 'absent' });

  return reports;
}

const NOT_INSTALLED =
  'Not installed: the enforcement layer. This build reports and validates; it does not restrict\n' +
  '  what your agent may do, choose per-node models, or count tokens. Runs opened from your own\n' +
  '  session are recorded at the `reported` tier and labelled that way wherever they are shown.';

export async function cmdConnect(args: string[]): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const workflow = loadWorkflowOrFail(repoRoot);

  if (args.includes('--check')) {
    for (const report of inspect(repoRoot, workflow)) {
      const label =
        report.state === 'current' ? 'ok     ' : report.state === 'stale' ? 'stale  ' : 'missing';
      console.log(`  ${label} ${report.path}`);
      for (const line of report.drift ?? []) console.log(`          ${line}`);
    }
    console.log(`\n  ${NOT_INSTALLED}`);
    return;
  }

  const written: string[] = [];
  const entry = serverCommand();

  if (writeIfChanged(join(repoRoot, SKILL_PATH), skillDocument(workflow))) written.push(SKILL_PATH);

  const section = instructionsSection(workflow);
  for (const file of instructionTargets(repoRoot)) {
    const path = join(repoRoot, file);
    if (writeIfChanged(path, spliceSection(read(path) ?? '', section))) written.push(file);
  }

  try {
    const merged = mergeMcpConfig(read(join(repoRoot, MCP_CONFIG)), {
      command: entry.command,
      args: entry.args,
    });
    if (merged !== undefined && writeIfChanged(join(repoRoot, MCP_CONFIG), merged)) {
      written.push(MCP_CONFIG);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (written.length === 0) {
    console.log('flow-code: already connected — nothing changed.');
  } else {
    console.log('flow-code: connected. Files changed:');
    for (const path of written) console.log(`  ${path}`);
  }
  if (!entry.portable) {
    console.log(
      `\n  \`flow-code\` is not on your PATH, so ${MCP_CONFIG} points at this checkout directly.\n` +
        '  Install it globally and re-run `flow-code connect` if you intend to commit that file.',
    );
  }
  console.log(`\n  ${NOT_INSTALLED}`);
  console.log('\n  Start a new agent session to pick up the change, then watch with `flow-code watch`.');
}
