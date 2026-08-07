import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadJsonStrict, saveJsonAtomic } from "../lib/json-store.js";
import {
  isSessionId,
  resolveWorkdir,
  scrubEnv,
} from "../../scripts/lib/claude-work-guards.ts";

// A conversation with Claude Code, one project at a time.
//
// There is no daemon and no held pipe. `claude -p --resume <id>` continues the
// same conversation with its full context, so each exchange is a short-lived
// process and the state lives in Claude Code's own session store. Verified: a
// number told in the first turn came back in the second. That is why nothing
// here has to survive an iva restart — Claude's side already does.
//
// The tool exists for what is OURS and cannot be guaranteed by a skill file:
// where a session may run, and that Iva's credentials never enter it. What to
// say to Claude, and when, is judgment — agent/skills/claude-work.md.

const run = promisify(execFile);

// Owner's decision: permissions always bypassed. A session that stops on a
// permission prompt is a dead session — we watched one sit blocked doing
// nothing. `/plan` remains available inside the conversation.
const PERMISSIONS = "--dangerously-skip-permissions";

// A real exchange can take minutes, and Iva's turn waits for it — that is the
// honest cost of a conversation rather than a fire-and-forget job. Long enough
// for design work, short enough that a wedged process cannot hold a turn open
// all day.
const TIMEOUT_MS = 10 * 60_000;

const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const SESSIONS = join(DATA_DIR, "claude-sessions.json");

type SessionMap = Record<string, string>;

interface ClaudeResult {
  session_id?: unknown;
  result?: unknown;
  is_error?: unknown;
  num_turns?: unknown;
}

export default defineTool({
  description:
    "Conversazione con Claude Code su un progetto. action=say parla con Claude " +
    "(serve project e message): la prima volta apre la conversazione, dopo la " +
    "riprende con tutto il contesto di prima. action=sessions elenca le " +
    "conversazioni aperte. Claude legge il codice da sé — non riassumerglielo.",
  inputSchema: z.object({
    action: z.enum(["say", "sessions"]),
    project: z
      .string()
      .optional()
      .describe("cartella sotto work/ — solo lettere, cifre, . _ -"),
    message: z.string().optional().describe("cosa dire a Claude"),
    fresh: z
      .boolean()
      .optional()
      .describe("true per ricominciare da capo invece di riprendere"),
  }),
  async execute({ action, project, message, fresh }) {
    const map = await loadJsonStrict<SessionMap>(SESSIONS, {});

    if (action === "sessions") {
      const open = Object.entries(map);
      return open.length
        ? open.map(([p, id]) => `${p}: ${id}`).join("\n")
        : "Nessuna conversazione aperta.";
    }

    if (!project || !message?.trim()) {
      return "Servono `project` e `message`.";
    }

    const dir = resolveWorkdir(project); // throws outside work/
    mkdirSync(dir, { recursive: true });

    const previous = map[project];
    const resuming = !fresh && isSessionId(previous);
    const args = [
      "-p",
      message.trim(),
      "--output-format",
      "json",
      PERMISSIONS,
      ...(resuming ? ["--resume", previous] : []),
    ];

    let stdout: string;
    try {
      ({ stdout } = await run("claude", args, {
        cwd: dir,
        env: scrubEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: 16_000_000,
      }));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // A resume that fails must not silently start a fresh conversation: that
      // would look like Claude forgot everything, with no way to tell why.
      return `Claude non ha risposto (${resuming ? "ripresa" : "apertura"}): ${why}`;
    }

    let parsed: ClaudeResult;
    try {
      parsed = JSON.parse(stdout) as ClaudeResult;
    } catch {
      return `Risposta non interpretabile da Claude:\n${stdout.slice(0, 2000)}`;
    }

    const id = parsed.session_id;
    if (isSessionId(id) && map[project] !== id) {
      await saveJsonAtomic(SESSIONS, { ...map, [project]: id });
    }

    const text =
      typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed);
    const head = resuming
      ? `[${project} · ripresa]`
      : `[${project} · nuova conversazione]`;
    return parsed.is_error === true ? `${head} ERRORE\n${text}` : `${head}\n${text}`;
  },
});
