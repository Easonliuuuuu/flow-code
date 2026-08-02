import type { ProviderId } from '../engine/providers.js';
import { type ModelListResult } from '../init/modelList.js';
export type ModelListState = {
    status: 'loading';
} | {
    status: 'loaded';
    models: string[];
} | {
    status: 'failed';
    error: string;
};
export interface ModelListLoader {
    getState(): ModelListState;
    /** Starts the fetch the first time it's called; a no-op on every call after. */
    ensureLoaded(): void;
}
/**
 * Wraps `fetchModelIds` for the run UI's model picker: the picker opens
 * immediately in a `loading` state and the caller is notified via `onChange`
 * once the fetch settles, so Ink's input loop never blocks on the network
 * call. One loader is meant to live for one provider for the life of a run —
 * `ensureLoaded` fetches at most once regardless of how many times the
 * picker is opened and closed.
 */
export declare function createModelListLoader(provider: ProviderId, apiKey: string | undefined, onChange: () => void, fetchFn?: (provider: ProviderId, apiKey: string | undefined) => Promise<ModelListResult>): ModelListLoader;
