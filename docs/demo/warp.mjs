/**
 * Compress dead air across both halves of the recording at once.
 *
 * `demo.mjs --max-gap` and `asciinema -i` each clamp their own stream, which
 * is fine alone and wrong here: two streams clamped independently no longer
 * describe the same clock, and the panes drift apart by however much idle time
 * one had that the other did not. So the warp is computed once, over the union
 * of both streams' event times, and applied to both.
 *
 * Nothing is invented or reordered — only intervals where *neither* stream did
 * anything are shortened, which is the same claim `--max-gap` already makes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

const castIn = arg('cast');
const runIn = arg('run');
const castOut = arg('cast-out');
const runOut = arg('run-out');
const start = Number(arg('start'));
const end = Number(arg('end'));
const maxGap = Number(arg('max-gap', 3));
const speed = Number(arg('speed', 5));
const headSeconds = Number(arg('head-seconds', 2));

const castLines = readFileSync(castIn, 'utf8').trim().split('\n');
const header = JSON.parse(castLines[0]);

// Cast events, in seconds from the start of the recording.
const events = [];
let t = 0;
for (const line of castLines.slice(1)) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  t += e[0];
  events.push({ t, kind: e[1], data: e[2] });
}

// Run frames, converted onto the same clock.
const allFrames = readFileSync(runIn, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const runStart = Date.parse(allFrames[0].state.createdAt) / 1000 - header.timestamp;
const allTimes = allFrames.map((f) => runStart + f.ms / 1000);

// Window the run the same way the cast is windowed. A window that opens
// mid-run — the usual case when cutting to one moment — would otherwise
// replay the graph from its first frame while the agent pane is already
// half-way through, and the offset between them comes out negative.
//
// Each frame is a complete state document, so the last frame at or before the
// window is exactly the state the graph was in when the window opens: keep it
// as the opener, pinned to the window's start, and drop everything earlier.
const firstInWindow = allTimes.findIndex((t) => t >= start);
const openerIdx = Math.max(0, (firstInWindow === -1 ? allFrames.length : firstInWindow) - 1);
const keep = allFrames
  .map((f, i) => ({ frame: f, t: allTimes[i], i }))
  .filter(({ i, t }) => i >= openerIdx && t <= end);
if (keep.length === 0) {
  console.error(`warp: no run frames in window ${start}-${end}s`);
  process.exit(1);
}
keep[0].t = Math.max(keep[0].t, start);
const frames = keep.map((k) => k.frame);
const frameTimes = keep.map((k) => k.t);

// One warp over the union of both streams: any interval in which neither
// stream produced anything is capped at `maxGap`.
const marks = [...new Set([...events.map((e) => e.t), ...frameTimes])].sort((a, b) => a - b);
const warped = new Map();
let acc = 0;
for (let i = 0; i < marks.length; i += 1) {
  if (i > 0) acc += Math.min(marks[i] - marks[i - 1], maxGap);
  warped.set(marks[i], acc);
}
const W = (x) => {
  if (warped.has(x)) return warped.get(x);
  // Between marks: the interval is dead by construction, so clamp to its start.
  let last = 0;
  for (const m of marks) {
    if (m > x) break;
    last = warped.get(m);
  }
  return last;
};

// Cast: the pre-window head is kept, so the pane opens on the scrollback the
// session had drawn — Claude Code renders its conversation as history, and
// clearing instead opens an empty pane that never fills.
//
// It is paced rather than dumped at zero delay. A thousand-odd events written
// as one burst overruns the pty and the terminal drops bytes; the erases go
// missing first, so Claude's footer and the flow-code status row end up
// overwriting each other on one row. Spreading the head over a couple of
// seconds of playback costs nothing visible and keeps every write intact.
const headEvents = events.filter((e) => e.t < start).length;
const headTotal = headSeconds * speed; // asciinema divides these by `speed`
const headStep = headEvents > 0 ? headTotal / headEvents : 0;

const keptCast = [castLines[0]];
let prev = null;
for (const e of events) {
  if (e.t > end) break;
  const w = W(e.t);
  const delta = e.t < start ? headStep : prev === null ? 0 : w - prev;
  keptCast.push(JSON.stringify([Number(delta.toFixed(4)), e.kind, e.data]));
  if (e.t >= start) prev = w;
}
writeFileSync(castOut, keptCast.join('\n') + '\n');

// Run: re-stamped onto the warped clock, relative to its own first frame.
const base = W(frameTimes[0]);
const keptRun = frames.map((f, i) =>
  JSON.stringify({ ...f, ms: Math.round((W(frameTimes[i]) - base) * 1000) }),
);
writeFileSync(runOut, keptRun.join('\n') + '\n');

const span = W(Math.min(end, marks[marks.length - 1])) - W(start);
const delay = W(frameTimes[0]) - W(start);
// The right pane waits out the left pane's head catch-up as well as the gap
// between the window opening and the run opening.
console.log(`warped span ${span.toFixed(1)}s of activity (was ${(Math.min(end, marks.at(-1)) - start).toFixed(1)}s wall clock)`);
console.log(`head: ${headEvents} events paced over ${headSeconds}s of playback`);
console.log(`\nat --speed ${speed}:  gif ${(span / speed).toFixed(1)}s   SPEED=${speed} DELAY=${(headSeconds + delay / speed).toFixed(2)}`);
