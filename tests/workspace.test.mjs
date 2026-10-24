import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  git,
  canonicalPath,
  prepareWorkspace,
  checkpoint,
  verifyWorkspace,
  integrateWorkspace,
} from "../dist/runtime/workspace.js";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { recoverRuntime } from "../dist/runtime/recovery.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "rarp-isolation-"));
  git(root, "init");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@localhost");
  writeFileSync(join(root, ".gitignore"), ".rarp/\n");
  writeFileSync(join(root, "feature.txt"), "base");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}
const check = [
  process.execPath,
  "-e",
  "require('node:assert').equal(require('node:fs').readFileSync('feature.txt','utf8'),'done')",
];
function edited(root, id = "task") {
  const ws = prepareWorkspace(root, id, ["feature.txt"], check);
  writeFileSync(join(ws.path, "feature.txt"), "done");
  checkpoint(ws);
  return ws;
}

test("repository root comparison accepts native Windows path aliases", () => {
  const root = repo();
  assert.equal(
    canonicalPath(root),
    canonicalPath(git(root, "rev-parse", "--show-toplevel")),
  );
  if (process.platform === "win32") {
    assert.equal(
      canonicalPath(root),
      canonicalPath(root.replaceAll("\\", "/")),
    );
    assert.equal(canonicalPath(root), canonicalPath("\\\\?\\" + root));
  }
});
test("worktree scope, verified integration and repeated integration", () => {
  const root = repo(),
    base = git(root, "rev-parse", "HEAD"),
    ws = edited(root);
  assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), "base");
  verifyWorkspace(ws);
  const merged = integrateWorkspace(root, ws);
  assert.notEqual(merged, base);
  assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), "done");
  assert.equal(integrateWorkspace(root, ws), merged); // crash before database save
  assert.equal(git(root, "status", "--porcelain"), "");
});
test("scope rejects rename source outside scope and traversal", () => {
  const root = repo();
  assert.throws(() => prepareWorkspace(root, "bad", ["../x"], check), /safe/);
  const ws = prepareWorkspace(root, "rename", ["new.txt"], check);
  git(ws.path, "mv", "feature.txt", "new.txt");
  assert.throws(() => checkpoint(ws), /outside task scope/);
});
test("failed verification and merge conflicts preserve main checkout", () => {
  const root = repo(),
    ws = edited(root);
  assert.throws(
    () =>
      verifyWorkspace({
        ...ws,
        check: [process.execPath, "-e", "process.exit(1)"],
      }),
    /Verification failed/,
  );
  writeFileSync(join(root, "feature.txt"), "other");
  git(root, "add", ".");
  git(root, "commit", "-m", "competing change");
  const before = git(root, "rev-parse", "HEAD");
  assert.throws(() => integrateWorkspace(root, ws));
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.ok(
    git(
      join(root, ".rarp", "integrations", "task"),
      "diff",
      "--name-only",
      "--diff-filter=U",
    ).includes("feature.txt"),
  );
});
test("resolved integration conflict can be retried without repeating the merge", () => {
  const root = repo(),
    ws = edited(root);
  writeFileSync(join(root, "feature.txt"), "competing");
  git(root, "add", ".");
  git(root, "commit", "-m", "competing change");
  assert.throws(() => integrateWorkspace(root, ws));
  const target = join(root, ".rarp", "integrations", ws.taskId);
  writeFileSync(join(target, "feature.txt"), "done");
  git(target, "add", "feature.txt");
  git(target, "commit", "-m", "Resolve integration conflict");
  const resolved = git(target, "rev-parse", "HEAD");
  assert.equal(integrateWorkspace(root, ws), resolved);
  assert.equal(integrateWorkspace(root, ws), resolved);
  assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), "done");
  assert.equal(git(root, "status", "--porcelain"), "");
});
test("integration rechecks combined tree before updating main", () => {
  const root = repo(),
    ws = edited(root);
  const before = git(root, "rev-parse", "HEAD");
  assert.throws(
    () =>
      integrateWorkspace(root, {
        ...ws,
        check: [process.execPath, "-e", "process.exit(2)"],
      }),
    /Verification failed/,
  );
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});
test("durable idempotency and resumed review do not repeat worker", async (t) => {
  const root = repo(),
    store = new Store(root, true);
  store.register("m", "manager");
  store.register("w", "worker");
  const task = store.create({
    title: "Write done to feature.txt",
    actor: "m",
    assignee: "w",
  });
  const command = (role) => ({
    file: process.execPath,
    args: [resolve("tests/fixtures/isolated-agent.mjs"), role],
  });
  let runtime = await startRuntime(root, command("worker"), {
    manager: command("manager"),
  });
  t.after(async () => {
    await runtime.stop();
    store.close();
  });
  const input = {
    taskId: task.id,
    isolated: true,
    scope: ["feature.txt"],
    check,
    requestKey: "one",
    timeoutMs: 5000,
  };
  await runtimeRequest(root, "workflow", input);
  assert.equal((await runtimeRequest(root, "workflow", input)).duplicate, true);
  for (let i = 0; runtime.status().active && i < 200; i++) await delay(50);
  assert.equal(store.show(task.id).status, "accepted");
  assert.equal(store.show(task.id).attempts.length, 1);
  await runtime.stop();
  runtime = await startRuntime(root, command("worker"), {
    manager: command("manager"),
  });
  assert.equal((await runtimeRequest(root, "workflow", input)).duplicate, true);
  await assert.rejects(
    runtimeRequest(root, "workflow", { ...input, timeoutMs: 6000 }),
    /different input/,
  );
  await runtimeRequest(root, "integrate", { taskId: task.id });
  const integrated = store.workspace(task.id).integrated;
  assert.ok(integrated);
  await runtimeRequest(root, "integrate", { taskId: task.id });
  assert.equal(store.workspace(task.id).integrated, integrated);
  // Prepare a submitted artifact as if the runtime died during review.
  await runtime.stop();
  const second = store.create({
    title: "Review preserved result",
    actor: "m",
    assignee: "w",
  });
  const ws = edited(root, second.id);
  store.saveWorkspace(ws);
  store.transition(second.id, "running", "w", "start");
  store.transition(second.id, "submitted", "w", "done");
  store.transition(second.id, "reviewing", "m", "review");
  store.reserveRun("interrupted", "fixture", second.id, "dead");
  assert.throws(() => store.recoverRuns(), /Live process/);
  const db = new DatabaseSync(join(root, ".rarp", "state.db"));
  db.exec(
    "UPDATE runs SET runtime_pid=2147483647,host_pid=NULL,lease_until=0 WHERE state='active'",
  );
  db.close();
  recoverRuntime(root);
  assert.equal(store.show(second.id).status, "submitted");
  runtime = await startRuntime(root, command("must-not-run"), {
    manager: command("manager"),
  });
  await runtimeRequest(root, "workflow", {
    taskId: second.id,
    isolated: true,
    resumeReview: true,
    requestKey: "resume",
  });
  for (let i = 0; runtime.status().active && i < 200; i++) await delay(50);
  assert.equal(store.show(second.id).status, "accepted");
  assert.equal(store.show(second.id).attempts.length, 1);
  const cursor = store.events().at(-1).id;
  assert.deepEqual(store.events(cursor), []);
});
test("recovery refuses live host and unexpired lease; interrupted worker is failed", () => {
  const root = repo(),
    store = new Store(root, true);
  store.register("m", "manager");
  store.register("w", "worker");
  const task = store.create({
    title: "Interrupted",
    actor: "m",
    assignee: "w",
  });
  store.transition(task.id, "running", "w", "start");
  store.reserveRun("key", "input", task.id, "owner");
  const db = new DatabaseSync(join(root, ".rarp", "state.db"));
  db.prepare("UPDATE runs SET runtime_pid=2147483647,host_pid=?").run(
    process.pid,
  );
  assert.throws(() => store.recoverRuns(), /Live process/);
  db.exec("UPDATE runs SET host_pid=NULL");
  assert.throws(() => store.recoverRuns(), /lease/);
  db.exec("UPDATE runs SET lease_until=0");
  recoverRuntime(root);
  assert.equal(store.show(task.id).status, "failed");
  assert.equal(store.show(task.id).attempts[0].outcome, "interrupted");
  assert.deepEqual(recoverRuntime(root).recovered, []);
  db.close();
  store.close();
});
