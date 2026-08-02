/**
 * The capability vocabulary. Deliberately closed: there is no network
 * capability in v1 — network-capable tools are unavailable to every session.
 */
export declare const CAPABILITIES: readonly ["read", "edit", "exec", "git-read", "git-write"];
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilitySet = ReadonlySet<Capability>;
export declare function capabilitySet(...caps: Capability[]): CapabilitySet;
