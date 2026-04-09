import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { AntigravityStream } from "../dist/adapters/antigravity.js";
async function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "rarp-flow-"));
  const store = new Store(root, true);
  store.register("m", "manager");
  store.register("w", "worker");
  const task = store.create({
    title: "Payable must be 50000",
    actor: "m",
    assignee: "w",
  });
  const command = (role) => ({
    file: process.execPath,
    args: [resolve("tests/fixtures/workflow-agent.mjs"), role, mode],
    ...(role === "worker" ? { protocol: "antigravity" } : {}),
  });
  const runtime = await startRuntime(root, command("worker"), {
    antigravity: command("worker"),
    manager: command("manager"),
  });
  t.after(async () => {
    await runtime.stop();
    store.close();
  });
  return { root, store, task, runtime };
}
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await delay(50);
  }
  throw new Error("Wait timed out");
}
test("AG parser accepts split success envelope and rejects error/missing result", () => {
  const p = new AntigravityStream(() => {});
  p.feed('{"event":"result","result":');
  p.feed('{"status":"SUCCESS","response":"ok"}}');
  p.finish();
  assert.equal(p.completed, true);
  assert.equal(p.result, "ok");
  const error = new AntigravityStream(() => {});
  error.feed('{"event":"result","result":{"status":"ERROR"}}\n');
  assert.equal(error.failed, true);
  const denied = new AntigravityStream(() => {});
  denied.feed(
    '{"event":"result","result":{"status":"SUCCESS","response":"done","denied_actions":[{"action":"command"}]}}\n',
  );
  assert.equal(denied.failed, true);
  assert.equal(denied.completed, false);
});
for (const mode of ["accept", "repair", "reject", "invalid"])
  test(`automatic review ${mode}`, async (t) => {
    const { root, store, task, runtime } = await fixture(t, mode);
    await runtimeRequest(root, "workflow", {
      taskId: task.id,
      adapter: "antigravity",
      maxRounds: 2,
      timeoutMs: 5000,
      totalTimeoutMs: 15000,
    });
    await until(() => !runtime.status().active);
    const result = store.show(task.id);
    assert.equal(
      result.status,
      mode === "reject"
        ? "changes_requested"
        : mode === "invalid"
          ? "failed"
          : "accepted",
    );
    assert.equal(
      result.attempts.length,
      mode === "reject" || mode === "repair" ? 2 : 1,
    );
    if (mode === "repair") {
      assert.deepEqual(
        result.reviews.map((r) => r.decision),
        ["changes_requested", "accepted"],
      );
      assert.match(
        readFileSync(join(root, "prompt-2"), "utf8"),
        /Set payable to 50000/,
      );
    }
    if (mode === "invalid") assert.equal(result.reviews.length, 0);
    const events = store.events().filter((e) => e.type === "review.output");
    assert.ok(events.length);
    assert.ok(events.every((e) => e.agent_id === "m" && e.attempt_id));
  });
for (const operation of ["cancel", "deadline", "stop"])
  test(`workflow ${operation} during review`, async (t) => {
    const { root, store, task, runtime } = await fixture(t, "hang");
    await runtimeRequest(root, "workflow", {
      taskId: task.id,
      timeoutMs: 10000,
      totalTimeoutMs: operation === "deadline" ? 2000 : 20000,
    });
    await until(() => existsSync(join(root, "review-started")));
    await assert.rejects(
      runtimeRequest(root, "workflow", { taskId: task.id }),
      /busy/,
    );
    if (operation === "cancel") await runtimeRequest(root, "cancel", {});
    if (operation === "stop") await runtime.stop();
    await until(() => !runtime.status().active);
    assert.equal(store.show(task.id).status, "failed");
    assert.equal(store.show(task.id).reviews.length, 0);
  });
