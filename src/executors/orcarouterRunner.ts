import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';

export const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';
export const DEFAULT_ORCAROUTER_MODEL = 'openai/gpt-4o-mini';

/** SessionRunner backed by OrcaRouter's OpenAI-compatible chat-completions API. */
export class OrcaRouterSessionRunner extends OpenAiCompatSessionRunner {
  constructor() {
    super({
      providerId: 'orcarouter',
      label: 'OrcaRouter',
      baseUrl: ORCAROUTER_BASE_URL,
      defaultModel: DEFAULT_ORCAROUTER_MODEL,
      // ORCAROUTER_API_KEY_2 is optional: an extra key (on a separate account) to
      // rotate onto if the primary is still rate-limited after retrying.
      apiKeyEnvVars: ['ORCAROUTER_API_KEY', 'ORCAROUTER_API_KEY_2'],
    });
  }
}
