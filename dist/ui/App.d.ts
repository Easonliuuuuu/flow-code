import React from 'react';
import { type ProviderId } from '../engine/providers.js';
import type { RunStateStore } from '../runstate/store.js';
import { type Workflow } from '../workflow/load.js';
import type { UiInteractionPorts } from './ports.js';
/** Provenance context the run UI needs to distinguish a node's own model
 * choice from one inherited from the workflow's settings or the provider's
 * default — captured by `cmdRun` before it fills `settings.model` in with
 * the provider default, since that fill-in would otherwise erase the
 * distinction (see design.md's "Pass model provenance into the UI
 * explicitly"). */
export interface ModelContext {
    providerId: ProviderId | undefined;
    providerDefaultModel: string | undefined;
    workflowSettingsModel: string | undefined;
}
export interface AppProps {
    workflow: Workflow;
    store: RunStateStore;
    ports: UiInteractionPorts;
    onExit: () => void;
    /** ctrl+c: interrupt the run rather than just closing the UI over it. */
    onInterrupt: () => void;
    modelContext: ModelContext;
}
export declare function App({ workflow, store, ports, onExit, onInterrupt, modelContext, }: AppProps): React.ReactElement;
