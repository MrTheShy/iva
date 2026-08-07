import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moodLine, type Mood } from "../../scripts/lib/mood.ts";

// Lo stato affettivo (data/mood.json, scritto dall'hook di appraisal e dal
// heartbeat) entra nel prompt di OGNI turno come due righe: stato + regola d'uso.
// File assente, corrotto o mood.enabled=false → stringa vuota, zero iniezione.
// Path relativi a cwd come in now.ts/20-core.ts (il service parte dalla root).
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Lingua come in now.ts: settings.language → env → ru. Duplicata inline apposta,
// le istruzioni restano autosufficienti.
function resolveLang(): "ru" | "en" {
  const settings = readJson(join(DATA_DIR, "settings.json"));
  const language = settings?.language;
  if (language === "ru" || language === "en") return language;
  return process.env.AGENT_LANGUAGE === "en" ? "en" : "ru";
}

function moodMarkdown(): string {
  const settings = readJson(join(DATA_DIR, "settings.json"));
  const moodSettings = settings?.mood;
  if (
    moodSettings !== null &&
    typeof moodSettings === "object" &&
    (moodSettings as Record<string, unknown>).enabled === false
  )
    return "";
  const raw = readJson(join(DATA_DIR, "mood.json"));
  if (!raw) return "";
  const mood = raw as unknown as Mood;
  if (
    typeof mood.calore !== "number" ||
    typeof mood.energia !== "number" ||
    typeof mood.curiosita !== "number"
  )
    return "";
  return moodLine(mood, resolveLang());
}

export default defineDynamic({
  events: {
    "turn.started": () => defineInstructions({ markdown: moodMarkdown() }),
  },
});
