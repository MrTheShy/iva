import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chiude il loop del battito. Il messaggio d'iniziativa parte da una sessione
// fresca e arriva via Bot API: la sessione della CHAT non l'ha mai visto, quindi
// a un «fatto» di risposta Iva replicava a un messaggio che per lei non esisteva.
// Qui l'ultima iniziativa (≤48h) entra nel prompt di ogni turno della chat.
// Path relativi a cwd come in 30-mood.ts; errori → nessuna iniezione.
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const WINDOW_MS = 48 * 3_600_000;
const MSG_CAP = 300;

function heartbeatMarkdown(): string {
  try {
    const raw = JSON.parse(
      readFileSync(join(DATA_DIR, "heartbeat.json"), "utf8"),
    ) as { lastSpokeAt?: unknown; lastMessage?: unknown };
    const at = typeof raw.lastSpokeAt === "number" ? raw.lastSpokeAt : 0;
    const msg =
      typeof raw.lastMessage === "string" ? raw.lastMessage.trim() : "";
    const age = Date.now() - at;
    if (!msg || at <= 0 || age < 0 || age > WINDOW_MS) return "";
    const min = Math.round(age / 60_000);
    const when = min < 60 ? `${min} min fa` : `${Math.round(min / 60)} ore fa`;
    return (
      `## La tua ultima iniziativa (heartbeat, ${when})\n` +
      `Hai scritto tu per prima: «${msg.slice(0, MSG_CAP)}». ` +
      "Se la risposta dell'utente sembra riferirsi a questo, è così: non chiedere di cosa parla."
    );
  } catch {
    return "";
  }
}

export default defineDynamic({
  events: {
    "turn.started": () => defineInstructions({ markdown: heartbeatMarkdown() }),
  },
});
