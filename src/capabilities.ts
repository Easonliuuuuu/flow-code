/**
 * The capability vocabulary. Deliberately closed: there is no network
 * capability in v1 — network-capable tools are unavailable to every session.
 */
export const CAPABILITIES = ['read', 'edit', 'exec', 'git-read', 'git-write'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySet = ReadonlySet<Capability>;

export function capabilitySet(...caps: Capability[]): CapabilitySet {
  return new Set(caps);
}
