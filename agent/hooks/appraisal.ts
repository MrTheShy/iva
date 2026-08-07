import { defineHook } from "eve/hooks";
import { streamText } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeCodexModel, providerConfig, providerName } from "../provider.js";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../lib/json-store.js";
import {
  applyAppraisal,
  defaultMood,
  parseAppraisal,
  type Mood,
} from "../../scripts/lib/mood.ts";

// L'ensemble di Amadeus collassato a una chiamata: a fine turno di chat UNA
// valutazione piccola dello scambio aggiorna data/mood.json (calore, energia,
// curiosità, com'è finita). Lo stato vive fuori dalla finestra di contesto: il
// dialogo non lo convince a parole. Side-effect puro, mai fatale per il turno —
// stessa filosofia di transcript.ts.

const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const VAULT_DIR = process.env.ASSISTANT_VAULT_DIR ?? "vault";
const MOOD_FILE = join(DATA_DIR, "mood.json");
const MOOD_LOCK = join(DATA_DIR, "mood.json.lock");
// Un turno può chiudere più message.completed: una valutazione ogni 2 minuti basta,
// e il debounce esclude anche le cascate dei rollup notturni.
const DEBOUNCE_MS = 120_000;

const PROMPT =
  "You observe the tail of today's exchange between the owner and his assistant. " +
  "Judge ONLY the owner's side of the most recent exchange and answer with JSON alone, no prose: " +
  '{"valenza": -1..1 (how the exchange felt for the owner: warm/positive vs heavy/negative), ' +
  '"intensita": 0..1 (how emotionally charged it was), ' +
  '"chiusura": "calda"|"neutra"|"pesante" (how the exchange closed), ' +
  '"temaAperto": short label of an unresolved personal topic that clearly weighs on the owner, or null}. ' +
  "Routine task-talk is valenza 0, intensita 0, chiusura neutra, temaAperto null.";

function moodEnabled(): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(DATA_DIR, "settings.json"), "utf8"),
    );
    if (parsed === null || typeof parsed !== "object") return true;
    const mood = (parsed as Record<string, unknown>).mood;
    if (mood === null || typeof mood !== "object") return true;
    return (mood as Record<string, unknown>).enabled !== false;
  } catch {
    return true;
  }
}

/** La coda del transcript di oggi: entrambe le voci ci sono già (telegram + transcript hook). */
function dailyTail(): string {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.ASSISTANT_TIMEZONE || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  try {
    const text = readFileSync(join(VAULT_DIR, "daily", `${localDate}.md`), "utf8");
    return text.slice(-2000);
  } catch {
    return "";
  }
}

/** Vero se nell'estratto parla anche il proprietario — esclude heartbeat/digest/rollup. */
function hasOwnerVoice(tail: string): boolean {
  return /^## \d{2}:\d{2} (?!\[iva\])/m.test(tail);
}

async function judge(tail: string): Promise<string> {
  const excerpt = `Transcript tail:\n${tail}`;
  if (providerName === "codex") {
    // Il backend della subscription accetta solo stream:true (vedi agent/vision.ts).
    const result = streamText({
      model: makeCodexModel(),
      messages: [{ role: "user", content: `${PROMPT}\n\n${excerpt}` }],
    });
    let out = "";
    for await (const chunk of result.textStream) out += chunk;
    return out.trim();
  }
  const { baseURL, apiKey, textModel } = providerConfig;
  if (!apiKey || !textModel) return "";
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: textModel,
      max_tokens: 150,
      messages: [{ role: "user", content: `${PROMPT}\n\n${excerpt}` }],
    }),
  });
  if (!res.ok)
    throw new Error(
      `appraisal HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

async function runAppraisal(): Promise<void> {
  if (!moodEnabled()) return;
  const now = Date.now();
  const current = await loadJsonStrict<Mood>(MOOD_FILE, defaultMood(now));
  if (now - current.updatedAt < DEBOUNCE_MS) return;
  const tail = dailyTail();
  if (!tail || !hasOwnerVoice(tail)) return;

  const raw = await judge(tail);
  const appraisal = parseAppraisal(raw);
  if (!appraisal) return;

  // Lock: l'altro scrittore è il tick del heartbeat (decay/assenza).
  const token = await acquireLock(MOOD_LOCK);
  try {
    const mood = await loadJsonStrict<Mood>(MOOD_FILE, defaultMood(now));
    await saveJsonAtomic(MOOD_FILE, applyAppraisal(mood, appraisal, Date.now()));
  } finally {
    releaseLock(MOOD_LOCK, token);
  }
}

export default defineHook({
  events: {
    "message.completed": (event) => {
      if (event.data.finishReason === "tool-calls") return;
      if (!(event.data.message ?? "").trim()) return;
      void runAppraisal().catch((error) => {
        console.error("[mood] appraisal skipped:", error);
      });
    },
  },
});
