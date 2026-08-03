import { displaySkillPath } from './discover.js';
const SOURCE_LABELS = {
    project: 'project',
    user: 'user',
    plugin: 'plugin',
    path: 'path',
};
/** Sources that travel with the repo. The other two are machine-local. */
function isPortable(source) {
    return source === 'project' || source === 'path';
}
/** Lines for `flow-code skills`: identifier, source, description, path. */
export function formatSkillsListing(skills, repoRoot) {
    if (skills.length === 0) {
        return [
            'flow-code: no skills found.',
            '  Looked in this repo\'s .claude/skills/, ~/.claude/skills/, and installed plugin marketplaces.',
        ];
    }
    const lines = [`flow-code: ${skills.length} skill(s) available:`, ''];
    for (const skill of skills) {
        lines.push(`${skill.id}  (${SOURCE_LABELS[skill.source]})`);
        if (skill.description)
            lines.push(`  ${skill.description}`);
        lines.push(`  ${displaySkillPath(skill, repoRoot)}`);
        if (skill.compatibility)
            lines.push(`  requires: ${skill.compatibility}`);
        if (!isPortable(skill.source)) {
            lines.push('  not in this repo — a workflow using it will not load on another checkout');
        }
        lines.push('');
    }
    return lines;
}
/**
 * Warnings for skills resolved outside the repo. The workflow file is checked
 * in but a user-root or plugin skill is not, so the same file will fail to
 * load on a teammate's clone. Reported, never fatal: it is the user's machine
 * and their call.
 */
export function skillPortabilityWarnings(workflow) {
    const warnings = [];
    for (const node of workflow.nodes) {
        for (const skill of node.skills) {
            if (isPortable(skill.source))
                continue;
            warnings.push(`node \`${node.id}\` uses skill \`${skill.id}\` from your ${SOURCE_LABELS[skill.source]} directory, ` +
                `which is not part of this repo — this workflow will not load on another checkout until that skill is available there.`);
        }
    }
    return warnings;
}
/** External dependencies discovered skills declare, for `doctor`. */
export function skillCompatibilityNotes(skills) {
    return skills
        .filter((s) => s.compatibility)
        .map((s) => `  ${s.id}: ${s.compatibility}`);
}
//# sourceMappingURL=report.js.map