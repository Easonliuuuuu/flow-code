import type { ExecuteContext, UpstreamInput } from '../engine/types.js';

export function upstreamPreamble(upstream: UpstreamInput[]): string {
  if (upstream.length === 0) return '';
  const parts = upstream.map(
    (u) =>
      `### Output of upstream node \`${u.nodeId}\` (${u.typeId})${u.truncated ? ' [truncated]' : ''}\n${u.outputJson}`,
  );
  return `## Upstream context\n\n${parts.join('\n\n')}\n\n`;
}

/**
 * Extract the last parseable JSON object from an agent's final text.
 * Prefers fenced ```json blocks; falls back to brace scanning.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fences[i]![1]!);
    } catch {
      // try earlier fences / brace scan
    }
  }
  let last: unknown;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            last = JSON.parse(text.slice(i, j + 1));
            found = true;
          } catch {
            // not JSON; keep scanning
          }
          i = j;
          break;
        }
      }
    }
  }
  if (!found) throw new Error('agent response contained no parseable JSON object');
  return last;
}

export function nodeModel(ctx: ExecuteContext, configModel: string | undefined): string | undefined {
  return configModel ?? ctx.settings.model;
}

export function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
