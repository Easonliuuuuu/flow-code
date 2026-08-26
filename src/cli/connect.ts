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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
import type { CompanionHost } from '../guest/host.js';
import { fail, loadWorkflowOrFail, repoRootFromCwd } from './context.js';
import { statusLineScript } from './status.js';

/** Agent instruction files this installs into, in the order it prefers them. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

const SKILL_PATH = join('.claude', 'skills', 'flow-code-workflow', 'SKILL.md');
const MCP_CONFIG = '.mcp.json';
const HOST_SETTINGS = join('.claude', 'settings.json');
const STATUS_SCRIPT = join('.claude', 'flow-code-status.sh');
const CODEX_CONFIG = join('.codex', 'config.toml');
const CODEX_HOOKS = join('.codex', 'hooks.json');
const CODEX_SKILL_PATH = join('.agents', 'skills', 'flow-code-workflow', 'SKILL.md');
const CODEX_BEGIN = '# flow-code:begin';
const CODEX_END = '# flow-code:end';
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
export function serverCommand(): Launcher {
  try {
    // Invoked as an argument to `sh` rather than through `shell: true`, which
    // concatenates instead of escaping and is deprecated for that reason.
    execFileSync('/bin/sh', ['-c', 'command -v flow-code'], { stdio: 'ignore' });
    return { command: 'flow-code', prefixArgs: [], portable: true };
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
        return { command: process.execPath, prefixArgs: [realpathSync(entry)], portable: false };
      } catch {
        // Unreadable entry (a virtual path under some runners): fall through.
      }
    }
    // Nothing resolvable to point at. Write the portable form anyway — it is
    // the command the user will eventually have — and let the caller say that
    // it will not start until `flow-code` is on PATH.
    return { command: 'flow-code', prefixArgs: [], portable: false };
  }
}

/** `flow-code <subcommand>`, as a host must spell it to reach this build. */
export function launch(entry: Launcher, ...subcommand: string[]): { command: string; args: string[] } {
  return { command: entry.command, args: [...entry.prefixArgs, ...subcommand] };
}

/** The same thing as one shell string, which is how a hook is registered. */
export function hookCommand(entry: Launcher, host: CompanionHost = 'claude'): string {
  const { command, args } =
    host === 'claude'
      ? launch(entry, 'hook', 'pretooluse')
      : launch(entry, 'hook', 'pretooluse', '--host', host);
  return [command, ...args].map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ');
}

/**
 * How to invoke this build of flow-code, split so any subcommand can be built
 * from it. Kept as a prefix rather than a finished command line because the
 * install needs two different ones — the MCP server and the hook — and
 * deriving the second by editing the first is how they drift apart.
 */
export interface Launcher {
  command: string;
  /** Empty when `flow-code` is itself executable; the script path otherwise. */
  prefixArgs: string[];
  portable: boolean;
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

interface HostSettings {
  hooks?: Record<string, HookEntry[]>;
  statusLine?: { type?: string; command?: string };
  [key: string]: unknown;
}

/**
 * Register the status line, without ever taking one the user already has.
 *
 * The point of this row is that a run stays visible without a second terminal
 * running `watch`. The point of *not* overwriting is that a status line is
 * someone's own screen furniture, and silently replacing it would be the most
 * annoying thing this installer could do. When one is already there, we leave
 * it and say how to add our row to it — the generated script says the same in
 * its header.
 *
 * Returns undefined when nothing should change.
 */
export function mergeStatusLine(existing: string | undefined, command: string): string | undefined {
  let settings: HostSettings = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      settings = JSON.parse(existing) as HostSettings;
    } catch {
      throw new Error(`${HOST_SETTINGS} is not valid JSON — fix it before connecting.`);
    }
  }
  const current = settings.statusLine;
  if (current !== undefined) return undefined;
  return `${JSON.stringify({ ...settings, statusLine: { type: 'command', command } }, null, 2)}\n`;
}

