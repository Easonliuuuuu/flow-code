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
/**
 * `nodeConfig ?? workflowSettingsModel ?? providerDefaultModel`, reported
 * with which of the three actually supplied it. When none do, `model` is
 * `undefined` and `origin` is `'provider'` — the level that would have
 * supplied it had a provider default been configured.
 */
export declare function resolveNodeModel(nodeConfig: unknown, workflowSettingsModel: string | undefined, providerDefaultModel: string | undefined): ResolvedModel;
