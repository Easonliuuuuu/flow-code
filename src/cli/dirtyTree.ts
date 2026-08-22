import { dirtyEntries, stashAll } from '../git/ops.js';
import { selectFromList } from '../init/SelectList.js';
import { fail } from './context.js';

/** How many paths the listing shows before it starts counting instead. */
const MAX_LISTED = 10;

export type DirtyTreeChoice = 'stash' | 'continue' | 'cancel';

export interface DirtyTreeResolution {
  /**
   * Whether the run must snapshot the working tree as its baseline instead of
   * diffing against HEAD — true only when the user chose to keep their changes
   * in place, which is what `--allow-dirty` does without asking.
   */
  allowDirty: boolean;
  /** Printed once the run is over, when the user's own work is sitting in a stash. */
  restoreNotice?: string;
}

/** The shape of `selectFromList` this needs — narrowed so a test can inject a fake without a real TTY. */
type DirtyPicker = (
  items: { label: string; value: DirtyTreeChoice }[],
  opts: { prompt: string },
) => Promise<DirtyTreeChoice | undefined>;

/**
 * The uncommitted paths, as a listing. Shown before the choice rather than
 * after it: "stash them" is only an informed answer if you can see that the
 * `them` includes the workflow file you scaffolded a minute ago.
 */
export function formatDirtyListing(entries: string[]): string {
  const shown = entries.slice(0, MAX_LISTED);
  const rest = entries.length - shown.length;
  return [
    `The working tree has ${entries.length} uncommitted change${entries.length === 1 ? '' : 's'}:`,
    ...shown.map((entry) => `  ${entry}`),
    ...(rest > 0 ? [`  …and ${rest} more`] : []),
  ].join('\n');
}

/**
 * What to do about a dirty working tree, asked rather than refused. Reached
 * only once preflight has already rejected the tree, so `refusal` is that
 * rejection's own wording — reused verbatim when there is no TTY to ask in,
 * which keeps CI seeing exactly the message it has always seen.
 *
 * Stashing leaves `allowDirty` false on purpose: the tree is at HEAD
 * afterwards, so the baseline is HEAD's tree and the approval diff shows the
 * agent's work and nothing else. That is the whole point of offering it.
 */
export async function resolveDirtyTree(
  repoRoot: string,
  refusal: string,
  deps: { pick?: DirtyPicker; now?: () => Date } = {},
): Promise<DirtyTreeResolution> {
  const entries = await dirtyEntries(repoRoot);
  const listing = formatDirtyListing(entries);

  if (!process.stdin.isTTY) {
    console.error(listing);
    fail(refusal);
  }

  const pick = deps.pick ?? selectFromList;
  const choice = await pick(
    [
      { label: 'Stash them — run against a clean HEAD, restore with `git stash pop`', value: 'stash' },
      { label: 'Continue anyway — snapshot them as the run baseline (--allow-dirty)', value: 'continue' },
      { label: 'Cancel', value: 'cancel' },
    ],
    {
      prompt:
        `${listing}\n\n` +
        'Pre-existing changes would be indistinguishable from agent changes in\n' +
        'approval diffs. How should this run start?',
    },
  );

  // Escape and ctrl+c resolve to undefined — the same answer as picking
  // Cancel, and never a silent fallback into running anyway.
  if (choice === undefined || choice === 'cancel') {
    fail('cancelled — the working tree still has uncommitted changes.');
  }
  if (choice === 'continue') return { allowDirty: true };

  const stamp = (deps.now?.() ?? new Date()).toISOString();
  let stashed: string | null;
  try {
    stashed = await stashAll(repoRoot, `flow-code: pre-run stash ${stamp}`);
  } catch (err) {
    fail(`could not stash the working tree: ${err instanceof Error ? err.message : String(err)}`);
  }
  // git saved nothing — whatever `status` reported went away between the two
  // calls. The tree is at HEAD either way, so there is simply nothing to
  // restore afterwards.
  if (stashed === null) return { allowDirty: false };

  const restoreNotice =
    `your pre-run changes are stashed as stash@{0} (${stashed.slice(0, 8)}) — ` +
    'restore them with `git stash pop`.';
  console.log(`flow-code: ${restoreNotice}`);
  return { allowDirty: false, restoreNotice };
}
