/**
 * Where a node's effective model came from: its own `config.model`, the
 * workflow's `settings.model`, or the provider's default (the model chosen
 * at `flow-code init`, stored in credentials). Kept separate from the
 * engine's `nodeModel()` (`src/executors/helpers.ts`), which resolves the
 * same fallback chain for execution but has no reason to report provenance.
 */
export type ModelOrigin = 'node' | 'settings' | 'provider';

export interface ResolvedModel {
  model: string | undefined;
  origin: ModelOrigin;
}

function modelFieldOf(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const model = (config as { model?: unknown }).model;
  return typeof model === 'string' ? model : undefined;
}

/**
 * `nodeConfig ?? workflowSettingsModel ?? providerDefaultModel`, reported
 * with which of the three actually supplied it. When none do, `model` is
 * `undefined` and `origin` is `'provider'` — the level that would have
 * supplied it had a provider default been configured.
 */
export function resolveNodeModel(
  nodeConfig: unknown,
  workflowSettingsModel: string | undefined,
  providerDefaultModel: string | undefined,
): ResolvedModel {
  const node = modelFieldOf(nodeConfig);
  if (node !== undefined) return { model: node, origin: 'node' };
  if (workflowSettingsModel !== undefined) return { model: workflowSettingsModel, origin: 'settings' };
  return { model: providerDefaultModel, origin: 'provider' };
}
