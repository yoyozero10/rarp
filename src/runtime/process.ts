import { fork, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexStream } from "../adapters/codex.js";
import type { CommandSpec } from "../adapters/codex.js";

const exec = promisify(execFile);
export interface WorkerResult {
  success: boolean;
  note: string;
  reason: string;
}
export function runWorker(
  command: CommandSpec,
  root: string,
  prompt: string,
  timeoutMs: number,
  event: (data: Record<string, unknown>) => void,
) {
  const host = fork(
    fileURLToPath(new URL("./worker-host.js", import.meta.url)),
    [],
    {
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    },
  );
  let finishing = false;
  let bytes = 0;
  let drainTimer: NodeJS.Timeout | undefined;
  let resolveResult: (result: WorkerResult) => void;
  let rejectResult: (error: Error) => void;
  const done = new Promise<WorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const parser = new CodexStream(event);
  async function finish(reason: string, code?: number | null) {
    if (finishing) return;
    finishing = true;
    clearTimeout(timer);
    clearTimeout(drainTimer);
    try {
      if (reason === "exit") parser.finish();
    } catch {
      reason = "protocol-error";
    }
    try {
      if (host.pid) {
        if (process.platform === "win32")
          await exec("taskkill", ["/PID", String(host.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 10000,
          });
        else {
          try {
            process.kill(-host.pid, "SIGKILL");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
          }
        }
      }
      const success =
        reason === "exit" &&
        code === 0 &&
        parser.completed &&
        !parser.failed &&
        Boolean(parser.result.trim());
      resolveResult({
        success,
        reason,
        note: success
          ? parser.result
          : `Worker ${reason}; exit=${code ?? "unknown"}; completed=${parser.completed}`,
      });
    } catch (error) {
      rejectResult(new Error(`Worker cleanup failed: ${String(error)}`));
    }
  }
  const timer = setTimeout(() => {
    void finish("timeout");
  }, timeoutMs);
  host.on("error", () => {
    void finish("host-error");
  });
  host.on("exit", () => {
    if (!finishing) void finish("host-exited");
  });
  host.on(
    "message",
    (message: { type: string; text?: string; code?: number | null }) => {
      if (finishing) return;
      try {
        bytes += Buffer.byteLength(message.text ?? "");
        if (bytes > 8 * 1024 * 1024) {
          void finish("output-limit");
          return;
        }
        if (message.type === "stdout") parser.feed(message.text ?? "");
        if (message.type === "stderr")
          event({ type: "stderr", text: message.text });
        if (message.type === "spawn-error") {
          event({ type: "spawn-error", text: message.text });
          void finish("spawn-error");
        }
        if (message.type === "exit")
          drainTimer = setTimeout(() => {
            void finish("exit", message.code);
          }, 300);
        if (message.type === "close") void finish("exit", message.code);
      } catch {
        void finish("protocol-error");
      }
    },
  );
  host.send({ command, root, prompt });
  return {
    pid: host.pid,
    done,
    cancel: () => {
      void finish("cancelled");
      return done;
    },
  };
}
