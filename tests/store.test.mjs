import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rarp-test-"));
  const store = new Store(root, true);
  t.after(() => store.close());
  store.register("manager", "manager");
  store.register("other-manager", "manager");
  store.register("worker", "worker");
  store.register("other-worker", "worker");
  const create = (dependencies = []) =>
    store.create({
      title: "Cart",
      actor: "manager",
      assignee: "worker",
      dependencies,
    });
  const move = (id, status, actor = "manager") =>
    store.transition(id, status, actor, "test evidence");
  return { root, store, create, move };
}
test("review loop, ownership and dependency gate", (t) => {
  const { store, create, move } = fixture(t);
  const a = create();
  const b = create([a.id]);
  assert.throws(() => move(b.id, "running", "worker"), /Dependencies/);
  assert.throws(() => move(a.id, "running", "other-worker"), /assigned worker/);
  assert.throws(() => move(a.id, "accepted"), /Invalid transition/);
  move(a.id, "running", "worker");
  move(a.id, "submitted", "worker");
  assert.throws(() => move(a.id, "reviewing", "worker"), /task manager/);
  assert.throws(() => move(a.id, "reviewing", "other-manager"), /task manager/);
  move(a.id, "reviewing");
  move(a.id, "changes_requested");
  move(a.id, "queued");
  move(a.id, "running", "worker");
  move(a.id, "submitted", "worker");
  move(a.id, "reviewing");
  move(a.id, "accepted");
  const result = store.show(a.id);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.reviews.length, 2);
  assert.equal(result.attempts[1].number, 2);
  move(b.id, "running", "worker");
  assert.throws(() => move(a.id, "queued"), /Invalid transition/);
});
test("event insert failure rolls back task, attempt and review mutations", (t) => {
  const { root, store, create, move } = fixture(t);
  const a = create();
  const raw = new DatabaseSync(join(root, ".rarp", "state.db"));
  t.after(() => raw.close());
  raw.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  const before = store.events().length;
  assert.throws(() => move(a.id, "running", "worker"), /injected failure/);
  assert.equal(store.show(a.id).status, "queued");
  assert.equal(store.show(a.id).attempts.length, 0);
  assert.throws(() => create(), /injected failure/);
  assert.equal(store.list().length, 1);
  raw.exec("DROP TRIGGER reject_event");
  move(a.id, "running", "worker");
  move(a.id, "submitted", "worker");
  move(a.id, "reviewing");
  raw.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  assert.throws(() => move(a.id, "accepted"), /injected failure/);
  assert.equal(store.show(a.id).status, "reviewing");
  assert.equal(store.show(a.id).reviews.length, 0);
  assert.equal(store.events().length, before + 3);
});
test("failed dependencies, invalid input and immutable agent roles", (t) => {
  const { store, create, move } = fixture(t);
  const a = create();
  const b = create([a.id]);
  move(a.id, "running", "worker");
  move(a.id, "failed", "worker");
  assert.throws(() => move(b.id, "running", "worker"), /Dependencies/);
  assert.throws(() => create(["missing"]), /Unknown task/);
  assert.throws(() => store.register("worker", "manager"), /different role/);
  assert.throws(() =>
    store.create({ title: " ", actor: "manager", assignee: "worker" }),
  );
  assert.throws(
    () => store.create({ title: "x", actor: "worker", assignee: "worker" }),
    /manager/,
  );
  move(a.id, "queued");
  move(a.id, "running", "worker");
  move(a.id, "cancelled");
  assert.equal(store.show(a.id).attempts[1].outcome, "cancelled");
  assert.equal(store.list().length, 2);
});
test("fresh CLI processes persist data and repeated init is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "rarp-cli-"));
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli/index.js"), "--project", root, "--json", ...args],
      { encoding: "utf8" },
    );
  const ok = (...args) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.notEqual(cli("status").status, 0);
  const first = ok("init");
  const second = ok("init");
  assert.deepEqual(second, first);
  ok("agent", "register", "manager", "--role", "manager");
  ok("agent", "register", "worker", "--role", "worker");
  const task = ok(
    "task",
    "create",
    "--title",
    "Persist me",
    "--actor",
    "manager",
    "--assignee",
    "worker",
  );
  assert.equal(ok("task", "show", task.id).title, "Persist me");
  assert.equal(ok("task", "list").length, 1);
  assert.equal(ok("status").tasks[0].count, 1);
  assert.notEqual(
    cli(
      "task",
      "transition",
      task.id,
      "accepted",
      "--actor",
      "worker",
      "--note",
      "invalid",
    ).status,
    0,
  );
  assert.equal(ok("task", "show", task.id).status, "queued");
});
test("unknown future schema fails without resetting data", () => {
  const root = mkdtempSync(join(tmpdir(), "rarp-schema-"));
  const store = new Store(root, true);
  store.close();
  const db = new DatabaseSync(join(root, ".rarp", "state.db"));
  db.exec("PRAGMA user_version=99");
  db.close();
  assert.throws(() => new Store(root, true), /Unsupported database version/);
});

test("PRAGMA configuration: busy_timeout is 30000 and safe WAL mode", (t) => {
  const { store } = fixture(t);
  const busyTimeout = store.db.prepare("PRAGMA busy_timeout").get().timeout;
  const journalMode = store.db.prepare("PRAGMA journal_mode").get().journal_mode;
  const synchronous = store.db.prepare("PRAGMA synchronous").get().synchronous;
  assert.equal(busyTimeout, 30000);
  assert.equal(journalMode, "wal");
  assert.equal(synchronous, 1);
});

