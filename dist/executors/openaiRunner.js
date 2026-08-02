import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
/** SessionRunner backed by OpenAI's chat-completions API. */
export class OpenAiSessionRunner extends OpenAiCompatSessionRunner {
    constructor() {
        super({
            providerId: 'openai',
            label: 'OpenAI',
            baseUrl: OPENAI_BASE_URL,
            defaultModel: DEFAULT_OPENAI_MODEL,
            // OPENAI_API_KEY_2 is optional: an extra key (on a separate account) to
            // rotate onto if the primary is still rate-limited after retrying.
            apiKeyEnvVars: ['OPENAI_API_KEY', 'OPENAI_API_KEY_2'],
        });
    }
}
//# sourceMappingURL=openaiRunner.js.map