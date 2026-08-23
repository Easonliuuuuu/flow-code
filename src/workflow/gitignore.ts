import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the guard lives, relative to the repository root. */
export const FLOW_CODE_GITIGNORE_RELATIVE_PATH = join('.flow-code', '.gitignore');

/**
 * The nested ignore file written into `.flow-code/`.
 *
 * `.flow-code/` holds three very different kinds of thing, and only one of
 * them belongs in version control:
 *
 *  - `workflow.yaml` — the graph. Reviewable, diffable, and the whole point of
 *    a workflow-as-code tool. Committed.
 *  - `credentials.json` — a plaintext API key. Written mode 0600, and never
 *    committed. The provider wizard used to *say* this file was gitignored
 *    while nothing outside this repository actually ignored it.
 *  - `runs/*.json`, `specs/*.md` — run state, including verbatim transcripts
 *    of every Discuss turn. Local history, not project history, and the most
 *    likely thing in here to contain something a person would not choose to
 *    publish.
 *
 * Deny-by-default with one exception is the only shape that stays correct as
 * new state lands: a future `runs/`-shaped directory is ignored the day it is
 * added rather than the day someone remembers to add a line. `!.gitignore`
 * keeps the guard itself visible, so a reviewer can see the rule that is
 * being applied to everything beside it.
 *
 * This is the mechanism the docs point at, and it deliberately overlaps with
 * `ensureGitExclude`, which writes the same paths into `.git/info/exclude`.
 * The two differ in reach, and that difference is the reason for this file:
 * `.git/info/exclude` is per-clone and never travels, so it protects only the
 * machine that ran `init`. A colleague who clones the repo and runs before
 * ever running `init` has no exclude entries at all, and their first
 * `git add -A` picks up a transcript. A committed `.gitignore` protects the
 * clone that has not run anything yet, which is precisely the one at risk.
 */
export const FLOW_CODE_GITIGNORE = `# Written by flow-code. Everything in this directory is local run state or a
# secret, except the workflow itself — which is meant to be reviewed and
# committed like any other source file.
#
# Deliberately deny-by-default: run records under runs/ contain verbatim
# transcripts of every Discuss turn, and credentials.json is a plaintext API
# key. Add a \`!\` line if you have something here you do want tracked.
*
!.gitignore
!workflow.yaml
`;

/**
 * Ensures `.flow-code/` exists and carries its ignore file, creating both if
 * they are missing. Called from every path that creates the directory, so the
 * guard is in place before anything sensitive is written beside it rather than
 * at some later point that depends on which command ran first.
 *
 * An existing file is left exactly as it is: once it is in the repository it
 * belongs to the project, and someone who added a `!` line for their own run
 * artefacts should not have it silently reverted on the next `init`.
 */
export function ensureFlowCodeGitignore(repoRoot: string): void {
  const dir = join(repoRoot, '.flow-code');
  mkdirSync(dir, { recursive: true });

  const path = join(dir, '.gitignore');
  if (existsSync(path)) return;
  writeFileSync(path, FLOW_CODE_GITIGNORE);
}
