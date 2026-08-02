/**
 * Shell-command classification for the interception check.
 *
 * Honest limit (see design.md): this is a guardrail against a well-intentioned
 * agent, not a sandbox against a hostile one — `eval`, exotic quoting, or
 * writing-then-running a script can defeat string inspection. The env-scoped
 * pushurl block underneath is the defense in depth.
 */
/** Git subcommands that never mutate the repository, its refs, or a remote. */
const GIT_READ_SUBCOMMANDS = new Set([
    'status',
    'log',
    'diff',
    'show',
    'rev-parse',
    'rev-list',
    'ls-files',
    'ls-tree',
    'cat-file',
    'blame',
    'describe',
    'shortlog',
    'grep',
    'merge-base',
    'name-rev',
    'show-ref',
    'for-each-ref',
    'count-objects',
    'cherry',
    'var',
    'version',
    'help',
    'check-ignore',
    'diff-tree',
    'diff-index',
    'diff-files',
]);
/**
 * Subcommands with both read and write forms: classified read only when their
 * arguments match a known read-only form; anything ambiguous counts as write.
 */
function classifyDualUseSubcommand(sub, args) {
    switch (sub) {
        case 'branch': {
            const readFlags = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current']);
            return args.every((a) => readFlags.has(a)) ? 'git-read' : 'git-write';
        }
        case 'tag':
            if (args.length === 0)
                return 'git-read';
            return args[0] === '-l' || args[0] === '--list' || args[0] === '--contains'
                ? 'git-read'
                : 'git-write';
        case 'remote':
            if (args.length === 0 || args[0] === '-v')
                return 'git-read';
            return args[0] === 'show' || args[0] === 'get-url' ? 'git-read' : 'git-write';
        case 'stash':
            return args[0] === 'list' || args[0] === 'show' ? 'git-read' : 'git-write';
        case 'worktree':
            return args[0] === 'list' ? 'git-read' : 'git-write';
        case 'config':
            return args.some((a) => a === '--get' || a === '--get-all' || a === '--list' || a === '-l')
                ? 'git-read'
                : 'git-write';
        case 'reflog':
            return args.length === 0 || args[0] === 'show' ? 'git-read' : 'git-write';
        case 'notes':
            return args[0] === 'show' || args[0] === 'list' ? 'git-read' : 'git-write';
        default:
            return 'git-write';
    }
}
const DUAL_USE = new Set([
    'branch',
    'tag',
    'remote',
    'stash',
    'worktree',
    'config',
    'reflog',
    'notes',
]);
/** Git global options that consume a following value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
/**
 * Tokenize one command segment into words, respecting single/double quotes.
 * Quote characters are stripped; escapes are handled naively.
 */
export function tokenize(segment) {
    const words = [];
    let current = '';
    let quote = null;
    let started = false;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
                current += segment[++i];
            }
            else {
                current += ch;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            started = true;
            continue;
        }
        if (ch === '\\' && i + 1 < segment.length) {
            current += segment[++i];
            started = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started || current.length > 0)
                words.push(current);
            current = '';
            started = false;
            continue;
        }
        current += ch;
        started = true;
    }
    if (started || current.length > 0)
        words.push(current);
    return words;
}
/**
 * Split a shell command into simple-command segments: on `&&`, `||`, `;`,
 * `|`, `&`, and newlines, plus the contents of `$(...)` and backticks
 * (which execute even inside double quotes).
 */
export function splitSegments(command) {
    const segments = [];
    let current = '';
    let quote = null;
    const push = () => {
        const t = current.trim();
        if (t.length > 0)
            segments.push(t);
        current = '';
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            current += ch;
            continue;
        }
        // Command substitution executes regardless of double quotes.
        if (ch === '$' && command[i + 1] === '(') {
            let depth = 1;
            let j = i + 2;
            let inner = '';
            while (j < command.length && depth > 0) {
                if (command[j] === '(')
                    depth++;
                else if (command[j] === ')')
                    depth--;
                if (depth > 0)
                    inner += command[j];
                j++;
            }
            segments.push(...splitSegments(inner));
            i = j - 1;
            continue;
        }
        if (ch === '`') {
            let j = i + 1;
            let inner = '';
            while (j < command.length && command[j] !== '`')
                inner += command[j++];
            segments.push(...splitSegments(inner));
            i = j;
            continue;
        }
        if (quote === '"') {
            if (ch === '"')
                quote = null;
            current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '\n' || ch === ';') {
            push();
            continue;
        }
        if ((ch === '&' || ch === '|')) {
            push();
            if (command[i + 1] === ch)
                i++;
            continue;
        }
        current += ch;
    }
    push();
    return segments;
}
const WRAPPERS = new Set(['env', 'command', 'nohup', 'time']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
function classifySegment(segment) {
    const words = tokenize(segment);
    let i = 0;
    // Skip leading env assignments and simple wrappers.
    while (i < words.length) {
        const w = words[i];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
            i++;
            continue;
        }
        if (WRAPPERS.has(w)) {
            i++;
            continue;
        }
        if (w === 'timeout' && i + 1 < words.length) {
            i += 2;
            continue;
        }
        break;
    }
    const cmd = words[i];
    if (cmd === undefined)
        return [{ text: segment, kind: 'non-git' }];
    // Recurse into `sh -c '<command>'`.
    if (SHELLS.has(cmd)) {
        const cIndex = words.indexOf('-c', i + 1);
        const inner = cIndex >= 0 ? words[cIndex + 1] : undefined;
        if (inner !== undefined)
            return classifyCommand(inner);
        return [{ text: segment, kind: 'non-git' }];
    }
    if (cmd !== 'git')
        return [{ text: segment, kind: 'non-git' }];
    // Skip git global options to find the subcommand.
    let j = i + 1;
    while (j < words.length) {
        const w = words[j];
        if (GIT_VALUE_OPTIONS.has(w)) {
            j += 2;
            continue;
        }
        if (w.startsWith('-')) {
            j++;
            continue;
        }
        break;
    }
    const sub = words[j];
    if (sub === undefined)
        return [{ text: segment, kind: 'git-read' }];
    const args = words.slice(j + 1);
    if (GIT_READ_SUBCOMMANDS.has(sub))
        return [{ text: segment, kind: 'git-read' }];
    if (DUAL_USE.has(sub))
        return [{ text: segment, kind: classifyDualUseSubcommand(sub, args) }];
    // Unknown or mutating subcommand (push, commit, merge, reset, fetch, …): write.
    return [{ text: segment, kind: 'git-write' }];
}
/** Classify every simple-command segment of a shell command string. */
export function classifyCommand(command) {
    return splitSegments(command).flatMap((s) => classifySegment(s));
}
//# sourceMappingURL=gitCommands.js.map