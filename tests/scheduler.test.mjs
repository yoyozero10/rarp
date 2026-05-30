import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { recoverRuntime } from "../dist/runtime/recovery.js";
import { git } from "../dist/runtime/workspace.js";
const command = (role) => ({
  file: process.execPath,
  args: [resolve("tests/fixtures/parallel-agent.mjs"), role],
});
async function until(fn) {
  for (let i = 0; i < 600; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for scheduler");
}
async function gone(pid) {
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
      return true;
    }
  });
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "rarp-parallel-"));
  git(root, "init");
  git(root, "config", "user.name", "Tests");
  git(root, "config", "user.email", "tests@localhost");
  writeFileSync(join(root, ".gitignore"), ".rarp/\n");
  for (const file of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"])
    writeFileSync(join(root, file), "base");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const store = new Store(root, true),
    probe = join(root, ".rarp", "probe");
  mkdirSync(probe);
  store.register("m", "manager");
  for (let i = 0; i < 6; i++) store.register("w" + i, "worker");
  const create = (file, worker = "w0", dependencies = []) =>
    store.create({
      title: "Write " + file,
      body: JSON.stringify({ file, probe }),
      actor: "m",
      assignee: worker,
      dependencies,
    });
  const input = (task, file, extra = {}) => ({
    taskId: task.id,
    isolated: true,
    scope: [file],
    check: [
      process.execPath,
      "-e",
      `require('node:assert').equal(require('node:fs').readFileSync('${file}','utf8'),'done')`,
    ],
    timeoutMs: 90000,
    totalTimeoutMs: 180000,
    requestKey: task.id,
    ...extra,
  });
  const release = (role) => writeFileSync(join(probe, "release-" + role), "go");
  const started = (file, role = "worker") =>
    existsSync(join(probe, file + "." + role + ".pid"));
  const start = (options = {}) =>
    startRuntime(
      root,
      command("worker"),
      { manager: command("manager") },
      options,
    );
  return { root, store, probe, create, input, release, started, start };
}
test("four workers overlap, queued capacity is bounded, cancel is isolated, reviewers are limited and merges serialize", async (t) => {
  const f = setup(),
    runtime = await f.start({ maxWorkers: 4, maxReviewers: 1 });
  t.after(async () => {
    await runtime.stop();
    f.store.close();
  });
  const tasks = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"].map(
    (file, i) => f.create(file, "w" + i),
  );
  for (let i = 0; i < 4; i++)
    await runtimeRequest(
      f.root,
      "workflow",
      f.input(tasks[i], String.fromCharCode(97 + i) + ".txt"),
    );
  await until(() =>
    ["a.txt", "b.txt", "c.txt", "d.txt"].every((file) => f.started(file)),
  );
  assert.equal(runtime.status().workers.length, 4);
  assert.equal(new Set(runtime.status().workers.map((w) => w.pid)).size, 4);
  await assert.rejects(runtimeRequest(f.root, "cancel", {}), /taskId required/);
  await runtimeRequest(
    f.root,
    "workflow",
    f.input(tasks[4], "e.txt", { enqueue: true }),
  );
  await runtimeRequest(
    f.root,
    "workflow",
    f.input(tasks[5], "f.txt", { enqueue: true }),
  );
  assert.equal(runtime.status().queue.length, 2);
  assert.equal(f.store.show(tasks[4].id).attempts.length, 0);
  await runtimeRequest(f.root, "cancel", { taskId: tasks[5].id });
  assert.equal(f.store.show(tasks[5].id).attempts.length, 0);
  await runtimeRequest(f.root, "cancel", { taskId: tasks[0].id });
  await until(() => f.started("e.txt"));
  assert.equal(f.store.show(tasks[0].id).status, "failed");
  assert.equal(f.store.show(tasks[1].id).status, "running");
  assert.equal(runtime.status().workers.length, 4);
  const dead = Number(readFileSync(join(f.probe, "a.txt.worker.pid"), "utf8"));
  await gone(dead);
  f.release("worker");
  await until(() =>
    runtime
      .status()
      .workers.some((w) => w.workflow?.stage === "waiting_review"),
  );
  assert.equal(runtime.status().limits.activeReviewers, 1);
  const waiting = runtime
    .status()
    .workers.find((w) => w.workflow?.stage === "waiting_review");
  await runtimeRequest(f.root, "cancel", { taskId: waiting.taskId });
  assert.equal(f.store.show(waiting.taskId).status, "failed");
  assert.equal(runtime.status().limits.activeReviewers, 1);
  f.release("manager");
  await until(() => !runtime.status().active);
  const accepted = tasks.filter(
    (task) => f.store.show(task.id).status === "accepted",
  );
  assert.equal(accepted.length, 3);
  for (const task of accepted)
    assert.equal(
      readFileSync(join(f.root, JSON.parse(task.body).file), "utf8"),
      "base",
    );
  await Promise.all(
    accepted.map((task) =>
      runtimeRequest(f.root, "integrate", { taskId: task.id }),
    ),
  );
  for (const task of accepted) {
    assert.ok(f.store.workspace(task.id).integrated);
    assert.equal(
      readFileSync(join(f.root, JSON.parse(task.body).file), "utf8"),
      "done",
    );
  }
  assert.equal(runtime.status().limits.freeSlots, 4);
  assert.equal(git(f.root, "status", "--porcelain"), "");
});
test("same worker and overlapping scopes wait; dependencies start only after integration", async (t) => {
  const f = setup(),
    runtime = await f.start({ maxWorkers: 2 });
  t.after(async () => {
    await runtime.stop();
    f.store.close();
  });
  const one = f.create("a.txt", "w0"),
    overlap = f.create("a.txt", "w1"),
    sameWorker = f.create("b.txt", "w0", [one.id]);
  await runtimeRequest(f.root, "workflow", f.input(one, "a.txt"));
  await runtimeRequest(
    f.root,
    "workflow",
    f.input(overlap, "a.txt", { enqueue: true }),
  );
  await runtimeRequest(
    f.root,
    "workflow",
    f.input(sameWorker, "b.txt", { enqueue: true }),
  );
  assert.equal(runtime.status().workers.length, 1);
  assert.match(runtime.status().queue[0].reason, /scope busy/);
  f.release("worker");
  f.release("manager");
  await until(
    () =>
      f.store.show(one.id).status === "accepted" && !runtime.status().active,
  );
  assert.equal(f.store.show(overlap.id).attempts.length, 0);
  assert.equal(f.store.show(sameWorker.id).attempts.length, 0);
  await runtimeRequest(f.root, "integrate", { taskId: one.id });
  await until(
    () =>
      f.store.show(overlap.id).status === "accepted" &&
      f.store.show(sameWorker.id).status === "accepted",
  );
  assert.equal(f.store.show(one.id).attempts.length, 1);
  assert.equal(f.store.show(overlap.id).attempts.length, 1);
});
test("queue persists paused across restart and duplicate requests never create another attempt", async (t) => {
  const f = setup();
  let runtime = await f.start({ maxWorkers: 1 });
  t.after(async () => {
    await runtime.stop();
    f.store.close();
  });
  const task = f.create("a.txt"),
    input = f.input(task, "a.txt", { enqueue: true });
  await runtimeRequest(f.root, "scheduler", { action: "pause" });
  await Promise.all(
    Array.from({ length: 6 }, () => runtimeRequest(f.root, "workflow", input)),
  );
  assert.equal(runtime.status().queue.length, 1);
  await runtime.stop();
  runtime = await f.start({ maxWorkers: 1 });
  assert.equal(runtime.status().paused, true);
  assert.equal(f.store.show(task.id).attempts.length, 0);
  assert.equal(
    (await runtimeRequest(f.root, "workflow", input)).duplicate,
    true,
  );
  await assert.rejects(
    runtimeRequest(f.root, "workflow", { ...input, timeoutMs: 10000 }),
    /different input/,
  );
  f.release("worker");
  f.release("manager");
  await runtimeRequest(f.root, "scheduler", { action: "resume" });
  await until(() => f.store.show(task.id).status === "accepted");
  assert.equal(f.store.show(task.id).attempts.length, 1);
  assert.equal(
    (await runtimeRequest(f.root, "workflow", input)).duplicate,
    true,
  );
});
test("verification stays responsive to cancel and stop kills every active tree", async (t) => {
  const f = setup(),
    runtime = await f.start({ maxWorkers: 4 });
  t.after(async () => {
    await runtime.stop();
    f.store.close();
  });
  f.release("worker");
  const task = f.create("a.txt", "w0");
  const marker = join(f.probe, "checking.pid");
  await runtimeRequest(
    f.root,
    "workflow",
    f.input(task, "a.txt", {
      check: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
      ],
    }),
  );
  await until(() => existsSync(marker));
  assert.equal(runtime.status().workers[0].workflow.stage, "verifying");
  const other = f.create("b.txt", "w1");
  await runtimeRequest(f.root, "workflow", f.input(other, "b.txt"));
  await until(() => f.started("b.txt", "manager"));
  await runtimeRequest(f.root, "cancel", { taskId: task.id });
  assert.equal(f.store.show(task.id).status, "failed");
  assert.equal(f.store.show(other.id).status, "reviewing");
  const checkPid = Number(readFileSync(marker, "utf8"));
  await gone(checkPid);
  const reviewPid = Number(
    readFileSync(join(f.probe, "b.txt.manager.pid"), "utf8"),
  );
  await runtime.stop();
  await gone(reviewPid);
});
test("crash recovers all four workers and leaves queued work paused until explicit resume", async (t) => {
  const f = setup(),
    tasks = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((file, i) =>
      f.create(file, "w" + i),
    );
  const child = fork(resolve("tests/fixtures/parallel-runtime.mjs"), [f.root], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let runtime;
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await runtime?.stop();
    f.store.close();
  });
  await once(child, "message");
  for (let i = 0; i < 5; i++)
    await runtimeRequest(
      f.root,
      "workflow",
      f.input(tasks[i], String.fromCharCode(97 + i) + ".txt", {
        enqueue: true,
      }),
    );
  await until(() =>
    ["a.txt", "b.txt", "c.txt", "d.txt"].every((file) => f.started(file)),
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await assert.rejects(f.start(), /Unfinished runs/);
  let recovered;
  await until(() => {
    try {
      recovered = recoverRuntime(f.root);
      return true;
    } catch (e) {
      assert.match(
        String(e),
        /Runtime still alive|Live process or unexpired lease/,
      );
      return false;
    }
  });
  assert.equal(recovered.recovered.length, 4);
  for (const task of tasks.slice(0, 4)) {
    assert.equal(f.store.show(task.id).status, "failed");
    const ws = f.store.workspace(task.id);
    assert.equal(
      readFileSync(join(ws.path, JSON.parse(task.body).file), "utf8"),
      "partial",
    );
  }
  assert.equal(
    f.store.dispatches().filter((d) => d.state === "interrupted").length,
    4,
  );
  runtime = await f.start({ maxWorkers: 4 });
  assert.equal(runtime.status().paused, true);
  assert.equal(f.store.show(tasks[4].id).attempts.length, 0);
  assert.equal(
    (
      await runtimeRequest(
        f.root,
        "workflow",
        f.input(tasks[0], "a.txt", { enqueue: true }),
      )
    ).duplicate,
    true,
  );
  f.release("worker");
  f.release("manager");
  await runtimeRequest(f.root, "scheduler", { action: "resume" });
  await until(() => f.store.show(tasks[4].id).status === "accepted");
  assert.equal(f.store.show(tasks[0].id).attempts.length, 1);
});
test("async integration can be cancelled while other isolated workflows continue", async (t) => {
  const f = setup(),
    runtime = await f.start({ maxWorkers: 2 });
  t.after(async () => {
    await runtime.stop();
    f.store.close();
  });
  f.release("worker");
  f.release("manager");
  const task = f.create("a.txt"),
    marker = join(f.probe, "integration.pid");
  const check = [
    process.execPath,
    "-e",
    `if(process.cwd().includes('integrations')){require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)}`,
  ];
  await runtimeRequest(f.root, "workflow", f.input(task, "a.txt", { check }));
  await until(
    () =>
      f.store.show(task.id).status === "accepted" && !runtime.status().active,
  );
  const before = git(f.root, "rev-parse", "HEAD");
  const ack = await runtimeRequest(f.root, "integrate", {
    taskId: task.id,
    async: true,
  });
  assert.equal(ack.state, "integration-queued");
  await until(() => existsSync(marker));
  assert.equal(
    (await runtimeRequest(f.root, "status")).integration.taskId,
    task.id,
  );
  const other = f.create("b.txt", "w1");
  await runtimeRequest(f.root, "workflow", f.input(other, "b.txt"));
  await until(() => f.store.show(other.id).status === "accepted");
  await runtimeRequest(f.root, "cancel", { taskId: task.id });
  await until(() => runtime.status().integration === null);
  assert.equal(runtime.status().lastIntegration.state, "failed");
  assert.equal(f.store.show(task.id).status, "accepted");
  assert.equal(git(f.root, "rev-parse", "HEAD"), before);
  assert.equal(
    f.store.runs().filter((row) => row.state === "active").length,
    0,
  );
  await gone(Number(readFileSync(marker, "utf8")));
});
test("interrupted integration preserves accepted commit and recovers without rerunning worker", async (t) => {
  const f = setup(),
    task = f.create("a.txt"),
    marker = join(f.probe, "integration.pid"),
    release = join(f.probe, "integration-release");
  f.release("worker");
  f.release("manager");
  const child = fork(resolve("tests/fixtures/parallel-runtime.mjs"), [f.root], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let runtime;
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await runtime?.stop();
    f.store.close();
  });
  await once(child, "message");
  const check = [
    process.execPath,
    "-e",
    `const fs=require('node:fs');if(process.cwd().includes('integrations')&&!fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)}`,
  ];
  await runtimeRequest(f.root, "workflow", f.input(task, "a.txt", { check }));
  await until(() => f.store.show(task.id).status === "accepted");
  const before = git(f.root, "rev-parse", "HEAD");
  await runtimeRequest(f.root, "integrate", { taskId: task.id, async: true });
  await until(() => existsSync(marker));
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await until(() => {
    try {
      recoverRuntime(f.root);
      return true;
    } catch (e) {
      assert.match(
        String(e),
        /Runtime still alive|Live process or unexpired lease/,
      );
      return false;
    }
  });
  assert.equal(f.store.show(task.id).status, "accepted");
  assert.equal(f.store.workspace(task.id).integrated, null);
  assert.equal(git(f.root, "rev-parse", "HEAD"), before);
  writeFileSync(release, "go");
  runtime = await f.start();
  await runtimeRequest(f.root, "integrate", { taskId: task.id });
  assert.ok(f.store.workspace(task.id).integrated);
  assert.equal(f.store.show(task.id).attempts.length, 1);
});
test("v2 migration preserves tasks and rejects invalid capacity before creating runtime lock", async () => {
  const f = setup(),
    task = f.create("a.txt");
  f.store.close();
  const db = new DatabaseSync(join(f.root, ".rarp", "state.db"));
  db.exec("DROP TABLE dispatches; PRAGMA user_version=2");
  db.close();
  const migrated = new Store(f.root);
  assert.equal(migrated.status().schemaVersion, 3);
  assert.equal(migrated.show(task.id).status, "queued");
  assert.deepEqual(migrated.dispatches(), []);
  migrated.close();
  await assert.rejects(f.start({ maxWorkers: 0 }));
  assert.equal(existsSync(join(f.root, ".rarp", "runtime.json")), false);
});
