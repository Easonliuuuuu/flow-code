import { type ProviderId } from './providers.js';
export declare const CREDENTIALS_RELATIVE_PATH: string;
export interface StoredCredentials {
    provider: ProviderId;
    /** Absent for 'claude' — it relies on the Claude Agent SDK's own credential resolution. */
    apiKey?: string;
    /** Optional second key (a separate account) to rotate onto under sustained rate-limiting. */
    apiKey2?: string;
    /** The model chosen for this provider — backs every agent-driven node in the project. */
    model: string;
}
export declare function credentialsPath(repoRoot: string): string;
/**
 * Returns undefined on anything unreadable/malformed/missing `model` — the
 * caller re-prompts (via `flow-code init`) rather than crashing. A missing
 * `model` also doubles as the migration path for credentials files written by
 * the pre-project-wide-provider shape (`nvidiaApiKey`/`nvidiaApiKey2`, no
 * `model`): they simply fail this check like any other malformed file.
 */
export declare function loadCredentials(repoRoot: string): StoredCredentials | undefined;
/** Written mode 0600: it's a plaintext API key. */
export declare function saveCredentials(repoRoot: string, creds: StoredCredentials): void;
