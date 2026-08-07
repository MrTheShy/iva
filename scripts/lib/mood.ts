// Stato affettivo persistente: tre scalari 0–100 che vivono FUORI dalla finestra di
// contesto (data/mood.json) — il dialogo non li convince a parole, li muovono solo
// queste regole. Qui solo funzioni pure, niente I/O: chi carica e salva sta
// nell'hook di appraisal e nel heartbeat, sotto lock (agent/lib/json-store.ts).
//
// calore    — temperatura della relazione (chiusure calde/pesanti, risposte ai follow-up)
// energia   — energia PERCEPITA del proprietario (bassa → tono sobrio e concreto)
// curiosita — si accumula con assenza e temi lasciati aperti, si scarica parlando

export type Chiusura = "calda" | "neutra" | "pesante";

export interface Appraisal {
  valenza: number; // -1..1
  intensita: number; // 0..1
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
  calore: MOOD_BASELINE,
  energia: MOOD_BASELINE,
  curiosita: MOOD_BASELINE,
  updatedAt: now,
});

const clamp = (v: number): number => Math.max(0, Math.min(100, v));

/** Un turno di chat valutato: aggiorna i tre scalari e memorizza la chiusura. */
export function applyAppraisal(mood: Mood, a: Appraisal, now: number): Mood {
  // Parlare scarica la curiosità; un tema lasciato aperto la ricarica.
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

/** Ritorno verso la baseline con emivita 48 ore: gli strascichi durano, non restano. */
export function applyDecay(mood: Mood, ore: number, now: number): Mood {
  if (!(ore > 0)) return mood;
  const toward = (v: number): number =>
    MOOD_BASELINE + (v - MOOD_BASELINE) * Math.pow(0.5, ore / 48);
  return {
    ...mood,
    calore: toward(mood.calore),
    energia: toward(mood.energia),
    curiosita: toward(mood.curiosita),
    updatedAt: now,
  };
}

/**
 * L'assenza fa crescere la curiosità («chissà come sta»), ma solo in una relazione
 * calda: una relazione fredda non accumula ansia da abbandono.
 */
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

/**
 * Il JSON dell'appraisal come arriva da un modello: testo attorno, campi fuori range,
 * chiusure inventate. Tutto ciò che non è valido diventa null — un no-op, mai un crash.
 */
export function parseAppraisal(raw: string): Appraisal | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const p = parsed as Record<string, unknown>;
  const valenza = Number(p.valenza);
  const intensita = Number(p.intensita);
  const chiusura = p.chiusura;
  if (!Number.isFinite(valenza) || !Number.isFinite(intensita)) return null;
  if (chiusura !== "calda" && chiusura !== "neutra" && chiusura !== "pesante")
    return null;
  const tema =
    typeof p.temaAperto === "string" && p.temaAperto.trim().length > 0
      ? p.temaAperto.trim().slice(0, 80)
      : null;
  return {
    valenza: Math.max(-1, Math.min(1, valenza)),
    intensita: Math.max(0, Math.min(1, intensita)),
    chiusura,
    temaAperto: tema,
  };
}

/**
 * Le due righe iniettate nel prompt di ogni turno: lo stato e la regola d'uso.
 * Dichiarabile su richiesta, mai teatrale — la scelta del proprietario.
 */
export function moodLine(mood: Mood, lang: "ru" | "en"): string {
  const c = Math.round(mood.calore);
  const e = Math.round(mood.energia);
  const q = Math.round(mood.curiosita);
  const tema = mood.ultimaChiusura?.temaAperto ?? null;
  if (lang === "en") {
    const low =
      e < 40 ? " (low: keep replies sober and concrete, no banter)" : "";
    const thread = tema ? ` — open thread: “${tema}”` : "";
    return (
      `Affective state: warmth ${c}/100 · owner's perceived energy ${e}/100${low} · curiosity ${q}/100${thread}.\n` +
      "Let it colour your tone without announcing it; a spontaneous hint only when it feels natural. " +
      "If the owner asks how you are, answer honestly from this state."
    );
  }
  const low = e < 40 ? " (низкая: тон трезвый и конкретный, без шуток)" : "";
  const thread = tema ? ` — открытая тема: «${tema}»` : "";
  return (
    `Аффективное состояние: тепло ${c}/100 · воспринимаемая энергия хозяина ${e}/100${low} · любопытство ${q}/100${thread}.\n` +
    "Пусть оно окрашивает тон, не объявляя его; спонтанный намёк — только когда естественно. " +
    "Если хозяин спросит, как ты, — ответь честно из этого состояния."
  );
}
