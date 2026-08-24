/**
 * Move a recording's clock to now, just before it is replayed.
 *
 * A finished node reports `endedAt - startedAt`, which is a fact and survives
 * replay untouched. A *running* node has no end yet, so the card reports
 * `now - startedAt` — and against a recording made days ago that renders as
 * `12h39m` beside an agent pane saying `17s`. Shifting every timestamp by one
 * constant leaves all durations exactly as recorded and makes the live counter
 * mean what it says again.
 *
 * Run at launch, not at capture: the shift is only correct relative to the
 * moment playback actually starts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out, delayArg] = process.argv.slice(2);
const delay = Number(delayArg ?? 0);

const text = readFileSync(src, 'utf8');
const first = JSON.parse(text.slice(0, text.indexOf('\n')));
const shiftMs = Date.now() + delay * 1000 - Date.parse(first.state.createdAt);

// Every ISO-8601 instant in the document moves together — createdAt, each
// node's startedAt/endedAt, gate decisions, the owner's claim.
const ISO = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"/g;
writeFileSync(
  out,
  text.replace(ISO, (_m, ts) => `"${new Date(Date.parse(ts) + shiftMs).toISOString()}"`),
);
