// Opt-in live test: five Codex tasks, fixed acceptance tests, four concurrent workflows.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { git } from "../dist/runtime/workspace.js";
import { codexCommand, codexReviewCommand } from "../dist/adapters/codex.js";
const index = process.argv.indexOf("--model"),
  model = index < 0 ? "gpt-6.1-sol" : process.argv[index + 1];
if (!model || model.startsWith("--")) throw new Error("--model requires an ID");
const withModel = (spec) => {
  spec.args.splice(-1, 0, "--model", model);
  if (process.argv.includes("--plain-tools"))
    spec.args.splice(-1, 0, "--disable", "hooks");
  return spec;
};
const executableIndex = process.argv.indexOf("--codex");
const executable =
  executableIndex < 0 ? "codex" : process.argv[executableIndex + 1];
if (!executable || executable.startsWith("--"))
  throw new Error("--codex requires an executable path");
const root = mkdtempSync(join(tmpdir(), "rarp-phase6-"));
git(root, "init");
git(root, "config", "user.name", "Rarp smoke");
git(root, "config", "user.email", "rarp@localhost");
writeFileSync(join(root, ".gitignore"), ".rarp/\n");
mkdirSync(join(root, "src"));
mkdirSync(join(root, "tests"));
const cases = [
  [
    "subtotal",
    "items",
    "Return sum of item.price * item.quantity; empty input returns 0. Reject nonfinite/negative prices and negative/noninteger quantities.",
    "assert.equal(subtotal([]),0);assert.equal(subtotal([{price:100,quantity:2},{price:50,quantity:3}]),350);assert.throws(()=>subtotal([{price:-1,quantity:1}]));assert.throws(()=>subtotal([{price:1,quantity:1.5}]));",
  ],
  [
    "discount",
    "amount, percent",
    "Return amount * (1 - percent/100). Reject nonfinite/negative amount, nonfinite percent and percent outside 0..100.",
    "assert.equal(discount(350,10),315);assert.equal(discount(100,100),0);assert.throws(()=>discount(1,101));assert.throws(()=>discount(Infinity,10));",
  ],
  [
    "shipping",
    "amount",
    "Return the flat shipping fee 30 for any finite nonnegative amount. Reject nonfinite or negative amount.",
    "assert.equal(shipping(500),30);assert.equal(shipping(499),30);assert.equal(shipping(0),30);assert.throws(()=>shipping(-1));assert.throws(()=>shipping(NaN));",
  ],
  [
    "roundMoney",
    "amount",
    "Round a finite nonnegative amount to two decimals, with standard half-up behavior for the supplied acceptance tests. Reject nonfinite or negative values.",
    "assert.equal(roundMoney(10.125),10.13);assert.equal(roundMoney(1.005),1.01);assert.equal(roundMoney(10),10);assert.throws(()=>roundMoney(-1));assert.throws(()=>roundMoney(Infinity));",
  ],
  [
    "checkout",
    "items, percent",
    "Import subtotal, discount, shipping and roundMoney from their sibling .mjs modules. Return roundMoney(discount(subtotal(items), percent) + shipping(subtotal(items))). Reuse their validation.",
    "const items=[{price:100,quantity:2},{price:50,quantity:3}];assert.equal(checkout(items,10),345);assert.equal(checkout([{price:500,quantity:1}],10),480);assert.throws(()=>checkout(items,101));",
  ],
];
for (const [name, args, , assertions] of cases) {
  writeFileSync(
    join(root, "src", name + ".mjs"),
    `export function ${name}(${args}) { throw new Error('TODO'); }\n`,
  );
  writeFileSync(
    join(root, "tests", name + ".test.mjs"),
    `import {test} from 'node:test';import assert from 'node:assert/strict';import {${name}} from '../src/${name}.mjs';test('${name}',()=>{${assertions}});`,
  );
}
git(root, "add", ".");
git(root, "commit", "-m", "Fixed cart acceptance tests");
const store = new Store(root, true);
store.register("manager", "manager");
for (let i = 0; i < 5; i++) store.register("worker-" + i, "worker");
const tasks = cases.map(([name, , requirements], i) =>
  store.create({
    title: "Implement " + name,
    body: `Edit only src/${name}.mjs. Export ${name}. ${requirements} Do not edit tests. Run node --test --test-isolation=none tests/${name}.test.mjs.`,
    actor: "manager",
    assignee: "worker-" + i,
    dependencies:
      i === 4
        ? store
            .list()
            .slice(0, 4)
            .map((t) => String(t.id))
        : [],
  }),
);
const runtime = await startRuntime(
  root,
  withModel(codexCommand(executable)),
  { manager: withModel(codexReviewCommand(executable)) },
  { maxWorkers: 4, maxReviewers: 1 },
);
let maxWorking = 0,
  maxActive = 0,
  maxReviewers = 0;
const integrated = new Set(),
  started = Date.now();
const measure = () => {
  const s = runtime.status();
  maxActive = Math.max(maxActive, s.workers.length);
  maxWorking = Math.max(
    maxWorking,
    s.workers.filter((w) => w.workflow?.stage === "working" && w.pid).length,
  );
  maxReviewers = Math.max(maxReviewers, s.limits.activeReviewers);
};
console.log(JSON.stringify({ root, model, tasks: tasks.map((t) => t.id) }));
try {
  for (let i = 0; i < tasks.length; i++) {
    await runtimeRequest(root, "workflow", {
      taskId: tasks[i].id,
      isolated: true,
      enqueue: true,
      scope: ["src/" + cases[i][0] + ".mjs"],
      check: [process.execPath, "--test", "tests/" + cases[i][0] + ".test.mjs"],
      requestKey: tasks[i].id,
      timeoutMs: 180000,
      totalTimeoutMs: 600000,
      maxRounds: 2,
    });
    measure();
  }
  while (integrated.size < tasks.length) {
    if (Date.now() - started > 900000)
      throw new Error("Smoke deadline exceeded");
    measure();
    for (const task of tasks) {
      const current = store.show(task.id);
      if (["failed", "changes_requested", "cancelled"].includes(current.status))
        throw new Error(
          JSON.stringify({ task: current, runtime: runtime.status() }),
        );
      if (current.status === "accepted" && !integrated.has(task.id)) {
        await runtimeRequest(root, "integrate", { taskId: task.id });
        integrated.add(task.id);
        console.log(
          JSON.stringify({
            taskId: task.id,
            state: "integrated",
            attempts: current.attempts.length,
          }),
        );
      }
    }
    await delay(250);
  }
  assert.equal(maxActive, 4);
  assert.equal(maxWorking, 4);
  assert.ok(maxReviewers <= 1);
  assert.equal(git(root, "status", "--porcelain"), "");
  const tests = execFileSync(process.execPath, ["--test"], {
    cwd: root,
    encoding: "utf8",
  });
  const result = {
    success: true,
    model,
    root,
    maxActive,
    maxWorking,
    maxReviewers,
    durationMs: Date.now() - started,
    tasks: tasks.map((task) => ({
      taskId: task.id,
      status: store.show(task.id).status,
      attempts: store.show(task.id).attempts.length,
      workspace: store.workspace(task.id),
    })),
    tests,
    head: git(root, "rev-parse", "HEAD"),
  };
  writeFileSync(
    join(root, ".rarp", "phase6-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await runtime.stop();
  store.close();
}
