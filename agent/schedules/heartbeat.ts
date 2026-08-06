// The heartbeat: the tick that lets Iva start a conversation on her own.
//
// Cron fires every 5 minutes, but a tick only RUNS when settings say so — the
// cron string is compiled into the build, while the interval is a button in
// /menu, so the fine clock lives here and the real cadence lives in
// data/settings.json (read at fire time, like digest.ts, so a change applies on
// the next tick with no restart).
//
// Off by default. An assistant that starts messaging you unprompted after an
// update is a bad surprise, however good the messages are.
//
// This file is glue only: is it on, is a tick due, spawn it. Whether a tick is
// due is scripts/lib/heartbeat-window.ts (pure, tested); whether there is
// anything worth SAYING is agent/skills/heartbeat.md (judgment).
import { defineSchedule } from "eve/schedules";
import { readSettings } from "../lib/settings.ts";
import { resolvePaths } from "../lib/schedule-paths.ts";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.ts";
import {
  shouldTick,
  type HeartbeatWindow,
} from "../../scripts/lib/heartbeat-window.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface HeartbeatSettings extends HeartbeatWindow {
  enabled?: boolean;
}

/** Local hour in ASSISTANT_TIMEZONE — the same zone the rollups schedule by. */
function localHour(now: Date): number {
  const tz = process.env.ASSISTANT_TIMEZONE;
  if (!tz) return now.getHours();
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: tz,
      }).format(now),
    );
  } catch {
    return now.getHours(); // invalid zone is reported at startup; don't fail here
  }
}

function lastTickAt(dataDir: string): number {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, "heartbeat.json"), "utf8"),
    );
    const at = (raw as { lastTickAt?: unknown }).lastTickAt;
    return typeof at === "number" && Number.isFinite(at) ? at : 0;
  } catch {
    return 0; // never ticked, or unreadable — either way, let it run
  }
}

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    const settings = readSettings() as { heartbeat?: HeartbeatSettings };
    const hb = settings.heartbeat;
    if (hb?.enabled !== true) return;

    const { root, statusPath } = resolvePaths();
    const dataDir = process.env.ASSISTANT_DATA_DIR ?? join(root, "data");
    const now = new Date();

    if (
      !shouldTick(hb, {
        now: now.getTime(),
        hour: localHour(now),
        lastTickAt: lastTickAt(dataDir),
      })
    ) {
      return;
    }

    waitUntil(
      runScheduledJob({
        name: "heartbeat",
        argv: ["scripts/heartbeat.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        // The runner's 2h default guard is sized for the memory rollups, which
        // never fire twice in a day; here it would swallow every tick but one.
        // shouldTick() is what spaces ticks out — this only has to catch a true
        // double-fire inside one cron slot.
        guardMs: 2 * 60_000,
        // Nothing waits on a tick, so a wedged one must not sit on the lock for
        // the runner's default hour: it would block the whole rest of the day.
        timeoutMs: 4 * 60_000,
      }),
    );
  },
});
