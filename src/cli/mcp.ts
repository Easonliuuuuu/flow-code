/**
 * `flow-code mcp` — serve the reporting tools on stdio.
 *
 * Meant to be launched by a host agent from its own MCP configuration rather
 * than typed by a person, which is why it prints nothing: stdout is the
 * protocol channel, and a single stray line of friendly output would corrupt
 * the stream before the first message.
 */

import { runMcpServer } from '../guest/mcp.js';
import { repoRootFromCwd } from './context.js';

export async function cmdMcp(): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  await runMcpServer(repoRoot);
}
