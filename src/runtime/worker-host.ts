import { spawn } from "node:child_process";
import type { CommandSpec } from "../adapters/codex.js";

// Keep this parent alive after the CLI exits so tree cleanup still has a live root.
const keepAlive = setInterval(() => {}, 1000);
process.once(
  "message",
  (message: { command: CommandSpec; root: string; prompt: string }) => {
    const child = spawn(message.command.file, message.command.args, {
      cwd: message.root,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const send = (data: unknown) => {
      if (process.connected) process.send?.(data);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => send({ type: "stdout", text }));
    child.stderr.on("data", (text: string) => send({ type: "stderr", text }));
    child.stdin.on("error", () => {});
    child.on("error", (error) =>
      send({ type: "spawn-error", text: error.message }),
    );
    child.on("exit", (code) => send({ type: "exit", code }));
    child.on("close", (code) => send({ type: "close", code }));
    child.stdin.end(message.prompt);
  },
);
process.on("disconnect", () => {
  // Best effort cleanup if the runtime disappears. Full crash reconciliation is M4.
  if (process.platform === "win32")
    spawn("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      clearInterval(keepAlive);
      process.exit(1);
    }
  }
});
