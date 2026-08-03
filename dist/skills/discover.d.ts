/**
 * Where a skill was found. `project` is the repo's own `.claude/skills/`,
 * `user` is `~/.claude/skills/`, `plugin` is an installed marketplace, and
 * `path` is a repo-relative path written directly in the workflow file.
 *
 * The distinction is not cosmetic: only `project` and `path` skills travel
 * with the repo, so the other two are reported as non-portable by preflight.
 */
export type SkillSource = 'project' | 'user' | 'plugin' | 'path';
export interface DiscoveredSkill {
    /** `house-review` for local skills, `plugin:skill` for marketplace ones. */
    id: string;
    description: string;
    /** Frontmatter `compatibility`, when declared — an external dependency. */
    compatibility?: string;
    source: SkillSource;
    /** Absolute path to the SKILL.md. */
    path: string;
    /** The markdown body, with frontmatter stripped. */
    body: string;
}
export interface SkillRoots {
    /** The repo's own `.claude/skills`. */
    project: string;
    /** `~/.claude/skills`. */
    user: string;
    /** `~/.claude/plugins/marketplaces`. */
    plugins: string;
}
export declare function defaultSkillRoots(repoRoot: string, home?: string): SkillRoots;
/**
 * Every discoverable skill, with project shadowing user for unqualified names.
 * Plugin skills carry a `plugin:` prefix, so they neither shadow nor are
 * shadowed by a local skill that happens to share a bare name.
 */
export declare function discoverSkills(roots: SkillRoots): DiscoveredSkill[];
export interface SkillResolution {
    skill?: DiscoveredSkill;
    /** Human-readable list of what was searched, for the failure message. */
    searched: string[];
}
/**
 * Resolve one `skills:` entry, either as a discovered identifier or as a path
 * relative to the repo root. Returns the roots searched either way so an
 * unresolvable entry can say where it looked.
 */
export declare function resolveSkillEntry(entry: string, roots: SkillRoots, repoRoot: string, discovered?: DiscoveredSkill[]): SkillResolution;
/** Repo-relative when the skill lives inside the repo, absolute otherwise. */
export declare function displaySkillPath(skill: DiscoveredSkill, repoRoot: string): string;
