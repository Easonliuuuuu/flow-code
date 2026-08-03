import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { loadWorkflowFromString, WorkflowValidationError } from './load.js';

export class WorkflowWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowWriteError';
  }
}

/**
 * Reads `path`, locates `nodeId`, hands the parsed Document and its index to
 * `mutate`, then re-validates and atomically writes the result — the shared
 * skeleton behind every field-level writer below.
 *
 * Preserves every comment, blank line, and key order the `yaml` package's
 * Document AST can carry across an edit — this file is checked in and
 * hand-edited, so a writer that re-emits it from a parsed object would
 * destroy that on the first save.
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
function editNode(path: string, nodeId: string, mutate: (doc: Document, index: number) => void): void {
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

  mutate(doc, index);

  const next = doc.toString();
  try {
    // `path` is always `<repoRoot>/.flow-code/workflow.yaml` (see
    // WORKFLOW_RELATIVE_PATH) — anchoring re-validation there, rather than
    // process.cwd(), matters once a node's config carries `skills:`: a
    // project-local skill resolves against the repo root, and a caller
    // running from a subdirectory of the repo would otherwise see a false
    // "no skill" failure on an edit that never touched skills at all.
    loadWorkflowFromString(next, { repoRoot: dirname(dirname(path)) });
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

/** Deletes `config.<field>`, and `config` itself if that empties it. */
function clearConfigField(doc: Document, index: number, field: string): void {
  doc.deleteIn(['nodes', index, 'config', field]);
  const config = doc.getIn(['nodes', index, 'config'], true);
  if (isMap(config) && config.items.length === 0) {
    doc.deleteIn(['nodes', index, 'config']);
  }
}

/** Sets (or, with `model: null`, clears) one node's `config.model` in the workflow file on disk. */
export function setNodeModel(path: string, nodeId: string, model: string | null): void {
  editNode(path, nodeId, (doc, index) => {
    if (model === null) clearConfigField(doc, index, 'model');
    else doc.setIn(['nodes', index, 'config', 'model'], model);
  });
}

/**
 * Sets (or, with `value: null`, clears) one arbitrary string field of a
 * node's config. The editable set is decided by `editableFields` in the UI,
 * not here — this writer only has to put a string where it was asked to.
 */
export function setNodeConfigString(
  path: string,
  nodeId: string,
  field: string,
  value: string | null,
): void {
  editNode(path, nodeId, (doc, index) => {
    if (value === null) clearConfigField(doc, index, field);
    else doc.setIn(['nodes', index, 'config', field], value);
  });
}

/**
 * Sets (or, with `tokens: null`, clears) one node's own token ceiling. The
 * budget is a sibling of `config`, so it can't go through `clearConfigField`.
 */
export function setNodeBudgetTokens(path: string, nodeId: string, tokens: number | null): void {
  editNode(path, nodeId, (doc, index) => {
    if (tokens === null) {
      doc.deleteIn(['nodes', index, 'budget', 'tokens']);
      const budget = doc.getIn(['nodes', index, 'budget'], true);
      if (isMap(budget) && budget.items.length === 0) doc.deleteIn(['nodes', index, 'budget']);
    } else {
      doc.setIn(['nodes', index, 'budget', 'tokens'], tokens);
    }
  });
}

/** Sets (or, with an empty array, clears) one node's `config.skills` in the workflow file on disk. */
export function setNodeSkills(path: string, nodeId: string, skills: string[]): void {
  editNode(path, nodeId, (doc, index) => {
    if (skills.length === 0) clearConfigField(doc, index, 'skills');
    else doc.setIn(['nodes', index, 'config', 'skills'], skills);
  });
}
