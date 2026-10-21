#!/usr/bin/env node
import { Command } from "commander";
import { Store } from "../storage/store.js";
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
      "Rarp Phase 1: persistent tasks and review workflow. Runtime is not implemented yet.",
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
try {
  program.parse();
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
