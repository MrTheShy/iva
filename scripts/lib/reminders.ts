// Selezione pura dei promemoria scaduti — gemella di heartbeat-window.ts: lo
// schedule (agent/schedules/reminders.ts) è colla, la decisione è una funzione
// testabile senza eve.
export interface ReminderTask {
  id: number;
  text: string;
  done: boolean;
  /** ISO 8601 con offset; assente/null = nessun promemoria. */
  remindAt?: string | null;
  /** Timbrato dopo la consegna: un promemoria suona una volta sola. */
  remindedAt?: string | null;
}

export function dueReminders<T extends ReminderTask>(
  tasks: T[],
  now: number,
): T[] {
  return tasks.filter((t) => {
    if (t.done || t.remindedAt || !t.remindAt) return false;
    const at = Date.parse(t.remindAt);
    return Number.isFinite(at) && at <= now;
  });
}
