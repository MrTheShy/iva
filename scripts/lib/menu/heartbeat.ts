// Heartbeat screen: the only initiative Iva takes on her own — deciding she has
// a reason to write to you, and writing.
//
// Off by default. The tick itself is agent/schedules/heartbeat.ts, which reads
// these values at fire time, so a tap applies to the next tick with no restart.
import { readSettings, writeSettings } from "#lib/settings.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Button = { text: string; callback_data: string };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
  show: (state: MenuState, screen: string) => Promise<void>;
};

// Every 5 minutes is the cron floor in agent/schedules/heartbeat.ts; nothing
// below it can be honoured, so it is not offered.
const INTERVALS = [15, 30, 60, 120] as const;

interface HeartbeatSettings {
  enabled?: boolean;
  intervalMinutes?: number;
}

function current(): Required<Pick<HeartbeatSettings, "enabled">> &
  HeartbeatSettings {
  try {
    const hb = (readSettings() as { heartbeat?: HeartbeatSettings }).heartbeat;
    return { enabled: hb?.enabled === true, intervalMinutes: hb?.intervalMinutes };
  } catch {
    return { enabled: false };
  }
}

/** When she last chose to speak, from the tick's own state file. */
function lastSpoke(T: (en: string, ru: string) => string): string {
  const raw = process.env.ASSISTANT_DATA_DIR ?? "data";
  const dir = raw.startsWith("/") ? raw : join(process.cwd(), raw);
  try {
    const at = (
      JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8")) as {
        lastSpokeAt?: unknown;
      }
    ).lastSpokeAt;
    if (typeof at !== "number" || !Number.isFinite(at))
      return T("never", "никогда");
    const hours = (Date.now() - at) / 3_600_000;
    if (hours < 1) return T("under an hour ago", "меньше часа назад");
    return T(`${Math.round(hours)}h ago`, `${Math.round(hours)} ч назад`);
  } catch {
    return T("never", "никогда");
  }
}

export default {
  parent: "r",
  render(_st: MenuState, ctx: MenuContext) {
    const T = ctx.tr;
    const hb = current();
    const interval = hb.intervalMinutes ?? 15;
    // The button carries the NEXT state, not a bare flip: a stale message
    // tapped twice must not undo a change made in between.
    const rows = [
      [
        ctx.btn(
          hb.enabled ? T("🔔 On", "🔔 Включён") : T("🔕 Off", "🔕 Выключен"),
          `iva_menu:hb:set:${hb.enabled ? "0" : "1"}`,
        ),
      ],
      INTERVALS.map((m) =>
        ctx.btn(`${m}m${interval === m ? " ✓" : ""}`, `iva_menu:hb:every:${m}`),
      ),
      ctx.backRow("r"),
    ];
    return {
      text: T(
        "💓 Heartbeat\n\nEvery interval she stops and asks herself whether there is " +
          "a reason to write to you. Most of the time there isn't, and she says nothing.\n\n" +
          `Quiet 23:00–08:00. Last time she wrote first: ${lastSpoke(T)}.`,
        "💓 Сердцебиение\n\nРаз в интервал она останавливается и спрашивает себя, есть ли " +
          "повод тебе написать. Чаще всего повода нет, и она молчит.\n\n" +
          `Тихие часы 23:00–08:00. Последний раз писала первой: ${lastSpoke(T)}.`,
      ),
      rows,
    };
  },
  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    const hb = current();
    if (verb === "set") {
      writeSettings({ heartbeat: { ...hb, enabled: args[0] === "1" } });
    } else if (verb === "every") {
      const m = Number(args[0]);
      // Reject anything not offered: the callback is ours, but a replayed or
      // hand-made one must not write a 1-minute interval into settings.
      if (!(INTERVALS as readonly number[]).includes(m)) return;
      writeSettings({ heartbeat: { ...hb, intervalMinutes: m } });
    } else {
      return;
    }
    st.page = 0;
    await ctx.show(st, "hb");
  },
};
