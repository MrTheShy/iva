// Decide se il tick del heartbeat merita un giro di MODELLO. Il tick gira ogni
// intervallo e ~90% delle volte il modello guarda lo stesso mondo e dice PASS:
// fino a ~60 chiamate al giorno pagate per niente (più il subprocess uv dei
// ricordi). Qui la parte deterministica: si pensa solo se il mondo è cambiato
// o se è passato abbastanza tempo dall'ultimo pensiero (saluto del mattino,
// follow-up), e MAI oltre la scala anti-nagging che lo skill finora enunciava
// solo a parole. Gemella di heartbeat-window.ts: lo schedule è colla, la
// decisione è una funzione testabile.

/** A mondo fermo si pensa comunque ogni tanto (saluti, follow-up, ricordi). */
export const THINK_IDLE_MS = 2 * 3_600_000;
/** «Due iniziative di fila senza risposta → aspetta domani» (heartbeat.md). */
export const NAG_COOLDOWN_MS = 20 * 3_600_000;

export interface ThinkGateInput {
  /** Impronta del mondo osservabile (mtime di tasks/daily/claude-sessions). */
  fingerprint: string;
  lastFingerprint?: string;
  lastThinkAt?: number;
  now: number;
  /** Shy non ha più scritto dopo l'ultima iniziativa. */
  ghosted: boolean;
  unanswered?: number;
  lastSpokeAt?: number;
}

export function shouldThink(i: ThinkGateInput): {
  think: boolean;
  reason: string;
} {
  if (
    i.ghosted &&
    (i.unanswered ?? 0) >= 2 &&
    typeof i.lastSpokeAt === "number" &&
    i.now - i.lastSpokeAt < NAG_COOLDOWN_MS
  ) {
    return { think: false, reason: "anti-nag: 2 iniziative senza risposta" };
  }
  if (i.fingerprint !== (i.lastFingerprint ?? "")) {
    return { think: true, reason: "mondo cambiato" };
  }
  if (i.now - (i.lastThinkAt ?? 0) >= THINK_IDLE_MS) {
    return { think: true, reason: "pensiero periodico" };
  }
  return { think: false, reason: "mondo fermo" };
}
