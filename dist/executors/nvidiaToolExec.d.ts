export declare function readFileTool(workingDir: string, input: Record<string, unknown>): string;
export declare function listDirTool(workingDir: string, input: Record<string, unknown>): string;
export declare function globTool(workingDir: string, input: Record<string, unknown>): string;
export declare function grepTool(workingDir: string, input: Record<string, unknown>): string;
export declare function writeFileTool(workingDir: string, input: Record<string, unknown>): string;
export declare function editFileTool(workingDir: string, input: Record<string, unknown>): string;
export interface ShellResult {
    output: string;
    exitStatus: number | null;
}
export declare function runShellTool(workingDir: string, input: Record<string, unknown>, extraEnv?: Record<string, string>, signal?: AbortSignal): Promise<ShellResult>;
