#!/usr/bin/env node
/**
 * Generates STATUS.md — the rollup of where the product actually is — and
 * checks for drift between what shipped and what was specced.
 *
 * The division of labour: you write intent (docs/product/roadmap.md,
 * coverage.yaml), this derives reality (git history, openspec/, src/). Nothing
 * here asks you to hand-maintain a fact the repo already knows, which is the
 * only reason a tracker like this survives past its first week.
 *
 *   npm run status         regenerate STATUS.md, print warnings
 *   npm run status:check   fail if STATUS.md is stale or drift is unregistered
 *
 * Two deliberate choices:
 *
 * - **No timestamps in the output.** A generated file containing a clock fails
 *   its own check on days nobody touched the repo, and a check that cries wolf
 *   gets deleted. Everything rendered is derived from tree content, so the
 *   output is stable until something real changes.
 * - **Time-based staleness warns, it never fails.** Whether a change has gone
 *   quiet depends on today's date, so it is printed, not written to the file.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productDir = join(repoRoot, 'docs', 'product');
const ledgerPath = join(productDir, 'coverage.yaml');
const roadmapPath = join(productDir, 'roadmap.md');
const changesDir = join(repoRoot, 'openspec', 'changes');
const archiveDir = join(changesDir, 'archive');
const specsDir = join(repoRoot, 'openspec', 'specs');
const srcDir = join(repoRoot, 'src');
const outputPath = join(repoRoot, 'STATUS.md');

const checkMode = process.argv.includes('--check');

for (const [label, path] of [['coverage.yaml', ledgerPath], ['roadmap.md', roadmapPath]]) {
  if (!existsSync(path)) {
    console.error(`status: docs/product/${label} is missing. See docs/product/README.md.`);
    process.exit(1);
  }
}

const ledger = parseYaml(readFileSync(ledgerPath, 'utf8')) ?? {};
const scopeMap = ledger.scopes ?? {};
const moduleMap = ledger.modules ?? {};
const changeMeta = ledger.changes ?? {};
const archivedMeta = ledger.archived ?? {};
const registeredGaps = ledger.registered_gaps ?? [];
const stalenessDays = ledger.staleness_days ?? 30;

/** Gaps you have already looked at, keyed as "kind:subject". */
const acknowledged = new Set(registeredGaps.map((g) => `${g.kind}:${g.subject}`));

const findings = [];
const warnings = [];

// ---------------------------------------------------------------- roadmap ---

/**
 * Reads milestones and business requirements out of roadmap.md, so BR titles
 * live in exactly one place. Milestones are `## M1 — title`, BRs are
 * `### BR-01 — title`, and a BR belongs to the milestone above it.
 */
