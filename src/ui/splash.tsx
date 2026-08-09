import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { spinnerFrame } from './nodeCard.js';

/**
 * Brief, skippable animated intro for `flow-code run`/`flow-code watch`:
 * a chain of five nodes runs left to right, the fourth one fails, the
 * chain retries from the node after the last confirmed-good one, a small
 * firework marks success, and the logo settles in line by line before a
 * final green "ready". Purely decorative — it reflects no real state, just
 * this process's own startup — but the fail/retry beat mirrors a shape
 * flow-code users will recognize from real node graphs.
 */

const FRAME_MS = 160;
const RUN_FRAMES = 2;
/** How long the failed node holds its red glyph before the retry kicks off. */
const ERROR_HOLD = 2;

type NodeState = 'idle' | 'running' | 'done' | 'error';
type NodeId = 'A' | 'B' | 'C' | 'D' | 'E';
const NODE_IDS: NodeId[] = ['A', 'B', 'C', 'D', 'E'];

/** One pass of a node: spinning across [start, end), then settling into `status`. */
interface Run {
  start: number;
  end: number;
  status: 'done' | 'error';
}

// A runs once and is never touched again. B and C each run twice: once in
// the initial pass, once in the retry. D runs twice too, but fails the
// first time — the retry is what finally gets it (and the chain) to green.
// E only exists after the retry succeeds.
const A_END = RUN_FRAMES;
const B_END = A_END + RUN_FRAMES;
const C_END = B_END + RUN_FRAMES;
const D_END = C_END + RUN_FRAMES;
const RETRY_START = D_END + ERROR_HOLD;
const B2_END = RETRY_START + RUN_FRAMES;
const C2_END = B2_END + RUN_FRAMES;
const D2_END = C2_END + RUN_FRAMES;
const E_END = D2_END + RUN_FRAMES;

const FIREWORK_START = E_END;
const FIREWORK_FRAMES = 4;
export const WORDMARK_START = FIREWORK_START + FIREWORK_FRAMES;
export const WORDMARK_LINE_COUNT = 4;
/** The wordmark reveals one FIGlet line per frame from `WORDMARK_START`; this is the first frame where all four are up. */
const WORDMARK_REVEAL_END = WORDMARK_START + WORDMARK_LINE_COUNT;
const HOLD_FRAMES = 2;
export const AUTO_DONE_FRAME = WORDMARK_REVEAL_END + HOLD_FRAMES;

const RUNS: Record<NodeId, Run[]> = {
  A: [{ start: 0, end: A_END, status: 'done' }],
  B: [
    { start: A_END, end: B_END, status: 'done' },
    { start: RETRY_START, end: B2_END, status: 'done' },
  ],
  C: [
    { start: B_END, end: C_END, status: 'done' },
    { start: B2_END, end: C2_END, status: 'done' },
  ],
  D: [
    { start: C_END, end: D_END, status: 'error' },
    { start: C2_END, end: D2_END, status: 'done' },
  ],
  E: [{ start: D2_END, end: E_END, status: 'done' }],
};

/** Below this width the chain and logo would wrap rather than fit, so the splash is skipped outright. */
const MIN_COLUMNS = 46;
/** Above this height the reserved logo block could overflow a very short terminal, so the splash is skipped outright too. */
const MIN_ROWS = 12;

/**
 * Whether the splash should skip itself rather than play: no TTY (a pipe, a
 * log file, a CI runner — same check `App.tsx` uses before enabling the
 * mouse) means there's no one to show an animation to and no raw-mode
 * keypress to skip it with, so waiting out the timer would just be a fixed
 * delay on every scripted invocation for nothing.
 */
function shouldSkip(stdin: NodeJS.ReadStream | undefined, stdout: NodeJS.WriteStream | undefined): boolean {
  if (!stdin || !stdout?.isTTY) return true;
  return (stdout.columns ?? 80) < MIN_COLUMNS || (stdout.rows ?? 24) < MIN_ROWS;
}

/** The settled state a node is in at `frame`, replaying its `Run`s in order. */
function stateAt(frame: number, runs: Run[]): NodeState {
  let state: NodeState = 'idle';
  for (const run of runs) {
    if (frame < run.start) break;
    if (frame < run.end) {
      state = 'running';
      break;
    }
    state = run.status;
  }
  return state;
}

/** Same idle/running/done/error glyphs and colors as `STATUS_GLYPHS`/`STATUS_STYLES` in canvas.ts. */
function glyphFor(state: NodeState, frame: number): { glyph: string; color?: string; dim?: boolean } {
  if (state === 'idle') return { glyph: '○', dim: true };
  if (state === 'running') return { glyph: spinnerFrame(frame), color: 'cyan' };
  if (state === 'error') return { glyph: '✖', color: 'red' };
  return { glyph: '●', color: 'green' };
}

/** Renders a `glyphFor` result — split out so the optional `color`/`dim` fields never reach `Text` as an explicit `undefined`. */
function Glyph({ glyph, color, dim }: { glyph: string; color?: string; dim?: boolean }): React.ReactElement {
  return (
    <Text {...(color ? { color } : {})} {...(dim ? { dimColor: true } : {})}>
      {glyph}
    </Text>
  );
}

/** An arrow between two nodes: bright once the node behind it is done, dim otherwise (including while it's being retried). */
function Arrow({ lit }: { lit: boolean }): React.ReactElement {
  return <Text dimColor={!lit}>{'───▶'}</Text>;
}

/** The storyline caption at `frame`: the failure, the retry, and the terminal green "ready". */
export function captionAt(frame: number): { text: string; color: string } | null {
  if (frame >= D_END && frame < RETRY_START) return { text: 'failed', color: 'red' };
  if (frame >= RETRY_START && frame < D2_END) return { text: 'retrying…', color: 'yellow' };
  if (frame >= WORDMARK_REVEAL_END) return { text: 'ready', color: 'green' };
  return null;
}

