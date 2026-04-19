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
import type { Workspace } from "../runtime/workspace.js";

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
        if (version !== 0 && version !== 1 && version !== 2)
          throw new Error(`Unsupported database version: ${version}`);
        if (version === 0) {
          if (!initialize) throw new Error("Database not initialized.");
          this.db.exec(migration);
        }
        if (version !== 2)
          this.db.exec(`
          CREATE TABLE workspaces(task_id TEXT PRIMARY KEY REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE TABLE runs(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL, runtime_pid INTEGER NOT NULL, host_pid INTEGER, lease_until INTEGER NOT NULL, state TEXT NOT NULL, result TEXT);
          CREATE UNIQUE INDEX active_task_run ON runs(task_id) WHERE state='active';
          PRAGMA user_version=2;
        `);
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
  workspace(taskId: string): Workspace | undefined {
    const row = this.db
      .prepare("SELECT data FROM workspaces WHERE task_id=?")
      .get(taskId);
    return row ? (JSON.parse(String(row["data"])) as Workspace) : undefined;
  }
  saveWorkspace(workspace: Workspace) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workspaces VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
        )
        .run(workspace.taskId, JSON.stringify(workspace));
      this.event("workspace.updated", null, workspace.taskId, null, workspace);
    });
  }
  findRun(key: string) {
    return this.db.prepare("SELECT * FROM runs WHERE request_key=?").get(key);
  }
  runs() {
    return this.db.prepare("SELECT * FROM runs ORDER BY rowid").all();
  }
  reserveRun(key: string, fingerprint: string, taskId: string, owner: string) {
    return this.transaction(() => {
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs(id,request_key,fingerprint,task_id,owner,runtime_pid,lease_until,state) VALUES(?,?,?,?,?,?,?,'active')",
        )
        .run(
          id,
          key,
          fingerprint,
          taskId,
          owner,
          process.pid,
          Date.now() + 15000,
        );
      this.event("run.started", null, taskId, null, { id, key });
      return id;
    });
  }
  hostRun(id: string, pid: number) {
    this.db
      .prepare("UPDATE runs SET host_pid=? WHERE id=? AND state='active'")
      .run(pid, id);
  }
  heartbeat(owner: string) {
    this.db
      .prepare("UPDATE runs SET lease_until=? WHERE owner=? AND state='active'")
      .run(Date.now() + 15000, owner);
  }
  finishRun(id: string, result: unknown) {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT task_id FROM runs WHERE id=?")
        .get(id);
      if (!row) throw new Error("Run missing");
      this.db
        .prepare(
          "UPDATE runs SET state='completed',result=?,host_pid=NULL WHERE id=?",
        )
        .run(JSON.stringify(result), id);
      this.event("run.completed", null, String(row["task_id"]), null, {
        id,
        result,
      });
    });
  }
  recoverRuns() {
    const alive = (pid: unknown) => {
      if (!pid) return false;
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM runs WHERE state='active'")
        .all();
      for (const row of rows)
        if (
          alive(row["runtime_pid"]) ||
          alive(row["host_pid"]) ||
          Number(row["lease_until"]) > Date.now()
        )
          throw new Error("Live process or unexpired lease; recovery refused");
      for (const row of rows) {
        const task = this.task(String(row["task_id"]));
        const now = new Date().toISOString();
        if (task.status === "running") {
          this.db
            .prepare(
              "UPDATE attempts SET ended_at=?,outcome='interrupted',summary='Runtime interrupted; inspect workspace before retry' WHERE task_id=? AND ended_at IS NULL",
            )
            .run(now, task.id);
          this.db
            .prepare("UPDATE tasks SET status='failed',updated_at=? WHERE id=?")
            .run(now, task.id);
        }
        if (task.status === "reviewing")
          this.db
            .prepare(
              "UPDATE tasks SET status='submitted',updated_at=? WHERE id=?",
            )
            .run(now, task.id);
        this.db
          .prepare("UPDATE runs SET state='recovered',result=? WHERE id=?")
          .run(
            JSON.stringify({ state: this.task(task.id).status }),
            String(row["id"]),
          );
        this.event("run.recovered", null, task.id, null, {
          id: row["id"],
          from: task.status,
          to: this.task(task.id).status,
        });
      }
      return rows.map((row) => row["id"]);
    });
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
        (["running", "submitted", "failed"].includes(next) &&
          task.status !== "reviewing") ||
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
  events(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Invalid event cursor");
    return this.db
      .prepare("SELECT * FROM events WHERE id>? ORDER BY id")
      .all(after);
  }
  recordReviewEvent(
    taskId: string,
    attemptId: string,
    actor: string,
    data: unknown,
  ) {
    this.transaction(() => {
      if (this.task(taskId).created_by !== actor)
        throw new Error("Reviewer mismatch");
      if (
        !this.db
          .prepare("SELECT id FROM attempts WHERE id=? AND task_id=?")
          .get(attemptId, taskId)
      )
        throw new Error("Review attempt mismatch");
      this.event("review.output", actor, taskId, attemptId, data);
    });
  }
  recordWorkerEvent(
    taskId: string,
    attemptId: string,
    actor: string,
    data: unknown,
  ) {
    this.transaction(() => {
      const attempt = this.db
        .prepare("SELECT * FROM attempts WHERE id=? AND task_id=? AND owner=?")
        .get(attemptId, taskId, actor);
      if (!attempt) throw new Error("Worker attempt mismatch");
      this.event("worker.output", actor, taskId, attemptId, data);
    });
  }
  status() {
    return {
      projectId: this.projectId,
      schemaVersion: 2,
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
