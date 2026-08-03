import type { Workflow } from '../workflow/load.js';
import { type DiscoveredSkill } from './discover.js';
/** Lines for `flow-code skills`: identifier, source, description, path. */
export declare function formatSkillsListing(skills: DiscoveredSkill[], repoRoot: string): string[];
/**
 * Warnings for skills resolved outside the repo. The workflow file is checked
 * in but a user-root or plugin skill is not, so the same file will fail to
 * load on a teammate's clone. Reported, never fatal: it is the user's machine
 * and their call.
 */
export declare function skillPortabilityWarnings(workflow: Workflow): string[];
/** External dependencies discovered skills declare, for `doctor`. */
export declare function skillCompatibilityNotes(skills: DiscoveredSkill[]): string[];
