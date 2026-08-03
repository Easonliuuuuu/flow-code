import { spawn } from 'node:child_process';

function run(command: string, args: string[], stdio: 'ignore' | 'inherit'): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/** Whether `command` resolves on PATH, via a POSIX `command -v` check. */
export function isCliAvailable(command: string): Promise<boolean> {
  return run('sh', ['-c', `command -v ${command}`], 'ignore');
}

/** Runs an installer, streaming its output to the terminal. False on a non-zero exit or spawn failure. */
export function runCliInstall(install: { command: string; args: string[] }): Promise<boolean> {
  return run(install.command, install.args, 'inherit');
}
