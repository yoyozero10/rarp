import { DatabaseSync } from "node:sqlite";
import { goalSchema, approvalSchema, validateProposal, hash } from "../core/plan.js";
import type { Goal, Plan, Approval } from "../core/plan.js";
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
import type { Dispatch } from "../core/dispatch.js";

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
        if (![0, 1, 2, 3, 4].includes(Number(version)))
          throw new Error(`Unsupported database version: ${version}`);
        if (version === 0) {
          if (!initialize) throw new Error("Database not initialized.");
          this.db.exec(migration);
        }
        if (Number(version) < 2)
          this.db.exec(`
          CREATE TABLE workspaces(task_id TEXT PRIMARY KEY REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE TABLE runs(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL, runtime_pid INTEGER NOT NULL, host_pid INTEGER, lease_until INTEGER NOT NULL, state TEXT NOT NULL, result TEXT);
          CREATE UNIQUE INDEX active_task_run ON runs(task_id) WHERE state='active';
          PRAGMA user_version=2;
        `);
        if (Number(version) < 3)
          this.db.exec(`
          CREATE TABLE dispatches(request_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL, data TEXT NOT NULL);
          CREATE UNIQUE INDEX pending_dispatch ON dispatches(task_id) WHERE state IN ('waiting','active');
          PRAGMA user_version=3;
        `);
        if (Number(version) < 4) this.db.exec(`
          CREATE TABLE goals(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE plans(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), data TEXT NOT NULL);
          CREATE TABLE plan_revisions(plan_id TEXT NOT NULL REFERENCES plans(id), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(plan_id,revision));
          CREATE TABLE plan_approvals(plan_id TEXT NOT NULL REFERENCES plans(id), revision INTEGER NOT NULL, content_hash TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(plan_id,revision));
          CREATE TABLE plan_task_links(plan_id TEXT NOT NULL REFERENCES plans(id), step_key TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), PRIMARY KEY(plan_id,step_key));
          CREATE TABLE planner_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL REFERENCES plans(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
          PRAGMA user_version=4;
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
  goals(): Goal[] { return this.db.prepare("SELECT data FROM goals ORDER BY rowid").all().map(r=>JSON.parse(String(r['data'])) as Goal); }
  goal(id: string) { const value=this.goals().find(g=>g.id===id); if(!value) throw new Error('Unknown goal'); return value; }
  plans(): Plan[] { return this.db.prepare("SELECT data FROM plans ORDER BY rowid").all().map(r=>JSON.parse(String(r['data'])) as Plan); }
  plan(id: string): Plan { const row=this.db.prepare('SELECT data FROM plans WHERE id=?').get(id); if(!row) throw new Error('Unknown plan'); return JSON.parse(String(row['data'])) as Plan; }
  private writePlan(plan: Plan) {
    this.db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify(plan),plan.id);
    this.db.prepare('UPDATE goals SET data=json_set(data,\'$.status\',?) WHERE id=?').run(plan.status,plan.goalId);
    this.event('plan.updated',null,null,null,{planId:plan.id,status:plan.status,revision:plan.revision});
  }
  createGoal(input: unknown) {
    const goal: Goal={...goalSchema.parse(input),id:'goal-'+randomUUID(),status:'received',createdAt:new Date().toISOString()};
    const plan: Plan={id:'plan-'+randomUUID(),goalId:goal.id,revision:0,contentHash:'',baseHead:'',fingerprint:'',status:'received',proposal:null,createdAt:goal.createdAt};
    this.transaction(()=>{ this.db.prepare('INSERT INTO goals VALUES(?,?)').run(goal.id,JSON.stringify(goal)); this.db.prepare('INSERT INTO plans VALUES(?,?,?)').run(plan.id,goal.id,JSON.stringify(plan)); this.event('goal.created',null,null,null,{goalId:goal.id,planId:plan.id}); });
    return {goal,plan};
  }
  updatePlan(id: string, revision: number, input: unknown, baseHead: string, fingerprint: string) {
    const proposal=validateProposal(input);
    return this.transaction(()=>{ const plan=this.plan(id); if(plan.revision!==revision) throw new Error('Plan revision changed'); if(['executing','materializing','completed','cancelled'].includes(plan.status)) throw new Error('Execution must not be edited; create a new goal');
      const links=this.planLinks(id);
      if(links.some(l=>this.dispatches().some(d=>d.taskId===l.taskId && d.state==='active'))) throw new Error('Cancel active work before revising');
      for(const link of links) {
        const task=this.show(link.taskId), old=plan.proposal?.steps.find(s=>s.key===link.stepKey), next=proposal.steps.find(s=>s.key===link.stepKey);
        if(task.status==='accepted') { if(!this.workspace(task.id)?.integrated || hash(old)!==hash(next)) throw new Error('Completed steps must remain unchanged and integrated'); }
        else { for(const d of this.dispatches().filter(d=>d.taskId===task.id && d.state==='waiting')) {d.state='cancelled';d.note='Superseded revision';this.db.prepare('UPDATE dispatches SET state=?,data=? WHERE request_key=?').run(d.state,JSON.stringify(d),d.key);} this.db.prepare('DELETE FROM plan_task_links WHERE plan_id=? AND step_key=?').run(id,link.stepKey); }
      }
      this.db.prepare('INSERT OR IGNORE INTO plan_revisions VALUES(?,?,?)').run(id,plan.revision,JSON.stringify(plan));
      plan.revision++; plan.proposal=proposal; plan.baseHead=baseHead; plan.fingerprint=fingerprint; plan.contentHash=hash({goal:this.goal(plan.goalId),proposal,baseHead,fingerprint}); delete plan.approval;
      plan.status=proposal.questions.length?'needs_clarification':'awaiting_approval'; this.writePlan(plan); return plan;
    });
  }
  planSnapshot(id: string,snapshot: {baseHead:string;fingerprint:string}) { this.transaction(()=>{const p=this.plan(id);p.executionSnapshot=snapshot;this.writePlan(p);}); }
  planState(id: string,status: string,note?: string) { return this.transaction(()=>{ const p=this.plan(id); p.status=status; if(note!==undefined)p.note=note; this.writePlan(p); return p; }); }
  plannerLog(id: string,data: unknown) { this.db.prepare('INSERT INTO planner_logs(plan_id,data,created_at) VALUES(?,?,?)').run(id,JSON.stringify(data),new Date().toISOString()); }
  planHistory(id: string) { return this.db.prepare('SELECT data FROM plan_revisions WHERE plan_id=? ORDER BY revision').all(id).map(r=>JSON.parse(String(r['data'])) as Plan); }
  planLogs(id: string) { return this.db.prepare('SELECT id,data,created_at FROM planner_logs WHERE plan_id=? ORDER BY id').all(id).map(r=>({...r,data:JSON.parse(String(r['data'])) as unknown})); }
  planLinks(id: string) { return this.db.prepare('SELECT step_key AS stepKey,task_id AS taskId FROM plan_task_links WHERE plan_id=? ORDER BY rowid').all(id).map(r=>({stepKey:String(r['stepKey']),taskId:String(r['taskId'])})); }
  taskPlan(taskId: string) { const row=this.db.prepare('SELECT plan_id FROM plan_task_links WHERE task_id=?').get(taskId); return row?this.plan(String(row['plan_id'])):undefined; }
  approvePlan(id: string,input: unknown,baseHead: string,fingerprint: string,bindings: Record<string,string> = {}) {
    const approval=approvalSchema.parse(input);
    return this.transaction(()=>{ const p=this.plan(id);
      if(p.revision!==approval.revision || p.contentHash!==approval.contentHash) throw new Error('Stale approval revision/hash');
      if(p.approval && hash(p.approval)===hash(approval) && ['executing','paused','completed'].includes(p.status)) { if(hash(p.bindings??{})!==hash(bindings)) throw new Error('Approved profile configuration changed'); return p; }
      if(p.status!=='awaiting_approval' || !p.proposal || p.proposal.questions.length) throw new Error('Plan is not awaiting approval');
      if(p.baseHead!==baseHead || p.fingerprint!==fingerprint) throw new Error('Repository stale; analyze again');
      const refs=new Set(approval.workers.map(w=>w.workerRef)); if(refs.size!==approval.workers.length || refs.size!==p.proposal.workers.length || p.proposal.workers.some(w=>!refs.has(w.workerRef))) throw new Error('Worker binding mismatch');
      if(approval.maxWorkers>p.proposal.maxWorkers || approval.maxWorkers>this.goal(p.goalId).maxWorkers) throw new Error('Approval exceeds plan/goal limit');
      p.approval=approval; p.bindings=bindings; p.executionSnapshot={baseHead,fingerprint}; p.status='materializing';
      this.db.prepare('INSERT INTO plan_approvals VALUES(?,?,?,?,?)').run(id,p.revision,p.contentHash,JSON.stringify(approval),new Date().toISOString());
      const manager='manager-'+id; this.db.prepare('INSERT OR IGNORE INTO agents VALUES(?,?,?)').run(manager,'manager',p.createdAt);
      const retained=new Map(this.planLinks(id).map(l=>[l.stepKey,l.taskId]));
      const ids=new Map(p.proposal.steps.map(s=>[s.key,retained.get(s.key)??randomUUID()]));
      for(const w of approval.workers) this.db.prepare('INSERT OR IGNORE INTO agents VALUES(?,?,?)').run(id+'-'+w.workerRef,'worker',p.createdAt);
      for(const s of p.proposal.steps) {
        if(retained.has(s.key)) continue;
        const taskId=ids.get(s.key)!, worker=approval.workers.find(w=>w.workerRef===s.workerRef)!;
        this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(taskId,s.title,[s.requirements,'Deliverable: '+s.deliverable,'Acceptance:\n'+s.acceptance.join('\n')].join('\n'),manager,id+'-'+s.workerRef,'queued',p.createdAt,p.createdAt);
        this.db.prepare('INSERT INTO plan_task_links VALUES(?,?,?)').run(id,s.key,taskId);
        const key=`${id}:${p.revision}:${s.key}`;
        const input={taskId,adapter:worker.adapter,profile:worker.profile,executionId:id,requestKey:key,isolated:true,resumeReview:false,enqueue:true,scope:s.scope,check:s.check,...p.proposal.policy};
        const dispatch: Dispatch={key,taskId,route:'workflow',input,state:'waiting',note:'Approved plan; waiting for scheduler',fingerprint:hash(input)};
        this.db.prepare('INSERT INTO dispatches VALUES(?,?,?,?)').run(key,taskId,dispatch.state,JSON.stringify(dispatch));
      }
      for(const s of p.proposal.steps) for(const d of s.dependencies) this.db.prepare('INSERT OR IGNORE INTO dependencies VALUES(?,?)').run(ids.get(s.key)!,ids.get(d)!);
      p.status='executing'; this.writePlan(p); return p;
    });
  }
  dispatch(key: string): Dispatch | undefined {
    const row = this.db
      .prepare("SELECT data FROM dispatches WHERE request_key=?")
      .get(key);
    return row ? (JSON.parse(String(row["data"])) as Dispatch) : undefined;
  }
  dispatches(): Dispatch[] {
    return this.db
      .prepare("SELECT data FROM dispatches ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row["data"])) as Dispatch);
  }
  schedulerEvent(
    type: "started" | "pause" | "resume" | "integration-failed",
    data: unknown,
  ) {
    this.transaction(() =>
      this.event("scheduler." + type, null, null, null, data),
    );
  }
  saveDispatch(dispatch: Dispatch) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO dispatches VALUES(?,?,?,?) ON CONFLICT(request_key) DO UPDATE SET state=excluded.state,data=excluded.data",
        )
        .run(
          dispatch.key,
          dispatch.taskId,
          dispatch.state,
          JSON.stringify(dispatch),
        );
      this.event("dispatch." + dispatch.state, null, dispatch.taskId, null, {
        key: dispatch.key,
        note: dispatch.note,
      });
    });
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
      for (const dispatch of this.dispatches().filter(
        (d) => d.state === "active",
      )) {
        dispatch.state = "interrupted";
        dispatch.note =
          "Recovered; inspect task and use a new request key before retry";
        this.db
          .prepare("UPDATE dispatches SET state=?,data=? WHERE request_key=?")
          .run(dispatch.state, JSON.stringify(dispatch), dispatch.key);
        this.event("dispatch.interrupted", null, dispatch.taskId, null, {
          key: dispatch.key,
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
  transition(
    id: string,
    nextInput: string,
    actor: string,
    noteInput: string,
    expectedStatus?: string,
  ) {
    const next = statusSchema.parse(nextInput);
    const note = textSchema.parse(noteInput);
    return this.transaction(() => {
      const task = this.task(id);
      if (expectedStatus !== undefined && task.status !== expectedStatus)
        throw new Error("Task changed; refresh before retrying");
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
  observation() {
    return this.transaction(() => ({
      ...this.status(),
      tasks: this.list().map((task) => ({
        ...this.show(String(task["id"])),
        workspace: this.workspace(String(task["id"])) ?? null,
      })),
      recentEvents: this.db
        .prepare(
          "SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT 100) ORDER BY id",
        )
        .all(),
    }));
  }
  reassign(
    id: string,
    actor: string,
    assignee: string,
    expectedStatus?: string,
  ) {
    return this.transaction(() => {
      const task = this.task(id);
      if (expectedStatus !== undefined && task.status !== expectedStatus)
        throw new Error("Task changed; refresh before retrying");
      if (actor !== task.created_by || this.agent(actor)["role"] !== "manager")
        throw new Error("Only the task manager can reassign");
      if (
        !["queued", "failed", "blocked", "changes_requested"].includes(
          task.status,
        )
      )
        throw new Error("Task cannot be reassigned in this state");
      if (this.agent(assignee)["role"] !== "worker")
        throw new Error("Assignee must be a worker");
      this.db
        .prepare("UPDATE tasks SET assigned_to=?,updated_at=? WHERE id=?")
        .run(assignee, new Date().toISOString(), id);
      this.event("task.reassigned", actor, id, null, {
        from: task.assigned_to,
        to: assignee,
      });
      return this.show(id);
    });
  }
  eventPage(after = 0, limit = 100, taskId?: string) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("Invalid event cursor or limit");
    const rows = taskId
      ? this.db
          .prepare(
            "SELECT * FROM events WHERE id>? AND task_id=? ORDER BY id LIMIT ?",
          )
          .all(after, taskId, limit + 1)
      : this.db
          .prepare("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?")
          .all(after, limit + 1);
    const events = rows.slice(0, limit);
    return {
      events,
      nextCursor: Number(events.at(-1)?.["id"] ?? after),
      hasMore: rows.length > limit,
    };
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
      schemaVersion: 4,
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
