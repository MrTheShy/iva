import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../lib/json-store.js";
import {
  LEGS_PER_HOUR,
  MAX_CONCURRENT,
  isBusy,
  pruneLegs,
  resolveWorkdir,
  type SessionEntry,
} from "../../scripts/lib/claude-work-guards.ts";

// A conversation with Claude Code that does NOT hold Iva's turn.
//
// say spawns one leg (scripts/claude-run.ts) as a transient systemd unit and
// returns immediately: the chat stays free while Claude thinks, and the leg
// survives an iva deploy because it is not in iva.service's cgroup. When the
// reply lands, the leg opens a dedicated eve/client judgment turn where Iva
// decides — continue, report to Shy, or PASS. The conversation's memory lives
// in Claude Code's session store; data/claude-sessions.json only maps project
// to session id plus the busy/leash bookkeeping.
//
// What is deterministic and OURS lives here and in the guards: one pending
// reply per project, MAX_CONCURRENT claude processes (8 GB, no swap), a hard
// LEGS_PER_HOUR leash on autonomous ping-pong, the work/ path bound, and the
// env allowlist for the claude child. What to say and when is judgment —
// agent/skills/claude-work.md.

const run = promisify(execFile);

const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const SESSIONS = join(DATA_DIR, "claude-sessions.json");
const LOCK = `${SESSIONS}.lock`;

type SessionMap = Record<string, SessionEntry>;

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export default defineTool({
  description:
    "Conversazione in background con Claude Code su un progetto. action=say " +
    "invia un messaggio (serve project e message) e torna SUBITO: la risposta " +
    "arriverà in un turno dedicato dove decidi il seguito. La conversazione " +
    "per progetto è unica e continua: Claude ricorda tutto, non ripetergli il " +
    "contesto. action=sessions elenca le conversazioni. fresh=true riparte da " +
    "zero (perde il contesto).",
  inputSchema: z.object({
    action: z.enum(["say", "sessions"]),
    project: z
      .string()
      .optional()
      .describe("cartella sotto work/ — lettere, cifre, . _ -"),
    message: z.string().optional().describe("cosa dire a Claude"),
    fresh: z
      .boolean()
      .optional()
      .describe("true per ricominciare la conversazione da capo"),
  }),
  async execute({ action, project, message, fresh }) {
    const now = Date.now();

    if (action === "sessions") {
      const map = await loadJsonStrict<SessionMap>(SESSIONS, {});
      const lines = Object.entries(map).map(([p, e]) => {
        const busy = isBusy(e, now)
          ? ` · in scambio da ${minutes(now - (e.busyAt ?? now))} min`
          : "";
        const legs = pruneLegs(e.legs, now).length;
        const id = e.id ? e.id.slice(0, 8) : "nuova";
        return `${p}: ${id}${busy} · ${legs} scambi nell'ultima ora`;
      });
      return lines.length ? lines.join("\n") : "Nessuna conversazione aperta.";
    }

    if (!project || !message?.trim()) {
      return "Servono `project` e `message`.";
    }
    const dir = resolveWorkdir(project); // throws outside work/

    // Claim under lock: one pending reply per project, a global process cap,
    // and the per-hour leash. All three are the reason this tool exists.
    const token = await acquireLock(LOCK);
    try {
      const map = await loadJsonStrict<SessionMap>(SESSIONS, {});
      const entry = map[project] ?? {};
      if (isBusy(entry, now)) {
        return (
          `C'è già uno scambio in corso su ${project} ` +
          `(da ${minutes(now - (entry.busyAt ?? now))} min). Aspetta la risposta.`
        );
      }
      const othersBusy = Object.entries(map).filter(
        ([p, e]) => p !== project && isBusy(e, now),
      ).length;
      if (othersBusy >= MAX_CONCURRENT) {
        return (
          `Ci sono già ${othersBusy} scambi in corso (tetto ${MAX_CONCURRENT}: ` +
          `8 GB, zero swap). Riprova quando uno finisce.`
        );
      }
      const legs = pruneLegs(entry.legs, now);
      if (legs.length >= LEGS_PER_HOUR) {
        return (
          `${legs.length} scambi su ${project} nell'ultima ora — tetto ` +
          `raggiunto. Fai il punto con Shy; il contatore si libera col tempo.`
        );
      }
      legs.push(now);
      map[project] = {
        ...(fresh || entry.id === undefined ? {} : { id: entry.id }),
        legs,
        busyAt: now,
      };
      await saveJsonAtomic(SESSIONS, map);
    } finally {
      releaseLock(LOCK, token);
    }

    mkdirSync(dir, { recursive: true });
    const root = process.cwd();
    const unit = `iva-claude-${project}-${now}`;
    try {
      await run(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--quiet",
          `--unit=${unit}`,
          `--working-directory=${root}`,
          "--property=RuntimeMaxSec=3900",
          process.execPath,
          `--env-file=${join(root, ".env")}`,
          join(root, "scripts", "claude-run.ts"),
          project,
          fresh ? "1" : "0",
          message.trim(),
        ],
        {
          timeout: 15_000,
          env: {
            ...process.env,
            XDG_RUNTIME_DIR:
              process.env.XDG_RUNTIME_DIR ??
              (typeof process.getuid === "function"
                ? `/run/user/${process.getuid()}`
                : ""),
          },
        },
      );
    } catch (e) {
      // Roll back the claim, or the project stays "busy" for 50 minutes.
      const t2 = await acquireLock(LOCK);
      try {
        const map = await loadJsonStrict<SessionMap>(SESSIONS, {});
        if (map[project]) {
          delete map[project].busyAt;
          await saveJsonAtomic(SESSIONS, map);
        }
      } finally {
        releaseLock(LOCK, t2);
      }
      const why = e instanceof Error ? e.message : String(e);
      return `Non sono riuscita ad avviare lo scambio: ${why}`;
    }

    return (
      `→ inviato a Claude su ${project}` +
      (fresh ? " (conversazione nuova)" : "") +
      ". Lo scambio corre in background: la risposta arriverà in un turno " +
      "dedicato. Questo turno è libero."
    );
  },
});
