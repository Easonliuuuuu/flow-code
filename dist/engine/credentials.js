import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isProviderId } from './providers.js';
export const CREDENTIALS_RELATIVE_PATH = join('.flow-code', 'credentials.json');
export function credentialsPath(repoRoot) {
    return join(repoRoot, CREDENTIALS_RELATIVE_PATH);
}
/**
 * Returns undefined on anything unreadable/malformed/missing `model` — the
 * caller re-prompts (via `flow-code init`) rather than crashing. A missing
 * `model` also doubles as the migration path for credentials files written by
 * the pre-project-wide-provider shape (`nvidiaApiKey`/`nvidiaApiKey2`, no
 * `model`): they simply fail this check like any other malformed file.
 */
export function loadCredentials(repoRoot) {
    const path = credentialsPath(repoRoot);
    if (!existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof parsed.provider !== 'string' || !isProviderId(parsed.provider))
            return undefined;
        if (typeof parsed.model !== 'string' || parsed.model.length === 0)
            return undefined;
        const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
        const apiKey2 = typeof parsed.apiKey2 === 'string' ? parsed.apiKey2 : undefined;
        return {
            provider: parsed.provider,
            model: parsed.model,
            ...(apiKey !== undefined ? { apiKey } : {}),
            ...(apiKey2 !== undefined ? { apiKey2 } : {}),
        };
    }
    catch {
        return undefined;
    }
}
/** Written mode 0600: it's a plaintext API key. */
export function saveCredentials(repoRoot, creds) {
    const path = credentialsPath(repoRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    }
    catch {
        // best-effort on platforms without POSIX permission bits
    }
}
//# sourceMappingURL=credentials.js.map