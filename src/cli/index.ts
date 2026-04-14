#!/usr/bin/env node
import { Command } from "commander";
import { Store } from "../storage/store.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runtimeRequest } from "../runtime/server.js";
import { recoverRuntime } from "../runtime/recovery.js";
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
      "Rarp Phase 4: isolated worktrees, verified integration and controlled recovery.",
    ),
  );
program
  .command("agent")
  .command("register <id>")
  .requiredOption("--role <role>", "manager or worker")
  .action((id: string, options: { role: string }) =>
    run((s) => s.register(id, options.role)),
  );
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
  .action(async (options: { codex: string; agy: string }) => {
    const root = resolve(program.opts()["project"] as string);
    const child = fork(
      fileURLToPath(new URL("../runtime/daemon.js", import.meta.url)),
      [root, options.codex, options.agy],
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
      child.once("message", (message: { ready?: boolean; error?: string }) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error));
        else resolve();
        child.unref();
      });
    });
    console.log(JSON.stringify(await runtimeRequest(root, "status")));
  });
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
  .action(async () =>
    console.log(
      JSON.stringify(
        await runtimeRequest(program.opts()["project"] as string, "cancel", {}),
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
