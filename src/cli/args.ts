import type { NotificationSettings } from '../workflow/schema.js';
import type { ResolvedNotificationConfig } from '../notify/types.js';

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

function isTruthyEnv(val: string | undefined): boolean {
  if (val === undefined || val === '') return false;
  return /^(1|true|yes|on)$/i.test(val.trim());
}

/**
 * Resolves active notification channels (bell, desktop popup) following the
 * 3-tier precedence: CLI flags > Environment variables > workflow settings > defaults.
 */
export function resolveNotificationConfig(
  args: string[],
  env: NodeJS.ProcessEnv,
  settings?: NotificationSettings,
): ResolvedNotificationConfig {
  const noAlertsArg = args.includes('--no-alerts') || args.includes('--silent-alerts');
  const noNotifyArg = noAlertsArg || args.includes('--no-notify');
  const noBellArg = noAlertsArg || args.includes('--no-bell');

  const noAlertsEnv = isTruthyEnv(env.FLOW_CODE_NO_ALERTS);
  const noNotifyEnv = noAlertsEnv || isTruthyEnv(env.FLOW_CODE_NO_NOTIFY);
  const noBellEnv = noAlertsEnv || isTruthyEnv(env.FLOW_CODE_NO_BELL);
  const isCi = env.CI !== undefined && env.CI !== '' && !/^(0|false|no|off)$/i.test(env.CI.trim());

  let bell = settings?.bell ?? true;
  let desktop = settings?.desktop ?? true;

  // CI suppresses desktop notifications by default
  if (isCi) {
    desktop = false;
  }

  // Env overrides
  if (noBellEnv) bell = false;
  if (noNotifyEnv) desktop = false;

  // CLI flags have the highest precedence
  if (noBellArg) bell = false;
  if (noNotifyArg) desktop = false;

  return { bell, desktop };
}
