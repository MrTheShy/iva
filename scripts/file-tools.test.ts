import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guards for the fork's fixes: grep no longer freezes the event loop on a
// catastrophic-backtracking regex, and write_file/read_file agree that a
// relative path is vault-relative (so a card written by its search-result path
// is found again).

process.env.IVA_GREP_TIMEOUT_MS = "800"; // keep the ReDoS case fast in CI

const grep = (await import("../agent/tools/grep.ts")).default as unknown as {
  execute: (a: {
    pattern: string;
    path?: string;
    glob?: string;
    flags?: string;
  }) => Promise<{ count: number; matches: unknown[]; error?: string }>;
};
const writeFileTool = (await import("../agent/tools/write_file.ts")).default as unknown as {
  execute: (a: {
    path: string;
    content: string;
  }) => Promise<{ ok: boolean; path?: string; error?: string }>;
};
const readFileTool = (await import("../agent/tools/read_file.ts")).default as unknown as {
  execute: (a: { path: string }) => Promise<{ content: string }>;
};

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-file-tools-"));
  process.env.ASSISTANT_VAULT_DIR = dir;
  return dir;
}

test("grep returns on a catastrophic-backtracking regex instead of hanging", async () => {
  const dir = freshVault();
  writeFileSync(join(dir, "bait.txt"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!\n");
  const started = Date.now();
  const result = await grep.execute({ pattern: "^(a+)+$", path: dir });
  // Bounded by the worker deadline, not the regex — a few seconds of slack.
  assert.ok(Date.now() - started < 5000, "grep should not hang");
  assert.equal(result.count, 0);
  assert.match(result.error ?? "", /таймаут/);
});

test("grep still matches normally and reports a bad pattern cleanly", async () => {
  const dir = freshVault();
  writeFileSync(join(dir, "notes.txt"), "hello world\nsecond line\n");
  const ok = await grep.execute({ pattern: "hello", path: dir });
  assert.equal(ok.count, 1);
  const bad = await grep.execute({ pattern: "(", path: dir });
  assert.equal(bad.count, 0);
  assert.match(bad.error ?? "", /регулярное/);
});

test("write_file resolves a relative path against the vault, and read_file reads it back", async () => {
  const dir = freshVault();
  const w = await writeFileTool.execute({
    path: "cards/contacts/ivan.md",
    content: "# Ivan\nfact\n",
  });
  assert.equal(w.ok, true);
  assert.ok(w.path?.startsWith(dir), "write must land inside the vault");
  const r = await readFileTool.execute({ path: "cards/contacts/ivan.md" });
  assert.match(r.content, /fact/);
});

test("write_file refuses to clobber an existing card by its vault-relative path", async () => {
  freshVault();
  await writeFileTool.execute({
    path: "cards/contacts/ivan.md",
    content: "# Ivan\nfact\n",
  });
  const second = await writeFileTool.execute({
    path: "cards/contacts/ivan.md",
    content: "overwrite",
  });
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /write_card/);
});
