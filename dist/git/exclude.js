import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Keep run-state and worktrees out of untracked-change detection and diffs. */
export function ensureGitExclude(repoRoot) {
    const excludePath = join(repoRoot, '.git', 'info', 'exclude');
    const wanted = ['.flow-code/runs/', '.flow-code/worktrees/', '.flow-code/credentials.json'];
    let current = '';
    try {
        current = readFileSync(excludePath, 'utf8');
    }
    catch {
        // no exclude file yet
    }
    const missing = wanted.filter((line) => !current.includes(line));
    if (missing.length > 0) {
        mkdirSync(dirname(excludePath), { recursive: true });
        appendFileSync(excludePath, `\n# added by flow-code\n${missing.join('\n')}\n`);
    }
}
//# sourceMappingURL=exclude.js.map