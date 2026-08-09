/**
 * Whether the startup splash plays for this invocation: skipped by `--no-splash`
 * or `FLOW_CODE_NO_SPLASH` (any truthy value), otherwise on. A bare `run`/`watch`
 * with a TTY is the only path that would have shown it, but the decision is
 * computed here so it stays a tiny, testable unit.
 */
export function splashEnabled(args: string[], env: NodeJS.ProcessEnv): boolean {
  if (args.includes('--no-splash')) return false;
  const raw = env.FLOW_CODE_NO_SPLASH;
  if (raw === undefined || raw === '') return true;
  return !/^(1|true|yes|on)$/i.test(raw);
}
