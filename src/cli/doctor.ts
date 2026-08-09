import { confirm } from '../init/prompts.js';
import { defaultSkillRoots, discoverSkills } from '../skills/discover.js';
import { skillCompatibilityNotes } from '../skills/report.js';
import { loadWorkflow } from '../workflow/load.js';
import { findOrphanedWorktrees, removeOrphanedWorktrees } from '../worktrees/reconcile.js';
import { repoRootFromCwd } from './context.js';

export async function cmdDoctor(args: string[]): Promise<void> {
  const repoRoot = await repoRootFromCwd();

  const compatibility = skillCompatibilityNotes(discoverSkills(defaultSkillRoots(repoRoot)));
  if (compatibility.length > 0) {
    console.log('flow-code: discovered skills declaring an external dependency:');
    for (const note of compatibility) console.log(note);
    console.log('');
  }

  // Test/Approval-Gate's optional agent step defaults to read-only; a node
  // that widens it is a real trade-off (a "code-review" skill could now
  // edit/exec/git-write), not a mistake — so this warns rather than blocks.
  try {
    const workflow = loadWorkflow(repoRoot);
    const capabilityWarnings = workflow.nodes.flatMap((node) => {
      if (!node.type.hasOptionalAgentStep) return [];
      const caps = (node.config as { capabilities?: string[] }).capabilities ?? [];
      const beyondReadOnly = caps.filter((c) => c !== 'read');
      if (beyondReadOnly.length === 0) return [];
      return [
        `  node \`${node.id}\` (${node.type.id}): capabilities [${caps.join(', ')}] — its optional agent ` +
          `step can ${beyondReadOnly.join('/')}, not just read.`,
      ];
    });
    if (capabilityWarnings.length > 0) {
      console.log("flow-code: optional agent step(s) configured beyond the read-only default:");
      for (const warning of capabilityWarnings) console.log(warning);
      console.log('');
    }
  } catch {
    // No workflow.yaml yet, or it doesn't load — doctor's other checks don't
    // depend on one either, so this one is just skipped rather than failing.
  }

  const orphans = findOrphanedWorktrees(repoRoot);
  if (orphans.length === 0) {
    console.log('flow-code: no orphaned worktrees.');
    return;
  }
  console.log(`flow-code: found ${orphans.length} orphaned worktree(s) from previous runs:`);
  for (const orphan of orphans) {
    console.log(`  ${orphan.dir}  (run ${orphan.runId.slice(0, 8)}, branch ${orphan.branch})`);
  }
  const yes = args.includes('--yes') || (await confirm('Remove them?'));
  if (!yes) {
    console.log('flow-code: leaving them in place. Re-run with --yes to remove.');
    // Explicit rather than relying on the event loop draining naturally: see
    // the comment atop prompts.ts on why these two don't mix reliably.
    process.exit(0);
  }
  const { removed, failed } = await removeOrphanedWorktrees(repoRoot, orphans);
  for (const dir of removed) console.log(`  removed ${dir}`);
  for (const failure of failed) console.log(`  FAILED ${failure.dir}: ${failure.error}`);
  process.exit(0);
}
