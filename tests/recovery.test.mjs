import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { runtimeRequest, startRuntime } from "../dist/runtime/server.js";
import { recoverRuntime } from "../dist/runtime/recovery.js";
test("killed runtime cleans host, preserves edits, and recovers once after lease expires", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rarp-crash-")),
    store = new Store(root, true);
  store.register("m", "manager");
  store.register("w", "worker");
  const task = store.create({ title: "Crash test", actor: "m", assignee: "w" });
  const child = fork(resolve("tests/fixtures/crash-runtime.mjs"), [root], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    store.close();
  });
  await once(child, "message");
  const input = { taskId: task.id, requestKey: "crash" };
  await runtimeRequest(root, "run", input);
  for (let i = 0; !existsSync(join(root, "partial.txt")) && i < 100; i++)
    await delay(50);
  assert.ok(existsSync(join(root, "partial.txt")));
  assert.throws(() => recoverRuntime(root), /still alive/);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await assert.rejects(startRuntime(root), /Unfinished runs/);
  let recovered;
  for (let i = 0; i < 200; i++) {
    try {
      recovered = recoverRuntime(root);
      break;
    } catch (error) {
      assert.match(String(error), /Runtime still alive|Live process or unexpired lease/);
      await delay(100);
    }
  }
  assert.equal(recovered?.recovered.length, 1);
  assert.equal(store.show(task.id).status, "failed");
  assert.equal(readFileSync(join(root, "partial.txt"), "utf8"), "preserved");
  const runtime = await startRuntime(root);
  try {
    assert.equal((await runtimeRequest(root, "run", input)).duplicate, true);
    assert.equal(store.show(task.id).attempts.length, 1);
  } finally {
    await runtime.stop();
  }
});
