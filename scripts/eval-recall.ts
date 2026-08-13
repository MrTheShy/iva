// A/B del richiamo automatico dalla memoria (agent/instructions/35-recall.ts).
//
// Due bracci sulle STESSE domande, stesso modello, sessioni fresche:
//   off   — recall spento: il modello deve decidere da solo di cercare (baseline,
//           il comportamento pre-modifica);
//   force — recall iniettato nel prompt (anche sui turni http di questo client).
// Scoring deterministico: la risposta contiene almeno una delle stringhe attese
// (case-insensitive). Niente giudice LLM: domande scelte perché il fatto atteso
// è un token distintivo (nome, numero), non una parafrasi.
//
// Il set di domande è DATO PERSONALE (deriva dal vault) e vive fuori da git:
//   data/eval-recall.json = [{ "question": "...", "expect": ["...", "..."] }]
// Durante il run un flag-file (agent/lib/eval-flag.ts) silenzia il transcript,
// così i turni di eval non sporcano il diario né il rollup notturno.
//
// Uso (sulla VM, con `iva` attivo):  node scripts/eval-recall.ts [file-domande]
import "./lib/ts-esm-hooks.ts";
import { Client } from "eve/client";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../agent/lib/json-store.ts";
import { evalFlagPath } from "../agent/lib/eval-flag.ts";

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER;
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const TURN_TIMEOUT_MS = 180_000;

interface EvalQuestion {
  question: string;
  expect: string[];
}

const file = process.argv[2] ?? join(DATA_DIR, "eval-recall.json");
const questions = JSON.parse(readFileSync(file, "utf8")) as EvalQuestion[];
if (!Array.isArray(questions) || questions.length === 0) {
  console.error(`nessuna domanda in ${file}`);
  process.exit(1);
}

async function setRecallMode(mode?: "off" | "force"): Promise<void> {
  const settings = join(DATA_DIR, "settings.json");
  const lock = `${settings}.lock`;
  const token = await acquireLock(lock);
  try {
    const s = await loadJsonStrict<Record<string, unknown>>(settings, {});
    if (mode === undefined) delete s.recallMode;
    else s.recallMode = mode;
    await saveJsonAtomic(settings, s);
  } finally {
    releaseLock(lock, token);
  }
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

async function ask(question: string): Promise<string> {
  const response = await client
    .session()
    .send(
      `${question}\nRispondi in una-due frasi, senza scrivere nulla in memoria.`,
    );
  const result = await Promise.race([
    response.result(),
    new Promise<{ status: string; message?: string }>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), TURN_TIMEOUT_MS),
    ),
  ]);
  return (result.message ?? "").trim();
}

interface ArmResult {
  hits: number;
  rows: string[];
}

async function runArm(mode: "off" | "force"): Promise<ArmResult> {
  await setRecallMode(mode);
  const rows: string[] = [];
  let hits = 0;
  for (const [i, q] of questions.entries()) {
    const answer = await ask(q.question);
    const hit = q.expect.some((e) =>
      answer.toLowerCase().includes(e.toLowerCase()),
    );
    if (hit) hits++;
    rows.push(
      `${hit ? "✓" : "✗"} [${mode}] Q${i + 1} ${q.question}\n    → ${answer.slice(0, 160).replaceAll("\n", " ")}`,
    );
    console.log(rows[rows.length - 1]);
  }
  return { hits, rows };
}

writeFileSync(evalFlagPath(), String(Date.now()), "utf8");
try {
  // Baseline prima, poi il braccio col recall: nessuno stato condiviso tra i
  // bracci (sessioni fresche), l'ordine conta solo per leggibilità del log.
  const off = await runArm("off");
  // Rinnova il flag: il primo braccio può avvicinarsi alla scadenza dei 30 min.
  writeFileSync(evalFlagPath(), String(Date.now()), "utf8");
  const force = await runArm("force");
  console.log(
    `\n== risultato ==\n` +
      `recall OFF   (baseline): ${off.hits}/${questions.length}\n` +
      `recall FORCE (iniettato): ${force.hits}/${questions.length}`,
  );
} finally {
  await setRecallMode(undefined);
  // Il transport del client eve ritenta le consegne fallite ("Queue delivery
  // failed … retrying"): un turno duplicato può completare MINUTI dopo l'ultima
  // risposta letta qui. Tenere il flag ancora un po' evita che quei ritardatari
  // finiscano nel diario a flag rimosso (successo il 2026-08-13: 4 voci spurie).
  console.log("attendo 3 min per i turni duplicati ritardatari…");
  await new Promise((resolve) => setTimeout(resolve, 180_000));
  rmSync(evalFlagPath(), { force: true });
}
