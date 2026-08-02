import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

/** SessionRunner backed by OpenRouter's OpenAI-compatible chat-completions API. */
export class OpenRouterSessionRunner extends OpenAiCompatSessionRunner {
  constructor() {
    super({
      providerId: 'openrouter',
      label: 'OpenRouter',
      baseUrl: OPENROUTER_BASE_URL,
      defaultModel: DEFAULT_OPENROUTER_MODEL,
      apiKeyEnvVars: ['OPENROUTER_API_KEY'],
    });
  }
}