/** Whether a settings object already carries a status line somebody else owns. */
function foreignStatusLine(settings: HostSettings, ours: string): boolean {
  const command = settings.statusLine?.command;
  return command !== undefined && command !== ours;
}

/**
 * Write the status-line script and register it, returning what changed.
 *
 * The script is written per-project rather than to a shared location because
 * the launcher baked into it is this checkout's, and two projects on one
 * machine may be running different builds.
 */
function installStatusLine(repoRoot: string, entry: Launcher): string[] {
  const written: string[] = [];
  const scriptPath = join(repoRoot, STATUS_SCRIPT);
  const launcher = [entry.command, ...entry.prefixArgs]
    .map((part) => (part.includes(' ') ? JSON.stringify(part) : part))
    .join(' ');
  if (writeIfChanged(scriptPath, statusLineScript(launcher))) written.push(STATUS_SCRIPT);
  chmodSync(scriptPath, 0o755);
  const withStatus = mergeStatusLine(read(join(repoRoot, HOST_SETTINGS)), scriptPath);
  if (withStatus !== undefined && writeIfChanged(join(repoRoot, HOST_SETTINGS), withStatus)) {
    written.push(HOST_SETTINGS);
  }
  return written;
}

/** Whether a settings object already registers our PreToolUse hook. */
function hasHook(settings: HostSettings, command: string): boolean {
  return (settings.hooks?.['PreToolUse'] ?? []).some((entry) =>
    (entry.hooks ?? []).some((h) => h.command === command),
  );
}

/**
 * Register the enforcement hook without disturbing anyone else's.
 *
 * Appended as its own entry rather than merged into an existing matcher block:
 * hooks on the same event compose (every one runs, and any single deny wins),
 * so adding ours alongside is both correct and the only edit that cannot break
 * a hook the user already depended on.
 *
 * Returns undefined when it is already registered, so re-running changes
 * nothing.
 */
