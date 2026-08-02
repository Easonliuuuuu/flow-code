/**
 * Best-effort scan for how this project runs its tests, so `flow-code init`
 * can suggest commands instead of leaving a placeholder. Cheap, file-presence
 * based; never runs anything. A project with none of these markers (a brand
 * new repo, or a stack we don't recognize) just gets an empty list back —
 * the caller treats that as "nothing to suggest," not an error.
 */
export declare function detectTestCommands(repoRoot: string): string[];
