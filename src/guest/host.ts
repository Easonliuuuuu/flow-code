/** Hosts that can run a flow-code companion session. */
export type CompanionHost = 'claude' | 'codex';

/** Limitations that are material to how a companion run should be read. */
export type CompanionLimitation = 'hosted-tools-unobserved';

/** What a host can report about its companion surface. */
export interface HostSurface {
  host: CompanionHost;
  limitations: CompanionLimitation[];
}

export const CODEX_LIMITATIONS: CompanionLimitation[] = ['hosted-tools-unobserved'];

export function hostSurface(host: CompanionHost | undefined): HostSurface | undefined {
  if (host === undefined) return undefined;
  return {
    host,
    limitations: host === 'codex' ? [...CODEX_LIMITATIONS] : [],
  };
}