test("high-throughput event batching flushes automatically when reaching 50 items", (t) => {
  const { root, store, create, move } = fixture(t);
  const task = create();
  move(task.id, "running", "worker");
  const attemptId = String(store.show(task.id).attempts[0].id);

  const raw = new DatabaseSync(join(root, ".rarp", "state.db"));
  t.after(() => raw.close());

  for (let i = 0; i < 49; i++) {
    store.recordWorkerEvent(task.id, attemptId, "worker", { seq: i });
  }

  const countBefore = Number(
    raw
      .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
      .get().c,
  );
  assert.equal(countBefore, 0);

  store.recordWorkerEvent(task.id, attemptId, "worker", { seq: 49 });

  const countAfter = Number(
    raw
      .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
      .get().c,
  );
  assert.equal(countAfter, 50);
});

test("event batching flushes periodically after 50ms", async (t) => {
  const { root, store, create, move } = fixture(t);
  const task = create();
  move(task.id, "running", "worker");
  const attemptId = String(store.show(task.id).attempts[0].id);

  const raw = new DatabaseSync(join(root, ".rarp", "state.db"));
  t.after(() => raw.close());

  for (let i = 0; i < 5; i++) {
    store.recordWorkerEvent(task.id, attemptId, "worker", { seq: i });
  }

  const countImmediate = Number(
    raw
      .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
      .get().c,
  );
  assert.equal(countImmediate, 0);

  await delay(80);

  const countAfterDelay = Number(
    raw
      .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
      .get().c,
  );
  assert.equal(countAfterDelay, 5);
});

test("event batching flushes cleanly on store close", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rarp-close-"));
  const store = new Store(root, true);
  store.register("manager", "manager");
  store.register("worker", "worker");
  const task = store.create({
    title: "Close test",
    actor: "manager",
    assignee: "worker",
    dependencies: [],
  });
  store.transition(task.id, "running", "worker", "start");
  const attemptId = String(store.show(task.id).attempts[0].id);

  for (let i = 0; i < 10; i++) {
    store.recordWorkerEvent(task.id, attemptId, "worker", { seq: i });
  }

  store.close();

  const raw = new DatabaseSync(join(root, ".rarp", "state.db"));
  try {
    const count = Number(
      raw
        .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
        .get().c,
    );
    assert.equal(count, 10);
  } finally {
    raw.close();
  }
});

test("manual flush persists batched events immediately", (t) => {
  const { root, store, create, move } = fixture(t);
  const task = create();
  move(task.id, "running", "worker");
  const attemptId = String(store.show(task.id).attempts[0].id);

  const raw = new DatabaseSync(join(root, ".rarp", "state.db"));
  t.after(() => raw.close());

  for (let i = 0; i < 7; i++) {
    store.recordWorkerEvent(task.id, attemptId, "worker", { seq: i });
  }

  assert.equal(
    Number(
      raw
        .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
        .get().c,
    ),
    0,
  );

  store.flush();

  assert.equal(
    Number(
      raw
        .prepare("SELECT count(*) as c FROM events WHERE type='worker.output'")
        .get().c,
    ),
    7,
  );
});

test("event validation rejects invalid attempts synchronously", (t) => {
  const { store, create, move } = fixture(t);
  const task = create();
  move(task.id, "running", "worker");
  const attemptId = String(store.show(task.id).attempts[0].id);

  assert.throws(
    () =>
      store.recordWorkerEvent(task.id, "bad-attempt-id", "worker", {
        data: 1,
      }),
    /Worker attempt mismatch/,
  );

  assert.throws(
    () =>
      store.recordReviewEvent(task.id, "bad-attempt-id", "manager", {
        data: 1,
      }),
    /Review attempt mismatch/,
  );

  assert.throws(
    () =>
      store.recordReviewEvent(task.id, attemptId, "other-manager", {
        data: 1,
      }),
    /Reviewer mismatch/,
  );
});

test("high concurrency worker events without SQLITE_BUSY", async (t) => {
  const { root, store } = fixture(t);
  store.register("worker-a", "worker");
  store.register("worker-b", "worker");
  store.register("worker-c", "worker");
  store.register("worker-d", "worker");

  const tasks = ["worker-a", "worker-b", "worker-c", "worker-d"].map(
    (assignee, idx) => {
      const task = store.create({
        title: `Parallel Task ${idx}`,
        actor: "manager",
        assignee,
        dependencies: [],
      });
      store.transition(task.id, "running", assignee, "start");
      const attemptId = String(store.show(task.id).attempts[0].id);
      return { task, assignee, attemptId };
    },
  );

  await Promise.all(
    tasks.map(async ({ task, assignee, attemptId }, workerIndex) => {
      for (let i = 0; i < 30; i++) {
        store.recordWorkerEvent(task.id, attemptId, assignee, {
          workerIndex,
          eventIndex: i,
        });
        if (i % 5 === 0) await delay(5);
      }
    }),
  );

  store.flush();

  const events = store.events().filter((e) => e.type === "worker.output");
  assert.equal(events.length, 120);
});

test("prepared statements are cached and cleared on close", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rarp-stmt-"));
  const store = new Store(root, true);
  store.register("manager", "manager");
  store.register("worker", "worker");
  const task = store.create({
    title: "Stmt task",
    actor: "manager",
    assignee: "worker",
    dependencies: [],
  });

  const cacheSizeBefore = store.statementCache.size;
  assert.ok(cacheSizeBefore > 0);

  // Calling show multiple times reuses cached statement without increasing cache size
  store.show(task.id);
  store.show(task.id);
  const cacheSizeAfterShow = store.statementCache.size;

  store.show(task.id);
  assert.equal(store.statementCache.size, cacheSizeAfterShow);

  store.close();
  assert.equal(store.statementCache.size, 0);
});
