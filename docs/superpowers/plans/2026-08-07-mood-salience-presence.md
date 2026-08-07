# Mood, salienza, presenza — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stato affettivo persistente (3 scalari), salienza nella memoria (scrittura, decadimento, recupero, rinforzo), heartbeat consapevole di chiusura/assenza con reminiscenza.

**Architecture:** regole pure in `scripts/lib/mood.ts`; stato in `data/mood.json` via `agent/lib/json-store.ts`; appraisal = un hook eve su `message.completed` con una chiamata piccola al provider; iniezione via `agent/instructions/30-mood.ts`; salienza dentro l'Ebbinghaus esistente di autograph e nello scoring di `memory_search`.

**Tech Stack:** TypeScript (node:test), Python (autograph), eve hooks/instructions. Nessuna nuova dipendenza.

**Spec:** `docs/superpowers/specs/2026-08-07-mood-salience-presence-design.md`

**Vincolo trasversale:** dopo ogni task che tocca `agent/`: `npm run build`. Commit per task, messaggi senza alcuna menzione di strumenti AI.

---

### Task 1: regole pure dell'umore — `scripts/lib/mood.ts`

**Files:** Create `scripts/lib/mood.ts`, Create `scripts/lib/mood.test.ts`

- [ ] Test prima (`node --test scripts/lib/mood.test.ts`, deve fallire per modulo mancante): appraisal positivo alza calore/energia e scarica curiosità; `temaAperto` porta curiosità ad almeno 60; decadimento 48h dimezza la distanza dalla baseline; assenza >12h alza curiosità solo se `calore ≥ 40`, cap 85; `parseAppraisal` regge JSON sporco (testo attorno), campi fuori range clampati, chiusura invalida → null.
- [ ] Implementazione:

```ts
export type Chiusura = "calda" | "neutra" | "pesante";
export interface Appraisal {
  valenza: number;
  intensita: number;
  chiusura: Chiusura;
  temaAperto: string | null;
}
export interface Mood {
  calore: number;
  energia: number;
  curiosita: number;
  updatedAt: number;
  ultimaChiusura?: { tono: Chiusura; at: number; temaAperto: string | null };
}

export const MOOD_BASELINE = 50;
export const defaultMood = (now: number): Mood => ({
  calore: 50,
  energia: 50,
  curiosita: 50,
  updatedAt: now,
});
const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function applyAppraisal(mood: Mood, a: Appraisal, now: number): Mood {
  let curiosita = Math.max(30, mood.curiosita - 15);
  if (a.temaAperto) curiosita = Math.max(curiosita, 60);
  return {
    calore: clamp(mood.calore + 8 * a.valenza * a.intensita),
    energia: clamp(mood.energia + 10 * a.valenza * a.intensita),
    curiosita: clamp(curiosita),
    updatedAt: now,
    ultimaChiusura: { tono: a.chiusura, at: now, temaAperto: a.temaAperto },
  };
}
export function applyDecay(mood: Mood, ore: number, now: number): Mood {
  if (!(ore > 0)) return mood;
  const toward = (v: number) =>
    MOOD_BASELINE + (v - MOOD_BASELINE) * Math.pow(0.5, ore / 48);
  return {
    ...mood,
    calore: toward(mood.calore),
    energia: toward(mood.energia),
    curiosita: toward(mood.curiosita),
    updatedAt: now,
  };
}
export function applyAbsence(
  mood: Mood,
  oreDiSilenzio: number,
  now: number,
): Mood {
  if (oreDiSilenzio <= 12 || mood.calore < 40) return mood;
  return {
    ...mood,
    curiosita: Math.min(85, mood.curiosita + 2 * (oreDiSilenzio - 12)),
    updatedAt: now,
  };
}
export function parseAppraisal(raw: string): Appraisal | null {
  /* estrae il primo {...}, valida, clampa, tema max 80 char */
}
export function moodLine(mood: Mood, lang: "ru" | "en"): string {
  /* una riga di stato + una di regola d'uso, vuota mai */
}
```

- [ ] `node --test scripts/lib/mood.test.ts` verde; `npx tsgo` senza errori nuovi; commit `mood: pure rules for the affective state`.

### Task 2: hook di appraisal — `agent/hooks/appraisal.ts`

**Files:** Create `agent/hooks/appraisal.ts` (forma di `agent/hooks/transcript.ts`)

- [ ] Su `message.completed` con `finishReason !== "tool-calls"`: fire-and-forget `runAppraisal()`, mai fatale.
- [ ] `runAppraisal()`: debounce (se `mood.updatedAt` < 120 s fa → return); legge la coda di `vault/daily/<oggi>.md` (~2000 char); se l'estratto non contiene un marker utente (verificare in `agent/channels/telegram.ts` il tipo scritto da appendDaily) → return (esclude heartbeat/digest/rollup).
- [ ] Chiamata modello: pattern `agent/vision.ts` (stesso provider/chiave da `agent/provider.ts`, `max_tokens` ~150, senza modello configurato → return). Prompt: valuta l'ultimo scambio, rispondi SOLO col JSON `{valenza, intensita, chiusura, temaAperto}`.
- [ ] `parseAppraisal` → null = no-op; altrimenti sotto lock (`acquireLock`/`loadJsonStrict`/`saveJsonAtomic` su `data/mood.json`, pattern `withState()` di `scripts/heartbeat.ts:52-62`) applica `applyAppraisal` e salva.
- [ ] `npm run build`; smoke: un turno di chat aggiorna `data/mood.json`; commit `mood: appraise each chat exchange into the affective state`.

