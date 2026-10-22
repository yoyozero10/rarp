// Explicit live test: uses the installed Codex account and a temporary workspace.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "rarp-live-"));
const cli = async (...args) =>
  JSON.parse(
    (
      await exec(
        process.execPath,
        [resolve("dist/cli/index.js"), "--project", root, "--json", ...args],
        { timeout: 30000 },
      )
    ).stdout,
  );
console.log(JSON.stringify({ root }));
await cli("init");
await cli("agent", "register", "manager", "--role", "manager");
await cli("agent", "register", "worker", "--role", "worker");
const task = await cli(
  "task",
  "create",
  "--title",
  "Write cart fixture",
  "--actor",
  "manager",
  "--assignee",
  "worker",
  "--body",
  "Create cart.json in the current directory with total=55000, discount=5000, payable=50000. Verify by reading the file. Do not read unrelated folders, use network, launch other agents, or modify .rarp. Report what you verified.",
);
await cli("runtime", "start");
try {
  await cli("worker", "run", task.id, "--timeout-ms", "120000");
  let status;
  for (let i = 0; i < 150; i++) {
    status = await cli("runtime", "status");
    if (!status.active) break;
    await delay(1000);
  }
  const final = await cli("task", "show", task.id);
  console.log(JSON.stringify({ runtime: status, task: final }));
  assert.equal(final.status, "submitted");
  const cart = JSON.parse(readFileSync(join(root, "cart.json"), "utf8"));
  assert.equal(cart.total, 55000);
  assert.equal(cart.discount, 5000);
  assert.equal(cart.payable, 50000);
  console.log(
    "PASS: real Codex wrote and verified the artifact; task submitted.",
  );
} finally {
  console.log(JSON.stringify(await cli("runtime", "stop")));
}
