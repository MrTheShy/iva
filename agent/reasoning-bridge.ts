// Bridge between the model middleware and the Telegram channel.
//
// The reasoning (DeepSeek's chain of thought) arrives as `reasoning-delta`
// stream parts inside the model middleware (provider.ts). The channel that
// should show it runs in a different async context — the middleware has no
// chat id, the channel has no stream. They share only the process.
//
// So: a module singleton. The middleware cannot name a session, so the buffer
// cannot be keyed by one: `wrapStream` sees only the model call, never
// ctx.session. Everything below is about making that singleton honest rather
// than pretending it is unambiguous.
//
// It is NOT enough that the Telegram queue serializes chat turns. The nightly
// rollups and the digest run their turns through `eve/client` against the
// running server (scripts/memory/rollup.ts, scripts/daily-digest.ts), so they
// execute inside THIS process, on the same wrapped model, in a session the
// queue knows nothing about. Their reasoning deltas reach the middleware while
// a chat turn's buffer is open, and would be appended to it.
//
// Since the deltas cannot be attributed, a polluted buffer is discarded instead
// of displayed: agent/hooks/reasoning-scope.ts reports every model step that
// completes on a non-Telegram channel, and a buffer that saw one yields "".
// Showing nothing beats showing another session's thinking as if it were yours.
//
// ponytail: detection rides on `step.completed`, so a foreign step that starts
// inside the window and completes after it is missed. Tightening that needs a
// step-start signal carrying the channel kind — not worth it for a display.
//
// The reasoning is STILL stripped from the replayed history (provider.ts): this
// is a read-only tee for display, it does not change what the model sees next
// turn. That strip is load-bearing — a reasoning part without `text` crashes
// ai@7's prompt schema and mutes the session forever. It runs whether or not
// the display is on, which is why turning the feature off is only a matter of
// not opening a buffer.

// ".ts", not ".js": the /menu screen reads showReasoning() from the poller,
// which runs raw Node and does not rewrite the specifier the way eve's build
// does. Same reason i18n.ts imports settings this way.
import { readSettings } from "./lib/settings.ts";

/**
 * Whether to show the thinking, read fresh so a /menu tap applies to the very
 * next message with no restart (same contract as the loader word).
 *
 * settings.showReasoning wins when it is a boolean, because that is an explicit
 * choice made in the menu. SHOW_REASONING=1 in .env stays the fallback: it was
 * the only switch before the menu screen existed, and an install already using
 * it must not silently go quiet on upgrade. Off when neither says otherwise.
 *
 * Called once per turn by the channel, never per delta — the middleware does
 * not consult it at all. `pushReasoning` is already inert unless the channel
 * opened a buffer, so the decision lives in exactly one place.
 */
export function showReasoning(): boolean {
  const s = readSettings().showReasoning;
  if (typeof s === "boolean") return s;
  return process.env.SHOW_REASONING === "1";
}

let buffer = "";
let active = false;
let foreign = false;

/** Turn start: open a fresh buffer for this turn's reasoning. */
export function beginReasoning(): void {
  buffer = "";
  foreign = false;
  active = true;
}

/** Called from the middleware for each reasoning-delta. No-op when no turn is active. */
export function pushReasoning(delta: string): void {
  if (active && delta) buffer += delta;
}

/**
 * A model step completed on another channel while this buffer was open, so the
 * buffer may hold that session's thinking too. Poison it rather than guess.
 */
export function noteForeignStep(): void {
  if (active) foreign = true;
}

/** The reasoning accumulated so far this turn (for the live draft). */
export function currentReasoning(): string {
  return foreign ? "" : buffer;
}

/** Turn end: return the full reasoning and reset. Empty if it got polluted. */
export function endReasoning(): string {
  const full = foreign ? "" : buffer;
  buffer = "";
  active = false;
  foreign = false;
  return full;
}
