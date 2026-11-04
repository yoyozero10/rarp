# Rarp

Local multi-agent orchestration runtime and command-line interface (CLI) for autonomous software engineering workflows. Rarp coordinates goal-driven task decomposition, isolated execution via Git worktrees, automated verification checks, structured review loops, and atomic integration into target repositories.

---

## Table of Contents

- [Architectural Overview](#architectural-overview)
- [Core Capabilities](#core-capabilities)
- [System Requirements](#system-requirements)
- [Packaging and Installation](#packaging-and-installation)
- [Quick Start Guide](#quick-start-guide)
- [Detailed Operational Workflows](#detailed-operational-workflows)
  - [1. Goal-Driven Planning and Explicit Approval](#1-goal-driven-planning-and-explicit-approval)
  - [2. Multi-Agent Scheduling and Queue Management](#2-multi-agent-scheduling-and-queue-management)
  - [3. Environment Isolation and Atomic Integration](#3-environment-isolation-and-atomic-integration)
  - [4. Crash Recovery and State Leases](#4-crash-recovery-and-state-leases)
- [CLI Reference](#cli-reference)
  - [Diagnostics and Metadata](#diagnostics-and-metadata)
  - [Runtime Daemon Management](#runtime-daemon-management)
  - [Goals and Plans](#goals-and-plans)
  - [Tasks and Workflows](#tasks-and-workflows)
- [Security and Access Control](#security-and-access-control)
- [Development and Verification](#development-and-verification)
- [License](#license)

---

## Architectural Overview

Rarp is implemented in TypeScript on Node.js, establishing a strict boundary between user presentation, central orchestration, and worker agents:

```text
[CLI / Web UI] 
      |
      v (HTTP / SSE / Token Authentication over 127.0.0.1)
[Runtime Daemon] <-------------------> [SQLite State Store (node:sqlite)]
      |                                  - Task state machine
      +---> [Planner / Manager]          - Event sourcing journal
      |       (Read-only Sandbox)        - Locks & Scheduler queue
      |
      +---> [Scheduler Engine]
              |
              +---> [Worker 1] (Git Worktree A) ---> Verification Checks
              |
              +---> [Worker 2] (Git Worktree B) ---> Verification Checks
              |
              v
       [Reviewer Loop] ---> [Atomic Integration Worker] ---> Main Branch
```

- **Runtime Daemon**: A standalone background process managing task lifecycles, execution scheduling, and real-time event streams.
- **Persistent State Store**: Employs Node.js native `node:sqlite` operating in Write-Ahead Logging (WAL) mode with strict transactional guarantees.
- **Autonomous Agents**: Interfaces with Codex CLI and Antigravity CLI adapters, enforcing subprocess tree supervision, process group termination, and configurable execution timeouts.

---

## Core Capabilities

- **Goal-Driven Planning**: Planner agents inspect the target codebase within a read-only sandbox, proposing structured task lists, dependency DAGs, parallel execution waves, and deterministic verification commands.
- **Explicit Plan Approval**: All generated plans require explicit operator confirmation regarding worker allocation, review iteration bounds, and permission scopes before workspace mutations can occur.
- **Complete Git Worktree Isolation**: Each task is dispatched to an isolated Git worktree. The primary working tree remains untouched until all verification checks and code reviews have passed.
- **Concurrent Scheduler**: Supports 1 to 16 parallel worker slots with a dedicated cap on concurrent reviewer agents. Automatically prevents file-scope overlap and race conditions between tasks.
- **Automated Review & Repair Loop**: Reviewer agents inspect candidate patches against acceptance criteria and test output, returning structured JSON feedback. Tasks failing review are routed back to workers for iterative remediation within approved round budgets.
- **Human-in-the-Loop Clarification**: Supports the `waiting_input` state when an agent requires specification disambiguation, enabling operators to answer via CLI or Web UI without terminating the plan.
- **Atomic Integration Worker**: Replays candidate branches into a dedicated integration worktree, executes the full test suite across the combined state, and fast-forwards the main branch only upon total test success.
- **Embedded Web Dashboard**: Embedded React dashboard connecting via Server-Sent Events (SSE) to deliver real-time dependency graphs, queue states, and execution logs.

---

## System Requirements

- **Node.js**: Version 24.0.0 or higher (requiring native `node:sqlite` support).
- **Git**: Installed and available in `PATH`. Target repositories must contain at least one initial commit and a clean working tree.
- **Agent CLI Adapters**: At least one authenticated CLI installed:
  - **Codex CLI**: Supporting `--no-daemon`, `exec --json`, and `--ephemeral`.
  - **Antigravity CLI (`agy`)**: Configured with valid local credentials.
- **Operating System**: Windows 10/11, Linux, or macOS.

---

## Packaging and Installation

### Building from Source

From the root of the Rarp source repository:

```sh
npm ci
npm pack
```

The `npm pack` command triggers `prepack` to compile TypeScript source files and bundle assets into `rarp-0.1.0.tgz`. The published tarball contains exclusively compiled artifacts, the web UI bundle, JSON schemas, and documentation.

### Global Installation

Install the compiled tarball globally:

```sh
npm install --global ./rarp-0.1.0.tgz
```

Verify the installation:

```sh
rarp --version
```

### Environment Diagnostics via `rarp doctor`

Verify system prerequisites and CLI adapter availability:

```sh
rarp --project "C:\path\to\target-repo" doctor
```

Available flags:
- `--codex <path>`: Custom binary path for Codex CLI.
- `--agy <path>`: Custom binary path for Antigravity CLI.
- `--manager-profile <name>`: Configuration profile for Planner and Reviewer agents.
- `--json`: Output results in structured JSON for automation pipelines.

Note: `rarp doctor` is strictly read-only. It executes no modifications, performs no billable model invocations, and grants no elevated permissions.

---

## Quick Start Guide

### Step 1: Initialize the Target Repository

```sh
rarp --project "C:\path\to\target-repo" init
```

Initializes the `.rarp` directory and creates the local SQLite database. Append `.rarp/` to the target repository's `.gitignore`.

### Step 2: Start the Runtime Daemon

Start the background daemon process:

```sh
rarp --project "C:\path\to\target-repo" runtime start --max-workers 2 --max-reviewers 1
```

To configure a dedicated manager profile (e.g., custom model routing):

```sh
rarp --project "C:\path\to\target-repo" runtime start --manager-profile custom-router --max-workers 2 --max-reviewers 1
```

### Step 3: Launch the Web Dashboard

Retrieve the local dashboard access URL:

```sh
rarp --project "C:\path\to\target-repo" ui
```

Open the generated loopback URL (`http://127.0.0.1:<port>/ui/#token=<token>`) in a browser. The session token is securely preserved in browser `sessionStorage`.

### Step 4: Plan and Execute a Goal

1. Open the Web Dashboard and navigate to the **Goals & Plans** view.
2. Provide a concrete objective, technical constraints, and acceptance criteria.
3. Click **Request Analysis**. The Planner agent will inspect the codebase in read-only mode and draft a structured plan.
4. Review the generated task breakdown, file write scopes, dependency waves, and automated verification commands.
5. Select the worker adapter (Codex or Antigravity), configure retry budgets, and click **Approve & Run**.

---

## Detailed Operational Workflows

### 1. Goal-Driven Planning and Explicit Approval

- **Read-Only Sandbox**: Codebase discovery during the planning phase is executed strictly within a read-only environment. Planner agents cannot alter files or execute stateful commands prior to operator approval.
- **Plan Revisions**: Any updates to goals, task scopes, or allocation parameters produce an immutable plan revision tagged with a content hash.
- **Human Input Handling (`waiting_input`)**: If an agent encounters ambiguous requirements, it raises a `rarp_input` question. Execution pauses and enters the `waiting_input` state. Operators can answer directly via the Web UI or CLI:
  ```sh
  rarp --project "C:\path\to\target-repo" plan answer PLAN_ID --file answer.json
  rarp --project "C:\path\to\target-repo" plan resume PLAN_ID
  ```
  The `answer.json` payload requires `{ taskId, requestId, answer }`.

### 2. Multi-Agent Scheduling and Queue Management

- **Execution Slots**: The `--max-workers` flag sets the concurrent task allocation limit (1 to 16). Each slot tracks the complete lifecycle: assignment, execution, local checks, review, and acceptance.
- **Reviewer Throttling**: The `--max-reviewers` flag bounds concurrent evaluation sessions to avoid upstream provider rate limits.
- **Scope Overlap Prevention**: Tasks targeting overlapping directory or file paths are prevented from running concurrently. Subsequent tasks queue automatically until active file scopes are released.
- **Dependency Enforcement**: Dependent tasks remain queued until prerequisite tasks achieve `accepted` status and integrate cleanly into the repository.

### 3. Environment Isolation and Atomic Integration

- **Dedicated Git Worktrees**: Every task executes within an independent Git worktree branched from the latest main commit.
- **Automated Verification**: Once a worker commits candidate code, the runtime executes configured verification commands (e.g., `npm test`, `npm run build`) in the worktree.
- **Independent Review**: Reviewer agents evaluate git diffs and test logs against acceptance criteria. Upon verification, the task is marked `accepted`.
- **Sequential Integration**:
  ```sh
  rarp --project "C:\path\to\target-repo" task integrate TASK_ID
  ```
  The runtime merges candidate branches into an ephemeral integration worktree, replays the target project's full test suite, and fast-forwards the main branch upon confirmation.

### 4. Crash Recovery and State Leases

- **Heartbeat Lease**: The active daemon maintains a 15-second heartbeat lease in SQLite.
- **Recovery After Unexpected Termination**: If host processes terminate abruptly due to crash or power loss:
  ```sh
  rarp --project "C:\path\to\target-repo" runtime recover
  rarp --project "C:\path\to\target-repo" runtime start
  ```
- **Task State Reconciliation**: The `recover` command reconciles unfinished tasks to `interrupted` or `failed` while preserving completed worktrees and `accepted` states. The scheduler boots into a paused state to permit operator review before calling `resume`.

---

## CLI Reference

All commands accept global flags `--project <path>` (defaults to current working directory) and `--json` (structured output for automation).

### Diagnostics and Metadata

| Command | Description |
| :--- | :--- |
| `rarp doctor` | Performs comprehensive, read-only diagnostic checks on prerequisites and adapters. |
| `rarp about` | Displays version information and supported capabilities. |
| `rarp status` | Summarizes database connectivity, plan states, and active task counts. |
| `rarp events [--after <id>]` | Queries the event sourcing journal with cursor-based pagination. |

### Runtime Daemon Management

| Command | Description |
| :--- | :--- |
| `rarp runtime start` | Launches the runtime daemon (`--max-workers`, `--max-reviewers`, `--manager-profile`, `--codex`, `--agy`). |
| `rarp runtime status` | Inspects daemon health, active worker slots, and scheduler queues. |
| `rarp runtime stop` | Gracefully shuts down the daemon and terminates managed worker process trees. |
| `rarp runtime pause` | Pauses scheduler dispatch of pending tasks. |
| `rarp runtime resume` | Resumes task dispatch in the scheduler. |
| `rarp runtime recover` | Reconciles dangling task states and stale locks after unexpected process terminations. |
| `rarp runtime queue` | Lists active orchestrations and queued tasks. |
| `rarp runtime cancel [--task <id>]` | Cancels a specific task or aborts all pending work. |
| `rarp ui` | Emits the Web Dashboard access URL with embedded authentication token. |

### Goals and Plans

| Command | Description |
| :--- | :--- |
| `rarp goal create --file <path>` | Creates a new high-level objective from a JSON specification. |
| `rarp goal list` | Lists all registered goals. |
| `rarp goal show <id>` | Displays the detailed specification of a goal. |
| `rarp plan list` | Lists all execution plans across revisions. |
| `rarp plan show <id>` | Inspects the task DAG, waves, and validation rules of a plan. |
| `rarp plan analyze <id>` | Triggers read-only agent analysis to decompose a goal into a plan. |
| `rarp plan approve <id> [--file <path>]` | Approves a plan and sets execution allocation parameters. |
| `rarp plan reject <id>` | Rejects a drafted plan revision. |
| `rarp plan pause <id>` | Suspends execution of an active plan. |
| `rarp plan resume <id>` | Resumes a suspended plan. |
| `rarp plan answer <id> --file <path>` | Submits operator answers to a worker agent's clarification request. |

### Tasks and Workflows

| Command | Description |
| :--- | :--- |
| `rarp task create` | Manually constructs a task (`--title`, `--actor`, `--assignee`, `--body`, `--depends-on`). |
| `rarp task list [--status <name>]` | Lists tasks with optional status filtering. |
| `rarp task show <id>` | Inspects task metadata, execution history, and review verdicts. |
| `rarp task workspace <id>` | Outputs the absolute path to the task's isolated Git worktree. |
| `rarp task integrate <id>` | Integrates an accepted task branch into the main branch. |
| `rarp workflow run <taskId>` | Executes an ad-hoc isolated workflow (`--isolated`, `--adapter`, `--scope`, `--check-json`, `--max-rounds`). |

---

## Security and Access Control

1. **Loopback Binding & Token Authentication**:
   - The Runtime Daemon binds strictly to `127.0.0.1`.
   - External networking is disabled. All HTTP and SSE endpoints require bearer tokens generated ephemerally at daemon startup.
2. **Planner and Reviewer Sandboxing**:
   - Planner and Reviewer agents execute under strict read-only sandbox configurations.
   - Shell command execution and file write operations are prohibited during planning and review phases.
3. **Worker Execution Boundaries**:
   - Worker agents run within standard tool sandbox boundaries by default.
   - For Antigravity CLI, elevated execution flags (`--dangerously-skip-permissions`) are passed only if explicitly approved by the human operator during plan review.
4. **Credential Isolation**:
   - Rarp state databases and event logs do not store API keys or user passwords.
   - Agents inherit authenticated session contexts from the host system's existing CLI profiles.

---

## Development and Verification

### Setting Up Development Environment

```sh
git clone https://github.com/yoyozero10/rarp.git
cd rarp
npm ci
```

### Verification Scripts

Run static type checking:
```sh
npm run typecheck
```

Compile TypeScript source files:
```sh
npm run build
```

Run unit and integration test suites:
```sh
npm test
```

Execute end-to-end package verification in an isolated temporary environment:
```sh
npm run test:package
```

The `test:package` script packages the build, installs it into an isolated temporary directory, initializes a clean runtime instance, and verifies the full Planner -> Worker -> Review -> Integration cycle against mock fixtures.

---

## License

This project is licensed under the MIT License.
