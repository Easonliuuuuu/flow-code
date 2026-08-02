import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { loadWorkflowFromString, WorkflowValidationError } from './load.js';

export class WorkflowWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowWriteError';
  }
}

/**
 * Sets (or, with `model: null`, clears) one node's `config.model` in the
 * workflow file on disk, preserving every comment, blank line, and key order
 * the `yaml` package's Document AST can carry across an edit — this file is
 * checked in and hand-edited, so a writer that re-emits it from a parsed
 * object would destroy that on the first save.
 *
 * Known gap: a comment block at the very end of a sequence with no node
 * after it (a "dangling" comment, e.g. the commented-out loop-back example
 * at the end of the scaffolded workflow) loses the blank line that used to
 * separate it from the preceding item — a `yaml` limitation, not something
 * this function works around. Every other comment, including ones attached
 * to a node or a key, round-trips untouched.
 *
 * Re-reads the file fresh rather than working from a document parsed earlier
 * in the run, so an edit made outside the UI while the run was live isn't
 * clobbered. The result is re-validated as a workflow before anything is
 * written; on any failure the file on disk is untouched.
 */
export function setNodeModel(path: string, nodeId: string, model: string | null): void {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new WorkflowWriteError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const doc = parseDocument(source);
  const nodes = doc.get('nodes', true) as YAMLSeq<YAMLMap> | undefined;
  const index = nodes?.items.findIndex((item) => isMap(item) && item.get('id') === nodeId) ?? -1;
  if (index < 0) {
    throw new WorkflowWriteError(`no node \`${nodeId}\` in ${path}`);
  }

  if (model === null) {
    doc.deleteIn(['nodes', index, 'config', 'model']);
    const config = doc.getIn(['nodes', index, 'config'], true);
    if (isMap(config) && config.items.length === 0) {
      doc.deleteIn(['nodes', index, 'config']);
    }
  } else {
    doc.setIn(['nodes', index, 'config', 'model'], model);
  }

  const next = doc.toString();
  try {
    loadWorkflowFromString(next);
  } catch (err) {
    const reason = err instanceof WorkflowValidationError ? err.message : String(err);
    throw new WorkflowWriteError(
      `refusing to write ${path}: the edited workflow would no longer load — ${reason}`,
    );
  }

  const tmpPath = join(dirname(path), `.${Date.now()}-${process.pid}.workflow.yaml.tmp`);
  try {
    writeFileSync(tmpPath, next, 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    throw new WorkflowWriteError(
      `could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
