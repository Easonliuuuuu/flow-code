import type { RunStateStore } from '../runstate/store.js';
import type { Workflow } from '../workflow/load.js';
import { type ModelContext } from './App.js';
import type { UiInteractionPorts } from './ports.js';
export { UiInteractionPorts } from './ports.js';
export type { ModelContext } from './App.js';
/** Mount the terminal UI; resolves when the user exits. */
export declare function runUi(opts: {
    workflow: Workflow;
    store: RunStateStore;
    ports: UiInteractionPorts;
    onInterrupt: () => void;
    modelContext: ModelContext;
}): Promise<void>;