/** How many of the four wordmark FIGlet lines are visible at `frame` — one per frame from `WORDMARK_START`. */
export function wordmarkLinesAt(frame: number): number {
  if (frame < WORDMARK_START) return 0;
  return Math.min(WORDMARK_LINE_COUNT, frame - WORDMARK_START + 1);
}

const FIREWORK_GLYPHS = ['✧', '✷', '✦', '✳'];
const FIREWORK_COLORS = ['yellow', 'magenta', 'cyan', 'green'];
/** Sparks pop in center-out rather than left-to-right, so it reads as a burst instead of a scan. */
const REVEAL_ORDER = [1, 2, 0, 3];

const WORDMARK_LINES = [
  '   __ _                           _     ',
  '  / _| |_____ __ _____ __ ___  __| |___ ',
  ' |  _| / _ \\ V  V /___/ _/ _ \\/ _` / -_)',
  ' |_| |_\\___/\\_/\\_/    \\__\\___/\\__,_\\___|',
];

export function Splash({ onDone }: { onDone: () => void }): React.ReactElement | null {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const [frame, setFrame] = useState(0);
  const skip = shouldSkip(stdin, stdout);
  // Guards against the interval and a stray keypress both firing onDone —
  // the caller unmounts this component and mounts the real UI on the first
  // call, and a second call would do that twice.
  const doneRef = useRef(false);
  const finish = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  useInput(() => finish());

  useEffect(() => {
    if (skip) {
      // Deferred rather than called inline: this effect can run synchronously
      // within the caller's `render()` call, and `onDone` (in ui/index.ts)
      // closes over the `const` holding that same render's return value —
      // calling it inline risks a TDZ crash ("Cannot access 'splash' before
      // initialization") by firing before that assignment completes.
      const timer = setTimeout(finish, 0);
      return () => clearTimeout(timer);
    }
    // Capped rather than left to run past the end: the updater has to stay a
    // pure function of the previous frame (see the completion effect below),
    // so it can't be the thing that stops its own interval. Once it pins at
    // AUTO_DONE_FRAME the state stops changing, React bails out of the
    // re-render, and the caller unmounts us a tick later anyway.
    const timer = setInterval(() => setFrame((f) => Math.min(f + 1, AUTO_DONE_FRAME)), FRAME_MS);
    return () => clearInterval(timer);
    // `finish` is intentionally not a dependency: it closes over `onDone`
    // and the guard ref, neither of which changes across this component's
    // short lifetime, and including it would just churn the interval.
  }, [skip]);

  // Completion is decided here rather than inside the setFrame updater above.
  // `finish` unmounts this tree and mounts the next Ink instance, and running
  // that from a render-phase callback made the new instance's effects flush
  // synchronously — which is what let App claim raw mode *before* the splash
  // instance's own deferred teardown turned it back off (see the handoff
  // comment in ui/index.ts). An effect is also simply where a side effect of
  // this size belongs; updaters must be re-runnable.
  useEffect(() => {
    if (!skip && frame >= AUTO_DONE_FRAME) finish();
    // Same reasoning as above for leaving `finish` out of the deps.
  }, [skip, frame]);

  if (skip) return null;

  const states = NODE_IDS.map((id) => stateAt(frame, RUNS[id]));
  const caption = captionAt(frame);
  const showFireworks = frame >= FIREWORK_START && frame < WORDMARK_START;
  const showsWordmark = frame >= WORDMARK_START;
  const wordmarkLines = wordmarkLinesAt(frame);
  const showHint = frame < WORDMARK_START;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
      <Box flexDirection="row">
        {NODE_IDS.map((id, i) => (
          <React.Fragment key={id}>
            <Glyph {...glyphFor(states[i]!, frame)} />
            <Text> {id} </Text>
            {i < NODE_IDS.length - 1 ? <Arrow lit={states[i] === 'done'} /> : null}
          </React.Fragment>
        ))}
      </Box>
      {/* One row for the storyline caption plus the skip hint, so the chain
          never shifts when either appears or disappears. */}
      <Box flexDirection="row" minHeight={1}>
        {caption ? <Text color={caption.color}>{caption.text}</Text> : null}
        {caption && showHint ? <Text> · </Text> : null}
        {showHint ? (
          <Text dimColor>press any key to skip</Text>
        ) : null}
      </Box>
      {/* The firework row, the four wordmark lines, and the tagline all share
          one fixed-height region so your eye never jumps when the firework
          hands off to the logo — the row count below it is constant the whole
          way through. */}
      <Box flexDirection="column" marginTop={1} minHeight={1 + WORDMARK_LINE_COUNT + 1}>
        {showFireworks ? (
          <Box flexDirection="row">
            {FIREWORK_GLYPHS.map((glyph, pos) => {
              const revealFrame = FIREWORK_START + REVEAL_ORDER.indexOf(pos);
              const lit = frame >= revealFrame;
              return (
                <Text key={pos} {...(lit ? { color: FIREWORK_COLORS[pos] } : {})} dimColor={!lit}>
                  {lit ? `${glyph} ` : '  '}
                </Text>
              );
            })}
          </Box>
        ) : null}
        {showsWordmark
          ? WORDMARK_LINES.slice(0, wordmarkLines).map((line, i) => (
              <Text key={i} bold color="cyan">
                {line}
              </Text>
            ))
          : null}
        <Text dimColor>
          {showsWordmark && wordmarkLines >= WORDMARK_LINE_COUNT ? 'agentic workflows, on your repo' : ''}
        </Text>
      </Box>
    </Box>
  );
}