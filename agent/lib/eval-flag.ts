import { statSync } from "node:fs";
import { join } from "node:path";

// Flag-file: mentre scripts/eval-recall.ts interroga l'agente, il transcript non
// deve registrare i turni di eval nel diario — inquinerebbero il rollup notturno
// e la coda letta dall'appraisal. Il runner crea il file all'inizio e lo rimuove
// alla fine; la scadenza rende innocuo un flag orfano dopo un crash del runner.
const MAX_AGE_MS = 30 * 60_000;

export function evalFlagPath(): string {
  return join(process.env.ASSISTANT_DATA_DIR ?? "data", "eval-running");
}

/** Puro sul tempo: testabile passando mtime e now. */
export function isEvalFresh(mtimeMs: number, now: number): boolean {
  return now - mtimeMs < MAX_AGE_MS;
}

export function isEvalRunning(now = Date.now()): boolean {
  try {
    return isEvalFresh(statSync(evalFlagPath()).mtimeMs, now);
  } catch {
    return false;
  }
}
