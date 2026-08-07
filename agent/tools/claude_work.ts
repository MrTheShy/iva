import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import {
  MAX_JOBS,
  atCapacity,
  resolveWorkdir,
  scrubEnv,
} from "../../scripts/lib/claude-work-guards.ts";

// Launch and list Claude Code background agents.
//
// Claude Code already owns every deterministic piece of running a job: --bg
// detaches it, it makes its own git worktree, `agents --json` is the registry,
// --resume survives a restart. None of that is reimplemented here.
//
// This tool exists for the three limits that are OURS and that a skill file
// cannot enforce: how many may run, where they may run, and what secrets they
// inherit. Everything else — what to ask Claude, when, what to report back —
// stays judgment and lives in agent/skills/claude-work.md.

const run = promisify(execFile);

// Owner's decision: always bypass permissions. A background job that stops on a
// permission prompt is a dead job — we watched one sit blocked doing nothing.
// The cost is that the worktree bounds edits, not the shell.
const PERMISSIONS = "--dangerously-skip-permissions";

const PLAN_PREFACE =
  "Prima analizza e proponi un piano: cosa faresti, in che ordine, e come si " +
  "capisce che è finito. NON implementare in questo giro.\n\n";

async function listAgents(): Promise<unknown[]> {
  try {
    const { stdout } = await run("claude", ["agents", "--json"], {
      timeout: 20_000,
      maxBuffer: 4_000_000,
    });
    const parsed: unknown = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A registry we cannot read is not an empty registry: refuse to launch
    // rather than assume there is room. Reported to the caller below.
    throw new Error("non riesco a leggere `claude agents --json`");
  }
}

export default defineTool({
  description:
    "Lavori di codice come agenti Claude Code in background. action=launch avvia " +
    "un lavoro su un progetto (serve project e task; mode='plan' chiede prima un " +
    "piano); action=list elenca i lavori attivi con id, stato e worktree. " +
    "Torna subito: il lavoro prosegue per conto suo.",
  inputSchema: z.object({
    action: z.enum(["launch", "list"]),
    project: z
      .string()
      .optional()
      .describe("cartella sotto work/ — solo lettere, cifre, . _ -"),
    task: z.string().optional().describe("il compito, in una frase chiara"),
    mode: z
      .enum(["plan", "work"])
      .optional()
      .describe("plan (default) chiede un piano prima di implementare"),
  }),
  async execute({ action, project, task, mode }) {
    if (action === "list") {
      const agents = await listAgents();
      return agents.length
        ? JSON.stringify(agents, null, 2)
        : "Nessun lavoro attivo.";
    }

    if (!project || !task?.trim()) {
      return "Servono `project` e `task`.";
    }

    const dir = resolveWorkdir(project); // throws outside work/
    const agents = await listAgents();
    if (atCapacity(agents)) {
      return (
        `Ci sono già ${agents.length} lavori attivi (tetto ${MAX_JOBS}, la macchina ha ` +
        `8 GB e zero swap). Aspetta che uno finisca — action=list per vedere quali.`
      );
    }

    mkdirSync(dir, { recursive: true });
    const prompt = (mode === "work" ? "" : PLAN_PREFACE) + task.trim();

    const child = spawn("claude", ["--bg", prompt, PERMISSIONS], {
      cwd: dir,
      env: scrubEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));

    const started = await new Promise<string>((done) => {
      const timer = setTimeout(() => done(out || "(nessun output)"), 30_000);
      child.on("close", () => {
        clearTimeout(timer);
        done(out || "(nessun output)");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        done(`errore di avvio: ${e.message}`);
      });
    });

    // "backgrounded · 029d2e39" — the short id is what she names to Shy.
    const id = /backgrounded[^\w]*([0-9a-f]{6,})/i.exec(started)?.[1];
    return id
      ? `Avviato in ${dir}\nid: ${id}\nmodo: ${mode === "work" ? "esecuzione" : "piano"}\n\n${started.trim()}`
      : `Avvio non confermato in ${dir}:\n${started.trim()}`;
  },
});
