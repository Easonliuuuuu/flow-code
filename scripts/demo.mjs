#!/usr/bin/env node
/**
 * Records a real run, and replays it through the real UI — the tooling behind
 * the README demo.
 *
 *   node scripts/demo.mjs capture    # window 2, while `flow-code run` drives window 1
 *   node scripts/demo.mjs play       # replay it: no engine, no provider, no tokens
 *   node scripts/demo.mjs duration   # how long a replay runs, for the VHS tape's Sleep
 *
 * Why a replay rather than a screen capture of a live run: a run takes
 * minutes, costs tokens, and never comes out the same way twice, which makes a
 * live recording something you get once and can never reproduce — so the demo
 * rots the first time a card's layout changes and nobody re-records it.
 *
 * The engine already writes the complete run-state document on every change
 * (FileRunStatePersister), which makes `.flow-code/runs/<runId>.json` a
 * recording medium: a capture is that file's successive versions with
 * timestamps, and a replay is those versions pushed back into a RunStateStore
 * on a compressed clock. `play` mounts the same `runUi` that `flow-code run`
 * mounts, against the same store, so what the GIF shows cannot drift from what
 * the tool does — only from what it did on the day the run was captured.
 *
 * One thing a recording does not contain: streamed agent output. The store
 * holds that in memory alone (RunStateStore.liveOutput), so it never reaches
 * the run file and cannot be recovered from it. Statuses, attempts, token
 * spend, the activity log, and each node's recorded output all persist, and
 * all replay.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RECORDING = join(repoRoot, 'docs', 'demo', 'run.jsonl');

const [, , command, ...argv] = process.argv;

/** `--name value` or `--name=value`; returns `fallback` when absent. */
function flag(name, fallback) {
  const exact = argv.indexOf(`--${name}`);
  if (exact !== -1 && argv[exact + 1] !== undefined && !argv[exact + 1].startsWith('--')) {
    return argv[exact + 1];
  }
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function bool(name) {
  return argv.includes(`--${name}`);
}

function num(name, fallback) {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) fail(`--${name} must be a number, got \`${raw}\``);
  return parsed;
}

function fail(message) {
  console.error(`demo: ${message}`);
  process.exit(1);
}

function asPath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

const USAGE = `flow-code demo recorder

  node scripts/demo.mjs capture [options]   record a run as it happens
    --repo <dir>       repo whose run to follow (default: cwd)
    --run <runId>      pin to one run (default: whichever is being written)
    --out <file>       recording to write (default: docs/demo/run.jsonl)
    --interval <ms>    poll cadence (default: 200)
    --redact           drop node output, Discuss transcripts and session ids

  node scripts/demo.mjs play [options]      replay a recording through the UI
    --recording <file> recording to play (default: docs/demo/run.jsonl)
    --speed <n>        playback multiplier (default: 4)
    --max-gap <ms>     clamp for dead air between frames (default: 1200)
    --hold <ms>        pause on the final frame before exiting (default: 2500)
    --splash           play the startup splash first
    --provider <id>    provider shown in the header (default: claude)
    --model <name>     model shown in the header (default: the run's own)

  node scripts/demo.mjs duration [options]  print a replay's length in seconds
    (takes --recording, --speed, --max-gap, --hold)
`;

// ---------------------------------------------------------------- recording

/** Newest run file by mtime — the one being written, which is the live run. */
function newestRunFile(runsDir) {
  let entries;
  try {
    entries = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }
  let newest;
  for (const entry of entries) {
    const path = join(runsDir, entry);
    try {
      const { mtimeMs } = statSync(path);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    } catch {
      // Vanished between readdir and stat (a `.tmp` mid-rename): skip it.
    }
  }
  return newest?.path;
}

/**
 * Strips what a published recording has no business carrying.
 *
 * `repoRoot` and `pid` always go: they describe the machine the run happened
 * on, and the player rewrites both anyway. `--redact` additionally drops the
 * three fields that hold verbatim content from the repo you recorded in —
 * worth reaching for when that repo isn't public, at the cost of the detail
 * panels being empty in the replay.
 */
