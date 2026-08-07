// Voice companion route: POST /eve/v1/app.
//
// The Android phone and watch apps do speech-to-text on the device and send plain
// text here; the reply comes back in the same response so the app can read it aloud.
// Without a synchronous reply there is no voice loop, which is the whole point of
// the apps — so this handler waits for the turn instead of acknowledging and running
// in the background like the Telegram webhook does.
//
// The turn lands in the SAME session as the Telegram chat: `send` continues whatever
// session owns the chat's continuation token, so a conversation started from the watch
// carries on in Telegram and back. That also means the reply is delivered to Telegram
// by the channel's own `message.completed` handler (agent/channels/telegram.ts) — we
// must NOT mirror it a second time. Only the dictated text needs an explicit echo,
// because it never passed through Telegram at all.
//
// This route lives in the Telegram channel's route list on purpose: eve namespaces
// continuation tokens per authored channel, so a channel of its own would address a
// different session (see the comment above the reset route).
import type { RouteHandlerArgs } from "eve/channels";
import {
  telegramContinuationToken,
  type TelegramChannelState,
} from "eve/channels/telegram";
import { extractBearerToken } from "eve/channels/auth";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { chatKeyOf, getChatStatus } from "../../agent/lib/run-status.ts";
import { sendTelegramHtml } from "./telegram-send.ts";
import { scanOutbound } from "./security-gate.ts";

/** Highest number of requests per rolling minute (each mounted route gets its own budget). */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
/** A dictation is speech, not a document; anything past this is a client bug or an abuse. */
const MAX_TEXT_CHARS = 12_000;
const MAX_BODY_BYTES = 64 * 1024;

/** Sliding-window limiter; one instance per route so a stolen token can't burn either freely. */
function createRateLimiter(limit: number, windowMs: number) {
  const hits: number[] = [];
  return function rateLimited(now: number): boolean {
    const cutoff = now - windowMs;
    while (hits.length > 0 && hits[0] !== undefined && hits[0] <= cutoff)
      hits.shift();
    if (hits.length >= limit) return true;
    hits.push(now);
    return false;
  };
}
/** How long a turn may run before the app gets 504 and stops waiting. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Where the resident voice server listens. Loopback only; see scripts/voice/server.py. */
const VOICE_URL = process.env.IVA_VOICE_URL ?? "http://127.0.0.1:8730/say";
/** Synthesis is seconds, not minutes: past this the app is better off with its own voice. */
const VOICE_TIMEOUT_MS = 30_000;

export interface AppRouteConfig {
  /** Shared secret the apps present as `Authorization: Bearer …`. */
  readonly bearer: string | undefined;
  /** Telegram chat the app speaks into — the same one the owner uses. */
  readonly chatId: string | undefined;
  /** Telegram user id the turn is attributed to. */
  readonly userId: string | undefined;
  /** Mirrors the dictated text into the chat. Never throws. */
  readonly echo: (text: string) => Promise<unknown>;
  /**
   * Delivers a service message (the pairing code) to the owner's chat. Returns false
   * when Telegram did not take it — the caller must know, because a code nobody saw
   * is a pairing that silently never completes.
   */
  readonly notify: (text: string) => Promise<boolean>;
  /** True while a turn is already running on that chat. */
  readonly isBusy: (chatId: string) => boolean;
  readonly now: () => number;
  readonly timeoutMs: number;
}

type AppRouteArgs = Pick<
  RouteHandlerArgs<TelegramChannelState>,
  "send" | "resolveActiveSession" | "getSession"
>;

