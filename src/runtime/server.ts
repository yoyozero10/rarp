import { createServer } from "node:http";
import { writeFileSync, readFileSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Store } from "../storage/store.js";
import { codexCommand } from "../adapters/codex.js";
import type { CommandSpec } from "../adapters/codex.js";
import { runWorker } from "./process.js";

export async function startRuntime(
  rootInput: string,
  command: CommandSpec = codexCommand(),
) {
  const root = realpathSync(rootInput);
  const store = new Store(root);
  const lock = join(root, ".rarp", "runtime.json");
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, token, state: "starting" }),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    store.close();
    throw new Error(
      "Runtime lock exists. Check runtime status; stale locks require manual inspection before removal.",
    );
  }
  let active:
    | {
        taskId: string;
        attemptId: string;
        worker: ReturnType<typeof runWorker>;
        settled: Promise<void>;
      }
    | undefined;
  let last: unknown = null;
  let stopping = false;
  let closed = false;
  let cleanupError: unknown;
  const snapshot = () => ({
    pid: process.pid,
    state: stopping ? "stopping" : active ? "working" : "ready",
    active: active
      ? {
          taskId: active.taskId,
          attemptId: active.attemptId,
          pid: active.worker.pid,
        }
      : null,
    last,
  });
  async function stop() {
    if (closed) return;
    stopping = true;
    if (active) {
      await active.worker.cancel();
      await active.settled;
    }
    if (cleanupError) throw cleanupError;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    unlinkSync(lock);
    closed = true;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const reply = (data: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply({ error: "Unauthorized" }, 401);
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        reply(snapshot());
        return;
      }
      if (req.method !== "POST") {
        reply({ error: "Unknown route" }, 404);
        return;
      }
      if (req.url === "/stop") {
        stopping = true;
        if (active) {
          await active.worker.cancel();
          await active.settled;
        }
        if (cleanupError) throw cleanupError;
        reply({ state: "stopped" });
        setImmediate(() => {
          void stop().catch(console.error);
        });
        return;
      }
      if (req.url === "/cancel") {
        if (active) {
          await active.worker.cancel();
          await active.settled;
        }
        reply(snapshot());
        return;
      }
      if (req.url !== "/run") {
        reply({ error: "Unknown route" }, 404);
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 4096) throw new Error("Request too large");
      }
      const input = z
        .object({
          taskId: z.string().min(1),
          timeoutMs: z.number().int().min(100).max(3600000).default(120000),
        })
        .parse(JSON.parse(body));
      if (stopping || active) throw new Error("Runtime busy or stopping");
      const task = store.show(input.taskId);
      const running = store.transition(
        task.id,
        "running",
        task.assigned_to,
        "Dispatched by runtime",
      );
      const attemptId = String(running.attempts.at(-1)!["id"]);
      const prompt = `You are a bounded Rarp worker. Work only in this project. Do not launch other agents or change .rarp state. Complete the task and report results; manager reviews separately.\nTitle: ${task.title}\n${task.body}`;
      const worker = runWorker(command, root, prompt, input.timeoutMs, (data) =>
        store.recordWorkerEvent(task.id, attemptId, task.assigned_to, data),
      );
      const settled = worker.done
        .then((result) => {
          const current = store.show(task.id);
          if (
            current.status === "running" &&
            current.attempts.at(-1)?.["id"] === attemptId
          )
            store.transition(
              task.id,
              result.success ? "submitted" : "failed",
              task.assigned_to,
              result.note,
            );
          last = {
            taskId: task.id,
            attemptId,
            ...result,
            state: result.success ? "exited" : "failed",
          };
        })
        .catch((error) => {
          cleanupError = error;
          last = { taskId: task.id, state: "failed", error: String(error) };
          stopping = true;
        })
        .finally(() => {
          active = undefined;
        });
      active = { taskId: task.id, attemptId, worker, settled };
      reply(snapshot(), 202);
    } catch (error) {
      reply(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No runtime address");
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, token, port: address.port }),
      { mode: 0o600 },
    );
  } catch (error) {
    store.close();
    unlinkSync(lock);
    throw error;
  }
  return { stop, status: snapshot };
}

export async function runtimeRequest(
  root: string,
  route: string,
  body?: unknown,
) {
  const meta = JSON.parse(
    readFileSync(join(root, ".rarp", "runtime.json"), "utf8"),
  ) as { port: number; token: string };
  if (!Number.isInteger(meta.port))
    throw new Error("Runtime is starting or requires inspection");
  const response = await fetch(`http://127.0.0.1:${meta.port}/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${meta.token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Runtime request failed");
  return data;
}
