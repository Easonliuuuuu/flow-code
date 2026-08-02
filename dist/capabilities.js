/**
 * The capability vocabulary. Deliberately closed: there is no network
 * capability in v1 — network-capable tools are unavailable to every session.
 */
export const CAPABILITIES = ['read', 'edit', 'exec', 'git-read', 'git-write'];
export function capabilitySet(...caps) {
    return new Set(caps);
}
//# sourceMappingURL=capabilities.js.map