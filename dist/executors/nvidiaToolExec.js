import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/** Text files beyond this size are truncated so a tool result can't blow out context. */
const MAX_READ_BYTES = 100_000;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
function resolveIn(workingDir, path) {
    return path === undefined || path.length === 0 ? workingDir : resolve(workingDir, path);
}
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}
export function readFileTool(workingDir, input) {
    const path = input['path'];
    if (typeof path !== 'string')
        throw new Error('read_file requires a string `path`');
    const raw = readFileSync(resolveIn(workingDir, path), 'utf8');
    return truncate(raw, MAX_READ_BYTES);
}
export function listDirTool(workingDir, input) {
    const path = input['path'];
    const target = resolveIn(workingDir, typeof path === 'string' ? path : undefined);
    const entries = readdirSync(target, { withFileTypes: true });
    return entries
        .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        .sort()
        .join('\n');
}
function globToRegExp(pattern) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i++;
                if (pattern[i + 1] === '/')
                    i++;
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else if ('.+^${}()|[]\\'.includes(c)) {
            re += `\\${c}`;
        }
        else {
            re += c;
        }
    }
    return new RegExp(`^${re}$`);
}
function walk(dir, root, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules')
            continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, root, out);
        }
        else {
            out.push(relative(root, full));
        }
    }
}
export function globTool(workingDir, input) {
    const pattern = input['pattern'];
    if (typeof pattern !== 'string')
        throw new Error('glob requires a string `pattern`');
    const regex = globToRegExp(pattern);
    const files = [];
    walk(workingDir, workingDir, files);
    const matched = files.filter((f) => regex.test(f));
    return matched.length > 0 ? matched.sort().join('\n') : '(no matches)';
}
export function grepTool(workingDir, input) {
    const pattern = input['pattern'];
    if (typeof pattern !== 'string')
        throw new Error('grep requires a string `pattern`');
    const subPath = input['path'];
    const root = resolveIn(workingDir, typeof subPath === 'string' ? subPath : undefined);
    const regex = new RegExp(pattern);
    const files = [];
    walk(root, workingDir, files);
    const matches = [];
    for (const rel of files) {
        const full = join(workingDir, rel);
        let content;
        try {
            content = readFileSync(full, 'utf8');
        }
        catch {
            continue; // binary or unreadable; skip
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]))
                matches.push(`${rel}:${i + 1}: ${lines[i]}`);
        }
        if (matches.length > 500)
            break;
    }
    return truncate(matches.length > 0 ? matches.join('\n') : '(no matches)', MAX_TOOL_OUTPUT_CHARS);
}
export function writeFileTool(workingDir, input) {
    const path = input['path'];
    const content = input['content'];
    if (typeof path !== 'string')
        throw new Error('write_file requires a string `path`');
    if (typeof content !== 'string')
        throw new Error('write_file requires a string `content`');
    const target = resolveIn(workingDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return `wrote ${content.length} bytes to ${path}`;
}
export function editFileTool(workingDir, input) {
    const path = input['path'];
    const oldString = input['old_string'];
    const newString = input['new_string'];
    if (typeof path !== 'string')
        throw new Error('edit_file requires a string `path`');
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
        throw new Error('edit_file requires string `old_string` and `new_string`');
    }
    const target = resolveIn(workingDir, path);
    const content = readFileSync(target, 'utf8');
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0)
        throw new Error(`old_string not found in ${path}`);
    if (occurrences > 1)
        throw new Error(`old_string is not unique in ${path} (${occurrences} matches)`);
    writeFileSync(target, content.replace(oldString, newString));
    return `edited ${path}`;
}
export async function runShellTool(workingDir, input, extraEnv = {}, signal) {
    const command = input['command'];
    if (typeof command !== 'string')
        throw new Error('run_shell requires a string `command`');
    try {
        const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
            cwd: workingDir,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, ...extraEnv },
            ...(signal ? { signal } : {}),
        });
        return { output: truncate(stdout + stderr, MAX_TOOL_OUTPUT_CHARS), exitStatus: 0 };
    }
    catch (err) {
        const e = err;
        const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        return { output: truncate(output, MAX_TOOL_OUTPUT_CHARS), exitStatus: typeof e.code === 'number' ? e.code : 1 };
    }
}
//# sourceMappingURL=nvidiaToolExec.js.map