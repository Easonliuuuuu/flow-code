function modelFieldOf(config) {
    if (typeof config !== 'object' || config === null)
        return undefined;
    const model = config.model;
    return typeof model === 'string' ? model : undefined;
}
/**
 * `nodeConfig ?? workflowSettingsModel ?? providerDefaultModel`, reported
 * with which of the three actually supplied it. When none do, `model` is
 * `undefined` and `origin` is `'provider'` — the level that would have
 * supplied it had a provider default been configured.
 */
export function resolveNodeModel(nodeConfig, workflowSettingsModel, providerDefaultModel) {
    const node = modelFieldOf(nodeConfig);
    if (node !== undefined)
        return { model: node, origin: 'node' };
    if (workflowSettingsModel !== undefined)
        return { model: workflowSettingsModel, origin: 'settings' };
    return { model: providerDefaultModel, origin: 'provider' };
}
//# sourceMappingURL=modelResolution.js.map