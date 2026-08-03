import type { ExecuteContext, UpstreamInput } from '../engine/types.js';

export function upstreamPreamble(upstream: UpstreamInput[]): string {
  if (upstream.length === 0) return '';
  const parts = upstream.map((u) => {
    const suffix = `${u.forwarded ? ' [forwarded]' : ''}${u.truncated ? ' [truncated]' : ''}`;
    if (u.retryReason) {
      return (
        `### You are running again because \`${u.nodeId}\` (${u.typeId}) failed${suffix}\n` +
        `Address this before finishing; repeating the previous attempt will fail the same way.\n` +
        `${u.outputJson}`
      );
    }
    return `### Output of upstream node \`${u.nodeId}\` (${u.typeId})${suffix}\n${u.outputJson}`;
  });
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

/**
 * Acceptance criteria reaching a node through its upstream context — the
 * contract a Spec node set for this run.
 *
 * Read back out of the serialized upstream outputs rather than passed down a
 * side channel: upstream output *is* how one node learns what another
 * decided, and a criterion the downstream prompt can quote is a criterion the
 * downstream node was actually given.
 */
export function acceptanceCriteriaFrom(
  upstream: UpstreamInput[],
): Array<{ id: string; text: string }> {
  for (const input of upstream) {
    // A truncated output may have lost criteria mid-array; verifying against
    // half a contract is worse than verifying against none.
    if (input.truncated) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.outputJson);
    } catch {
      continue;
    }
    const criteria = (parsed as { acceptanceCriteria?: unknown } | null)?.acceptanceCriteria;
    if (!Array.isArray(criteria)) continue;
    const usable = criteria.filter(
      (c): c is { id: string; text: string } =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { id?: unknown }).id === 'string' &&
        typeof (c as { text?: unknown }).text === 'string',
    );
    if (usable.length > 0) return usable;
  }
  return [];
}

export function nodeModel(ctx: ExecuteContext, configModel: string | undefined): string | undefined {
  return configModel ?? ctx.settings.model;
}

export function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
