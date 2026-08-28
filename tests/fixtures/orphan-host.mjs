import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.argv[2];
const host = fork(resolve("dist/runtime/worker-host.js"), [], {
  // Mirror runWorker: on POSIX the host must be a group leader for killTree().
  detached: process.platform !== "win32",
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
host.send({
  root,
  prompt: "",
  command: {
    file: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync('orphan.pid',String(process.pid));setInterval(()=>{},1000)",
    ],
    protocol: "agent",
  },
});
while (!existsSync(join(root, "orphan.pid"))) await delay(25);
process.send?.("ready");
// Stay alive so the test can hard-kill us and exercise the host watchdog.
setInterval(() => {}, 1000);
