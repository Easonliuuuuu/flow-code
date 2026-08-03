import { readFileSync, writeFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { SessionRunner } from '../engine/types.js';
import { confirm, promptText } from './prompts.js';
import { detectTestCommands } from './testDetect.js';
import { discoverTestCommandsWithAgent } from './testDiscoverAgent.js';

export interface TestSetupOptions {
  /**
   * The configured provider's runner, used only for the fallback. Absent when
   * no provider is configured, which skips the fallback rather than failing —
   * `init` still has to finish.
   */
  sessions?: SessionRunner;
  model?: string;
}

/** Writes `commands` into the `test` node's config, preserving the rest of the file (comments included). */
export function writeTestCommands(workflowPath: string, commands: string[]): void {
  const doc = parseDocument(readFileSync(workflowPath, 'utf8'));
  const nodes = doc.get('nodes');
  if (!isSeq(nodes)) return;
  for (const item of nodes.items) {
    if (isMap(item) && item.get('id') === 'test') {
      item.setIn(['config', 'commands'], commands);
    }
  }
  writeFileSync(workflowPath, String(doc));
}

/**
 * The fallback path: heuristics found nothing, or the user wanted none of what
 * they found. Everything proposed here is shown with its evidence and accepted
 * one at a time — nothing is executed to check it, and nothing is written
 * without a yes.
 */
async function offerAgentFallback(
  repoRoot: string,
  chosen: string[],
  opts: TestSetupOptions,
): Promise<void> {
  if (!opts.sessions) {
    console.log(
      '  No provider configured yet, so flow-code cannot search the repo for you — leaving the placeholder in place.',
    );
    return;
  }
  if (!(await confirm('  Have flow-code read the repo and work out the test command(s)?', { defaultAnswer: true }))) {
    return;
  }

  console.log('  Reading the repository…');
  let proposals;
  try {
    proposals = await discoverTestCommandsWithAgent({
      repoRoot,
      sessions: opts.sessions,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  } catch (err) {
    console.log(`  Could not work it out: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (proposals.length === 0) {
    console.log('  Found no test command — fine for a project with nothing to test yet.');
    return;
  }

  console.log(`  Proposed ${proposals.length} test command${proposals.length > 1 ? 's' : ''}:`);
  for (const proposal of proposals) {
    if (proposal.rationale) console.log(`    ${proposal.rationale}`);
    if (await confirm(`  Include \`${proposal.command}\`?`, { defaultAnswer: true })) {
      chosen.push(proposal.command);
    }
  }
}

/**
 * Walks the user through the Test node's command(s) right after scaffolding
 * `.flow-code/workflow.yaml`: shows anything auto-detected (package.json
 * scripts, a Makefile target, pytest/go/cargo) for them to accept or skip,
 * then offers to add more by hand — useful for a second test level
 * (integration/e2e) detection won't have found, or a project with no test
 * command yet, which just leaves the scaffolded placeholder untouched.
 */
export async function runTestSetupWizard(
  repoRoot: string,
  workflowPath: string,
  opts: TestSetupOptions = {},
): Promise<void> {
  console.log('\nflow-code: set up the command(s) the Test node runs.\n');

  // Heuristics first, always: free, instant, offline, and right for the common
  // case. A model is spent only where they actually failed.
  const detected = detectTestCommands(repoRoot);
  const chosen: string[] = [];

  if (detected.length > 0) {
    console.log(`  Detected ${detected.length} possible test command${detected.length > 1 ? 's' : ''}:`);
    for (const command of detected) {
      if (await confirm(`  Include \`${command}\`?`, { defaultAnswer: true })) chosen.push(command);
    }
  } else {
    console.log('  No test command detected by inspection.');
  }

  if (chosen.length === 0) {
    await offerAgentFallback(repoRoot, chosen, opts);
  }

  for (;;) {
    const prompt = chosen.length === 0 ? '  Add a test command?' : '  Add another test command?';
    if (!(await confirm(prompt))) break;
    const command = await promptText('  Command: ');
    if (command) chosen.push(command);
  }

  if (chosen.length === 0) {
    console.log(
      '  Skipped — leaving the placeholder in .flow-code/workflow.yaml; edit `nodes: test: config: commands` whenever you have one.',
    );
    return;
  }

  writeTestCommands(workflowPath, chosen);
  console.log(`  Saved ${chosen.length} test command${chosen.length > 1 ? 's' : ''} to .flow-code/workflow.yaml.`);
}
