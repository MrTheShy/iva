// One leg of a Claude Code conversation, detached from Iva's turn.
//
// The tool (agent/tools/claude_work.ts) spawns this under systemd-run and
// returns immediately, so the chat stays free while Claude thinks. This script
// runs the exchange, then opens a dedicated eve/client turn — the same pattern
// as the digest and the rollups — where Iva evaluates the reply and decides:
// continue the exchange (another claude_work say, which spawns the next leg),
// send something to Shy, or close with PASS.
//
// No daemon and no held pipe anywhere in the chain: every leg is a short-lived
// process, the conversation's memory lives in Claude Code's session store, and
// Iva's side of the loop is a fresh judgment turn per leg. An iva restart in
// the middle costs nothing — this unit is not in iva.service's cgroup.
//
// Runs with node --env-file=.env (it needs the bot token and the bearer); the
// claude child gets the allowlisted environment only.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "eve/client";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../agent/lib/json-store.ts";
import {
  envForClaude,
  isSessionId,
  pruneLegs,
  resolveWorkdir,
  type SessionEntry,
} from "./lib/claude-work-guards.ts";

const run = promisify(execFile);

const [, , project = "", freshFlag = "0", message = ""] = process.argv;
if (!project || !message.trim()) {
  console.error("uso: claude-run.ts <project> <fresh 0|1> <message>");
  process.exit(1);
}
const dir = resolveWorkdir(project);

const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/")
  ? DATA_DIR_RAW
  : join(process.cwd(), DATA_DIR_RAW);
const SESSIONS = join(DATA_DIR, "claude-sessions.json");
const LOCK = `${SESSIONS}.lock`;

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
const BEARER = process.env.ASSISTANT_BEARER;

if (!BOT || !CHAT) {
  console.error("TELEGRAM_BOT_TOKEN e TELEGRAM_DIGEST_CHAT_ID obbligatori");
  process.exit(1);
}

// Implementation work takes real time; nothing waits on this process, so the
// budget is generous. The transient unit has RuntimeMaxSec above it as the
// absolute stop.
const CLAUDE_TIMEOUT_MS = 45 * 60_000;

type SessionMap = Record<string, SessionEntry>;

async function mutateSessions(
  mutate: (entry: SessionEntry) => void,
): Promise<void> {
  const token = await acquireLock(LOCK);
  try {
    const map = await loadJsonStrict<SessionMap>(SESSIONS, {});
    const entry = (map[project] = map[project] ?? {});
    mutate(entry);
    await saveJsonAtomic(SESSIONS, map);
  } finally {
    releaseLock(LOCK, token);
  }
}

async function notify(md: string): Promise<void> {
  const r = await sendTelegramHtml(BOT, CHAT, md);
  if (!r.ok) console.error("claude-run: invio Telegram fallito:", r.error);
}

const before = await loadJsonStrict<SessionMap>(SESSIONS, {});
const sid =
  freshFlag === "1"
    ? undefined
    : isSessionId(before[project]?.id)
      ? before[project]?.id
      : undefined;

let stdout = "";
try {
  ({ stdout } = await run(
    "claude",
    [
      "-p",
      message,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      ...(sid ? ["--resume", sid] : []),
    ],
    {
      cwd: dir,
      env: envForClaude(),
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 32_000_000,
    },
  ));
} catch (e) {
  await mutateSessions((entry) => delete entry.busyAt);
  const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  await notify(`⚠️ Scambio con Claude su **${project}** fallito: ${why}`);
  process.exit(1);
}

interface ClaudeResult {
  session_id?: unknown;
  result?: unknown;
  is_error?: unknown;
}
let parsed: ClaudeResult;
try {
  parsed = JSON.parse(stdout) as ClaudeResult;
} catch {
  await mutateSessions((entry) => delete entry.busyAt);
  await notify(`⚠️ Risposta di Claude su **${project}** non interpretabile.`);
  process.exit(1);
}

const newId = isSessionId(parsed.session_id) ? parsed.session_id : undefined;
// The claude process is done: release the busy claim BEFORE the judgment turn,
// so that turn can itself start the next leg without tripping over ours.
await mutateSessions((entry) => {
  delete entry.busyAt;
  if (newId) entry.id = newId;
});

const reply =
  typeof parsed.result === "string"
    ? parsed.result
    : JSON.stringify(parsed).slice(0, 4000);

if (parsed.is_error === true) {
  await notify(
    `⚠️ Claude su **${project}** riporta un errore:\n${reply.slice(0, 1000)}`,
  );
  process.exit(1);
}

const now = await loadJsonStrict<SessionMap>(SESSIONS, {});
const legsHour = pruneLegs(now[project]?.legs, Date.now()).length;

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

const prompt = [
  `Turno di orchestrazione: è arrivata la risposta di Claude Code sul progetto «${project}».`,
  `Scambi con Claude su questo progetto nell'ultima ora: ${legsHour}.`,
  `Messaggio che gli era stato mandato: «${message.slice(0, 500)}»`,
  "Risposta di Claude:",
  "<<<",
  reply.slice(0, 6000),
  ">>>",
  "Carica lo skill `claude-work` e decidi il prossimo passo: continuare lo " +
    "scambio con il tool claude_work, oppure riportare qualcosa a Shy, oppure " +
    "chiudere qui.",
  "Il testo finale di questo turno viene inviato a Shy su Telegram tale e " +
    "quale. Se non c'è niente che valga la pena mandargli, rispondi " +
    "esattamente PASS.",
].join("\n");

const result = await (await client.session().send(prompt)).result();

if (result.status === "failed" || !result.message) {
  // The judgment turn failing must not swallow Claude's reply.
  await notify(
    `Claude su **${project}** ha risposto, ma la valutazione è fallita ` +
      `(${result.status}). Risposta:\n\n${reply.slice(0, 1500)}`,
  );
  process.exit(1);
}

const text = result.message.trim();
if (text !== "PASS") {
  await notify(text);
  console.log("claude-run: riportato a Shy");
} else {
  console.log("claude-run: PASS");
}
