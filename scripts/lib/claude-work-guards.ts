// The limits that must not live in a skill file. PHILOSOPHY's boundary rule is
// explicit: limits, state and security belong in small deterministic code,
// because Markdown cannot guarantee them. Pure and separate so they are
// testable without spawning anything.

import { join, resolve, sep } from "node:path";

export function workRoot(cwd: string = process.cwd()): string {
  return join(cwd, "work");
}

/**
 * Where a conversation runs. One directory under work/ per project, checked
 * both by a name allowlist and by a resolved-prefix test — the belt-and-braces
 * AGENTS.md requires of any tool taking a path.
 *
 * ponytail: this bounds where the session STARTS, not where its shell can
 * reach. Permissions are bypassed by owner's decision, so a determined command
 * can still cd anywhere; real containment is a sandbox or a separate user, not
 * a longer check here.
 */
export function resolveWorkdir(project: string, cwd?: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project)) {
    throw new Error(
      `nome progetto non valido: "${project}" (lettere, cifre, . _ - ; max 64)`,
    );
  }
  const root = workRoot(cwd);
  const dir = resolve(root, project);
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`percorso fuori da ${root}`);
  }
  return dir;
}

/** A session id we would put on a command line — Claude's own UUID shape. */
export function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/** One entry per project in data/claude-sessions.json. */
export interface SessionEntry {
  /** Claude Code session id — the conversation's memory lives on its side. */
  id?: string;
  /** Set while a leg's `claude` process may still be running. */
  busyAt?: number;
  /** Timestamps of recent legs, for the hard per-hour leash. */
  legs?: number[];
}

/** 8 GB, no swap: two claude processes next to iva.service is the ceiling. */
export const MAX_CONCURRENT = 2;

/**
 * Hard leash on autonomous ping-pong. Judgment ("stop and report to Shy") is
 * in the skill and Iva could talk herself past it; this cap cannot be argued
 * with, and forces at most one hour of runaway before it stops itself.
 */
export const LEGS_PER_HOUR = 12;

/** The claude exec timeout is 45 min; an older busy claim is a crashed leg. */
export const BUSY_STALE_MS = 50 * 60_000;

export function isBusy(entry: SessionEntry | undefined, now: number): boolean {
  return (
    typeof entry?.busyAt === "number" && now - entry.busyAt < BUSY_STALE_MS
  );
}

/** Legs younger than an hour; anything malformed is dropped, not counted. */
export function pruneLegs(legs: unknown, now: number): number[] {
  return Array.isArray(legs)
    ? legs.filter(
        (t): t is number => typeof t === "number" && now - t < 3_600_000,
      )
    : [];
}

// PHILOSOPHY bans blacklists as a security boundary — and the first version of
// this function was one (a regex over variable names, so any secret with an
// unmatched name rode through). Allowlist instead: only what a shell, git and
// the claude CLI actually need. Claude authenticates from ~/.claude, so HOME
// covers it; SSH_AUTH_SOCK lets git push over ssh without exposing a value.
const ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
] as const;

export function envForClaude(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k];
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("LC_") && v !== undefined) out[k] = v;
  }
  return out;
}
