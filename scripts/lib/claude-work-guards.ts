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

// Iva's own credentials must not reach a Claude that runs with permissions
// bypassed: it reads repos, issues and web pages, so a prompt injection would
// otherwise have DeepSeek, Telegram, Deepgram and Tavily keys in process.env.
// Claude authenticates from ~/.claude, it needs none of them.
const SECRET_RE = /(KEY|TOKEN|SECRET|BEARER|PASSWORD|CREDENTIAL)/i;

export function scrubEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !SECRET_RE.test(k)) out[k] = v;
  }
  return out;
}
