import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
export function defaultSkillRoots(repoRoot, home = homedir()) {
    return {
        project: join(repoRoot, '.claude', 'skills'),
        user: join(home, '.claude', 'skills'),
        plugins: join(home, '.claude', 'plugins', 'marketplaces'),
    };
}
/**
 * Split a `---`-delimited YAML frontmatter block off the front of a document.
 * A file with no frontmatter is still a usable skill — it just has no
 * description — so this never throws.
 */
function splitFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!match)
        return { meta: {}, body: text };
    let meta = {};
    try {
        const parsed = parseYaml(match[1]);
        if (parsed !== null && typeof parsed === 'object')
            meta = parsed;
    }
    catch {
        // Malformed frontmatter costs the description, not the skill.
    }
    return { meta, body: text.slice(match[0].length) };
}
function readSkillDir(dir, id, source) {
    const path = join(dir, 'SKILL.md');
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        // A directory without a SKILL.md is not a skill; ignore it silently.
        return undefined;
    }
    const { meta, body } = splitFrontmatter(text);
    return {
        id,
        description: typeof meta.description === 'string' ? meta.description : '',
        ...(typeof meta.compatibility === 'string' ? { compatibility: meta.compatibility } : {}),
        source,
        path,
        body: body.trim(),
    };
}
function subdirectories(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name)
            .filter((name) => !name.startsWith('.'))
            .sort();
    }
    catch {
        return [];
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** Every skill directly under a `skills/` root, keyed by its directory name. */
function skillsInRoot(root, source) {
    const found = [];
    for (const name of subdirectories(root)) {
        const skill = readSkillDir(join(root, name), name, source);
        if (skill)
            found.push(skill);
    }
    return found;
}
/**
 * Plugin skills, namespaced `plugin:skill`. Marketplaces nest inconsistently —
 * some expose `<marketplace>/skills/`, others `<marketplace>/<plugin>/skills/` —
 * so both shapes are searched, and the directory holding `skills/` names the
 * namespace either way.
 */
function pluginSkills(pluginsRoot) {
    const found = [];
    const visit = (dir, namespace) => {
        const skillsDir = join(dir, 'skills');
        if (!isDirectory(skillsDir))
            return;
        for (const skill of skillsInRoot(skillsDir, 'plugin')) {
            found.push({ ...skill, id: `${namespace}:${skill.id}` });
        }
    };
    for (const marketplace of subdirectories(pluginsRoot)) {
        const marketplaceDir = join(pluginsRoot, marketplace);
        visit(marketplaceDir, marketplace);
        for (const plugin of subdirectories(marketplaceDir)) {
            if (plugin === 'skills')
                continue;
            visit(join(marketplaceDir, plugin), plugin);
        }
    }
    return found;
}
/**
 * Every discoverable skill, with project shadowing user for unqualified names.
 * Plugin skills carry a `plugin:` prefix, so they neither shadow nor are
 * shadowed by a local skill that happens to share a bare name.
 */
export function discoverSkills(roots) {
    const byId = new Map();
    // Reverse precedence order: later writes win, so project lands last.
    for (const skill of skillsInRoot(roots.user, 'user'))
        byId.set(skill.id, skill);
    for (const skill of skillsInRoot(roots.project, 'project'))
        byId.set(skill.id, skill);
    for (const skill of pluginSkills(roots.plugins))
        byId.set(skill.id, skill);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
/** A `skills:` entry is a path form when it looks like one, not when it resolves. */
function isPathEntry(entry) {
    return entry.startsWith('.') || entry.startsWith('/') || entry.includes('/');
}
/**
 * Resolve one `skills:` entry, either as a discovered identifier or as a path
 * relative to the repo root. Returns the roots searched either way so an
 * unresolvable entry can say where it looked.
 */
export function resolveSkillEntry(entry, roots, repoRoot, discovered) {
    if (isPathEntry(entry)) {
        const dir = isAbsolute(entry) ? entry : resolve(repoRoot, entry);
        const skill = readSkillDir(dir, entry, 'path');
        return skill ? { skill, searched: [dir] } : { searched: [join(dir, 'SKILL.md')] };
    }
    const all = discovered ?? discoverSkills(roots);
    const skill = all.find((s) => s.id === entry);
    return skill
        ? { skill, searched: [] }
        : { searched: [roots.project, roots.user, `${roots.plugins} (as \`plugin:${entry}\`)`] };
}
/** Repo-relative when the skill lives inside the repo, absolute otherwise. */
export function displaySkillPath(skill, repoRoot) {
    const rel = relative(repoRoot, skill.path);
    return rel.startsWith('..') || isAbsolute(rel) ? skill.path : rel;
}
//# sourceMappingURL=discover.js.map