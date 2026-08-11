/**
 * What was actually in force while a run executed.
 *
 * flow-code used to have one answer to "is this run enforced?" because it had
 * one producer of run-state: its own engine, which spawns the session and so
 * controls the process, the tool policy, and the bill. A run reported from a
 * session flow-code did not spawn has strictly less than that — but not
 * nothing, and how much less depends on what the host exposes. A boolean
 * would have to round that to one of the two extremes, and both roundings
 * mislead: `false` discards enforcement a host really did apply, `true`
 * claims process-level guards nobody held.
 *
 * So a run records its tier *and* enumerates what that tier does not provide,
 * rather than leaving a consumer to derive the second from the first. The
 * derivation lives here, in one table, so the viewer, the status line, and
 * anything later cannot each grow their own version of it.
 */

/**
 * Guarantees an engine-driven run provides, named individually because a
 * middle tier holds some and not others.
 */
export const GUARANTEES = [
  'capability-enforcement',
  'process-guards',
  'per-node-model',
  'token-accounting',
  'loopback-routing',
] as const;

export type Guarantee = (typeof GUARANTEES)[number];

/** One line each, for a viewer that has to say what a run is missing. */
export const GUARANTEE_LABELS: Record<Guarantee, string> = {
  'capability-enforcement': "tool calls outside a node's capability set are blocked",
  'process-guards': 'the session runs under a controlled cwd, environment, and push url',
  'per-node-model': 'each node runs on the model its config selects',
  'token-accounting': 'token spend is counted per node and checked against budgets',
  'loopback-routing': 'a failing node is routed back to its loop-back target automatically',
};

/**
 * `engine` — flow-code spawned the session and executed the graph.
 * `hooks` — a host session with flow-code's enforcement layer verified active:
 *   the tool policy and the git interception apply, nothing process-level does.
 * `reported` — a host session reporting its own progress, enforcing nothing.
 *
 * Ordered strongest-first, which is what {@link weakestTier} relies on.
 */
export const ENFORCEMENT_TIERS = ['engine', 'hooks', 'reported'] as const;

export type EnforcementTier = (typeof ENFORCEMENT_TIERS)[number];

/** How transitions reached run-state. Recorded so two surfaces stay tellable apart. */
export const REPORTING_SURFACES = ['engine', 'mcp', 'cli'] as const;

export type ReportingSurface = (typeof REPORTING_SURFACES)[number];

/**
 * What each tier cannot deliver.
 *
 * `hooks` keeps capability enforcement because a host that exposes a
 * tool-interception point can apply the same compiled policy the engine
 * applies. It loses everything that depends on having *started* the process,
 * and it loses loop-back routing for a different reason: a hook can decline to
 * end a turn, which is steering, but it cannot make a session run a node.
 */
const ABSENT_BY_TIER: Record<EnforcementTier, readonly Guarantee[]> = {
  engine: [],
  hooks: ['process-guards', 'per-node-model', 'token-accounting', 'loopback-routing'],
  reported: GUARANTEES,
};

/** Guarantees a run at `tier` does not provide. */
export function absentGuarantees(tier: EnforcementTier): Guarantee[] {
  return [...ABSENT_BY_TIER[tier]];
}

/**
 * The enforcement a run ran under, recorded in its own document.
 *
 * `absent` is stored rather than recomputed on read so that a run stays
 * readable against a future build whose tier table has moved: what a run
 * claims about itself should not change because the code reading it changed.
 */
export interface RunEnforcement {
  tier: EnforcementTier;
  surface: ReportingSurface;
  /** Enumerated, never implied — see {@link absentGuarantees}. */
  absent: Guarantee[];
  /** Present once a run has lost enforcement it opened with. */
  downgrades?: TierDowngrade[];
}

/**
 * A run losing enforcement part-way through.
 *
 * Recorded with its point rather than applied by rewriting `tier`, because the
 * two facts are different: the earlier part of the run really did have the
 * stronger guarantees, and erasing that would misreport it in the other
 * direction. What a consumer wants is the weakest tier anything in the run ran
 * under — see {@link effectiveTier} — plus the ability to say when it changed.
 */
export interface TierDowngrade {
  from: EnforcementTier;
  to: EnforcementTier;
  at: string;
  reason: string;
}

/**
 * The tier a run should be *reported* at: the weakest it ever held.
 *
 * A run is only as trustworthy as its weakest moment, because nothing in the
 * document says which node's work happened under which tier. Presenting it at
 * the tier it opened with would credit the whole run with guarantees that
 * stopped part-way through.
 */
export function effectiveTier(enforcement: RunEnforcement | undefined): EnforcementTier {
  if (!enforcement) return 'engine';
  return (enforcement.downgrades ?? []).reduce(
    (weakest, d) => weakestTier(weakest, d.to),
    enforcement.tier,
  );
}

export function enforcementOf(tier: EnforcementTier, surface: ReportingSurface): RunEnforcement {
  return { tier, surface, absent: absentGuarantees(tier) };
}

/** What `flow-code run` records: everything in force, nothing absent. */
export function engineEnforcement(): RunEnforcement {
  return enforcementOf('engine', 'engine');
}

/** How each tier is named on screen. */
export const TIER_LABELS: Record<EnforcementTier, string> = {
  engine: 'engine',
  hooks: 'host session',
  reported: 'self-reported',
};

/**
 * One line saying what a run at this tier is, and what was not in force while
 * it ran — undefined for `engine`, which is the tier every run had before
 * there were tiers and needs no disclaimer.
 *
 * Built from the same table the run records rather than written out per tier,
 * so a guarantee added here cannot go unmentioned in the place a user reads.
 */
export function tierDisclosure(tier: EnforcementTier): string | undefined {
  if (tier === 'engine') return undefined;
  const missing = absentGuarantees(tier).map((g) => GUARANTEE_LABELS[g]);
  const what =
    tier === 'reported'
      ? 'self-reported: transitions were checked against the graph; the work behind them was not'
      : 'host session: flow-code enforced tool policy inside a session it did not start';
  return `${what}. Not in force — ${missing.join('; ')}.`;
}

/**
 * The weaker of two tiers. Used when a run's tier moved while it ran: a run
 * gets reported at the weakest enforcement it ever had, because that is the
 * only claim every part of it can support.
 */
export function weakestTier(a: EnforcementTier, b: EnforcementTier): EnforcementTier {
  return ENFORCEMENT_TIERS.indexOf(a) >= ENFORCEMENT_TIERS.indexOf(b) ? a : b;
}
