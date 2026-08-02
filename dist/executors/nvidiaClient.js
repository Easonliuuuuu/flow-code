import { callOpenAiCompatChat, OpenAiCompatApiError, } from './openaiCompatClient.js';
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_MODEL = 'meta/llama-3.1-70b-instruct';
/** Thrown on a non-2xx response or a malformed body; carries enough detail to log usefully. */
export class NvidiaApiError extends OpenAiCompatApiError {
}
export function nvidiaApiKey() {
    return process.env['NVIDIA_API_KEY'];
}
export async function callNvidiaChat(opts) {
    const { apiKey, ...rest } = opts;
    try {
        return await callOpenAiCompatChat({ baseUrl: NVIDIA_BASE_URL, apiKeys: [apiKey], ...rest });
    }
    catch (err) {
        if (err instanceof OpenAiCompatApiError)
            throw new NvidiaApiError(err.message);
        throw err;
    }
}
//# sourceMappingURL=nvidiaClient.js.map