function readRoadmap() {
  const milestones = [];
  let current = null;
  for (const line of readFileSync(roadmapPath, 'utf8').split('\n')) {
    const milestone = line.match(/^##\s+(M\d+)\s+[—-]\s+(.+?)\s*$/);
    if (milestone) {
      current = { id: milestone[1], title: milestone[2], brs: [] };
      milestones.push(current);
      continue;
    }
    const br = line.match(/^###\s+(BR-\d+)\s+[—-]\s+(.+?)\s*$/);
    if (br && current) current.brs.push({ id: br[1], title: br[2] });
  }
  return milestones;
}

// ------------------------------------------------------------ openspec ------

/** Counts `- [ ]` / `- [x]` task lines in a change's tasks.md. */
function countTasks(changePath) {
  const tasksPath = join(changePath, 'tasks.md');
  if (!existsSync(tasksPath)) return { done: 0, total: 0 };
  const body = readFileSync(tasksPath, 'utf8');
  const done = (body.match(/^\s*-\s*\[x\]/gim) ?? []).length;
  const open = (body.match(/^\s*-\s*\[ \]/gim) ?? []).length;
  return { done, total: done + open };
}

/** Reads `created:` out of a change's .openspec.yaml, if present. */
function createdOn(changePath) {
  const metaPath = join(changePath, '.openspec.yaml');
  if (!existsSync(metaPath)) return null;
  const meta = parseYaml(readFileSync(metaPath, 'utf8')) ?? {};
  return meta.created ? String(meta.created).slice(0, 10) : null;
}

function directoriesIn(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort();
}

function readChanges() {
  return directoriesIn(changesDir).map((name) => {
    const path = join(changesDir, name);
    const meta = changeMeta[name] ?? {};
    return {
      name,
      br: meta.br ?? null,
      status: meta.status ?? 'active',
      note: meta.note ?? null,
      created: createdOn(path),
      ...countTasks(path),
    };
  });
}

function readArchived() {
  return directoriesIn(archiveDir).map((name) => ({
    name,
    br: archivedMeta[name] ?? null,
    ...countTasks(join(archiveDir, name)),
  }));
}

// --------------------------------------------------------------- drift ------

/** Top-level modules under src/ — directories and single-file modules alike. */
function readModules() {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.name.endsWith('.ts'))
    .map((entry) => entry.name.replace(/\.ts$/, ''))
    .filter((name) => name !== 'index')
    .sort();
}

/** Every scope used in a `feat(<scope>):` commit subject, across all history. */
function readFeatScopes() {
  let log;
  try {
    // A shallow clone would leave this pass seeing almost no commits and
    // reporting success, which is exactly the false assurance the check exists
    // to prevent. Say so rather than passing quietly.
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    if (shallow === 'true') {
      warnings.push(
        'shallow git clone — the commit-scope pass only saw part of history and cannot be trusted. ' +
          'Check out with full history (actions/checkout `fetch-depth: 0`).',
      );
    }
    log = execFileSync('git', ['log', '--format=%s'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    warnings.push('git history unavailable — the commit-scope pass was skipped.');
    return [];
  }
  const scopes = new Set();
  for (const line of log.split('\n')) {
    const match = line.match(/^feat\(([^)]+)\)!?:/);
    if (match) scopes.add(match[1]);
  }
  return [...scopes].sort();
}

const knownCapabilities = new Set(directoriesIn(specsDir));

/** Flags mapped capabilities that do not exist — a typo silently covers nothing. */
function checkMappingTargets(map, kind) {
  for (const [subject, capabilities] of Object.entries(map)) {
    for (const capability of capabilities ?? []) {
      if (!knownCapabilities.has(capability)) {
        findings.push({
          kind: 'ledger',
          subject,
          detail: `${kind} maps to "${capability}", which is not a capability in openspec/specs/.`,
        });
      }
    }
  }
}

function detectDrift(modules, scopes, changes, archived) {
  checkMappingTargets(scopeMap, 'scope');
  checkMappingTargets(moduleMap, 'module');

  for (const module of modules) {
    if (moduleMap[module] || acknowledged.has(`module:${module}`)) continue;
    findings.push({
      kind: 'module',
      subject: module,
      detail: `src/${module} has no owning capability spec. Map it in coverage.yaml, or register it as a gap.`,
    });
  }

  for (const scope of scopes) {
    if (scopeMap[scope] || acknowledged.has(`scope:${scope}`)) continue;
    findings.push({
      kind: 'scope',
      subject: scope,
      detail: `feat(${scope}) shipped, but the scope maps to no capability. This is a feature nobody decided the home of.`,
    });
  }

  for (const change of changes) {
    if (!change.br) {
      findings.push({
        kind: 'change',
        subject: change.name,
        detail: 'Open change serves no business requirement. Add it to coverage.yaml `changes:`.',
      });
    }
  }

  for (const change of archived) {
    if (change.total > 0 && change.done < change.total) {
      findings.push({
        kind: 'archive',
        subject: change.name,
        detail: `Archived with ${change.total - change.done} of ${change.total} tasks unchecked. Either it shipped and the boxes lie, or it did not.`,
      });
    }
  }

  for (const gap of registeredGaps) {
    if (!gap.tracked_by) {
      findings.push({
        kind: 'ledger',
        subject: gap.id ?? gap.subject,
        detail: 'Registered gap has no `tracked_by`. A gap tracked by nothing is a silenced alarm.',
      });
    }
  }
}

/** Time-dependent, so it warns rather than failing or entering the file. */
function warnOnQuietChanges(changes) {
  const today = Date.now();
  for (const change of changes) {
    if (change.status === 'parked' || !change.created) continue;
    if (change.total > 0 && change.done === change.total) continue;
    const age = Math.floor((today - Date.parse(change.created)) / 86_400_000);
    if (age > stalenessDays) {
      warnings.push(
        `${change.name} has been open ${age} days with ${change.total - change.done} tasks left. ` +
          'Finish it, park it in coverage.yaml, or drop it.',
      );
    }
  }
}

// --------------------------------------------------------------- render -----

function bar(done, total) {
  if (total === 0) return '—';
  const filled = Math.round((done / total) * 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${done}/${total}`;
}

function render({ milestones, changes, archived, modules }) {
  const byBr = new Map();
  for (const change of [...changes, ...archived]) {
    if (!change.br) continue;
    if (!byBr.has(change.br)) byBr.set(change.br, []);
    byBr.get(change.br).push(change);
  }
  const archivedNames = new Set(archived.map((c) => c.name));

  const lines = [
    '<!-- Generated by scripts/status.mjs. Do not edit by hand. -->',
    '<!-- Regenerate with: npm run status -->',
    '',
    '# Status',
    '',
    'Where the product actually is, derived from `openspec/`, `src/`, and git history.',
    'Intent lives in [`docs/product/roadmap.md`](docs/product/roadmap.md); this file is',
    'the reality check against it. Nothing here is hand-written, so nothing here can',
    'flatter you.',
    '',
  ];

  for (const milestone of milestones) {
    const all = milestone.brs.flatMap((br) => byBr.get(br.id) ?? []);
    const done = all.reduce((n, c) => n + c.done, 0);
    const total = all.reduce((n, c) => n + c.total, 0);
    lines.push(`## ${milestone.id} — ${milestone.title}`, '', `\`${bar(done, total)}\` tasks across ${all.length} change(s)`, '');

    for (const br of milestone.brs) {
      const serving = byBr.get(br.id) ?? [];
      lines.push(`### ${br.id} — ${br.title}`, '');
      if (serving.length === 0) {
        lines.push('_No OpenSpec change serves this yet._', '');
        continue;
      }
      lines.push('| Change | State | Tasks |', '| --- | --- | --- |');
      for (const change of serving) {
        const state = archivedNames.has(change.name) ? 'archived' : change.status;
        lines.push(`| \`${change.name}\` | ${state} | ${bar(change.done, change.total)} |`);
      }
      lines.push('');
    }
  }

  const orphanChanges = changes.filter((c) => !c.br);
  if (orphanChanges.length > 0) {
    lines.push('## Not mapped to any requirement', '');
    for (const change of orphanChanges) lines.push(`- \`${change.name}\``);
    lines.push('');
  }

  const parked = changes.filter((c) => c.status === 'parked');
  if (parked.length > 0) {
    lines.push('## Parked', '', 'Designed, deliberately not scheduled — recorded so it stays distinguishable from forgotten.', '');
    for (const change of parked) {
      lines.push(`- **\`${change.name}\`**${change.br ? ` (${change.br})` : ''}${change.created ? `, opened ${change.created}` : ''}`);
      if (change.note) lines.push(`  ${change.note.trim().replace(/\s+/g, ' ')}`);
    }
    lines.push('');
  }

  lines.push('## Drift', '');
  if (findings.length === 0) {
    lines.push(`No unregistered drift. ${registeredGaps.length} known gap(s) registered in \`coverage.yaml\`.`, '');
  } else {
    lines.push(`**${findings.length} unregistered finding(s).** Fix, map, or register each in \`coverage.yaml\`.`, '');
    for (const finding of findings) lines.push(`- **${finding.kind} \`${finding.subject}\`** — ${finding.detail}`);
    lines.push('');
  }

  if (registeredGaps.length > 0) {
    lines.push('### Registered gaps', '', 'Known debt, already decided about. Green on purpose — but still debt.', '', '| Gap | Subject | Tracked by |', '| --- | --- | --- |');
    for (const gap of registeredGaps) {
      lines.push(`| ${gap.id ?? '—'} | ${gap.kind} \`${gap.subject}\` | ${gap.tracked_by ?? '**nothing**'} |`);
    }
    lines.push('');
  }

  const totalArchivedTasks = archived.reduce((n, c) => n + c.total, 0);
  lines.push(
    '## Shipped',
    '',
    `${archived.length} archived change(s), ${totalArchivedTasks} tasks. ${modules.length} modules under \`src/\`, ${knownCapabilities.size} capability specs.`,
    '',
  );

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ----------------------------------------------------------------- main -----

const milestones = readRoadmap();
const changes = readChanges();
const archived = readArchived();
const modules = readModules();
const scopes = readFeatScopes();

detectDrift(modules, scopes, changes, archived);
warnOnQuietChanges(changes);

const rendered = render({ milestones, changes, archived, modules });

if (checkMode) {
  const existing = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
  let failed = false;

  if (existing !== rendered) {
    console.error('status: STATUS.md is out of date. Run `npm run status` and commit the result.');
    failed = true;
  }
  if (findings.length > 0) {
    console.error(`status: ${findings.length} unregistered drift finding(s):`);
    for (const finding of findings) console.error(`  - ${finding.kind} "${finding.subject}": ${finding.detail}`);
    console.error('Fix each, map it in docs/product/coverage.yaml, or register it under `registered_gaps`.');
    failed = true;
  }
  for (const warning of warnings) console.warn(`status: warning: ${warning}`);
  process.exit(failed ? 1 : 0);
}

writeFileSync(outputPath, rendered);
console.log(`status: wrote ${outputPath.replace(`${repoRoot}/`, '')}`);
if (findings.length > 0) {
  console.log(`status: ${findings.length} unregistered drift finding(s) — see the Drift section.`);
}
for (const warning of warnings) console.warn(`status: warning: ${warning}`);
