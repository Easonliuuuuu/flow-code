import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { spinnerFrame } from './nodeCard.js';

/**
 * Brief, skippable animated intro for `flow-code run`/`flow-code watch` —
 * three tributary nodes converging into one, the same glyphs and colors the
 * canvas itself uses for node status (see `STATUS_STYLES` in canvas.ts),
 * before the real UI takes over. Shaped like a small DAG rather than a
 * straight line deliberately: it's the one animation that can only be
 * flow-code's, and the merge node correctly waits for all three tributaries
 * before it starts — the same rule `depsSatisfied` enforces for real.
 * Purely decorative otherwise: it reflects no real state, just this
 * process's own startup.
 */

const FRAME_MS = 80;
const INPUT_COUNT = 3;
/** Frames between one tributary starting its animation and the next. */
const STAGGER = 2;
/** Frames a node spends spinning before it flips to done. */
const RUN_FRAMES = 2;
/** The frame every tributary has reached `done` by — the merge node cannot start before this. */
const ALL_INPUTS_DONE_FRAME = (INPUT_COUNT - 1) * STAGGER + RUN_FRAMES;
const CONVERGENCE_DONE_FRAME = ALL_INPUTS_DONE_FRAME + RUN_FRAMES;
/** How long the settled wordmark holds before auto-continuing. */
const HOLD_FRAMES = 6;
const AUTO_DONE_FRAME = CONVERGENCE_DONE_FRAME + HOLD_FRAMES;

/** Below this width the diagram would wrap rather than fit, so the splash is skipped outright. */
const MIN_COLUMNS = 40;

type NodeState = 'idle' | 'running' | 'done';

function inputStateAt(frame: number, index: number): NodeState {
  const start = index * STAGGER;
  if (frame < start) return 'idle';
  if (frame < start + RUN_FRAMES) return 'running';
  return 'done';
}

function convergenceStateAt(frame: number): NodeState {
  if (frame < ALL_INPUTS_DONE_FRAME) return 'idle';
  if (frame < CONVERGENCE_DONE_FRAME) return 'running';
  return 'done';
}

/** Same idle/running/done color mapping as `STATUS_STYLES` in canvas.ts. */
function glyphFor(state: NodeState, frame: number): { glyph: string; color?: string; dim?: boolean } {
  if (state === 'idle') return { glyph: '○', dim: true };
  if (state === 'running') return { glyph: spinnerFrame(frame), color: 'cyan' };
  return { glyph: '●', color: 'green' };
}

/** A structural line/corner character: bright once its tributary has arrived, dim (unlit) until then. */
function Segment({ lit, children }: { lit: boolean; children: string }): React.ReactElement {
  return <Text dimColor={!lit}>{children}</Text>;
}

/** Renders a `glyphFor` result — split out so the optional `color`/`dim` fields never reach `Text` as an explicit `undefined`. */
function Glyph({ glyph, color, dim }: { glyph: string; color?: string; dim?: boolean }): React.ReactElement {
  return (
    <Text {...(color ? { color } : {})} {...(dim ? { dimColor: true } : {})}>
      {glyph}
    </Text>
  );
}

export function Splash({ onDone }: { onDone: () => void }): React.ReactElement | null {
  const { stdout } = useStdout();
  const [frame, setFrame] = useState(0);
  const columns = stdout?.columns ?? 80;
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
    if (columns < MIN_COLUMNS) {
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
  }, [columns]);

  if (columns < MIN_COLUMNS) return null;

  const top = inputStateAt(frame, 0);
  const mid = inputStateAt(frame, 1);
  const bottom = inputStateAt(frame, 2);
  const topDone = top === 'done';
  const bottomDone = bottom === 'done';
  const allInputsDone = topDone && mid === 'done' && bottomDone;
  const convergence = convergenceStateAt(frame);
  const convergenceGlyph = glyphFor(convergence, frame);
  const showWordmark = frame >= CONVERGENCE_DONE_FRAME;

  const topGlyph = glyphFor(top, frame);
  const midGlyph = glyphFor(mid, frame);
  const bottomGlyph = glyphFor(bottom, frame);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
      {/* Top tributary, turning down into the shared bus once it lands. */}
      <Box flexDirection="row">
        <Glyph {...topGlyph} />
        <Segment lit={topDone}>{'─╮'}</Segment>
      </Box>
      {/* Bus descending from the top tributary, plus the merge node's top border. */}
      <Box flexDirection="row">
        <Text>{'  '}</Text>
        <Segment lit={topDone}>{'│'}</Segment>
        <Text dimColor>{'  ╭───╮'}</Text>
      </Box>
      {/* Middle tributary feeds the junction directly; the junction and its
          onward arrow only light once all three tributaries have arrived —
          same rule a real node's dependencies enforce. */}
      <Box flexDirection="row">
        <Glyph {...midGlyph} />
        <Segment lit={mid === 'done'}>{'─'}</Segment>
        <Segment lit={allInputsDone}>{'┼─▶'}</Segment>
        <Text dimColor>{'│ '}</Text>
        <Glyph {...convergenceGlyph} />
        <Text dimColor>{' │'}</Text>
      </Box>
      {/* Bus ascending from the bottom tributary, plus the merge node's bottom border. */}
      <Box flexDirection="row">
        <Text>{'  '}</Text>
        <Segment lit={bottomDone}>{'│'}</Segment>
        <Text dimColor>{'  ╰───╯'}</Text>
      </Box>
      {/* Bottom tributary, turning up into the shared bus once it lands. */}
      <Box flexDirection="row">
        <Glyph {...bottomGlyph} />
        <Segment lit={bottomDone}>{'─╯'}</Segment>
      </Box>
      {showWordmark ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            flow-code
          </Text>
          <Text dimColor>agentic workflows, on your repo</Text>
        </Box>
      ) : null}
    </Box>
  );
}
