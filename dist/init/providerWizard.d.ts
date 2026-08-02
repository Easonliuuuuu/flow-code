import { type ProviderId } from '../engine/providers.js';
/**
 * Walks the user through picking a provider and model for the whole project,
 * then saves the choice (and any API key entered) to
 * `.flow-code/credentials.json`. Returns undefined if the user cancels at
 * any point — nothing is saved in that case.
 */
export declare function runProviderWizard(repoRoot: string): Promise<{
    provider: ProviderId;
    model: string;
} | undefined>;
