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
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../agent/lib/json-store.ts";
import {
  applyAbsence,
  applyDecay,
  defaultMood,
  type Mood,
} from "./lib/mood.ts";
import { sendRing } from "./lib/fcm.ts";

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
const LOCK = `${STATE_FILE}.lock`;

interface HeartbeatState {
  lastTickAt?: number;
  lastSpokeAt?: number;
  lastMessage?: string;
  ticksSinceSpoke?: number;
  /** Consecutive initiative messages Shy never answered. */
  unanswered?: number;
}

// Every write is a locked read-modify-write against the CURRENT file, not the
// snapshot loaded at process start: a menu "Beat now" racing a scheduled tick must
// not clobber the other's lastSpokeAt/lastMessage (the "don't repeat yourself"
// evidence). The lock spans one file write, never the think.
async function withState(
  update: (current: HeartbeatState) => HeartbeatState,
): Promise<void> {
  const token = await acquireLock(LOCK);
  try {
    const current = await loadJsonStrict<HeartbeatState>(STATE_FILE, {});
    await saveJsonAtomic(STATE_FILE, update(current));
  } finally {
    releaseLock(LOCK, token);
  }
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

// He's mid-conversation — don't barge in. The chat's run-status file is touched by
// every chat turn, so recent activity means a turn is running or just ended. A fresh
// tick session can't see the chat, so this deterministic gate is the only way to
// honour heartbeat.md's "if he's clearly busy, wait". No claim on this path: the next
// 5-minute slot re-checks cheaply and ticks as soon as the chat goes quiet.
const RECENT_CHAT_MS = 3 * 60_000;
const chatAt = lastChatActivity();
if (!DRY && chatAt !== null && now - chatAt < RECENT_CHAT_MS) {
  console.log("heartbeat: chat active, holding off");
  process.exit(0);
}

// Claim the tick BEFORE thinking, not after. The schedule spaces ticks by
// lastTickAt, and a think can outlast a cron slot — writing it at the end would
// let a second tick start on top of a slow one. A crashed tick counting as
// spent is the right trade: it costs one skipped interval, not a retry storm.
if (!DRY) await withState((current) => ({ ...current, lastTickAt: now }));

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

const ghosted =
  typeof state.lastSpokeAt === "number" &&
  chatAt !== null &&
  chatAt < state.lastSpokeAt;

// The affective state evolves while nobody talks: moods drift back to baseline,
// and past 12 hours of silence curiosity builds up — but only in a warm
// relationship (scripts/lib/mood.ts). The tick is the only writer on this path;
// the other one is the appraisal hook at the end of each chat turn.
const MOOD_FILE = join(DATA_DIR, "mood.json");
const MOOD_LOCK = `${MOOD_FILE}.lock`;
async function evolveMood(): Promise<Mood> {
  const token = await acquireLock(MOOD_LOCK);
  try {
    const current = await loadJsonStrict<Mood>(MOOD_FILE, defaultMood(now));
    let mood = applyDecay(current, (now - current.updatedAt) / 3_600_000, now);
    if (chatAt !== null)
      mood = applyAbsence(mood, (now - chatAt) / 3_600_000, now);
    if (!DRY) await saveJsonAtomic(MOOD_FILE, mood);
    return mood;
  } finally {
    releaseLock(MOOD_LOCK, token);
  }
}
const mood = await evolveMood();

// A high-salience memory from the cold tiers, for reminiscence. Best-effort:
// no uv, no vault, no salient cards — no line in the prompt, never a failure.
function resurfacedMemories(): string {
  const vaultRaw = process.env.ASSISTANT_VAULT_DIR ?? "vault";
  const vault = vaultRaw.startsWith("/") ? vaultRaw : resolve(vaultRaw);
  const engine = resolve("scripts/autograph/engine.py");
  try {
    const r = spawnSync(
      "uv",
      ["run", engine, "creative", "3", ".", "--min-salience", "0.6"],
      { cwd: vault, encoding: "utf8", timeout: 20_000 },
    );
    if (r.status !== 0) return "";
    const out = (r.stdout ?? "").trim();
    return out.includes("[") ? out : "";
  } catch {
    return "";
  }
}
const memories = resurfacedMemories();

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
    `Il tuo stato affettivo: calore ${Math.round(mood.calore)}/100 · ` +
      `energia percepita di Shy ${Math.round(mood.energia)}/100 · ` +
      `curiosità ${Math.round(mood.curiosita)}/100.`,
    ...(mood.ultimaChiusura
      ? [
          `L'ultima conversazione si è chiusa ${mood.ultimaChiusura.tono} ` +
            `(${hoursSince(mood.ultimaChiusura.at)})` +
            (mood.ultimaChiusura.temaAperto
              ? ` — tema rimasto aperto: «${mood.ultimaChiusura.temaAperto}».`
              : "."),
        ]
      : []),
    ...(memories
      ? [
          "Ricordi riaffiorati dall'archivio (alta salienza, non toccati da tempo). " +
            "Riaprine uno SOLO se riaprirlo è utile a lui, non per riempire il silenzio:",
          memories,
        ]
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
  // Merge onto the CURRENT file under the lock, not the start-of-tick snapshot, so a
  // concurrent tick's lastSpokeAt/lastMessage survives.
  await withState((current) => ({ ...current, lastTickAt: now, ...patch }));
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
  // Send time, not tick-start: a message Shy sends DURING the think must count as
  // "after we spoke" so the next tick's ghost check reads it correctly.
  lastSpokeAt: Date.now(),
  lastMessage: text,
  ticksSinceSpoke: 0,
  // If he never answered the previous one, this message joins the unanswered
  // streak; if he did answer, the streak restarts at one.
  unanswered: ghosted ? (state.unanswered ?? 1) + 1 : 1,
});

// The wrist call: park the message in the inbox and wake the registered devices.
// The push carries no content — the watch fetches it back over the bearer route.
// Best-effort top to bottom: no Firebase, no tokens, no watch → Telegram already
// delivered, and that is the contract that matters.
try {
  await saveJsonAtomic(join(DATA_DIR, "app-inbox.json"), {
    text,
    at: Date.now(),
  });
  const store = await loadJsonStrict<{
    tokens?: Record<string, { platform: string; at: number }>;
  }>(join(DATA_DIR, "push-tokens.json"), {});
  const invalid = await sendRing(Object.keys(store.tokens ?? {}));
  // ponytail: i token morti non si potano qui — il cap a 5 sul registro li
  // spazza alla prossima registrazione, e un ring in più non costa niente.
  if (invalid.length > 0)
    console.log(`heartbeat: ${invalid.length} dead push tokens`);
} catch (error) {
  console.error("heartbeat: ring failed:", error);
}
console.log("heartbeat: spoke");