### Task 3: iniezione nel prompt — `agent/instructions/30-mood.ts`

**Files:** Create `agent/instructions/30-mood.ts` (forma di `now.ts`: `defineDynamic` su `turn.started`)

- [ ] Legge `data/settings.json` (`mood.enabled !== false`) e `data/mood.json` (path relativi a cwd); assente/corrotto/spento → `defineInstructions({ markdown: "" })`.
- [ ] Import di `moodLine` da `scripts/lib/mood.ts` (pattern già provato da `20-core.ts`); lingua con lo stesso resolveLang di `now.ts` (inline).
- [ ] `npm run build`; smoke con un turno; commit `mood: inject the affective line into every turn`.

### Task 4: salienza nel recupero + rinforzo — `agent/tools/memory_search.ts`

**Files:** Create `scripts/lib/memory-weight.ts` + test, Modify `agent/tools/memory_search.ts`

- [ ] Test prima: `memoryWeight(score, relevance, salience, stale)` → default salience 0.3 e relevance 1 quando assenti; alta salienza vince a parità di BM25; relevance bassa sopprime; stale ×0.3 conservato.

```ts
export function memoryWeight(
  score: number,
  relevance: number | undefined,
  salience: number | undefined,
  stale: boolean,
): number {
  const r =
    typeof relevance === "number" ? Math.max(0, Math.min(1, relevance)) : 1;
  const s =
    typeof salience === "number" ? Math.max(0, Math.min(1, salience)) : 0.3;
  return score * (0.6 + 0.4 * r) * (1 + 0.3 * s) * (stale ? 0.3 : 1);
}
```

- [ ] In `memory_search.ts`: aggiungere `relevance`/`salience` al `Doc` (`loadDocs`, `:120-133`), sostituire il malus stale (`:488`) con `memoryWeight`, e dopo il ranking accodare i path dei top-3 a `data/memory-touch.jsonl` (append fire-and-forget, mai fatale).
- [ ] `npm run build`; test verdi; commit `memory: decayed relevance and salience finally shape recall`.

### Task 5: salienza in autograph + consumo touch — Python + doctor

**Files:** Modify `scripts/autograph/common.py` (`calc_relevance`, `:627`), `scripts/autograph/engine.py` (`cmd_creative`, `:151`), `vault-template/schema.json` (system fields), `scripts/memory/doctor.ts` (**rebase sulle modifiche non committate dell'altra sessione — leggere prima di toccare**), istruzioni dbrain (`scripts/memory/instructions/dbrain-processor/`).

- [ ] `calc_relevance`: leggere `salience` dalla carta (default 0.3), `rate_eff = rate / (strength * (1 + 2 * salience))`.
- [ ] `cmd_creative`: flag `--min-salience X` che filtra il campione.
- [ ] `schema.json`: dichiarare `salience` fra i campi di sistema (enforce non deve toccarlo).
- [ ] Istruzioni dbrain: alla creazione/aggiornamento carta assegnare `salience` (~0.8 eventi emotivi forti/decisioni pesanti, ~0.5 fatti medi, ~0.2 routine).
- [ ] `doctor.ts`: nuovo passo dopo `engine.decay` — leggere `data/memory-touch.jsonl`, dedup dei path, `engine.py touch <path>` per ciascuno, troncare il file.
- [ ] Commit `memory: salience slows decay, recall reinforces`.

### Task 6: heartbeat che sente + digest

**Files:** Modify `scripts/heartbeat.ts`, `agent/skills/heartbeat.md`, `agent/skills/morning-digest.md`

- [ ] Al claim del tick: caricare `data/mood.json` (lock), `applyDecay(ore da updatedAt)` + `applyAbsence(ore da chatAt)`, salvare.
- [ ] Prompt del tick (+3 righe nel blocco `:132-162`): umore attuale; `ultimaChiusura` (tono + tema aperto + quanto fa); eventuale ricordo riaffiorato da `engine.py creative --min-salience 0.6 .` (spawn con try, vuoto su errore).
- [ ] `heartbeat.md`: principio del benessere (premurosa sì, bisognosa mai, niente «mi manchi»); il tono del follow-up si calibra sulla chiusura; reminiscenza libera col criterio «riapri un filo se è utile a lui, non per riempire il silenzio».
- [ ] `morning-digest.md`: il ricordo non risolto ad alta salienza può diventare la frase di focus.
- [ ] Verifica con `node scripts/heartbeat.ts --dry`; commit `heartbeat: mood, closure and resurfaced memories in the tick`.

### Task 7: chiusura

- [ ] `npm test` (tutti), `npx tsgo` (solo errori preesistenti), `npm run lint` sui file toccati.
- [ ] `npm run build`; push; deploy VPS: `git pull && npm run build && systemctl --user restart iva`.

## Self-review

Spec §3→Task 1+2, §4→Task 2, §5→Task 3, §6→Task 4+5, §7→Task 6, §8→Task 6, §10→test nei task, §11→note in Task 5 e vincolo build. Nessun TBD. Nomi coerenti (`applyAppraisal/applyDecay/applyAbsence/parseAppraisal/moodLine/memoryWeight`).
