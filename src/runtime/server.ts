import { createServer } from "node:http";
import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Store } from "../storage/store.js";
import { codexCommand } from "../adapters/codex.js";
import type { CommandSpec } from "../adapters/codex.js";
import { observer, serveDashboard } from "./observer.js";
import { createScheduler, limitsSchema } from "./scheduler.js";
import type { SchedulerOptions } from "./scheduler.js";

export async function startRuntime(
  rootInput: string,
  command: CommandSpec = codexCommand(),
  adapters: { antigravity?: CommandSpec; manager?: CommandSpec } = {},
  options: SchedulerOptions = {},
) {
  const configuration = limitsSchema.parse(options);
  const root = realpathSync(rootInput);
  if (existsSync(join(root, ".rarp", "recovery.lock")))
    throw new Error("Recovery in progress");
  const store = new Store(root);
  if (
    store.runs().some((row) => row["state"] === "active") ||
    store.dispatches().some((d) => d.state === "active")
  ) {
    store.close();
    throw new Error("Unfinished runs exist; recover before starting runtime");
  }
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
  // Close the startup/recovery race after acquiring the exclusive runtime lock.
  if (existsSync(join(root, ".rarp", "recovery.lock"))) {
    store.close();
    unlinkSync(lock);
    throw new Error("Recovery in progress");
  }
  let stopping = false,
    closed = false;
  let cleanupError: unknown;
  const scheduler = createScheduler(
    store,
    root,
    command,
    adapters,
    configuration,
  );
  const heartbeat = setInterval(() => {
    try {
      scheduler.heartbeat();
    } catch (error) {
      cleanupError = error;
      stopping = true;
    }
  }, 2000);
  let finalSnapshot: ReturnType<typeof scheduler.snapshot> | undefined;
  const snapshot = () => ({
    ...(finalSnapshot ?? scheduler.snapshot()),
    ...(stopping ? { state: "stopping" } : {}),
  });
  const observation = observer(store, snapshot);
  let stopPromise: Promise<void> | undefined;
  function stop() {
    return (stopPromise ??= (async () => {
      if (closed) return;
      stopping = true;
      await scheduler.shutdown();
      if (cleanupError) throw cleanupError;
      observation.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      finalSnapshot = scheduler.snapshot();
      store.close();
      clearInterval(heartbeat);
      unlinkSync(lock);
      closed = true;
    })());
  }
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const reply = (data: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    try {
      const address = server.address();
      const origin =
        address && typeof address !== "string"
          ? `http://127.0.0.1:${address.port}`
          : "";
      if (
        req.headers.host !== origin.slice(7) ||
        (req.headers.origin && req.headers.origin !== origin)
      ) {
        reply({ error: "Invalid host or origin" }, 403);
        return;
      }
      const url = new URL(req.url ?? "/", origin);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "no-store");
      if (req.method === "GET" && serveDashboard(url.pathname, res)) return;
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply({ error: "Unauthorized" }, 401);
        return;
      }
      if (observation.handle(req, res, url)) return;
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
        await scheduler.shutdown();
        if (cleanupError) throw cleanupError;
        reply({ state: "stopped" });
        setImmediate(() => {
          void stop().catch(console.error);
        });
        return;
      }
      if (req.url === "/cancel") {
        let body = "";
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 4096) throw new Error("Request too large");
        }
        const input = z
          .object({ taskId: z.string().optional() })
          .parse(JSON.parse(body || "{}"));
        await scheduler.cancel(input.taskId);
        reply(snapshot());
        return;
      }
      if (
        req.url !== "/run" &&
        req.url !== "/workflow" &&
        req.url !== "/integrate" &&
        ![
          "/tasks",
          "/transition",
          "/reassign",
          "/agents",
          "/scheduler",
        ].includes(req.url ?? "")
      ) {
        reply({ error: "Unknown route" }, 404);
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 32768) throw new Error("Request too large");
      }
      if (
        ["/tasks", "/transition", "/reassign", "/agents"].includes(
          req.url ?? "",
        )
      ) {
        if (stopping) throw new Error("Runtime stopping");
        const data = JSON.parse(body);
        if (req.url === "/tasks") {
          reply(store.create(data));
          return;
        }
        if (req.url === "/agents") {
          const input = z
            .object({ id: z.string(), role: z.string() })
            .parse(data);
          reply(store.register(input.id, input.role));
          return;
        }
        const input = z
          .object({
            taskId: z.string(),
            actor: z.string(),
            expectedStatus: z.string(),
            note: z.string().min(1).max(20000),
            status: z.string().optional(),
            assignee: z.string().optional(),
          })
          .parse(data);
        if (scheduler.has(input.taskId))
          throw new Error(
            "Cancel the active workflow before changing this task",
          );
        if (store.show(input.taskId).status !== input.expectedStatus)
          throw new Error("Task changed; refresh before retrying");
        if (req.url === "/reassign") {
          if (!input.assignee) throw new Error("assignee required");
          reply(
            store.reassign(
              input.taskId,
              input.actor,
              input.assignee,
              input.expectedStatus,
            ),
          );
          return;
        }
        if (!input.status || ["running", "submitted"].includes(input.status))
          throw new Error("Use workflow to run or submit work");
        reply(
          store.transition(
            input.taskId,
            input.status,
            input.actor,
            input.note,
            input.expectedStatus,
          ),
        );
        return;
      }
      if (req.url === "/scheduler") {
        const input = z
          .object({ action: z.enum(["pause", "resume"]) })
          .parse(JSON.parse(body));
        scheduler.control(input.action);
        reply(snapshot());
        return;
      }
      if (req.url === "/integrate") {
        const input = z
          .object({
            taskId: z.string().min(1),
            async: z.boolean().default(false),
          })
          .parse(JSON.parse(body));
        const integration = scheduler.integrate(input.taskId);
        if (input.async) {
          void integration.catch(() => {});
          reply({ state: "integration-queued", taskId: input.taskId }, 202);
        } else reply(await integration);
        return;
      }
      if (stopping) throw new Error("Runtime busy or stopping");
      const dispatched = scheduler.request(
        req.url === "/run" ? "run" : "workflow",
        JSON.parse(body),
      );
      reply({ ...snapshot(), ...dispatched }, dispatched.duplicate ? 200 : 202);
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
    await scheduler.shutdown();
    store.close();
    clearInterval(heartbeat);
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
