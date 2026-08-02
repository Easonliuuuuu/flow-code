import { fetchModelIds } from '../init/modelList.js';
/**
 * Wraps `fetchModelIds` for the run UI's model picker: the picker opens
 * immediately in a `loading` state and the caller is notified via `onChange`
 * once the fetch settles, so Ink's input loop never blocks on the network
 * call. One loader is meant to live for one provider for the life of a run —
 * `ensureLoaded` fetches at most once regardless of how many times the
 * picker is opened and closed.
 */
export function createModelListLoader(provider, apiKey, onChange, fetchFn = fetchModelIds) {
    let state = { status: 'loading' };
    let started = false;
    return {
        getState: () => state,
        ensureLoaded: () => {
            if (started)
                return;
            started = true;
            void fetchFn(provider, apiKey).then((result) => {
                state =
                    result.error !== undefined
                        ? { status: 'failed', error: result.error }
                        : { status: 'loaded', models: result.models };
                onChange();
            });
        },
    };
}
//# sourceMappingURL=modelListLoader.js.map