/** Timing-safe secret comparison, same shape as agent/lib/eve-auth.ts. */
function equalSecret(left: string, right: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * Reads `text` out of the request body. Anything that is not a JSON object with a
 * non-blank `text` string is a client mistake, not an empty turn: a dictation that
 * produced nothing must never reach the model.
 */
async function readText(request: Request): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const text = (parsed as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Rejects an oversized body before it is read into memory. A dictation is short; a
 * multi-megabyte body is either a bug or an attempt to OOM the box or flood the chat
 * with the echo (which gets chunked into a Telegram message per 4096 chars).
 */
function oversizedBody(request: Request): boolean {
  const length = Number(request.headers.get("content-length"));
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

/**
 * Collects the assistant text of one turn from the session's durable event stream.
 *
 * `send` resolves as soon as the session accepts the message, not when the turn ends,
 * so the reply has to be read from the stream. The filter matches the one the channel
 * uses to decide what to post to Telegram (`finishReason === "tool-calls"` and empty
 * messages are steps, not answers) — the app hears exactly what appears in the chat.
 */
async function collectReply(
  // `data` is optional because a few session-level events carry none.
  stream: ReadableStream<{
    readonly type: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }>,
  deadlineAt: number,
  now: () => number,
): Promise<
  | { readonly status: "completed"; readonly reply: string }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" }
> {
  const reader = stream.getReader();
  const parts: string[] = [];
  // Lock onto OUR turn. We took the stream position before sending, so if another turn
  // was already running its `turn.started` is behind us and only its tail is in view —
  // skipping everything until the first `turn.started` drops that tail. After locking,
  // events from any other (interleaved) turn are ignored: the app hears one answer, its
  // own, never a racing turn's reply. Events carry `turnId`; the old code read none.
  let turnId: string | undefined;
  try {
    for (;;) {
      const remaining = deadlineAt - now();
      if (remaining <= 0) return { status: "timeout" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      let step: "timeout" | Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (step === "timeout") return { status: "timeout" };
      // The stream ending before a terminal event means the session went away
      // mid-turn; treat it as a timeout so the app says something rather than
      // reading an empty reply aloud.
      if (step.done) return { status: "timeout" };
      const event = step.value;
      const data = event.data ?? {};
      const eventTurn =
        typeof data.turnId === "string" ? data.turnId : undefined;
      if (event.type === "turn.started") {
        if (turnId === undefined) turnId = eventTurn;
        continue;
      }
      // Not our turn yet (still draining a turn that was live when we started), or a
      // different turn's event once we have locked ours.
      if (turnId === undefined) continue;
      if (eventTurn !== undefined && eventTurn !== turnId) continue;
      if (event.type === "message.completed") {
        const message = data.message;
        if (
          data.finishReason !== "tool-calls" &&
          typeof message === "string" &&
          message.length > 0
        )
          parts.push(message);
        continue;
      }
      if (event.type === "turn.completed")
        return { status: "completed", reply: parts.join("\n\n") };
      if (event.type === "turn.cancelled") return { status: "cancelled" };
      if (event.type === "turn.failed")
        return {
          status: "failed",
          message:
            typeof data.message === "string" ? data.message : "turn failed",
        };
    }
  } finally {
    reader.releaseLock();
    // Reading stops at the terminal event, but the stream stays open — drop it so
    // the session does not keep a consumer around for every voice turn.
    void stream.cancel().catch(() => {});
  }
}

/**
 * Rejects a request that does not carry the app secret. Returns null when it does.
 *
 * Fail-closed: an unset secret locks everyone out rather than letting everyone in.
 * These routes are the only thing the reverse proxy publishes, so a missing
 * `IVA_APP_BEARER` must not become an open door to the assistant.
 */
function unauthorized(
  config: AppRouteConfig,
  request: Request,
): Response | null {
  const expected = config.bearer?.trim();
  const received = extractBearerToken(request.headers.get("authorization"));
  if (expected && received && equalSecret(received, expected)) return null;
  console.error("[app] rejected a request with a bad or missing bearer");
  return json({ error: "unauthorized" }, 401);
}

/**
 * Speaks a reply in Iva's own voice instead of the phone's.
 *
 * A separate request from the turn on purpose: the answer reaches the app as soon as
 * it exists, and the audio follows a few seconds later. Any failure here is answered
 * plainly so the app can fall back to the voice built into the device — a companion
 * that stays silent because a model is down is worse than one that sounds generic.
 */
export function createVoiceRoute(config: AppRouteConfig) {
  const rateLimited = createRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
  return async function handleVoiceRequest(
    request: Request,
  ): Promise<Response> {
    const rejected = unauthorized(config, request);
    if (rejected) return rejected;
    // Synthesis is the expensive endpoint (CPU, one at a time behind a global lock in
    // server.py). Even an authenticated client must not be able to spin it unbounded.
    if (rateLimited(config.now())) return json({ error: "slow down" }, 429);
    if (oversizedBody(request)) return json({ error: "too large" }, 413);

    const text = await readText(request);
    if (text === null) return json({ error: "text is required" }, 400);
    if (text.length > MAX_TEXT_CHARS) return json({ error: "too long" }, 413);

    try {
      const spoken = await fetch(VOICE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
      });
      if (!spoken.ok) {
        console.error("[app] voce non disponibile:", spoken.status);
        return json({ error: "voice unavailable" }, 503);
      }
      return new Response(spoken.body, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    } catch (error) {
      console.error("[app] voce irraggiungibile:", error);
      return json({ error: "voice unavailable" }, 503);
    }
  };
}

/** How long a pairing code stays claimable. */
const PAIR_CODE_TTL_MS = 5 * 60_000;
/** Minimum pause between two codes: an unauthenticated endpoint must not become a Telegram firehose. */
const PAIR_ISSUE_COOLDOWN_MS = 30_000;
/** Wrong guesses one code survives before it dies. 5 tries against 10^6 codes. */
const PAIR_MAX_ATTEMPTS = 5;

/**
 * Device pairing: how a watch gets the bearer without anyone typing 43 characters
 * on a watch. POST /pair sends a six-digit code to the owner's Telegram; POST
 * /pair/claim trades that code for the bearer token.
 *
 * Both endpoints are deliberately unauthenticated — the whole point is that the
 * device has no credentials yet. What keeps them safe: the code only ever appears in
 * the owner's own chat, one code is active at a time, it dies after five wrong
 * guesses or five minutes, and issuing is cooled down so strangers cannot spam the
 * chat or farm guesses.
 */
export function createPairRoutes(config: AppRouteConfig) {
  let active: {
    code: string;
    expiresAt: number;
    attemptsLeft: number;
  } | null = null;
  let lastIssuedAt: number | null = null;

  async function issue(): Promise<Response> {
    if (!config.bearer?.trim()) return json({ error: "not configured" }, 503);
    const now = config.now();
    if (lastIssuedAt !== null && now - lastIssuedAt < PAIR_ISSUE_COOLDOWN_MS)
      return json({ error: "slow down" }, 429);
    lastIssuedAt = now;
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    active = {
      code,
      expiresAt: now + PAIR_CODE_TTL_MS,
      attemptsLeft: PAIR_MAX_ATTEMPTS,
    };
    const delivered = await config.notify(
      `⌚ Codice per collegare l'app: <b>${code}</b> — vale 5 minuti. ` +
        "Se non l'hai chiesto tu, ignoralo.",
    );
    if (!delivered) {
      // A code nobody can read is only an extra guess window. Kill it.
      active = null;
      return json({ error: "telegram unavailable" }, 502);
    }
    return json({ ok: true }, 200);
  }

  async function claim(request: Request): Promise<Response> {
    const bearer = config.bearer?.trim();
    if (!bearer) return json({ error: "not configured" }, 503);
    const code = await readCode(request);
    if (code === null) return json({ error: "code is required" }, 400);
    const current = active;
    if (!current || config.now() > current.expiresAt)
      return json({ error: "no active code" }, 401);
    if (current.attemptsLeft <= 0) {
      active = null;
      return json({ error: "too many attempts" }, 429);
    }
    current.attemptsLeft -= 1;
    if (!equalSecret(code, current.code))
      return json({ error: "wrong code" }, 401);
    // One code, one device: a claimed code must not keep working.
    active = null;
    return json({ token: bearer }, 200);
  }

  return { issue, claim };
}

/** The `code` field of the claim body: exactly six digits, or nothing. */
async function readCode(request: Request): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const code = (parsed as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

/**
 * Builds the route handler. Everything the handler touches beyond eve itself arrives
 * through {@link AppRouteConfig}, so the tests drive it without a server, a network,
 * or a Telegram token.
 */
export function createAppRoute(config: AppRouteConfig) {
  const rateLimited = createRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);

  return async function handleAppRequest(
    request: Request,
    args: AppRouteArgs,
  ): Promise<Response> {
    const rejected = unauthorized(config, request);
    if (rejected) return rejected;
    if (!config.chatId || !config.userId)
      return json({ error: "chat not configured" }, 503);
    if (rateLimited(config.now())) return json({ error: "slow down" }, 429);
    if (oversizedBody(request)) return json({ error: "too large" }, 413);

    const text = await readText(request);
    if (text === null) return json({ error: "text is required" }, 400);
    if (text.length > MAX_TEXT_CHARS) return json({ error: "too long" }, 413);

    // The Telegram bridge buffers inbound messages while a turn runs; the app does
    // not pass through the bridge, so it would otherwise interleave with whatever
    // the chat is doing. Better to say "she's still answering" out loud.
    if (config.isBusy(config.chatId)) return json({ error: "busy" }, 409);

    const continuationToken = telegramContinuationToken({
      chatId: config.chatId,
    });

    // Take the stream position BEFORE sending: events recorded by our own turn must
    // not be missed, and reading from the current tail is the only way to skip the
    // history without racing the turn we are about to start.
    const active = await args.resolveActiveSession({ continuationToken });
    const startIndex = active
      ? (await args.getSession(active.sessionId).getStreamTailIndex()) + 1
      : 0;

    // The echo is what makes Telegram the archive of everything said from the wrist.
    // It goes out before the turn so the chat reads in the order it happened, and a
    // failed echo is logged inside `echo`, never fatal to the turn.
    await config.echo(text);

    const session = await args.send(text, {
      auth: {
        attributes: { chat_id: config.chatId, user_id: config.userId },
        authenticator: "iva-app",
        issuer: "telegram",
        principalId: `telegram:${config.userId}`,
        principalType: "user",
      },
      continuationToken,
      // Seed for a session that does not exist yet; ignored once one does, which is
      // the normal case here.
      state: {
        chatId: config.chatId,
        chatType: "private",
        conversationId: null,
        messageThreadId: null,
      },
    });

    const outcome = await collectReply(
      await session.getEventStream({ startIndex }),
      config.now() + config.timeoutMs,
      config.now,
    );
    if (outcome.status === "timeout")
      return json({ error: "timed out; check Telegram" }, 504);
    if (outcome.status === "cancelled")
      return json({ error: "cancelled" }, 409);
    if (outcome.status === "failed")
      return json({ error: outcome.message }, 502);
    // The Telegram delivery path redacts leaked secrets via scanOutbound; the app reads
    // the reply straight off the event stream, so redact it here too — otherwise the
    // phone/watch would receive (and read aloud) what Telegram would have hidden.
    return json({ reply: scanOutbound(outcome.reply).text }, 200);
  };
}

/** Wires the route to the real environment: the owner's chat, bot token and run status. */
export function defaultAppRouteConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppRouteConfig {
  const bot = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_DIGEST_CHAT_ID;
  return {
    bearer: env.IVA_APP_BEARER,
    chatId,
    // The allowlist is the same one the Telegram channel enforces; the first entry is
    // the owner, whose turns these are.
    userId: (env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)[0],
    echo: async (text) => {
      if (!bot || !chatId) return;
      const result = await sendTelegramHtml(bot, chatId, `🎙 ${text}`);
      if (!result.ok) console.error("[app] echo failed:", result.error);
    },
    notify: async (text) => {
      if (!bot || !chatId) return false;
      const result = await sendTelegramHtml(bot, chatId, text);
      if (!result.ok)
        console.error("[app] pairing code not delivered:", result.error);
      return result.ok;
    },
    isBusy: (chat) => getChatStatus(chatKeyOf(chat))?.status === "running",
    now: () => Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
