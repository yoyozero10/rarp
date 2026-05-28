import { resolve } from "node:path";
import { startRuntime } from "../../dist/runtime/server.js";
const command = (role) => ({
  file: process.execPath,
  args: [resolve("tests/fixtures/parallel-agent.mjs"), role],
});
await startRuntime(
  process.argv[2],
  command("worker"),
  { manager: command("manager") },
  { maxWorkers: 4 },
);
process.send?.("ready");
