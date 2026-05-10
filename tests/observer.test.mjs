import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import {
  git,
  prepareWorkspace,
  checkpoint,
} from "../dist/runtime/workspace.js";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rarp-observe-"));
  const store = new Store(root, true);
  store.register("manager", "manager");
  store.register("one", "worker");
  store.register("two", "worker");
  const task = store.create({
    title: "Observed task",
    actor: "manager",
    assignee: "one",
  });
  const runtime = await startRuntime(root, {
    file: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
  });
  const meta = JSON.parse(
    readFileSync(join(root, ".rarp/runtime.json"), "utf8"),
  );
  const base = `http://127.0.0.1:${meta.port}`,
    headers = { authorization: `Bearer ${meta.token}` };
  t.after(async () => {
    await runtime.stop();
    store.close();
  });
  return { root, store, task, runtime, meta, base, headers };
}
async function readEvent(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const next = await reader.read();
    assert.equal(next.done, false);
    text += decoder.decode(next.value);
    const line = text.split("\n").find((line) => line.startsWith("data: "));
    if (line) return JSON.parse(line.slice(6));
  }
}
test("task-scoped cancel cannot stop a different active task", async (t) => {
  const { root, task } = await fixture(t);
  await runtimeRequest(root, "run", { taskId: task.id });
  await assert.rejects(
    runtimeRequest(root, "cancel", { taskId: "stale-task" }),
    /Active task changed/,
  );
  assert.equal((await runtimeRequest(root, "status")).active.taskId, task.id);
  await assert.rejects(
    runtimeRequest(root, "transition", {
      taskId: task.id,
      actor: "manager",
      status: "cancelled",
      expectedStatus: "running",
      note: "stale edit",
    }),
    /Cancel the active/,
  );
  await runtimeRequest(root, "cancel", { taskId: task.id });
  assert.equal((await runtimeRequest(root, "status")).active, null);
});
test("snapshot cursor and paginated events replay external CLI writes without duplicates", async (t) => {
  const { root, store, task } = await fixture(t);
  const snapshot = await runtimeRequest(root, "snapshot");
  assert.equal(snapshot.tasks[0].dependencies.length, 0);
  assert.equal(snapshot.tasks[0].workspace, null);
  const external = new Store(root);
  external.register("new-worker", "worker");
  external.transition(task.id, "blocked", "manager", "Waiting for input");
  external.close();
  const first = await runtimeRequest(
    root,
    `events?after=${snapshot.lastEventId}&limit=1`,
  );
  assert.equal(first.events.length, 1);
  assert.equal(first.hasMore, true);
  const next = await runtimeRequest(
    root,
    `events?after=${first.nextCursor}&limit=1`,
  );
  assert.equal(next.events.length, 1);
  assert.ok(next.events[0].id > first.events[0].id);
  assert.equal(next.hasMore, false);
  const onlyTask = await runtimeRequest(
    root,
    `events?after=${snapshot.lastEventId}&taskId=${task.id}`,
  );
  assert.deepEqual(
    onlyTask.events.map((e) => e.type),
    ["task.transitioned"],
  );
  assert.equal(
    (await runtimeRequest(root, "snapshot")).tasks[0].status,
    "blocked",
  );
  await assert.rejects(runtimeRequest(root, "events?limit=999"), /Invalid/);
  await assert.rejects(runtimeRequest(root, "stream?after=-1"), /Invalid/);
});
test("SSE reconnect uses Last-Event-ID and disconnect does not stop runtime", async (t) => {
  const { root, store, task, base, headers } = await fixture(t);
  const snapshot = await runtimeRequest(root, "snapshot");
  store.transition(task.id, "blocked", "manager", "waiting");
  const first = await fetch(base + `/stream?after=${snapshot.lastEventId}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  const reader = first.body.getReader();
  const event = await readEvent(reader);
  await reader.cancel();
  store.transition(task.id, "queued", "manager", "ready");
  const second = await fetch(base + "/stream?after=0", {
    headers: { ...headers, "last-event-id": String(event.id) },
    signal: AbortSignal.timeout(5000),
  });
  const nextReader = second.body.getReader(),
    next = await readEvent(nextReader);
  await nextReader.cancel();
  assert.ok(next.id > event.id);
  assert.equal(JSON.parse(next.payload).to, "queued");
  assert.equal((await runtimeRequest(root, "status")).state, "ready");
  // Shutdown must close open streaming connections instead of hanging.
  const open = await fetch(base + "/stream", { headers });
  await (await import("node:timers/promises")).setTimeout(20);
  await runtimeRequest(root, "stop", {});
  await open.body.cancel();
});
test("observer and mutations require token and reject cross-origin requests", async (t) => {
  const { base, headers } = await fixture(t);
  for (const route of [
    "/snapshot",
    "/events",
    "/stream",
    "/diff?taskId=anything",
  ])
    assert.equal((await fetch(base + route)).status, 401);
  assert.equal(
    (
      await fetch(base + "/snapshot", {
        headers: { ...headers, origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const invalidHost = await new Promise((resolve, reject) => {
    const req = request(
      base + "/snapshot",
      { headers: { ...headers, host: "untrusted.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(invalidHost, 403);
  const ui = await fetch(base + "/ui/");
  assert.equal(ui.status, 200);
  assert.ok(
    ui.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  const html = await ui.text();
  assert.ok(!html.includes(headers.authorization));
  const script = html.match(/src="([^"]+\.js)"/)[1];
  const asset = await fetch(base + script);
  assert.equal(asset.status, 200);
  assert.ok(asset.headers.get("content-type").includes("javascript"));
});
test("task controls reject stale updates and unauthorized managers; reassign persists", async (t) => {
  const { root, store, task } = await fixture(t);
  store.register("other", "manager");
  const payload = {
    taskId: task.id,
    actor: "manager",
    expectedStatus: "queued",
    note: "Waiting",
    status: "blocked",
  };
  await runtimeRequest(root, "transition", payload);
  await assert.rejects(
    runtimeRequest(root, "transition", payload),
    /Task changed/,
  );
  await assert.rejects(
    runtimeRequest(root, "reassign", {
      ...payload,
      expectedStatus: "blocked",
      actor: "other",
      assignee: "two",
    }),
    /Only the task manager/,
  );
  await runtimeRequest(root, "reassign", {
    ...payload,
    expectedStatus: "blocked",
    assignee: "two",
  });
  assert.equal(store.show(task.id).assigned_to, "two");
  await assert.rejects(
    runtimeRequest(root, "transition", {
      ...payload,
      expectedStatus: "blocked",
      status: "running",
    }),
    /Use workflow/,
  );
  const created = await runtimeRequest(root, "tasks", {
    title: "Dependent",
    actor: "manager",
    assignee: "two",
    dependencies: [task.id],
  });
  assert.deepEqual(created.dependencies, [task.id]);
});
test("diff is bounded to task checkpoint and includes integration test evidence", async (t) => {
  const { root, store, task } = await fixture(t);
  git(root, "init");
  git(root, "config", "user.name", "Tests");
  git(root, "config", "user.email", "tests@localhost");
  writeFileSync(join(root, ".gitignore"), ".rarp/\n");
  writeFileSync(join(root, "feature.txt"), "before");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const workspace = prepareWorkspace(
    root,
    task.id,
    ["feature.txt"],
    [process.execPath, "-e", ""],
  );
  writeFileSync(join(workspace.path, "feature.txt"), "after");
  checkpoint(workspace);
  store.saveWorkspace(workspace);
  const result = await runtimeRequest(root, `diff?taskId=${task.id}`);
  assert.match(result.diff, /-before/);
  assert.match(result.diff, /\+after/);
  writeFileSync(join(workspace.path, "feature.txt"), "uncommitted");
  assert.equal(
    (await runtimeRequest(root, `diff?taskId=${task.id}`)).diff,
    result.diff,
  );
  await assert.rejects(
    runtimeRequest(root, "diff?taskId=missing"),
    /Unknown task/,
  );
});
