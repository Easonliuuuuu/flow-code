import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { spinnerFrame } from './nodeCard.js';

/**
 * Brief, skippable animated intro for `flow-code run`/`flow-code watch`:
 * a chain of five nodes runs left to right, the fourth one fails, the
 * chain retries from the node after the last confirmed-good one, and a
 * small firework marks success before the logo settles in. Purely
 * decorative — it reflects no real state, just this process's own
 * startup — but the fail/retry beat mirrors a shape flow-code users will
 * recognize from real node graphs.
 */

const FRAME_MS = 200;
const RUN_FRAMES = 2;
/** How long the failed node holds its red glyph before the retry kicks off. */
const ERROR_HOLD = 3;

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
const FIREWORK_FRAMES = 5;
const WORDMARK_START = FIREWORK_START + FIREWORK_FRAMES;
const HOLD_FRAMES = 5;
const AUTO_DONE_FRAME = WORDMARK_START + HOLD_FRAMES;

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

/**
 * Whether the splash should skip itself rather than play: no TTY (a pipe, a
 * log file, a CI runner — same check `App.tsx` uses before enabling the
 * mouse) means there's no one to show an animation to and no raw-mode
 * keypress to skip it with, so waiting out the timer would just be a fixed
 * delay on every scripted invocation for nothing.
 */
function shouldSkip(stdin: NodeJS.ReadStream | undefined, stdout: NodeJS.WriteStream | undefined): boolean {
  if (!stdin || !stdout?.isTTY) return true;
  return (stdout.columns ?? 80) < MIN_COLUMNS;
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

function captionAt(frame: number): { text: string; color: string } | null {
  if (frame >= D_END && frame < RETRY_START) return { text: 'failed', color: 'red' };
  if (frame >= RETRY_START && frame < D2_END) return { text: 'retrying…', color: 'yellow' };
  return null;
}

const FIREWORK_GLYPHS = ['✧', '✷', '✦', '✳', '✧'];
const FIREWORK_COLORS = ['yellow', 'magenta', 'cyan', 'green', 'yellow'];
/** Sparks pop in center-out rather than left-to-right, so it reads as a burst instead of a scan. */
const REVEAL_ORDER = [2, 1, 3, 0, 4];

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
      finish();
      return;
    }
    const timer = setInterval(() => {
      setFrame((f) => {
        const next = f + 1;
        if (next >= AUTO_DONE_FRAME) {
          clearInterval(timer);
          finish();
        }
        return next;
      });
    }, FRAME_MS);
    return () => clearInterval(timer);
    // `finish` is intentionally not a dependency: it closes over `onDone`
    // and the guard ref, neither of which changes across this component's
    // short lifetime, and including it would just churn the interval.
  }, [skip]);

  if (skip) return null;

  const states = NODE_IDS.map((id) => stateAt(frame, RUNS[id]));
  const caption = captionAt(frame);
  const showFireworks = frame >= FIREWORK_START && frame < WORDMARK_START;
  const showWordmark = frame >= WORDMARK_START;

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
      <Box flexDirection="row" minHeight={1}>
        <Text {...(caption ? { color: caption.color } : {})}>{caption?.text ?? ''}</Text>
      </Box>
      {showFireworks ? (
        <Box flexDirection="row" marginTop={1}>
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
      {showWordmark ? (
        <Box flexDirection="column" marginTop={1}>
          {WORDMARK_LINES.map((line, i) => (
            <Text key={i} bold color="cyan">
              {line}
            </Text>
          ))}
          <Text dimColor>agentic workflows, on your repo</Text>
        </Box>
      ) : null}
    </Box>
  );
}
