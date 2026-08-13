#!/usr/bin/env node
import { Command } from "commander";
import { Store } from "../storage/store.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { runtimeRequest } from "../runtime/server.js";
import { recoverRuntime } from "../runtime/recovery.js";
import { doctor } from './doctor.js';
const program = new Command()
  .name("rarp")
  .description("Local multi-agent task coordination")
  .version("0.1.0")
  .option("--project <path>", "Project directory", process.cwd())
  .option("--json", "Output JSON");
function run(fn: (store: Store) => unknown, initialize = false) {
  const store = new Store(program.opts()["project"] as string, initialize);
  try {
    console.log(
      JSON.stringify(fn(store), null, program.opts()["json"] ? undefined : 2),
    );
  } finally {
    store.close();
  }
}
program.command('doctor').description('Read-only installation and project diagnostics; no model calls')
  .option('--codex <executable>','Codex executable','codex')
  .option('--agy <executable>','Antigravity executable','agy')
  .option('--manager-profile <name>','Codex CLI profile to check authentication')
  .action((options:{codex:string;agy:string;managerProfile?:string})=>{
    const report=doctor(program.opts()['project'] as string,options);
    console.log(program.opts()['json']?JSON.stringify(report):report.checks.map(c=>`${c.status.toUpperCase()} ${c.name}: ${c.detail}${c.status!=='pass' && c.fix?'\n  '+c.fix:''}`).join('\n'));
    if(!report.ok)process.exitCode=1;
  });
program
  .command("init")
  .description("Initialize storage (safe to repeat)")
  .action(() => run((s) => s.status(), true));
program
  .command("status")
  .description("Show persisted project status")
  .action(() => run((s) => s.status()));
program
  .command("events")
  .description("Show persisted events")
  .option("--after <id>", "Replay events after cursor", "0")
  .action((options: { after: string }) =>
    run((s) => s.events(Number(options.after))),
  );
program
  .command("about")
  .action(() =>
    console.log(
      "Rarp Phase 8: goals, plan approval, isolated workflows, bounded review and recovery.",
    ),
  );
program
  .command("ui")
  .description("Print the local dashboard URL (start runtime first)")
  .action(() => {
    const meta = JSON.parse(
      readFileSync(
        resolve(program.opts()["project"] as string, ".rarp", "runtime.json"),
        "utf8",
      ),
    ) as { port: number; token: string };
    if (!Number.isInteger(meta.port)) throw new Error("Runtime not ready");
    console.log(`http://127.0.0.1:${meta.port}/ui/#token=${meta.token}`);
  });
program
  .command("agent")
  .command("register <id>")
  .requiredOption("--role <role>", "manager or worker")
  .action((id: string, options: { role: string }) =>
    run((s) => s.register(id, options.role)),
  );
const goal = program.command('goal').description('Goals and read-only planning');
goal.command('create').requiredOption('--file <path>', 'Goal JSON file').action(async (options:{file:string})=>console.log(JSON.stringify(await runtimeRequest(program.opts()['project'] as string,'goals',JSON.parse(readFileSync(options.file,'utf8'))),null,2)));
goal.command('list').action(async()=>console.log(JSON.stringify(await runtimeRequest(program.opts()['project'] as string,'goals'),null,2)));
goal.command('show <id>').action(async(id:string)=>console.log(JSON.stringify(await runtimeRequest(program.opts()['project'] as string,'goals/'+id),null,2)));
const plan = program.command('plan').description('Inspect, revise and explicitly approve plans');
plan.command('list').action(async()=>console.log(JSON.stringify(await runtimeRequest(program.opts()['project'] as string,'plans'),null,2)));
plan.command('show <id>').action(async(id:string)=>console.log(JSON.stringify(await runtimeRequest(program.opts()['project'] as string,'plans/'+id),null,2)));
for(const action of ['update','analyze','approve','reject','cancel','pause','resume']) plan.command(action+' <id>').option('--file <path>','Request JSON file').action(async(id:string,options:{file?:string})=>console.log(JSON.stringify(await runtimeRequest(program.opts()['project'] as string,'plans/'+id+'/'+action,options.file?JSON.parse(readFileSync(options.file,'utf8')):{}),null,2)));
const task = program.command("task").description("Manage tasks");
task
  .command("create")
  .requiredOption("--title <text>")
  .requiredOption("--actor <id>")
  .requiredOption("--assignee <id>")
  .option("--body <text>", "Task details", "")
  .option("--depends-on <ids...>", "Dependency task IDs")
  .action(
    (options: {
      title: string;
      actor: string;
      assignee: string;
      body: string;
      dependsOn?: string[];
    }) =>
      run((s) =>
        s.create({
          title: options.title,
          actor: options.actor,
          assignee: options.assignee,
          body: options.body,
          dependencies: options.dependsOn ?? [],
        }),
      ),
  );
task
  .command("list")
  .option("--status <status>")
  .action((options: { status?: string }) => run((s) => s.list(options.status)));
task.command("show <id>").action((id: string) => run((s) => s.show(id)));
task
  .command("transition <id> <status>")
  .requiredOption("--actor <id>")
  .requiredOption("--note <text>", "Result or feedback")
  .action(
    (id: string, status: string, options: { actor: string; note: string }) =>
      run((s) => s.transition(id, status, options.actor, options.note)),
  );
const runtime = program
  .command("runtime")
  .description("Control the local runtime");
