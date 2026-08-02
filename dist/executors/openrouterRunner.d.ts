import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';
export declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export declare const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
/** SessionRunner backed by OpenRouter's OpenAI-compatible chat-completions API. */
export declare class OpenRouterSessionRunner extends OpenAiCompatSessionRunner {
    constructor();
}
