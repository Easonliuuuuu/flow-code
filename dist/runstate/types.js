export const NODE_STATUSES = ['idle', 'running', 'waiting', 'done', 'error', 'skipped'];
/** Every token a usage record accounts for — what a budget is measured against. */
export function sumTokens(usage) {
    return usage ? usage.input + usage.cached + usage.output : 0;
}
//# sourceMappingURL=types.js.map