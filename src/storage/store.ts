import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createTaskSchema,
  idSchema,
  roleSchema,
  statusSchema,
  textSchema,
  transitions,
} from "../core/task.js";
import type { Task } from "../core/task.js";

const migration = `
CREATE TABLE projects(id TEXT PRIMARY KEY, root TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE agents(id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('manager','worker')), created_at TEXT NOT NULL);
CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES agents(id), assigned_to TEXT NOT NULL REFERENCES agents(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','submitted','reviewing','accepted','changes_requested','blocked','failed','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE dependencies(task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id,depends_on), CHECK(task_id != depends_on));
CREATE TABLE attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL REFERENCES agents(id), number INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, summary TEXT, UNIQUE(task_id,number));
CREATE UNIQUE INDEX active_attempt ON attempts(task_id) WHERE ended_at IS NULL;
CREATE TABLE reviews(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), reviewer TEXT NOT NULL REFERENCES agents(id), decision TEXT NOT NULL CHECK(decision IN ('accepted','changes_requested')), feedback TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL DEFAULT 1, project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), task_id TEXT REFERENCES tasks(id), attempt_id TEXT REFERENCES attempts(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX events_task ON events(task_id,id);
PRAGMA user_version = 1;`;

export class Store {
  private db: DatabaseSync;
  private projectId = "";
  constructor(root: string, initialize = false) {
    const directory = join(resolve(root), ".rarp");
    const file = join(directory, "state.db");
    if (!initialize && !existsSync(file))
      throw new Error("Project not initialized. Run rarp init first.");
    if (initialize) mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
      );
      this.transaction(() => {
        const version = this.db.prepare("PRAGMA user_version").get()![
          "user_version"
        ];
        if (version !== 0 && version !== 1)
          throw new Error(`Unsupported database version: ${version}`);
        if (version === 0) {
          if (!initialize) throw new Error("Database not initialized.");
          this.db.exec(migration);
        }
        const project = this.db
          .prepare("SELECT id FROM projects LIMIT 1")
          .get();
        if (project) this.projectId = String(project["id"]);
        else {
          if (!initialize) throw new Error("Project record missing.");
          this.projectId = randomUUID();
          this.db
            .prepare("INSERT INTO projects VALUES(?,?,?)")
            .run(this.projectId, resolve(root), new Date().toISOString());
          this.event("project.initialized", null, null, null, {});
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private event(
    type: string,
    actor: string | null,
    task: string | null,
    attempt: string | null,
    payload: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO events(project_id,type,agent_id,task_id,attempt_id,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        this.projectId,
        type,
        actor,
        task,
        attempt,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  private agent(id: string) {
    const agent = this.db.prepare("SELECT * FROM agents WHERE id=?").get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }
  register(id: string, role: string) {
    id = idSchema.parse(id);
    role = roleSchema.parse(role);
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM agents WHERE id=?")
        .get(id);
      if (existing) {
        if (existing["role"] !== role)
          throw new Error("Agent already registered with a different role.");
        return existing;
      }
      this.db
        .prepare("INSERT INTO agents VALUES(?,?,?)")
        .run(id, role, new Date().toISOString());
      this.event("agent.registered", id, null, null, { role });
      return this.agent(id);
    });
  }
  create(input: unknown) {
    const data = createTaskSchema.parse(input);
    return this.transaction(() => {
      if (this.agent(data.actor)["role"] !== "manager")
        throw new Error("Only a manager can create tasks.");
      if (this.agent(data.assignee)["role"] !== "worker")
        throw new Error("Assignee must be a worker.");
      for (const dependency of data.dependencies) this.task(dependency);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)")
        .run(
          id,
          data.title,
          data.body,
          data.actor,
          data.assignee,
          "queued",
          now,
          now,
        );
      for (const dependency of new Set(data.dependencies))
        this.db
          .prepare("INSERT INTO dependencies VALUES(?,?)")
          .run(id, dependency);
      this.event("task.created", data.actor, id, null, data);
      return this.show(id);
    });
  }
  private task(id: string): Task {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(idSchema.parse(id));
    if (!row) throw new Error(`Unknown task: ${id}`);
    return row as unknown as Task;
  }
  show(id: string) {
    return {
      ...this.task(id),
      dependencies: this.db
        .prepare(
          "SELECT depends_on FROM dependencies WHERE task_id=? ORDER BY depends_on",
        )
        .all(id)
        .map((row) => row["depends_on"]),
      attempts: this.db
        .prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY number")
        .all(id),
      reviews: this.db
        .prepare("SELECT * FROM reviews WHERE task_id=? ORDER BY created_at")
        .all(id),
    };
  }
  list(status?: string) {
    return status
      ? this.db
          .prepare("SELECT * FROM tasks WHERE status=? ORDER BY created_at,id")
          .all(statusSchema.parse(status))
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at,id").all();
  }
  transition(id: string, nextInput: string, actor: string, noteInput: string) {
    const next = statusSchema.parse(nextInput);
    const note = textSchema.parse(noteInput);
    return this.transaction(() => {
      const task = this.task(id);
      const agent = this.agent(actor);
      if (!transitions[task.status].includes(next))
        throw new Error(`Invalid transition: ${task.status} -> ${next}`);
      const workerAction =
        ["running", "submitted", "failed"].includes(next) ||
        (next === "blocked" && task.status === "running");
      if (workerAction) {
        if (agent["role"] !== "worker" || task.assigned_to !== actor)
          throw new Error(
            "Only the assigned worker can perform this transition.",
          );
      } else if (agent["role"] !== "manager" || actor !== task.created_by)
        throw new Error("Only the task manager can perform this transition.");
      const now = new Date().toISOString();
      let attempt = this.db
        .prepare(
          "SELECT * FROM attempts WHERE task_id=? ORDER BY number DESC LIMIT 1",
        )
        .get(id);
      if (next === "running") {
        const pending = this.db
          .prepare(
            "SELECT t.id FROM dependencies d JOIN tasks t ON t.id=d.depends_on WHERE d.task_id=? AND t.status!='accepted'",
          )
          .all(id);
        if (pending.length)
          throw new Error("Dependencies must be accepted before starting.");
        const attemptId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO attempts(id,task_id,owner,number,started_at) VALUES(?,?,?,?,?)",
          )
          .run(attemptId, id, actor, Number(attempt?.["number"] ?? 0) + 1, now);
        attempt = this.db
          .prepare("SELECT * FROM attempts WHERE id=?")
          .get(attemptId);
      }
      if (task.status === "running") {
        if (!attempt || attempt["ended_at"] !== null)
          throw new Error("Active attempt missing.");
        this.db
          .prepare(
            "UPDATE attempts SET ended_at=?,outcome=?,summary=? WHERE id=?",
          )
          .run(now, next, note, String(attempt["id"]));
      }
      if (next === "accepted" || next === "changes_requested") {
        if (!attempt || attempt["outcome"] !== "submitted")
          throw new Error("Submitted attempt missing.");
        this.db
          .prepare("INSERT INTO reviews VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), id, String(attempt["id"]), actor, next, note, now);
      }
      this.db
        .prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=?")
        .run(next, now, id);
      this.event(
        "task.transitioned",
        actor,
        id,
        attempt ? String(attempt["id"]) : null,
        { from: task.status, to: next, note },
      );
      return this.show(id);
    });
  }
  events() {
    return this.db.prepare("SELECT * FROM events ORDER BY id").all();
  }
  status() {
    return {
      projectId: this.projectId,
      schemaVersion: 1,
      agents: this.db.prepare("SELECT * FROM agents ORDER BY id").all(),
      tasks: this.db
        .prepare(
          "SELECT status,count(*) AS count FROM tasks GROUP BY status ORDER BY status",
        )
        .all(),
      lastEventId: this.db
        .prepare("SELECT coalesce(max(id),0) AS id FROM events")
        .get()!["id"],
    };
  }
}
