import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import type { RunStateStore } from '../runstate/store.js';
import { loadWorkflowFromString, WorkflowValidationError, type Workflow } from './load.js';

export class WorkflowWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowWriteError';
  }
}

/** Where a node's `nodes:` sequence lives in the document — top level, or inside a named `graphs:` entry. */
function nodesPathFor(graphName: string | undefined): string[] {
  return graphName !== undefined ? ['graphs', graphName, 'nodes'] : ['nodes'];
}

/**
 * Reads `path`, locates `nodeId` (inside `graphs.<graphName>.nodes` when
 * `graphName` is given, or the top-level `nodes` otherwise), hands the parsed
 * Document, its index, and its nodes path to `mutate`, then re-validates and
 * atomically writes the result — the shared skeleton behind every field-level
 * writer below. Returns the `Workflow` the write re-validated against, so a
 * caller that needs the authoritative post-write shape (`editRunningNode`)
 * doesn't have to reload it separately.
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
function editNode(
  path: string,
  nodeId: string,
  mutate: (doc: Document, index: number, nodesPath: string[]) => void,
  graphName?: string,
): Workflow {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new WorkflowWriteError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const doc = parseDocument(source);
  const nodesPath = nodesPathFor(graphName);
  const nodes = doc.getIn(nodesPath, true) as YAMLSeq<YAMLMap> | undefined;
  const index = nodes?.items.findIndex((item) => isMap(item) && item.get('id') === nodeId) ?? -1;
  if (index < 0) {
    const where = graphName !== undefined ? ` in graph \`${graphName}\`` : '';
    throw new WorkflowWriteError(`no node \`${nodeId}\`${where} in ${path}`);
  }

  mutate(doc, index, nodesPath);

  const next = doc.toString();
  let workflow: Workflow;
  try {
    // `path` is always `<repoRoot>/.flow-code/workflow.yaml` (see
    // WORKFLOW_RELATIVE_PATH) — anchoring re-validation there, rather than
    // process.cwd(), matters once a node's config carries `skills:`: a
    // project-local skill resolves against the repo root, and a caller
    // running from a subdirectory of the repo would otherwise see a false
    // "no skill" failure on an edit that never touched skills at all.
    workflow = loadWorkflowFromString(next, {
      repoRoot: dirname(dirname(path)),
      ...(graphName !== undefined ? { graph: graphName } : {}),
    });
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
  return workflow;
}

/** Deletes `config.<field>`, and `config` itself if that empties it. */
function clearConfigField(doc: Document, index: number, nodesPath: string[], field: string): void {
  doc.deleteIn([...nodesPath, index, 'config', field]);
  const config = doc.getIn([...nodesPath, index, 'config'], true);
  if (isMap(config) && config.items.length === 0) {
    doc.deleteIn([...nodesPath, index, 'config']);
  }
}

/** Sets (or, with `model: null`, clears) one node's `config.model` in the workflow file on disk. */
export function setNodeModel(
  path: string,
  nodeId: string,
  model: string | null,
  graphName?: string,
): Workflow {
  return editNode(
    path,
    nodeId,
    (doc, index, nodesPath) => {
      if (model === null) clearConfigField(doc, index, nodesPath, 'model');
      else doc.setIn([...nodesPath, index, 'config', 'model'], model);
    },
    graphName,
  );
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
  graphName?: string,
): Workflow {
  return editNode(
    path,
    nodeId,
    (doc, index, nodesPath) => {
      if (value === null) clearConfigField(doc, index, nodesPath, field);
      else doc.setIn([...nodesPath, index, 'config', field], value);
    },
    graphName,
  );
}

/**
 * Sets (or, with `tokens: null`, clears) one node's own token ceiling. The
 * budget is a sibling of `config`, so it can't go through `clearConfigField`.
 */
export function setNodeBudgetTokens(
  path: string,
  nodeId: string,
  tokens: number | null,
  graphName?: string,
): Workflow {
  return editNode(
    path,
    nodeId,
    (doc, index, nodesPath) => {
      if (tokens === null) {
        doc.deleteIn([...nodesPath, index, 'budget', 'tokens']);
        const budget = doc.getIn([...nodesPath, index, 'budget'], true);
        if (isMap(budget) && budget.items.length === 0) doc.deleteIn([...nodesPath, index, 'budget']);
      } else {
        doc.setIn([...nodesPath, index, 'budget', 'tokens'], tokens);
      }
    },
    graphName,
  );
}

/**
 * Writes the command list a Test node runs. Used when a node reaches
 * execution still carrying the scaffolded placeholder and the user says what
 * it should run instead — the answer is kept so the question is asked once
 * per project rather than once per run.
 */
export function setNodeTestCommands(
  path: string,
  nodeId: string,
  commands: string[],
  graphName?: string,
): Workflow {
  return editNode(
    path,
    nodeId,
    (doc, index, nodesPath) => {
      doc.setIn([...nodesPath, index, 'config', 'commands'], commands);
    },
    graphName,
  );
}

/** Sets (or, with an empty array, clears) one node's `config.skills` in the workflow file on disk. */
export function setNodeSkills(
  path: string,
  nodeId: string,
  skills: string[],
  graphName?: string,
): Workflow {
  return editNode(
    path,
    nodeId,
    (doc, index, nodesPath) => {
      if (skills.length === 0) clearConfigField(doc, index, nodesPath, 'skills');
      else doc.setIn([...nodesPath, index, 'config', 'skills'], skills);
    },
    graphName,
  );
}

/** One mid-run node edit — the shape `editRunningNode` dispatches on. */
export type NodeFieldEdit =
  | { kind: 'model'; value: string | null }
  | { kind: 'configString'; field: string; value: string | null }
  | { kind: 'budgetTokens'; value: number | null }
  | { kind: 'skills'; value: string[] }
  | { kind: 'testCommands'; value: string[] };

/**
 * The one path a running node's model, skills, budget, or test commands
 * change through: writes `workflowPath` via the matching setter above, then
 * mirrors the authoritative post-write `config`/`budget` onto the run's
 * recorded graph via `RunStateStore.patchGraphNode` — so the file and the
 * recording move together and no call site can update one without the other.
 *
 * Rejects an edit naming a node id absent from the recorded graph before
 * touching the file at all: an edit for a node this run isn't running
 * describes no node in this run, run or no run.
 */
export function editRunningNode(
  workflowPath: string,
  store: RunStateStore,
  nodeId: string,
  edit: NodeFieldEdit,
): Workflow {
  const graph = store.snapshot().graph;
  if (!graph || !graph.nodes.some((n) => n.id === nodeId)) {
    throw new WorkflowWriteError(`no node \`${nodeId}\` in this run's recorded graph`);
  }
  const graphName = graph.selected;
  let workflow: Workflow;
  switch (edit.kind) {
    case 'model':
      workflow = setNodeModel(workflowPath, nodeId, edit.value, graphName);
      break;
    case 'configString':
      workflow = setNodeConfigString(workflowPath, nodeId, edit.field, edit.value, graphName);
      break;
    case 'budgetTokens':
      workflow = setNodeBudgetTokens(workflowPath, nodeId, edit.value, graphName);
      break;
    case 'skills':
      workflow = setNodeSkills(workflowPath, nodeId, edit.value, graphName);
      break;
    case 'testCommands':
      workflow = setNodeTestCommands(workflowPath, nodeId, edit.value, graphName);
      break;
  }
  const node = workflow.nodes.find((n) => n.id === nodeId)!;
  store.patchGraphNode(nodeId, { config: node.config, ...(node.budget ? { budget: node.budget } : {}) });
  return workflow;
}
