// Pure "should this tick run" logic for the heartbeat, kept out of
// agent/schedules/heartbeat.ts so it can be tested without pulling in eve.
// Same split the repo already uses for core-clamp and the continuation token:
// the schedule is glue (framework, settings, spawn), the decision is a function.

export interface HeartbeatWindow {
  intervalMinutes?: number;
  quietFrom?: number;
  quietTo?: number;
}

export const DEFAULT_INTERVAL_MIN = 15;
// A person does not call you at 04:00. Local hours, [from, to).
export const DEFAULT_QUIET_FROM = 23;
export const DEFAULT_QUIET_TO = 8;
// The cron floor in agent/schedules/heartbeat.ts: a shorter interval cannot be
// honoured, so it is clamped rather than silently treated as "every tick".
export const MIN_INTERVAL_MIN = 5;

/** Quiet windows wrap midnight, so 23→8 means 23,0,…,7. Half-open: [from, to). */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  // from === to means "no quiet hours", not "quiet all day" — otherwise setting
  // both to the same value would mute her forever with no error anywhere.
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * Whether a tick is due: enough time has passed and it is a decent hour.
 * `lastTickAt` is 0 when she has never ticked, which counts as due.
 */
export function shouldTick(
  window: HeartbeatWindow,
  { now, hour, lastTickAt }: { now: number; hour: number; lastTickAt: number },
): boolean {
  if (
    inQuietHours(
      hour,
      window.quietFrom ?? DEFAULT_QUIET_FROM,
      window.quietTo ?? DEFAULT_QUIET_TO,
    )
  ) {
    return false;
  }
  const interval = Math.max(
    MIN_INTERVAL_MIN,
    window.intervalMinutes ?? DEFAULT_INTERVAL_MIN,
  );
  return now - lastTickAt >= interval * 60_000;
}
