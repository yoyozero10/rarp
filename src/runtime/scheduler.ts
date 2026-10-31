import { randomBytes } from "node:crypto";
import { profileCommand, repositorySnapshot, available } from "./planning.js";
import { hash, planBudget, remainingTime } from "../core/plan.js";
import type { PlanningAdapters } from "./planning.js";
import { z } from "zod";
import { dispatchSchema } from "../core/dispatch.js";
import type { Dispatch, DispatchInput } from "../core/dispatch.js";
import type { Store } from "../storage/store.js";
import type { CommandSpec } from "../adapters/codex.js";
import { codexReviewCommand } from "../adapters/codex.js";
import { antigravityCommand, withFullAccess } from "../adapters/antigravity.js";
import { runWorker } from "./process.js";
import { runWorkflow } from "./workflow.js";
import { classifyFailure } from './workflow.js';
import {
  prepareWorkspace,
  integrateWorkspaceAsync,
  validateScope,
  git,
} from "./workspace.js";
import { reviewPool } from "./review-pool.js";
import type { Workspace } from './workspace.js';

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
  adapters: PlanningAdapters,
  options: SchedulerOptions = {},
) {
  const limits = limitsSchema.parse(options),
    reviews = reviewPool(limits.maxReviewers);
  const owner = randomBytes(16).toString("hex"),
    active = new Map<string, Active>();
  let last: unknown = null,
    error: unknown,
    stopping = false,
    paused = store.events().filter(e=>e['type']==='scheduler.pause' || e['type']==='scheduler.resume').at(-1)?.['type']==='scheduler.pause' || store.dispatches().some(d=>d.state==='waiting' && !d.input.executionId);
  let integration:
    | { taskId: string; check?: ReturnType<typeof runWorker> }
    | undefined;
  let integrationTail: Promise<unknown> = Promise.resolve();
  const integratingPlans = new Set<string>();
  const executionReviews = new Map<string, ReturnType<typeof reviewPool>>();
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
    const plan = store.taskPlan(task.id);
    if (plan) {
      if(plan.status !== 'executing') return 'Execution '+plan.status;
      if(!plan.approval || input.executionId!==plan.id) return 'Missing plan approval';
      if(plan.bindings?.['__manager'] && plan.bindings['__manager']!==hash(adapters.manager??codexReviewCommand(command.file))) {store.planState(plan.id,'paused','Manager profile changed; approval required','configuration');return 'Manager profile changed';}
      const step=plan.proposal?.steps.find(s=>store.planLinks(plan.id).find(l=>l.taskId===task.id)?.stepKey===s.key);
      const binding=plan.approval.workers.find(w=>w.workerRef===step?.workerRef);
      if(!binding || input.adapter!==binding.adapter || input.profile!==binding.profile) return 'Plan binding changed';
      const selected=profileCommand(adapters,command,binding.adapter,binding.profile);
      if(!available(selected.file) || plan.bindings?.[binding.workerRef]!==hash(selected)) { store.planState(plan.id,'paused','Profile changed or unavailable; approval required','configuration'); return 'Profile changed'; }
      if(integration) return 'Integration in progress';
      const snapshot=repositorySnapshot(root), expected=plan.executionSnapshot??plan;
      if(snapshot.baseHead!==expected.baseHead || snapshot.fingerprint!==expected.fingerprint) { store.planState(plan.id,'paused','Repository stale before dispatch; analyze again','repository'); return 'Repository stale'; }
      const budget=planBudget(plan),usage=store.taskUsage(task.id);
      if((!input.resumeReview && usage.rounds>=budget.maxRounds) || remainingTime(plan)<=0) {store.planState(plan.id,'paused','Budget exhausted; approve a larger budget in a new revision','budget');return 'Budget exhausted';}
      if([...active.values()].filter(a=>a.dispatch.input.executionId===plan.id).length>=plan.approval.maxWorkers) return 'Execution worker capacity busy';
    }
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
      if(input.executionId)store.startExecution(input.executionId);
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
      const selected = input.executionId
        ? withFullAccess(
            profileCommand(adapters, command, input.adapter, input.profile),
            store.plan(input.executionId).approval?.antigravityFullAccess === true,
          )
        : input.adapter === "antigravity"
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
                acquireReview: async (signal) => {
                  if(!input.executionId) return reviews.acquire(signal);
                  let pool=executionReviews.get(input.executionId);
                  if(!pool) { pool=reviewPool(store.plan(input.executionId).approval!.maxReviewers); executionReviews.set(input.executionId,pool); }
                  const local=await pool.acquire(signal);
                  try { const global=await reviews.acquire(signal); return ()=>{global();local();}; } catch(e) {local();throw e;}
                },
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
    for (const plan of store.plans().filter(p=>p.status==='executing')) {
      const links=store.planLinks(plan.id), tasks=links.map(l=>store.show(l.taskId));
      const failed=tasks.find(t=>['failed','blocked','changes_requested','cancelled'].includes(t.status) && !active.has(t.id));
      if(failed) {const usage=store.taskUsage(failed.id);store.planState(plan.id,'paused',usage.feedback??String(failed.reviews.at(-1)?.['feedback']??'Task needs decision'),usage.stopReason??(failed.status==='changes_requested'?'review':'worker'));continue;}
      const accepted=tasks.find(t=>t.status==='accepted' && !store.workspace(t.id)?.integrated);
      if(accepted && plan.approval?.integration==='reviewed-local' && !integration && !integratingPlans.has(plan.id)) {
        integratingPlans.add(plan.id);
        void api.integrate(accepted.id).catch(cause=>{ if(store.plan(plan.id).status==='executing') store.planState(plan.id,'paused',String(cause),'integration'); }).finally(()=>integratingPlans.delete(plan.id));
      }
      if(tasks.length && tasks.every(t=>t.status==='accepted' && !!store.workspace(t.id)?.integrated) && !integration && !integratingPlans.has(plan.id) && !active.size) {
        integratingPlans.add(plan.id);
        const result=integrationTail.then(()=>verifyPlan(plan.id));
        integrationTail=result.catch(cause=>{if(store.plan(plan.id).status==='executing')store.planState(plan.id,'paused',String(cause),'verification');}).finally(()=>integratingPlans.delete(plan.id));
      }
    }
    for (const dispatch of pending()) {
      try {
        validate(dispatch);
        if (!reason(dispatch)) start(dispatch);
      } catch (cause) {
        if (dispatch.state === "waiting")
          finish(dispatch, "failed", String(cause));
        const plan = store.taskPlan(dispatch.taskId);
        if (plan?.status === 'executing') store.planState(plan.id, 'paused', String(cause),'configuration');
      }
    }
  }
  async function verifyPlan(id:string) {
    const p=store.plan(id);if(stopping || p.status!=='executing')return;
    const before=repositorySnapshot(root),expected=p.executionSnapshot??p;
    if(before.baseHead!==expected.baseHead || before.fingerprint!==expected.fingerprint)throw new Error('Repository stale before final verification');
    const deadline=store.startExecution(id),evidence:string[]=[];
    for(const link of store.planLinks(id)) {
      if(stopping || store.plan(id).status!=='executing')return;
      if(Date.now()>=deadline){store.planState(id,'paused','Execution time budget exhausted','budget');return;}
      const ws=store.workspace(link.taskId)!,task=store.show(link.taskId);
      const runId=store.reserveRun('final-'+randomBytes(16).toString('hex'),'final:'+before.baseHead,task.id,owner);
      integration={taskId:task.id};
      try {
        const check=runWorker({file:ws.check[0]!,args:ws.check.slice(1),protocol:'check'},root,'',Math.max(1,Math.min(planBudget(p).timeoutMs,deadline-Date.now())),event=>store.recordReviewEvent(task.id,String(task.attempts.at(-1)!['id']),task.created_by,event),pid=>store.hostRun(runId,pid));
        integration.check=check;const result=await check.done;store.finishRun(runId,result);
        const after=repositorySnapshot(root);if(after.baseHead!==before.baseHead || after.fingerprint!==before.fingerprint || git(root,'status','--porcelain'))throw new Error('Repository changed during final verification');
        evidence.push(link.stepKey+': '+result.note);
        if(!result.success) {
          store.planVerification(id,{head:before.baseHead,passed:false,evidence});
          if(stopping || store.plan(id).status!=='executing')return;
          const reason=result.reason==='cancelled'?'human':classifyFailure(result.note,'verification'),usage=store.taskUsage(task.id);
          if(reason==='human'){store.planState(id,'paused','Final verification cancelled','human');return;}
          if(reason==='configuration' || reason==='permission' || usage.rounds>=planBudget(p).maxRounds || Date.now()>=deadline) {store.planState(id,'paused',result.note,reason==='configuration'||reason==='permission'?reason:'budget');return;}
          const fresh=prepareWorkspace(root,task.id,ws.scope,ws.check,'-repair-'+randomBytes(6).toString('hex'));
          store.repairAccepted(task.id,fresh,'Final verification failed: '+result.note);return;
        }
      }catch(cause){if(String(cause).includes('cleanup failed')){error=cause;stopping=true;}else store.finishRun(runId,{error:String(cause)});throw cause;}
      finally{integration=undefined;}
    }
    if(!stopping && store.plan(id).status==='executing'){store.planVerification(id,{head:before.baseHead,passed:true,evidence});store.planState(id,'completed');}
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
  const api = {
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
      if(store.taskPlan(input.taskId) || input.executionId) throw new Error('Plan tasks dispatch only through approved materialization');
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
        const plan=store.taskPlan(taskId);
        if(plan && !['executing','paused','waiting_permission','waiting_input'].includes(plan.status)) throw new Error('Approved running or paused execution required');
        if(plan) {const snap=repositorySnapshot(root),expected=plan.executionSnapshot??plan;if(!plan.approval || snap.baseHead!==expected.baseHead || snap.fingerprint!==expected.fingerprint)throw new Error('Repository stale; revise and approve before integration');}
        const task = store.show(taskId);
        if (task.status !== "accepted")
          throw new Error("Task must be accepted before integration");
        const workspace = store.workspace(taskId);
        if (!workspace) throw new Error("Task has no isolated workspace");
        if(plan) {const link=store.planLinks(plan.id).find(l=>l.taskId===taskId),step=plan.proposal?.steps.find(s=>s.key===link?.stepKey);if(!step || hash(step.scope)!==hash(workspace.scope) || hash(step.check)!==hash(workspace.check))throw new Error('Workspace scope/check differs from approved task');}
        const runId = store.reserveRun(
          "integration-" + randomBytes(16).toString("hex"),
          "integration:" + workspace.commit,
          taskId,
          owner,
        );
        integration = { taskId };
        lastIntegration = { taskId, state: "integrating" };
        let failedCandidate: Workspace | undefined;
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
              if (!result.success) {
                if(result.reason==='exit' && classifyFailure(result.note,'verification')==='verification')failedCandidate=candidate;
                throw new Error("Verification failed: " + result.note);
              }
              return result.note;
            },
          );
          store.saveWorkspace(workspace);
          const plan=store.taskPlan(taskId);
          if(plan) store.planSnapshot(plan.id,repositorySnapshot(root));
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
          if(plan && failedCandidate && !stopping && store.plan(plan.id).status==='executing' && store.taskUsage(taskId).rounds<planBudget(plan).maxRounds) {
            const snapshot=repositorySnapshot(root),expected=store.plan(plan.id).executionSnapshot??plan;
            if(snapshot.baseHead===expected.baseHead && snapshot.fingerprint===expected.fingerprint && !git(failedCandidate.path,'status','--porcelain')) {
              const fresh=prepareWorkspace(root,taskId,workspace.scope,workspace.check,'-repair-'+randomBytes(6).toString('hex'));
              git(fresh.path,'-c','core.hooksPath=/dev/null','merge','--ff-only',git(failedCandidate.path,'rev-parse','HEAD'));
              fresh.commit=git(fresh.path,'rev-parse','HEAD');
              store.repairAccepted(taskId,fresh,String(cause));return fresh;
            }
          }
          if(plan && ['executing','paused','waiting_permission','waiting_input'].includes(store.plan(plan.id).status))store.planState(plan.id,'paused',String(cause),classifyFailure(String(cause),'integration'));
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
  return api;
}