function scrub(state, redact) {
  const scrubbed = { ...state, repoRoot: '', pid: 0 };
  if (!redact) return scrubbed;
  scrubbed.nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([id, node]) => {
      const { output, discussTranscript, sessionId, ...rest } = node;
      return [id, rest];
    }),
  );
  return scrubbed;
}

function capture() {
  const repo = asPath(flag('repo', process.cwd()));
  const runsDir = join(repo, '.flow-code', 'runs');
  const runId = flag('run');
  const out = asPath(flag('out', DEFAULT_RECORDING));
  const intervalMs = num('interval', 200);
  const redact = bool('redact');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, '');

  let pinned = runId ? join(runsDir, `${runId}.json`) : undefined;
  let lastText;
  let startedAt;
  let frames = 0;
  let stopping;
  /** Finished runs already reported as skipped, so the wait doesn't spam. */
  const ignored = new Set();

  console.log(`demo: watching ${runsDir}`);
  console.log(`demo: writing ${out}`);
  console.log('demo: start `flow-code run` in another window; ctrl+c here when you have enough.\n');

  const tick = () => {
    const path = pinned ?? newestRunFile(runsDir);
    if (!path) return;

    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    if (text === lastText) return;

    let state;
    try {
      state = JSON.parse(text);
    } catch {
      // Caught mid-write. Leave `lastText` alone so the next tick retries.
      return;
    }

    lastText = text;

    // A run that was already over when this started is history, not a
    // recording — capturing its final frame and stopping on the `finishedAt`
    // it has always had is how a capture "succeeds" with one frame of a run
    // nobody just did. Wait for a live one instead, and leave `pinned` unset
    // so a run started later is still picked up. Naming a run with `--run`
    // is the explicit opt-out: asking for it by id means wanting it however
    // it ended.
    if (frames === 0 && state.finishedAt && !runId) {
      if (!ignored.has(path)) {
        ignored.add(path);
        console.log(`demo: ignoring ${state.runId.slice(0, 8)} — already finished; waiting for a new run`);
      }
      return;
    }

    pinned ??= path;
    startedAt ??= Date.now();
    appendFileSync(out, `${JSON.stringify({ ms: Date.now() - startedAt, state: scrub(state, redact) })}\n`);
    frames += 1;
    process.stdout.write(`\rdemo: ${frames} frame(s) captured`);

    // A finished run still has a write or two left in it (the final activity
    // rows, `finishedAt` itself); give those a beat rather than cutting the
    // recording off on the frame that happened to set the flag.
    if (state.finishedAt && !stopping) {
      stopping = setTimeout(() => stop('run finished'), 1500);
    }
  };

  const poll = setInterval(tick, intervalMs);

  const stop = (why) => {
    clearInterval(poll);
    if (stopping) clearTimeout(stopping);
    const bytes = existsSync(out) ? statSync(out).size : 0;
    const seconds = startedAt ? ((Date.now() - startedAt) / 1000).toFixed(1) : '0.0';
    process.stdout.write('\n');
    console.log(`demo: ${why} — ${frames} frame(s), ${seconds}s, ${(bytes / 1024).toFixed(0)} KB`);
    if (frames === 0) {
      console.log('demo: nothing captured. Was a run writing to .flow-code/runs while this waited?');
    } else {
      console.log('demo: read the recording before committing it — every frame carries the run\'s');
      console.log('      activity log and node output verbatim, and the GIF publishes both.');
      console.log(`demo: preview it with \`node scripts/demo.mjs play --recording ${out}\``);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => stop('stopped'));
  tick();
}

// ----------------------------------------------------------------- playback

function readFrames(path) {
  if (!existsSync(path)) {
    fail(`no recording at ${path} — record one with \`node scripts/demo.mjs capture\`.`);
  }
  const frames = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        return fail(`recording line ${i + 1} is not valid JSON.`);
      }
    });
  if (frames.length === 0) fail(`${path} is empty.`);
  return frames;
}

