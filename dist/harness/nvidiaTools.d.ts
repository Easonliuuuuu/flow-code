/**
 * Tool vocabulary offered to the NVIDIA-backed runner via OpenAI-style
 * function calling. Independent of compile.ts on purpose (see design.md):
 * NVIDIA's chat-completions API has no built-in tools, so flow-code owns the
 * full tool surface, not just a Claude tool allow/deny list.
 */
import type { CapabilitySet } from '../capabilities.js';
export interface NvidiaToolDef {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}
export declare const READ_TOOL_NAMES: readonly ["read_file", "list_dir", "glob", "grep"];
export declare const EDIT_TOOL_NAMES: readonly ["write_file", "edit_file"];
export declare const EXEC_TOOL_NAMES: readonly ["run_shell"];
/** Layer 2 equivalent to compile.ts's disallowedTools: only offer tools the capability set allows. */
export declare function toolsForCapabilities(caps: CapabilitySet): NvidiaToolDef[];
/** Layer 1: states the boundary in the system prompt. Guarantees nothing — see nvidiaIntercept.ts for layer 3. */
export declare function nvidiaBoundaryPrompt(caps: CapabilitySet, workingDir: string): string;