runtime
  .command("recover")
  .action(() =>
    console.log(
      JSON.stringify(recoverRuntime(program.opts()["project"] as string)),
    ),
  );
runtime.command("runs").action(() => run((s) => s.runs()));
runtime.command("queue").action(() => run((s) => s.dispatches()));
for (const action of ["pause", "resume"] as const)
  runtime
    .command(action)
    .action(async () =>
      console.log(
        JSON.stringify(
          await runtimeRequest(
            program.opts()["project"] as string,
            "scheduler",
            { action },
          ),
        ),
      ),
    );
task
  .command("workspace <id>")
  .action((id: string) => run((s) => s.workspace(id) ?? null));
task.command("integrate <id>").action(async (id: string) =>
  console.log(
    JSON.stringify(
      await runtimeRequest(program.opts()["project"] as string, "integrate", {
        taskId: id,
      }),
    ),
  ),
);
runtime
  .command("start")
  .option(
    "--codex <executable>",
    "Codex executable (not a shell command)",
    "codex",
  )
  .option("--agy <executable>", "Antigravity executable", "agy")
  .option("--manager-profile <name>", "Codex CLI profile for planner and reviewer")
  .option("--max-workers <n>", "Concurrent workflow slots (1–16)", "2")
  .option("--max-reviewers <n>", "Concurrent review invocations (1–16)", "1")
  .action(
    async (options: {
      codex: string;
      agy: string;
      managerProfile?: string;
      maxWorkers: string;
      maxReviewers: string;
    }) => {
      const root = resolve(program.opts()["project"] as string);
      const child = fork(
        fileURLToPath(new URL("../runtime/daemon.js", import.meta.url)),
        [
          root,
          options.codex,
          options.agy,
          options.maxWorkers,
          options.maxReviewers,
          ...(options.managerProfile !== undefined ? [options.managerProfile] : []),
        ],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Runtime startup timeout"));
        }, 15000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Runtime exited during startup: ${code}`));
        });
        child.once(
          "message",
          (message: { ready?: boolean; error?: string }) => {
            clearTimeout(timer);
            if (message.error) reject(new Error(message.error));
            else resolve();
            child.unref();
          },
        );
      });
      console.log(JSON.stringify(await runtimeRequest(root, "status")));
    },
  );
runtime
  .command("status")
  .action(async () =>
    console.log(
      JSON.stringify(
        await runtimeRequest(program.opts()["project"] as string, "status"),
      ),
    ),
  );
runtime
  .command("stop")
  .action(async () =>
    console.log(
      JSON.stringify(
        await runtimeRequest(program.opts()["project"] as string, "stop", {}),
      ),
    ),
  );
program
  .command("worker")
  .command("run <taskId>")
  .option("--timeout-ms <ms>", "Maximum execution time", "120000")
  .option("--adapter <name>", "codex or antigravity", "codex")
  .option("--request-key <key>", "Persistent idempotency key")
  .action(
    async (
      taskId: string,
      options: { timeoutMs: string; adapter: string; requestKey?: string },
    ) =>
      console.log(
        JSON.stringify(
          await runtimeRequest(program.opts()["project"] as string, "run", {
            taskId,
            timeoutMs: Number(options.timeoutMs),
            adapter: options.adapter,
            requestKey: options.requestKey,
          }),
        ),
      ),
  );
runtime
  .command("cancel")
  .option("--task <id>", "Cancel one active or queued task")
  .action(async (options: { task?: string }) =>
    console.log(
      JSON.stringify(
        await runtimeRequest(program.opts()["project"] as string, "cancel", {
          taskId: options.task,
        }),
      ),
    ),
  );
program
  .command("workflow")
  .command("run <taskId>")
  .option("--adapter <name>", "Worker: codex or antigravity", "codex")
  .option("--max-rounds <n>", "Maximum worker/review rounds", "3")
  .option("--timeout-ms <ms>", "Timeout per agent invocation", "120000")
  .option("--total-timeout-ms <ms>", "Overall workflow deadline", "600000")
  .option("--request-key <key>", "Persistent idempotency key")
  .option("--isolated", "Run in a task Git worktree")
  .option("--resume-review", "Review an existing submitted result")
  .option("--enqueue", "Persist and wait for capacity/dependencies")
  .option(
    "--scope <paths...>",
    "Allowed repository-relative files/directories",
    [],
  )
  .option("--check-json <argv>", "Verification command as JSON argv", "[]")
  .action(
    async (
      taskId: string,
      options: {
        adapter: string;
        maxRounds: string;
        timeoutMs: string;
        totalTimeoutMs: string;
        requestKey?: string;
        isolated?: boolean;
        resumeReview?: boolean;
        enqueue?: boolean;
        scope: string[];
        checkJson: string;
      },
    ) =>
      console.log(
        JSON.stringify(
          await runtimeRequest(
            program.opts()["project"] as string,
            "workflow",
            {
              taskId,
              adapter: options.adapter,
              maxRounds: Number(options.maxRounds),
              timeoutMs: Number(options.timeoutMs),
              totalTimeoutMs: Number(options.totalTimeoutMs),
              requestKey: options.requestKey,
              isolated: options.isolated,
              resumeReview: options.resumeReview,
              enqueue: options.enqueue,
              scope: options.scope,
              check: JSON.parse(options.checkJson),
            },
          ),
        ),
      ),
  );
try {
  await program.parseAsync();
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
