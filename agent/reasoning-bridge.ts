// Bridge between the model middleware and the Telegram channel.
//
// The reasoning (DeepSeek's chain of thought) arrives as `reasoning-delta`
// stream parts inside the model middleware (provider.ts). The channel that
// should show it runs in a different async context — the middleware has no
// chat id, the channel has no stream. They share only the process.
//
// So: a module singleton. iva is single-user and turns are serialized by the
// Telegram queue, so at most one turn reasons at a time and the buffer is
// unambiguous.
//
// ponytail: single active turn. If turns ever run truly concurrently (multi
// user, parallel chats), this would mix their reasoning — swap the singleton
// for a Map keyed by session id then. Not before.
//
// The reasoning is STILL stripped from the replayed history (provider.ts): this
// is a read-only tee for display, it does not change what the model sees next
// turn. That strip is load-bearing — a reasoning part without `text` crashes
// ai@7's prompt schema and mutes the session forever.

/** Off by default. Turn on with SHOW_REASONING=1 in .env. */
export const SHOW_REASONING = process.env.SHOW_REASONING === "1";

let buffer = "";
let active = false;

/** Turn start: open a fresh buffer for this turn's reasoning. */
export function beginReasoning(): void {
  buffer = "";
  active = true;
}

/** Called from the middleware for each reasoning-delta. No-op when no turn is active. */
export function pushReasoning(delta: string): void {
  if (active && delta) buffer += delta;
}

/** The reasoning accumulated so far this turn (for the live draft). */
export function currentReasoning(): string {
  return buffer;
}

/** Turn end: return the full reasoning and reset. */
export function endReasoning(): string {
  const full = buffer;
  buffer = "";
  active = false;
  return full;
}
