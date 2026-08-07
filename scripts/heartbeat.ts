// One heartbeat tick: wake the agent with nobody having asked anything, let it
// decide whether there is a reason to write, and send the message if there is.
//
// This is the only initiative Iva takes on her own. She does not act here — she
// thinks and may speak. Everything else still starts from the conversation the
// message opens.
//
// Shaped after scripts/daily-digest.ts: a fresh eve/client session, one
// instruction, one Telegram send. A fresh session per tick is deliberate — the
// tick must not inherit (or pollute) the chat's continuation, and the judgment
// it needs comes from the vault and tasks, not from conversation scrollback.
//
// Requires a running agent (eve start) plus TELEGRAM_BOT_TOKEN and
// TELEGRAM_DIGEST_CHAT_ID. Scheduled by agent/schedules/heartbeat.ts.
import { Client } from "eve/client";
import { statSync } from "node:fs";
import { join } from "node:path";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { loadJsonStrict, saveJsonAtomic } from "../agent/lib/json-store.ts";

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
const BEARER = process.env.ASSISTANT_BEARER;

const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/")
  ? DATA_DIR_RAW
  : join(process.cwd(), DATA_DIR_RAW);
const STATE_FILE = join(DATA_DIR, "heartbeat.json");

interface HeartbeatState {
  lastTickAt?: number;
  lastSpokeAt?: number;
  lastMessage?: string;
  ticksSinceSpoke?: number;
  /** Consecutive initiative messages Shy never answered. */
  unanswered?: number;
}

if (!BOT || !CHAT) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_DIGEST_CHAT_ID are required");
  process.exit(1);
}

// --dry: think out loud and print, send nothing, touch no state. This is how
// you tune the skill — run it ten times and count how often she picks PASS,
// without ten messages arriving. Running this script by hand at all bypasses
// the schedule's gates (enabled, interval, quiet hours) by design: those belong
// to the tick, not to the thinking.
const DRY = process.argv.includes("--dry");

const state = await loadJsonStrict<HeartbeatState>(STATE_FILE, {});
const now = Date.now();

// Claim the tick BEFORE thinking, not after. The schedule spaces ticks by
// lastTickAt, and a think can outlast a cron slot — writing it at the end would
// let a second tick start on top of a slow one. A crashed tick counting as
// spent is the right trade: it costs one skipped interval, not a retry storm.
if (!DRY) await saveJsonAtomic(STATE_FILE, { ...state, lastTickAt: now });

function hoursSince(at: number | undefined): string {
  if (!at) return "mai";
  const h = (now - at) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} minuti fa` : `${Math.round(h)} ore fa`;
}

// Whether Shy has written in the chat since her last initiative message. A
// fresh tick session cannot see the chat, so without this she cannot tell "he
// answered and we moved on" from "he ghosted me" — and a follow-up rule is
// unwritable. The per-chat run-status file is only touched by chat turns, and
// a chat turn only exists when he sends a message, so its mtime is the last
// time he was present. (chatKeyOf for a private chat is `${chatId}:`, and the
// file name is its base64url — mirrored from agent/lib/run-status.ts.)
function lastChatActivity(): number | null {
  try {
    const key = Buffer.from(`${CHAT}:`, "utf8").toString("base64url");
    return statSync(join(DATA_DIR, "run-status.d", `${key}.json`)).mtimeMs;
  } catch {
    return null; // no chat yet, or unreadable — say nothing rather than guess
  }
}

const chatAt = lastChatActivity();
const ghosted =
  typeof state.lastSpokeAt === "number" &&
  chatAt !== null &&
  chatAt < state.lastSpokeAt;

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

// The last message is quoted back so she can tell repetition from novelty —
// the skill's hardest rule ("don't say it twice") needs the evidence, and a
// fresh session has no memory of what the previous tick sent.
const response = await client.session().send(
  [
    "Battito. Nessuno ti ha scritto: ti sei svegliata da sola.",
    "Carica lo skill `heartbeat` e seguilo.",
    `Hai parlato di tua iniziativa l'ultima volta: ${hoursSince(state.lastSpokeAt)}.`,
    state.lastMessage
      ? `L'ultima cosa che gli hai detto di tua iniziativa: «${state.lastMessage}»`
      : "Non gli hai mai scritto di tua iniziativa.",
    ...(ghosted
      ? [
          `Shy NON ha più scritto in chat dopo quel messaggio ` +
            `(ti ha lasciata senza risposta; suoi messaggi mancati di fila: ` +
            `${state.unanswered ?? 1}).`,
        ]
      : state.lastSpokeAt
        ? ["Shy ha scritto in chat dopo il tuo ultimo messaggio."]
        : []),
    "Rispondi con PASS oppure con il solo testo del messaggio.",
    // Silence is the right answer most of the time, but a bare PASS is
    // untunable: you cannot tell good judgment from a tick that looked at
    // nothing. In a dry run only, ask for the reasoning — real ticks stay
    // strict so the exact-match check below keeps working.
    ...(DRY
      ? [
          "SEI IN PROVA: dopo PASS vai a capo e scrivi 2-3 righe su cosa hai",
          "guardato (CORE, task aperte, log di oggi) e perché non vale la pena",
          "parlare. Se invece scrivi il messaggio, non aggiungere spiegazioni.",
        ]
      : []),
  ].join("\n"),
);
const result = await response.result();

async function persist(patch: HeartbeatState): Promise<void> {
  if (DRY) return;
  await saveJsonAtomic(STATE_FILE, { ...state, lastTickAt: now, ...patch });
}

if (result.status === "failed" || !result.message) {
  // A failed tick is not an incident: there is no user waiting on it. Record it
  // and let the next one try, rather than exiting non-zero into the scheduler's
  // error path 96 times a day.
  console.log(`heartbeat: no answer (${result.status})`);
  await persist({ ticksSinceSpoke: (state.ticksSinceSpoke ?? 0) + 1 });
  process.exit(0);
}

const text = result.message.trim();

// Exact match on a real tick. A model that wraps PASS in a sentence has decided
// to talk, and the visible failure (one message too many) beats the invisible
// one. A dry run also accepts a leading PASS, because it asked for the reasoning
// that follows — that relaxation must never apply when a send is possible.
const passed = DRY ? /^PASS\b/.test(text) : text === "PASS";
if (passed) {
  const why = DRY ? text.replace(/^PASS\b[:.\s-]*/, "").trim() : "";
  console.log("heartbeat: PASS — niente da dire");
  if (why) console.log(`\nperché:\n${why}`);
  await persist({ ticksSinceSpoke: (state.ticksSinceSpoke ?? 0) + 1 });
  process.exit(0);
}

if (DRY) {
  console.log("heartbeat: AVREBBE SCRITTO (--dry, non inviato)\n");
  console.log(text);
  process.exit(0);
}

const sent = await sendTelegramHtml(BOT, CHAT, text);
if (!sent.ok) {
  console.error("heartbeat: Telegram send failed:", sent.error);
  await persist({ ticksSinceSpoke: (state.ticksSinceSpoke ?? 0) + 1 });
  process.exit(1);
}

await persist({
  lastSpokeAt: now,
  lastMessage: text,
  ticksSinceSpoke: 0,
  // If he never answered the previous one, this message joins the unanswered
  // streak; if he did answer, the streak restarts at one.
  unanswered: ghosted ? (state.unanswered ?? 1) + 1 : 1,
});
console.log("heartbeat: spoke");
