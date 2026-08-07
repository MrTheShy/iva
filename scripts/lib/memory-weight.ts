// Il peso di stato di una carta nel recupero: la relevance dell'Ebbinghaus di
// autograph (che fino a oggi memory_search ignorava) e la salienza emotiva.
// Una carta decaduta è trovabile ma soppressa — riemerge se i richiami la
// rinforzano (engine.py touch); una carta saliente galleggia più a lungo.
export function memoryWeight(
  score: number,
  relevance: number | undefined,
  salience: number | undefined,
  stale: boolean,
): number {
  const r =
    typeof relevance === "number" && Number.isFinite(relevance)
      ? Math.max(0, Math.min(1, relevance))
      : 1; // carte senza campo (mai passate dal decay) non vanno punite
  const s =
    typeof salience === "number" && Number.isFinite(salience)
      ? Math.max(0, Math.min(1, salience))
      : 0.3; // il default di scrittura: routine
  return score * (0.6 + 0.4 * r) * (1 + 0.3 * s) * (stale ? 0.3 : 1);
}