/**
 * Gaps between frames, compressed for playback.
 *
 * Two knobs, because a real run has two kinds of pause: the sub-second churn
 * of a node streaming (divided down by `speed`, so it still reads as motion)
 * and the minute-long silence of an agent thinking (clamped by `maxGap`, since
 * nothing on screen changes and no viewer will wait it out).
 */
function delays(frames, speed, maxGapMs) {
  return frames.slice(1).map((frame, i) => Math.min(maxGapMs, Math.max(0, (frame.ms - frames[i].ms) / speed)));
}

function dist(relative) {
  const path = join(repoRoot, 'dist', relative);
  if (!existsSync(path)) fail('dist/ is not built. Run `npm run build` first.');
  return path;
}

async function play() {
  const recordingPath = asPath(flag('recording', DEFAULT_RECORDING));
  const speed = num('speed', 4);
  const maxGapMs = num('max-gap', 1200);
  const holdMs = num('hold', 2500);
  const frames = readFrames(recordingPath);

  const first = frames[0].state;
  if (!first.graph) {
    fail(
      'this recording has no recorded graph — it predates runs describing their own shape.\n' +
        '       Re-capture with a current build.',
    );
  }

  const { rehydrateGraph, RecordedGraphError } = await import(dist('workflow/record.js'));
  const { RunStateStore } = await import(dist('runstate/store.js'));
  const { runUi, UiInteractionPorts } = await import(dist('ui/index.js'));

  // The graph comes from the recording, not from any workflow.yaml: a replay
  // has to draw the graph the run actually executed, and it should play in any
  // directory rather than only in a repo prepared to receive it.
  let workflow;
  try {
    workflow = rehydrateGraph(first.graph, { repoRoot: process.cwd() });
  } catch (err) {
    if (err instanceof RecordedGraphError) {
      fail(`${err.message}\n       (skills a node was attached to may not exist on this machine)`);
    }
    throw err;
  }

  // The recorded `repoRoot` was scrubbed and the pid belonged to a process
  // that exited long ago; both are re-pointed at this one so the header and
  // the working-directory lines describe something real.
  const hydrate = (state) => ({ ...state, repoRoot: process.cwd(), pid: process.pid });

  const store = new RunStateStore({ repoRoot: process.cwd(), graph: first.graph });
  store.applySnapshot(hydrate(first));

  const gaps = delays(frames, speed, maxGapMs);
  let next = 1;
  const step = () => {
    if (next >= frames.length) {
      setTimeout(() => process.exit(0), holdMs);
      return;
    }
    const i = next;
    setTimeout(() => {
      store.applySnapshot(hydrate(frames[i].state));
      next += 1;
      step();
    }, gaps[i - 1]);
  };
  step();

  await runUi({
    workflow,
    store,
    ports: new UiInteractionPorts(),
    // Nothing to interrupt: ctrl+c (and `q`) just end the replay.
    onInterrupt: () => {},
    splash: bool('splash'),
    modelContext: {
      providerId: flag('provider', 'claude'),
      providerDefaultModel: flag('model', first.graph.settings.model),
      workflowSettingsModel: first.graph.settings.model,
    },
  });
  process.exit(0);
}

function duration() {
  const frames = readFrames(asPath(flag('recording', DEFAULT_RECORDING)));
  const total = delays(frames, num('speed', 4), num('max-gap', 1200)).reduce((a, b) => a + b, 0);
  const seconds = (total + num('hold', 2500)) / 1000;
  console.log(
    `${seconds.toFixed(1)}s — ${frames.length} frames, ` +
      `${(frames[frames.length - 1].ms / 1000).toFixed(0)}s of real run time`,
  );
}

if (argv.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

switch (command) {
  case 'capture':
    capture();
    break;
  case 'play':
    await play();
    break;
  case 'duration':
    duration();
    break;
  default:
    console.log(USAGE);
    process.exit(command === undefined || command === '--help' ? 0 : 1);
}
