import { randomBytes } from "node:crypto";
import { z } from "zod";
import { dispatchSchema } from "../core/dispatch.js";
import type { Dispatch, DispatchInput } from "../core/dispatch.js";
import type { Store } from "../storage/store.js";
import type { CommandSpec } from "../adapters/codex.js";
import { codexReviewCommand } from "../adapters/codex.js";
import { antigravityCommand } from "../adapters/antigravity.js";
import { runWorker } from "./process.js";
import { runWorkflow } from "./workflow.js";
import {
  prepareWorkspace,
  integrateWorkspaceAsync,
  validateScope,
} from "./workspace.js";
import { reviewPool } from "./review-pool.js";

type Active = {
  dispatch: Dispatch;
  assignee: string;
  attemptId: string;
  worker: {
    pid: number | undefined;
    cancel: () => Promise<unknown>;
    snapshot?: () => {
      stage: string;
      round: number;
      attemptId: string;
      pid: number | undefined;
    };
  };
  settled: Promise<void>;
};
export const limitsSchema = z.object({
  maxWorkers: z.number().int().min(1).max(16).default(2),
  maxReviewers: z.number().int().min(1).max(16).default(1),
});
export type SchedulerOptions = z.input<typeof limitsSchema>;
export function createScheduler(
  store: Store,
  root: string,
  command: CommandSpec,
  adapters: { antigravity?: CommandSpec; manager?: CommandSpec },
  options: SchedulerOptions = {},
) {
  const limits = limitsSchema.parse(options),
    reviews = reviewPool(limits.maxReviewers);
  const owner = randomBytes(16).toString("hex"),
    active = new Map<string, Active>();
  let last: unknown = null,
    error: unknown,
    stopping = false,
    paused = store.dispatches().some((d) => d.state === "waiting");
  let integration:
    | { taskId: string; check?: ReturnType<typeof runWorker> }
    | undefined;
  let integrationTail: Promise<unknown> = Promise.resolve();
  let lastIntegration: {
    taskId: string;
    state: string;
    error?: string;
  } | null = null;
  store.schedulerEvent("started", { ...limits, paused });
  const pending = () => store.dispatches().filter((d) => d.state === "waiting");
  const scopes = (input: DispatchInput) =>
    store.workspace(input.taskId)?.scope ?? input.scope;
  const overlaps = (a: string[], b: string[]) =>
    a.some((x) =>
      b.some((y) => {
        if (process.platform === "win32") {
          x = x.toLowerCase();
          y = y.toLowerCase();
        }
        return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
      }),
    );
  function reason(dispatch: Dispatch) {
    const input = dispatch.input,
      task = store.show(dispatch.taskId);
    if (stopping || error) return "Runtime stopping";
    if (paused) return "Scheduler paused";
    if (active.size >= limits.maxWorkers) return "Worker capacity busy";
    if (active.has(task.id)) return "Task already active";
    if ([...active.values()].some((a) => a.assignee === task.assigned_to))
      return "Assigned worker busy";
    if (
      active.size &&
      (!input.isolated ||
        [...active.values()].some((a) => !a.dispatch.input.isolated))
    )
      return "Main checkout busy; non-isolated tasks run exclusively";
    if (integration && !input.isolated) return "Main checkout busy integrating";
    for (const id of task.dependencies) {
      if (store.show(String(id)).status !== "accepted")
        return "Dependencies must be accepted before starting";
      const dep = store.workspace(String(id));
      if (input.isolated && dep && !dep.integrated)
        return "Integrate isolated dependencies before dispatch";
    }
    if (input.isolated) {
      if (
        [...active.values()].some((a) =>
          overlaps(scopes(input), scopes(a.dispatch.input)),
        )
      )
        return "File scope busy";
      for (const other of store.list("accepted")) {
        if (other["id"] === task.id) continue;
        const ws = store.workspace(String(other["id"]));
        if (ws && !ws.integrated && overlaps(scopes(input), ws.scope))
          return "Integrate accepted overlapping scope before dispatch";
      }
    }
    return null;
  }
  function validate(dispatch: Dispatch) {
    const input = dispatch.input,
      task = store.show(input.taskId),
      workspace = store.workspace(input.taskId);
    if ((input.isolated || input.resumeReview) && dispatch.route !== "workflow")
      throw new Error("Isolation and resume-review require workflow");
    if (task.status !== (input.resumeReview ? "submitted" : "queued"))
      throw new Error(
        input.resumeReview
          ? "Resume review requires a submitted task"
          : "Task must be queued",
      );
    if (workspace && !input.isolated)
      throw new Error("Task has an isolated workspace; use isolated mode");
    if (
      workspace &&
      ((input.scope.length &&
        JSON.stringify(input.scope) !== JSON.stringify(workspace.scope)) ||
        (input.check.length &&
          JSON.stringify(input.check) !== JSON.stringify(workspace.check)))
    )
      throw new Error(
        "Existing workspace scope/check are immutable; omit them or reuse original values",
      );
    if (input.isolated && !workspace) {
      validateScope(input.scope);
      if (!input.check.length || !input.check[0])
        throw new Error("A verification command is required");
    }
  }
  function finish(dispatch: Dispatch, state: string, note: string) {
    dispatch.state = state;
    dispatch.note = note;
    store.saveDispatch(dispatch);
  }
  function start(dispatch: Dispatch) {
    let runId: string | undefined;
    try {
      validate(dispatch);
      const input = dispatch.input,
        task = store.show(input.taskId);
      finish(dispatch, "active", "Claimed by scheduler");
      let workspace = store.workspace(task.id);
      if (input.isolated && !workspace) {
        workspace = prepareWorkspace(root, task.id, input.scope, input.check);
        store.saveWorkspace(workspace);
      }
      runId = store.reserveRun(
        dispatch.key,
        dispatch.fingerprint,
        task.id,
        owner,
      );
      const running = input.resumeReview
        ? task
        : store.transition(
            task.id,
            "running",
            task.assigned_to,
            "Dispatched by scheduler",
            "queued",
          );
      const attemptId = String(running.attempts.at(-1)!["id"]),
        id = runId;
      const selected =
        input.adapter === "antigravity"
          ? (adapters.antigravity ?? antigravityCommand())
          : command;
      const worker =
        dispatch.route === "workflow"
          ? runWorkflow(
              store,
              workspace?.path ?? root,
              task.id,
              selected,
              adapters.manager ?? codexReviewCommand(command.file),
              {
                ...input,
                ...(workspace ? { workspace } : {}),
                onSpawn: (pid) => store.hostRun(id, pid),
                acquireReview: (signal) => reviews.acquire(signal),
              },
              attemptId,
            )
          : runWorker(
              selected,
              root,
              `You are a bounded Rarp worker. Work only in this project; do not alter .rarp or launch agents.\nTitle: ${task.title}\n${task.body}`,
              input.timeoutMs,
              (event) =>
                store.recordWorkerEvent(
                  task.id,
                  attemptId,
                  task.assigned_to,
                  event,
                ),
              (pid) => store.hostRun(id, pid),
            );
      const settled = worker.done
        .then((result) => {
          if (dispatch.route === "run") {
            const current = store.show(task.id);
            if (
              current.status === "running" &&
              current.attempts.at(-1)?.["id"] === attemptId
            )
              store.transition(
                task.id,
                result.success ? "submitted" : "failed",
                task.assigned_to,
                "note" in result ? result.note : String(result),
              );
          }
          last = { taskId: task.id, attemptId, ...result };
          store.finishRun(id, last);
          finish(dispatch, "completed", String(store.show(task.id).status));
        })
        .catch((cause) => {
          error = cause;
          stopping = true;
          last = { taskId: task.id, error: String(cause) };
        })
        .finally(() => {
          active.delete(task.id);
        });
      active.set(task.id, {
        dispatch,
        assignee: task.assigned_to,
        attemptId,
        worker,
        settled,
      });
    } catch (cause) {
      if (runId) store.finishRun(runId, { error: String(cause) });
      finish(dispatch, "failed", String(cause));
      throw cause;
    }
  }
  function tick() {
    if (stopping || paused || error) return;
    for (const dispatch of pending()) {
      try {
        validate(dispatch);
        if (!reason(dispatch)) start(dispatch);
      } catch (cause) {
        if (dispatch.state === "waiting")
          finish(dispatch, "failed", String(cause));
      }
    }
  }
  const timer = setInterval(() => {
    try {
      tick();
    } catch (cause) {
      error = cause;
      stopping = true;
    }
  }, 250);
  async function cancel(taskId?: string) {
    if (!taskId) {
      if (active.size > 1)
        throw new Error("taskId required when multiple workers are active");
      taskId = active.keys().next().value;
    }
    if (!taskId) {
      if (pending().length)
        throw new Error("taskId required to cancel a queued dispatch");
      return;
    }
    if (integration?.taskId === taskId) {
      await integration.check?.cancel();
      return;
    }
    const item = active.get(taskId);
    if (item) {
      await item.worker.cancel();
      await item.settled;
      return;
    }
    const queued = pending().find((d) => d.taskId === taskId);
    if (queued) {
      finish(
        queued,
        "cancelled",
        "Queued dispatch cancelled; task remains queued",
      );
      return;
    }
    throw new Error("Active task changed; refresh before cancelling");
  }
  return {
    get error() {
      return error;
    },
    heartbeat() {
      store.heartbeat(owner);
    },
    has(taskId: string) {
      return active.has(taskId);
    },
    snapshot() {
      const workers = [...active.values()].map((item) => ({
        taskId: item.dispatch.taskId,
        assignee: item.assignee,
        requestKey: item.dispatch.key,
        attemptId: item.worker.snapshot?.().attemptId ?? item.attemptId,
        pid: item.worker.pid,
        workflow: item.worker.snapshot?.(),
      }));
      return {
        pid: process.pid,
        state: stopping
          ? "stopping"
          : active.size || integration
            ? "working"
            : "ready",
        active: workers[0] ?? null,
        workers,
        lastIntegration,
        integration: integration
          ? { taskId: integration.taskId, pid: integration.check?.pid }
          : null,
        queue: pending().map((d) => ({
          taskId: d.taskId,
          requestKey: d.key,
          reason: reason(d),
        })),
        limits: {
          ...limits,
          freeSlots: limits.maxWorkers - active.size,
          activeReviewers: reviews.active,
        },
        paused,
        last,
      };
    },
    request(route: "run" | "workflow", body: unknown) {
      const input = dispatchSchema.parse(body),
        key = input.requestKey ?? randomBytes(16).toString("hex");
      const fingerprint = JSON.stringify({
          route: "/" + route,
          ...input,
          requestKey: undefined,
          enqueue: input.enqueue || undefined,
        }),
        old = store.dispatch(key),
        run = store.findRun(key);
      if (old || run) {
        if ((old?.fingerprint ?? run?.["fingerprint"]) !== fingerprint)
          throw new Error("Request key reused with different input");
        return { duplicate: true, dispatch: old, run };
      }
      if (stopping || error) throw new Error("Runtime busy or stopping");
      if (
        active.has(input.taskId) ||
        pending().some((d) => d.taskId === input.taskId)
      )
        throw new Error("Task busy or already queued");
      const dispatch: Dispatch = {
        key,
        fingerprint,
        taskId: input.taskId,
        route,
        input,
        state: "waiting",
        note: "Waiting for capacity and dependencies",
      };
      validate(dispatch);
      const wait = reason(dispatch);
      if (wait && !input.enqueue)
        throw new Error("Runtime busy or stopping: " + wait);
      store.saveDispatch(dispatch);
      if (!wait) start(dispatch);
      return { queued: !!wait, requestKey: key };
    },
    cancel,
    control(action: "pause" | "resume") {
      if (stopping || error) throw new Error("Runtime stopping");
      paused = action === "pause";
      store.schedulerEvent(action, { paused });
      if (!paused) tick();
    },
    integrate(taskId: string) {
      if (stopping || error) throw new Error("Runtime stopping");
      if (store.show(taskId).status !== "accepted")
        throw new Error("Task must be accepted before integration");
      if (!store.workspace(taskId))
        throw new Error("Task has no isolated workspace");
      const result = integrationTail.then(async () => {
        if (
          stopping ||
          error ||
          [...active.values()].some((a) => !a.dispatch.input.isolated)
        )
          throw new Error("Main checkout busy or runtime stopping");
        const task = store.show(taskId);
        if (task.status !== "accepted")
          throw new Error("Task must be accepted before integration");
        const workspace = store.workspace(taskId);
        if (!workspace) throw new Error("Task has no isolated workspace");
        const runId = store.reserveRun(
          "integration-" + randomBytes(16).toString("hex"),
          "integration:" + workspace.commit,
          taskId,
          owner,
        );
        integration = { taskId };
        lastIntegration = { taskId, state: "integrating" };
        try {
          workspace.integrated = await integrateWorkspaceAsync(
            root,
            workspace,
            async (candidate) => {
              const check = runWorker(
                {
                  file: candidate.check[0]!,
                  args: candidate.check.slice(1),
                  protocol: "check",
                },
                candidate.path,
                "",
                120000,
                (event) =>
                  store.recordReviewEvent(
                    taskId,
                    String(task.attempts.at(-1)!["id"]),
                    task.created_by,
                    event,
                  ),
                (pid) => store.hostRun(runId, pid),
              );
              integration!.check = check;
              const result = await check.done;
              if (!result.success)
                throw new Error("Verification failed: " + result.note);
              return result.note;
            },
          );
          store.saveWorkspace(workspace);
          lastIntegration = { taskId, state: "integrated" };
          store.finishRun(runId, {
            state: "integrated",
            commit: workspace.integrated,
          });
          return workspace;
        } catch (cause) {
          if (String(cause).includes("cleanup failed")) {
            error = cause;
            stopping = true;
          } else
            store.finishRun(runId, {
              state: "integration-failed",
              error: String(cause),
            });
          throw cause;
        } finally {
          integration = undefined;
        }
      });
      integrationTail = result.catch((cause) => {
        lastIntegration = { taskId, state: "failed", error: String(cause) };
        store.schedulerEvent("integration-failed", lastIntegration);
      });
      return result;
    },
    async shutdown() {
      stopping = true;
      clearInterval(timer);
      const results = await Promise.allSettled(
        [...active.values()].map(async (item) => {
          await item.worker.cancel();
          await item.settled;
        }),
      );
      await integration?.check?.cancel();
      await integrationTail;
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
      if (error) throw error;
    },
  };
}
