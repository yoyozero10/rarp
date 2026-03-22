#!/usr/bin/env node
import { Command } from "commander";
import { Store } from "../storage/store.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runtimeRequest } from "../runtime/server.js";
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
  .action(() => run((s) => s.events()));
program
  .command("about")
  .action(() =>
    console.log(
      "Rarp Phase 2: persistent tasks, local runtime and a Codex worker. Automated review is planned for Phase 3.",
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
  .command("start")
  .option(
    "--codex <executable>",
    "Codex executable (not a shell command)",
    "codex",
  )
  .action(async (options: { codex: string }) => {
    const root = resolve(program.opts()["project"] as string);
    const child = fork(
      fileURLToPath(new URL("../runtime/daemon.js", import.meta.url)),
      [root, options.codex],
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
  .action(async (taskId: string, options: { timeoutMs: string }) =>
    console.log(
      JSON.stringify(
        await runtimeRequest(program.opts()["project"] as string, "run", {
          taskId,
          timeoutMs: Number(options.timeoutMs),
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
