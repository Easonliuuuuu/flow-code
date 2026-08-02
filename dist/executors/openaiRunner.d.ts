import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';
export declare const OPENAI_BASE_URL = "https://api.openai.com/v1";
export declare const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
/** SessionRunner backed by OpenAI's chat-completions API. */
export declare class OpenAiSessionRunner extends OpenAiCompatSessionRunner {
    constructor();
}
