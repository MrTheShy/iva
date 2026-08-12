// Promemoria one-shot deterministici: `tasks add … remindAt=<ISO>` e questo cron
// li consegna al minuto giusto — o al primo minuto utile dopo un downtime, perché
// «scaduto e non timbrato» resta vero finché la consegna non riesce. Sostituisce i
// timer systemd-run scritti a mano dal modello: sopravvive al reboot, si elenca con
// `tasks list`, si annulla con `tasks done/remove`, funziona anche senza systemd.
// Niente LLM: lettura, invio, timbro.
import { defineSchedule } from "eve/schedules";
import { join } from "node:path";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../lib/json-store.ts";
import { dueReminders, type ReminderTask } from "../../scripts/lib/reminders.ts";
import { sendTelegramHtml } from "../../scripts/lib/telegram-send.ts";

// Un giro per volta: un invio lento non deve accavallarsi col cron successivo e
// consegnare due volte (il timbro arriva solo a invii finiti).
let running = false;

async function deliverDue(): Promise<void> {
  const BOT = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
  if (!BOT || !CHAT || running) return;
  running = true;
  try {
    const dataDir = process.env.ASSISTANT_DATA_DIR ?? "data";
    const file = join(dataDir, "tasks.json");
    let due: ReminderTask[];
    try {
      due = dueReminders(
        await loadJsonStrict<ReminderTask[]>(file, []),
        Date.now(),
      );
    } catch {
      return; // tasks.json corrotto: ci pensa il tool al prossimo uso, non il cron
    }
    if (due.length === 0) return;
    const delivered = new Set<number>();
    for (const t of due) {
      const sent = await sendTelegramHtml(BOT, CHAT, `⏰ ${t.text}`);
      if (sent.ok) delivered.add(t.id);
      else console.error(`[reminders] invio fallito per task ${t.id}:`, sent.error);
    }
    if (delivered.size === 0) return;
    const lock = `${file}.lock`;
    const token = await acquireLock(lock);
    try {
      const tasks = await loadJsonStrict<ReminderTask[]>(file, []);
      const stamp = new Date().toISOString();
      for (const t of tasks) if (delivered.has(t.id)) t.remindedAt = stamp;
      await saveJsonAtomic(file, tasks);
    } finally {
      releaseLock(lock, token);
    }
  } finally {
    running = false;
  }
}

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(deliverDue());
  },
});
