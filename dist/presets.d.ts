/**
 * A named starting workflow. A preset is a scaffolded file and nothing more —
 * it composes existing node types with skills, and adds no registry surface.
 * That is the whole reason methodologies like openspec ship as presets rather
 * than as four new node types: explore/propose/apply/archive are not new
 * *kinds* of node, they are Discuss/Spec/Implement/Git-ops given different
 * instructions.
 */
export interface WorkflowPreset {
    name: string;
    description: string;
    /** Graph summary printed after scaffolding. */
    summary: string;
    yaml: string;
    /** Skills the scaffolded graph references, checked after writing. */
    requiredSkills: string[];
}
export declare const DEFAULT_PRESET: WorkflowPreset;
export declare function getPreset(name: string): WorkflowPreset | undefined;
export declare function presetNames(): string[];
export declare function listPresets(): WorkflowPreset[];
