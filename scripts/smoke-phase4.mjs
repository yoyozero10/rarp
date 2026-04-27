// Live Codex use is opt-in; fixed tests stay outside worker file scopes.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { git } from "../dist/runtime/workspace.js";
import { codexCommand, codexReviewCommand } from "../dist/adapters/codex.js";
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
if (modelIndex >= 0 && (!model || model.startsWith("--")))
  throw new Error("--model requires a model ID");
const withModel = (spec) => {
  if (model) spec.args.splice(-1, 0, "--model", model);
  return spec;
};
const root = mkdtempSync(join(tmpdir(), "rarp-phase4-"));
git(root, "init");
git(root, "config", "user.name", "Rarp smoke");
git(root, "config", "user.email", "rarp@localhost");
writeFileSync(join(root, ".gitignore"), ".rarp/\n");
mkdirSync(join(root, "src"));
mkdirSync(join(root, "tests"));
writeFileSync(
  join(root, "src/total.mjs"),
  "export function total(items) { return 0; }\n",
);
writeFileSync(
  join(root, "src/discount.mjs"),
  "export function payable(items, percent) { return 0; }\n",
);
writeFileSync(
  join(root, "tests/total.test.mjs"),
  `import {test} from 'node:test';import assert from 'node:assert/strict';import {total} from '../src/total.mjs';test('total',()=>{assert.equal(total([]),0);assert.equal(total([{price:100,quantity:2},{price:50,quantity:3}]),350);assert.throws(()=>total([{price:-1,quantity:1}]));assert.throws(()=>total([{price:1,quantity:1.5}]));});`,
);
writeFileSync(
  join(root, "tests/discount.test.mjs"),
  `import {test} from 'node:test';import assert from 'node:assert/strict';import {payable} from '../src/discount.mjs';test('discount',()=>{const items=[{price:100,quantity:2},{price:50,quantity:3}];assert.equal(payable(items,10),315);assert.equal(payable(items,100),0);assert.equal(payable(items,0),350);assert.throws(()=>payable(items,101));assert.throws(()=>payable(items,-1));});`,
);
git(root, "add", ".");
git(root, "commit", "-m", "Fixed acceptance tests and stubs");
const store = new Store(root, true);
store.register("manager", "manager");
store.register("worker-total", "worker");
store.register("worker-discount", "worker");
const first = store.create({
  title: "Implement cart total",
  body: "Edit only src/total.mjs. Export total(items), summing price * quantity. Empty input returns 0. Reject negative/nonfinite prices and negative/noninteger quantities. Run node --test tests/total.test.mjs.",
  actor: "manager",
  assignee: "worker-total",
});
const second = store.create({
  title: "Implement discount using total",
  body: "Edit only src/discount.mjs. Import total from ./total.mjs. Export payable(items, percent), total(items) * (1 - percent/100). Reject nonfinite percentage or values outside 0..100. Run node --test.",
  actor: "manager",
  assignee: "worker-discount",
  dependencies: [first.id],
});
const fixture = process.argv.includes("--fixture");
const command = (role) => ({
  file: process.execPath,
  args: [resolve("tests/fixtures/isolated-agent.mjs"), role],
});
const runtime = fixture
  ? await startRuntime(root, command("feature-worker"), {
      manager: command("feature-manager"),
    })
  : await startRuntime(root, withModel(codexCommand()), {
      manager: withModel(codexReviewCommand()),
    });
console.log(
  JSON.stringify({
    root,
    model: model ?? "CLI default",
    tasks: [first.id, second.id],
  }),
);
try {
  for (const [task, scope, check] of [
    [
      first,
      ["src/total.mjs"],
      [process.execPath, "--test", "tests/total.test.mjs"],
    ],
    [second, ["src/discount.mjs"], [process.execPath, "--test"]],
  ]) {
    await runtimeRequest(root, "workflow", {
      taskId: task.id,
      isolated: true,
      scope,
      check,
      requestKey: task.id,
      timeoutMs: 180000,
      totalTimeoutMs: 480000,
      maxRounds: 2,
    });
    while (runtime.status().active) await delay(500);
    const result = store.show(task.id);
    console.log(
      JSON.stringify({
        taskId: task.id,
        status: result.status,
        attempts: result.attempts.length,
        reviews: result.reviews,
        last: runtime.status().last,
      }),
    );
    assert.equal(result.status, "accepted");
    await runtimeRequest(root, "integrate", { taskId: task.id });
  }
  console.log(
    JSON.stringify({
      success: true,
      root,
      workspaces: [store.workspace(first.id), store.workspace(second.id)],
      head: git(root, "rev-parse", "HEAD"),
    }),
  );
} finally {
  await runtime.stop();
  store.close();
}
