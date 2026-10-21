import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
