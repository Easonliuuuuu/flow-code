#!/usr/bin/env node
/**
 * Generates the parts of the hand-written docs that restate something the
 * source already knows, and replaces them in place between marker comments.
 *
 * `gen-node-types-doc.mjs` generates a whole file from the node type registry,
 * and that doc is the only one in the repo that has never drifted. This is the
 * same machinery pointed at the two places that had: the README's command
 * table (which had lost `runs`, `--resume`, `--allow-dirty` and `doctor --yes`)
 * and the workflow reference's settings table (which had never gained
 * `subagents` or `notifications` at all).
 *
 * Run `npm run docs:generate` after changing a command or a setting. With
 * `--check` it regenerates in memory and fails if a committed file is stale,
 * which is how CI catches a source change that skipped the docs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

if (!existsSync(join(distDir, 'cli', 'commands.js'))) {
  console.error('gen-docs: dist/ not built. Run `npm run build` first.');
  process.exit(1);
}

const { CLI_COMMANDS } = await import(join(distDir, 'cli', 'commands.js'));
const { SETTINGS_FIELDS } = await import(join(distDir, 'workflow', 'schema.js'));

/** Escape the pipes that would otherwise split a markdown table cell. */
const cell = (text) => String(text).replaceAll('|', '\\|');

function commandTable() {
  return [
    '| Command | What it does |',
    '| --- | --- |',
    ...CLI_COMMANDS.map((c) => `| \`${cell(c.usage)}\` | ${cell(c.summary)} |`),
  ];
}

function settingsTable() {
  return [
    '| Field | Type | Default | What it does |',
    '| --- | --- | --- | --- |',
    ...SETTINGS_FIELDS.map(
      (f) => `| \`${cell(f.name)}\` | ${cell(f.type)} | ${f.default} | ${f.description} |`,
    ),
  ];
}

/**
 * Each target names a file, a region id, and what fills it. The markers stay
 * in the file so the generated span is obvious to anyone editing around it.
 */
const TARGETS = [
  { file: 'README.md', region: 'cli-commands', render: commandTable },
  { file: 'docs/workflow-reference.md', region: 'settings-fields', render: settingsTable },
];

/** Replace everything between the region's markers, keeping the markers. */
function splice(source, region, lines) {
  const begin = `<!-- BEGIN GENERATED: ${region} -->`;
  const end = `<!-- END GENERATED: ${region} -->`;
  const from = source.indexOf(begin);
  const to = source.indexOf(end);

  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `missing or malformed markers for region \`${region}\` — expected ${begin} … ${end}`,
    );
  }

  return `${source.slice(0, from + begin.length)}\n${lines.join('\n')}\n${source.slice(to)}`;
}

const check = process.argv.includes('--check');
let stale = false;

for (const target of TARGETS) {
  const path = join(repoRoot, target.file);
  const current = readFileSync(path, 'utf8');
  const generated = splice(current, target.region, target.render());

  if (check) {
    if (current !== generated) {
      console.error(
        `gen-docs: ${target.file} region \`${target.region}\` is out of date with the source.\n` +
          'Run `npm run docs:generate` and commit the result.',
      );
      stale = true;
    }
    continue;
  }

  if (current !== generated) {
    writeFileSync(path, generated);
    console.log(`gen-docs: updated ${relative(repoRoot, path)} (${target.region})`);
  }
}

if (stale) process.exit(1);
if (check) console.log('gen-docs: every generated region is up to date.');
