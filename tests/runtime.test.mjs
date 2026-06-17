import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { CodexStream } from "../dist/adapters/codex.js";

async function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "rarp-runtime-"));
  const store = new Store(root, true);
  store.register("m", "manager");
  store.register("w", "worker");
  const task = store.create({ title: "Fixture", actor: "m", assignee: "w" });
  const runtime = await startRuntime(root, {
    file: process.execPath,
    args: [resolve("tests/fixtures/fake-codex.mjs"), mode],
  });
  t.after(async () => {
    await runtime.stop();
    store.close();
  });
  return { root, store, task, runtime };
}
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for condition");
}
test("incremental JSONL parses split lines and requires valid events", () => {
  const events = [];
  const parser = new CodexStream((e) => events.push(e));
  parser.feed('{"type":"turn.');
  parser.feed('completed"}\n');
  parser.finish();
  assert.equal(parser.completed, true);
  assert.equal(events.length, 1);
  assert.throws(() => parser.feed("null\n"), /Invalid/);
});

test('Codex errors preserve actionable failure details without accepting malformed messages', () => {
  const parser = new CodexStream(() => {});
  parser.feed(JSON.stringify({type:'error',message:'Usage limit reached'})+'\n');
  assert.equal(parser.failed,true);
  assert.equal(parser.failureReason,'Usage limit reached');
  parser.feed(JSON.stringify({type:'turn.failed',error:{message:'Authentication expired'}})+'\n');
  assert.equal(parser.failureReason,'Authentication expired');
  parser.feed(JSON.stringify({type:'turn.failed',error:{message:{unexpected:true}}})+'\n');
  assert.equal(parser.failureReason,'Authentication expired');
});
test("runtime excludes duplicate owner, authenticates, submits and attaches logs", async (t) => {
  const { root, store, task, runtime } = await fixture(t, "success");
  await assert.rejects(startRuntime(root), /lock exists/);
  const meta = JSON.parse(
    readFileSync(join(root, ".rarp/runtime.json"), "utf8"),
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${meta.port}/status`)).status,
    401,
  );
  await runtimeRequest(root, "run", { taskId: task.id });
  await until(() => !runtime.status().active);
  assert.equal(store.show(task.id).status, "submitted");
  assert.equal(runtime.status().last.success, true);
  const logs = store.events().filter((e) => e.type === "worker.output");
  assert.ok(logs.length >= 2);
  assert.ok(
    logs.every((e) => e.attempt_id === store.show(task.id).attempts[0].id),
  );
  await runtime.stop();
  assert.equal(existsSync(join(root, ".rarp/runtime.json")), false);
});
for (const mode of ["bad", "failure", "incomplete"])
  test(`worker ${mode} never submits`, async (t) => {
    const { root, store, task, runtime } = await fixture(t, mode);
    await runtimeRequest(root, "run", { taskId: task.id, timeoutMs: 5000 });
    await until(() => !runtime.status().active);
    assert.equal(store.show(task.id).status, "failed");
    assert.equal(runtime.status().last.success, false);
  });
for (const operation of ["timeout", "cancel", "stop"])
  test(`${operation} cleans worker descendants`, async (t) => {
    const { root, store, task, runtime } = await fixture(t, "hang");
    await runtimeRequest(root, "run", {
      taskId: task.id,
      timeoutMs: operation === "timeout" ? 1500 : 10000,
    });
    await until(() => existsSync(join(root, "child.pid")));
    const pid = Number(readFileSync(join(root, "child.pid"), "utf8"));
    if (operation === "cancel") await runtimeRequest(root, "cancel", {});
    if (operation === "stop") await runtime.stop();
    await until(() => !runtime.status().active);
    assert.equal(store.show(task.id).status, "failed");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
