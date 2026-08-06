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
import { createHash, timingSafeEqual } from "node:crypto";
import { chatKeyOf, getChatStatus } from "../../agent/lib/run-status.ts";
import { sendTelegramHtml } from "./telegram-send.ts";

/** Highest number of requests one token may spend per rolling minute. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
/** How long a turn may run before the app gets 504 and stops waiting. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AppRouteConfig {
  /** Shared secret the apps present as `Authorization: Bearer …`. */
  readonly bearer: string | undefined;
  /** Telegram chat the app speaks into — the same one the owner uses. */
  readonly chatId: string | undefined;
  /** Telegram user id the turn is attributed to. */
  readonly userId: string | undefined;
  /** Mirrors the dictated text into the chat. Never throws. */
  readonly echo: (text: string) => Promise<unknown>;
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
 * Builds the route handler. Everything the handler touches beyond eve itself arrives
 * through {@link AppRouteConfig}, so the tests drive it without a server, a network,
 * or a Telegram token.
 */
export function createAppRoute(config: AppRouteConfig) {
  const hits: number[] = [];

  function rateLimited(now: number): boolean {
    const cutoff = now - RATE_WINDOW_MS;
    while (hits.length > 0 && hits[0] !== undefined && hits[0] <= cutoff)
      hits.shift();
    if (hits.length >= RATE_LIMIT) return true;
    hits.push(now);
    return false;
  }

  return async function handleAppRequest(
    request: Request,
    args: AppRouteArgs,
  ): Promise<Response> {
    // Fail-closed: an unset secret locks everyone out rather than letting everyone
    // in. This route is the one thing the reverse proxy publishes, so a missing
    // `IVA_APP_BEARER` must not become an open door to the assistant.
    const expected = config.bearer?.trim();
    const received = extractBearerToken(request.headers.get("authorization"));
    if (!expected || !received || !equalSecret(received, expected)) {
      console.error("[app] rejected a request with a bad or missing bearer");
      return json({ error: "unauthorized" }, 401);
    }
    if (!config.chatId || !config.userId)
      return json({ error: "chat not configured" }, 503);
    if (rateLimited(config.now())) return json({ error: "slow down" }, 429);

    const text = await readText(request);
    if (text === null) return json({ error: "text is required" }, 400);

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
    return json({ reply: outcome.reply }, 200);
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
    isBusy: (chat) => getChatStatus(chatKeyOf(chat))?.status === "running",
    now: () => Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
