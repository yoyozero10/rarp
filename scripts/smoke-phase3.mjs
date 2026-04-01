import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { startRuntime } from "../dist/runtime/server.js";
import { codexCommand } from "../dist/adapters/codex.js";
import { antigravityCommand } from "../dist/adapters/antigravity.js";
const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "rarp-phase3-"));
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
let localRuntime;
if (process.argv.includes("--allow-agy-auto-approve")) {
  const agy = antigravityCommand();
  agy.args.unshift("--dangerously-skip-permissions");
  localRuntime = await startRuntime(root, codexCommand(), { antigravity: agy });
} else await cli("runtime", "start");
try {
  let previous;
  for (const adapter of process.argv.includes("--codex-only")
    ? ["codex", "codex"]
    : ["antigravity", "codex"]) {
    const body = previous
      ? "Read cart.json, preserve total=55000 and add discount=5000 and payable=50000. Verify payable equals total minus discount."
      : "Create cart.json with items [{price:20000,quantity:2},{price:15000,quantity:1}] and total=55000. Verify arithmetic.";
    const task = await cli(
      "task",
      "create",
      "--title",
      `Cart ${adapter}`,
      "--body",
      body,
      "--actor",
      "manager",
      "--assignee",
      "worker",
      ...(previous ? ["--depends-on", previous] : []),
    );
    await cli(
      "workflow",
      "run",
      task.id,
      "--adapter",
      adapter,
      "--max-rounds",
      "2",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "300000",
    );
    for (let i = 0; i < 330; i++) {
      const status = await cli("runtime", "status");
      if (!status.active) {
        console.log(JSON.stringify(status.last));
        break;
      }
      if (i % 15 === 0)
        console.log(JSON.stringify({ adapter, active: status.active }));
      await delay(1000);
    }
    const result = await cli("task", "show", task.id);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    previous = task.id;
  }
  const cart = JSON.parse(readFileSync(join(root, "cart.json"), "utf8"));
  assert.equal(cart.total, 55000);
  assert.equal(cart.payable, 50000);
  assert.equal(cart.discount, 5000);
  console.log(
    "PASS: selected workers with automatic Codex review, sequential dependency verified.",
  );
} finally {
  if (localRuntime) {
    await localRuntime.stop();
    console.log("Runtime stopped");
  } else console.log(JSON.stringify(await cli("runtime", "stop")));
}
