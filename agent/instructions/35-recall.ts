import {
  defineDynamic,
  defineInstructions,
  type DynamicResolveContext,
} from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchMemory } from "../tools/memory_search.ts";

// Richiamo automatico pre-turno. La MAP chiede al modello di CHIAMARE memory_search,
// ma se non lo fa il vault non esiste per quel turno: la debolezza singola più
// costosa della memoria. Qui i top-3 richiami sul messaggio corrente entrano nel
// prompt da soli; il modello parte già sapendo cosa sa e apre le carte con
// read_file solo quando servono i dettagli. Best-effort totale: qualunque errore
// → nessuna iniezione, mai un turno rotto.
//
// Allowlist esplicita: il richiamo gira SOLO sui turni della chat Telegram.
// I giri di servizio (rollup, digest, heartbeat, eval) entrano via eve/client
// senza canale autorato — il loro kind può essere "http" o undefined a seconda
// del percorso, quindi un blocklist non basta: lì il "messaggio" è un prompt di
// sistema lungo e cercarlo nel vault è solo rumore e latenza.
const ALLOW_KIND = "telegram";
const MAX_QUERY = 400;
const MIN_QUERY = 4;
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";

// settings.recallMode, riletto ogni turno come le altre instruction dinamiche:
// "off" spegne il richiamo, "force" lo attiva anche sui turni http (serve al
// runner A/B scripts/eval-recall.ts), tutto il resto = comportamento normale.
function recallMode(): "auto" | "off" | "force" {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(DATA_DIR, "settings.json"), "utf8"),
    );
    const m =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).recallMode
        : undefined;
    if (m === "off" || m === "force") return m;
  } catch {
    // nessun file / JSON rotto → auto
  }
  return "auto";
}

function lastUserText(messages: DynamicResolveContext["messages"]): string {
  // Le user-part in coda dopo l'ultima replica dell'assistente: lead dei media +
  // testo corrente, senza lo scrollback già risposto.
  const chunks: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role === "assistant") break;
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") {
      chunks.push(c);
    } else if (Array.isArray(c)) {
      const texts: string[] = [];
      for (const p of c as Array<{ type?: unknown; text?: unknown }>)
        if (p && p.type === "text" && typeof p.text === "string")
          texts.push(p.text);
      chunks.push(texts.join("\n"));
    }
  }
  return chunks.reverse().join("\n").trim();
}

export default defineDynamic({
  events: {
    "turn.started": async (_event: unknown, ctx: DynamicResolveContext) => {
      try {
        const mode = recallMode();
        if (mode === "off") return defineInstructions({ markdown: "" });
        if (mode !== "force" && ctx.channel?.kind !== ALLOW_KIND)
          return defineInstructions({ markdown: "" });
        const text = lastUserText(ctx.messages);
        if (text.length < MIN_QUERY || text.startsWith("/"))
          return defineInstructions({ markdown: "" });
        const { hits } = await searchMemory({
          query: text.slice(0, MAX_QUERY),
          limit: 3,
          touch: false,
        });
        if (hits.length === 0) return defineInstructions({ markdown: "" });
        const lines = hits.map(
          (h) =>
            `- ${h.file}${h.status && h.status !== "active" ? ` [${h.status}]` : ""}: ${h.snippet}`,
        );
        return defineInstructions({
          markdown:
            "## Richiami automatici dalla memoria (top-3, non verificati)\n" +
            lines.join("\n") +
            "\nSe uno è pertinente, aprilo con read_file prima di affermare i dettagli. " +
            "status superseded = non più vero; retracted = mai stato vero.",
        });
      } catch {
        return defineInstructions({ markdown: "" });
      }
    },
  },
});