export function mergeHookSettings(existing: string | undefined, command: string): string | undefined {
  let settings: HostSettings = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      settings = JSON.parse(existing) as HostSettings;
    } catch {
      throw new Error(`${HOST_SETTINGS} is not valid JSON — fix it before connecting.`);
    }
  }
  if (hasHook(settings, command)) return undefined;
  const preToolUse = [...(settings.hooks?.['PreToolUse'] ?? [])];
  preToolUse.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] });
  return `${JSON.stringify({ ...settings, hooks: { ...settings.hooks, PreToolUse: preToolUse } }, null, 2)}\n`;
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexConfigBlock(entry: { command: string; args: string[] }): string {
  return [
    CODEX_BEGIN,
    '[mcp_servers.flow-code]',
    `command = ${tomlString(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    'required = true',
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.flow-code.tools.decide_gate]',
    'approval_mode = "prompt"',
    '',
    '[mcp_servers.flow-code.tools.accept_plan]',
    'approval_mode = "prompt"',
    CODEX_END,
  ].join('\n');
}

/** Merge the flow-code-owned TOML block into Codex's project config. */
export function mergeCodexConfig(
  existing: string | undefined,
  entry: { command: string; args: string[] },
): string | undefined {
  const block = codexConfigBlock(entry);
  const text = existing ?? '';
  const owned = new RegExp(`${escapeRegExp(CODEX_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_END)}`, 'm');
  const withoutOwned = text.replace(owned, '').trim();
  if (/^\[mcp_servers\.flow-code\]$/m.test(withoutOwned)) {
    throw new Error(`${CODEX_CONFIG} already configures flow-code outside its managed section — merge it manually before connecting.`);
  }
  if (text.match(owned)?.[0] === block && withoutOwned === text.replace(owned, '').trim()) return undefined;
  if (owned.test(text)) return `${text.replace(owned, block).replace(/\n*$/, '\n')}`;
  return text.trim() === '' ? `${block}\n` : `${text.trimEnd()}\n\n${block}\n`;
}

/** Merge the Codex hook using the same protocol shape as Claude's hook. */
export function mergeCodexHooks(existing: string | undefined, command: string): string | undefined {
  let hooks: HostSettings = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      hooks = JSON.parse(existing) as HostSettings;
    } catch {
      throw new Error(`${CODEX_HOOKS} is not valid JSON — fix it before connecting.`);
    }
  }
  if (hasHook(hooks, command)) return undefined;
  const preToolUse = [...(hooks.hooks?.['PreToolUse'] ?? [])];
  preToolUse.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] });
  return `${JSON.stringify({ ...hooks, hooks: { ...hooks.hooks, PreToolUse: preToolUse } }, null, 2)}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function codexInstructionTargets(): string[] {
  return ['AGENTS.md'];
}

export interface SurfaceReport {
  path: string;
  state: InstructionState;
  drift?: string[];
}

/** What is installed right now, without changing anything. */
export function inspect(repoRoot: string, workflow: Workflow): SurfaceReport[] {
  const reports: SurfaceReport[] = [];

  const enforced = { enforced: true };
  const skill = read(join(repoRoot, SKILL_PATH));
  reports.push({
    path: SKILL_PATH,
    state:
      skill === undefined ? 'absent' : skill === skillDocument(workflow, enforced) ? 'current' : 'stale',
  });

  for (const file of INSTRUCTION_FILES) {
    const text = read(join(repoRoot, file));
    if (text === undefined) continue;
    const section = installedSection(text);
    const state = instructionState(section, workflow, enforced);
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

  const settings = read(join(repoRoot, HOST_SETTINGS));
  let hooked = false;
  let statusLine: SurfaceReport = { path: `${HOST_SETTINGS} (statusLine)`, state: 'absent' };
  try {
    const parsed = settings === undefined ? {} : (JSON.parse(settings) as HostSettings);
    hooked = settings !== undefined && hasHook(parsed, hookCommand(serverCommand()));
    const ours = join(repoRoot, STATUS_SCRIPT);
    if (foreignStatusLine(parsed, ours)) {
      // Not "missing": nothing here is broken, and the next run of `connect`
      // must not read as though it should fix it.
      statusLine = {
        path: `${HOST_SETTINGS} (statusLine)`,
        state: 'stale',
        drift: [`a status line is already set — add \`flow-code status --line --dir "$DIR"\` to it yourself`],
      };
    } else if (parsed.statusLine?.command === ours && read(ours) !== undefined) {
      statusLine = { path: `${HOST_SETTINGS} (statusLine)`, state: 'current' };
    }
  } catch {
    hooked = false;
  }
  reports.push({ path: HOST_SETTINGS, state: hooked ? 'current' : 'absent' });
  reports.push(statusLine);

  return reports;
}

/** What the Codex project surface has installed right now. */
export function inspectCodex(repoRoot: string, workflow: Workflow): SurfaceReport[] {
  const reports: SurfaceReport[] = [];
  const enforced = { enforced: true };
  const skill = read(join(repoRoot, CODEX_SKILL_PATH));
  reports.push({
    path: CODEX_SKILL_PATH,
    state:
      skill === undefined
        ? 'absent'
        : skill === skillDocument(workflow, { enforced: true, host: 'codex' })
          ? 'current'
          : 'stale',
  });

  const agents = read(join(repoRoot, 'AGENTS.md'));
  const section = agents === undefined ? undefined : installedSection(agents);
  const instructionStateValue = instructionState(section, workflow, enforced);
  reports.push({
    path: 'AGENTS.md',
    state: instructionStateValue,
    ...(instructionStateValue === 'stale' && section ? { drift: describeDrift(section, workflow) } : {}),
  });

  const config = read(join(repoRoot, CODEX_CONFIG));
  let configState: InstructionState = 'absent';
  try {
    if (config !== undefined) {
      configState = mergeCodexConfig(config, launch(serverCommand(), 'mcp')) === undefined ? 'current' : 'stale';
    }
  } catch {
    configState = 'stale';
  }
  reports.push({ path: CODEX_CONFIG, state: configState });

  const hooks = read(join(repoRoot, CODEX_HOOKS));
  let hooked = false;
  try {
    const parsed = hooks === undefined ? {} : (JSON.parse(hooks) as HostSettings);
    hooked = hooks !== undefined && hasHook(parsed, hookCommand(serverCommand(), 'codex'));
  } catch {
    hooked = false;
  }
  reports.push({ path: CODEX_HOOKS, state: hooked ? 'current' : 'absent' });
  return reports;
}

/**
 * What the user gets, and — just as important — what they do not.
 *
 * Stated on every run of this command rather than buried in documentation,
 * because the failure this whole surface guards against is someone reading a
 * green graph as a stronger claim than it is.
 */
function whatYouGet(host: ConnectHost): string {
  const hosts = host === 'all' ? 'Claude Code and Codex' : host === 'codex' ? 'Codex' : 'Claude Code';
  const status = host === 'codex' ? '' : ' and a\n  status row showing the run in your session';
  const limitation =
    host === 'codex'
      ? '\n  Codex hosted tools such as web search are not visible to this local hook, so the run records\n  that limitation rather than claiming complete tool-call observation.'
      : '';
  const installed = host === 'claude' ? 'Installed' : `Installed for ${hosts}`;
  return (
    `${installed}: the reporting tools, this project's instructions, and the enforcement hook${status} —\n` +
    '  no second terminal needed.\n' +
    '  While a step is in progress, observable local tool calls outside that step\'s capability set\n' +
    '  are denied, and git writes stay blocked behind an unapproved approval gate.' +
    limitation +
    '\n\n  Still not in force, because flow-code did not start your session: process-level guards\n' +
    '  (working directory, environment, push url), per-node model selection, which subagent types\n' +
    '  are available, token accounting, and automatic loop-back routing. A run records the `hooks`\n' +
    '  tier only when the hook is verified to be running; otherwise it records `reported` and says so.'
  );
}

type ConnectHost = CompanionHost | 'all';

function parseHost(args: string[]): ConnectHost {
  const values = args.flatMap((arg, index) => {
    if (arg === '--host') return [args[index + 1]];
    if (arg.startsWith('--host=')) return [arg.slice('--host='.length)];
    return [];
  });
  if (values.length === 0) return 'claude';
  if (values.length > 1 || values[0] === undefined || !['claude', 'codex', 'all'].includes(values[0])) {
    throw new Error('connect --host expects exactly one of: claude, codex, all');
  }
  return values[0] as ConnectHost;
}

function selectedHosts(host: ConnectHost): CompanionHost[] {
  return host === 'all' ? ['claude', 'codex'] : [host];
}

export async function cmdConnect(args: string[]): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const workflow = loadWorkflowOrFail(repoRoot);
  let host: ConnectHost;
  try {
    host = parseHost(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const hosts = selectedHosts(host);

  if (args.includes('--check')) {
    for (const selected of hosts) {
      console.log(`  ${selected}:`);
      const reports = selected === 'codex' ? inspectCodex(repoRoot, workflow) : inspect(repoRoot, workflow);
      for (const report of reports) {
        const label =
          report.state === 'current' ? 'ok     ' : report.state === 'stale' ? 'stale  ' : 'missing';
        console.log(`    ${label} ${report.path}`);
        for (const line of report.drift ?? []) console.log(`            ${line}`);
      }
    }
    console.log(`\n  ${whatYouGet(host)}`);
    return;
  }

  const written: string[] = [];
  const entry = serverCommand();

  // The Claude Code plugin installs the tools, the instructions, and the hook
  // on its own, but a plugin manifest has no `statusLine` field — Claude Code
  // ignores one if you write it — so the status row is the single piece a
  // plugin user still has to install per project. This flag is that install and
  // nothing else, so running it in a plugin-managed repo does not also scatter
  // a second copy of the instructions the plugin is already serving.
  if (args.includes('--status-line') && hosts.includes('codex') && !hosts.includes('claude')) {
    fail('Codex does not expose a project status-line setting; use `flow-code status --line` from your own status bar.');
    return;
  }

  if (args.includes('--status-line')) {
    try {
      for (const path of installStatusLine(repoRoot, entry)) written.push(path);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (written.length === 0) {
      console.log('flow-code: status line already installed — nothing changed.');
      const settings = read(join(repoRoot, HOST_SETTINGS));
      if (settings !== undefined && foreignStatusLine(JSON.parse(settings) as HostSettings, join(repoRoot, STATUS_SCRIPT))) {
        console.log(
          '\n  You already have a status line, so yours was left alone. To include this run in it,\n' +
            `  call \`flow-code status --line --dir "$DIR"\` from your own script.`,
        );
      }
    } else {
      console.log('flow-code: status line installed. Files changed:');
      for (const path of written) console.log(`  ${path}`);
      console.log('\n  Start a new session to pick it up.');
    }
    if (host === 'claude') return;
  }

  try {
    if (hosts.includes('claude')) {
      // `connect` installs the enforcement hook, so the instructions it writes
      // describe a session in which calls really are checked.
      if (writeIfChanged(join(repoRoot, SKILL_PATH), skillDocument(workflow, { enforced: true })))
        written.push(SKILL_PATH);

      const section = instructionsSection(workflow, { enforced: true });
      for (const file of instructionTargets(repoRoot)) {
        const path = join(repoRoot, file);
        if (writeIfChanged(path, spliceSection(read(path) ?? '', section))) written.push(file);
      }

      const merged = mergeMcpConfig(read(join(repoRoot, MCP_CONFIG)), launch(entry, 'mcp'));
      if (merged !== undefined && writeIfChanged(join(repoRoot, MCP_CONFIG), merged)) {
        written.push(MCP_CONFIG);
      }
      const settings = mergeHookSettings(read(join(repoRoot, HOST_SETTINGS)), hookCommand(entry));
      if (settings !== undefined && writeIfChanged(join(repoRoot, HOST_SETTINGS), settings)) {
        written.push(HOST_SETTINGS);
      }

      if (!args.includes('--status-line')) {
        for (const path of installStatusLine(repoRoot, entry)) {
          if (!written.includes(path)) written.push(path);
        }
      }
    }

    if (hosts.includes('codex')) {
      const codexSkillInstructions = { enforced: true, host: 'codex' as const };
      if (
        writeIfChanged(
          join(repoRoot, CODEX_SKILL_PATH),
          skillDocument(workflow, codexSkillInstructions),
        )
      )
        written.push(CODEX_SKILL_PATH);

      // AGENTS.md is shared by both hosts when --host all is used. Keep that
      // section host-neutral; the Codex skill and runtime MCP brief carry the
      // Codex-only hosted-tool disclosure.
      const sharedInstructions = { enforced: true };
      for (const file of codexInstructionTargets()) {
        const path = join(repoRoot, file);
        if (
          writeIfChanged(
            path,
            spliceSection(read(path) ?? '', instructionsSection(workflow, sharedInstructions)),
          )
        )
          written.push(file);
      }

      const codexConfig = mergeCodexConfig(read(join(repoRoot, CODEX_CONFIG)), launch(entry, 'mcp'));
      if (codexConfig !== undefined && writeIfChanged(join(repoRoot, CODEX_CONFIG), codexConfig)) {
        written.push(CODEX_CONFIG);
      }
      const codexHooks = mergeCodexHooks(
        read(join(repoRoot, CODEX_HOOKS)),
        hookCommand(entry, 'codex'),
      );
      if (codexHooks !== undefined && writeIfChanged(join(repoRoot, CODEX_HOOKS), codexHooks)) {
        written.push(CODEX_HOOKS);
      }
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
      `\n  \`flow-code\` is not on your PATH, so the generated host config points at this checkout directly.\n` +
        '  Install it globally and re-run `flow-code connect` if you intend to commit that file.',
    );
  }
  console.log(`\n  ${whatYouGet(host)}`);
  console.log('\n  Start a new agent session to pick up the change, then watch with `flow-code watch`.');
}
