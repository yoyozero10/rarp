import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
export function canonicalPath(path: string) {
  // Native Windows resolution expands 8.3 names used by hosted-runner TEMP paths.
  const normalized = resolve(realpathSync.native(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
export interface Workspace {
  taskId: string;
  path: string;
  base: string;
  commit: string | null;
  scope: string[];
  check: string[];
  integrated: string | null;
  integrationEvidence?: string;
}
export function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
export function validateScope(scope: string[]) {
  if (!scope.length)
    throw new Error("Isolated workflows require explicit file scope");
  for (const p of scope)
    if (
      !p ||
      isAbsolute(p) ||
      p.includes("\\") ||
      p
        .split("/")
        .some(
          (s) =>
            s === ".." ||
            s === "." ||
            s === ".git" ||
            s === ".rarp" ||
            s === "",
        ) ||
      p.startsWith("-")
    )
      throw new Error(
        "Scope must contain safe repository-relative files/directories",
      );
}
export function prepareWorkspace(
  root: string,
  taskId: string,
  scope: string[],
  check: string[],
): Workspace {
  validateScope(scope);
  if (!check.length) throw new Error("A verification command is required");
  if (
    canonicalPath(git(root, "rev-parse", "--show-toplevel")) !==
    canonicalPath(root)
  )
    throw new Error("Use the Git repository root");
  if (git(root, "status", "--porcelain"))
    throw new Error("Main checkout must be clean");
  const base = git(root, "rev-parse", "HEAD");
  const path = join(root, ".rarp", "worktrees", taskId);
  if (existsSync(path))
    throw new Error("Workspace already exists; inspect it before recovery");
  git(root, "worktree", "add", "--detach", path, base);
  return { taskId, path, base, commit: null, scope, check, integrated: null };
}
export function checkpoint(workspace: Workspace) {
  git(workspace.path, "add", "--all");
  const paths = execFileSync(
    "git",
    [
      "-C",
      workspace.path,
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      workspace.base,
    ],
    { encoding: "utf8", windowsHide: true },
  )
    .split("\0")
    .filter(Boolean);
  for (const p of paths)
    if (!workspace.scope.some((s) => p === s || p.startsWith(s + "/")))
      throw new Error(`File outside task scope: ${p}`);
  if (git(workspace.path, "diff", "--cached", "--name-only"))
    git(
      workspace.path,
      "-c",
      "user.name=Rarp",
      "-c",
      "user.email=rarp@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      `Rarp task ${workspace.taskId}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
    );
  workspace.commit = git(workspace.path, "rev-parse", "HEAD");
  return workspace;
}
export function verifyWorkspace(workspace: Workspace) {
  const result = spawnSync(workspace.check[0]!, workspace.check.slice(1), {
    cwd: workspace.path,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  const output = ((result.stdout ?? "") + (result.stderr ?? "")).slice(-16000);
  if (result.error || result.status !== 0)
    throw new Error(
      `Verification failed: ${result.error?.message ?? result.status}\n${output}`,
    );
  if (git(workspace.path, "status", "--porcelain"))
    throw new Error("Verification changed workspace files");
  return output || "Verification command passed";
}
interface IntegrationPlan {
  before: string;
  path: string;
  commit: string;
  done?: string;
}
function planIntegration(root: string, workspace: Workspace): IntegrationPlan {
  if (!workspace.commit) throw new Error("No reviewed commit");
  const before = git(root, "rev-parse", "HEAD");
  if (workspace.integrated) {
    git(root, "merge-base", "--is-ancestor", workspace.integrated, "HEAD");
    return { before, path: root, commit: before, done: workspace.integrated };
  }
  if (git(root, "status", "--porcelain"))
    throw new Error("Main checkout must be clean");
  const ancestor = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", workspace.commit, "HEAD"],
    { windowsHide: true },
  );
  if (ancestor.status === 0) return { before, path: root, commit: before };
  const path = join(root, ".rarp", "integrations", workspace.taskId);
  if (existsSync(path)) {
    if (git(path, "status", "--porcelain"))
      throw new Error(
        "Integration conflict/edits remain; inspect and resolve in integration workspace",
      );
    git(path, "merge-base", "--is-ancestor", before, "HEAD");
    git(path, "merge-base", "--is-ancestor", workspace.commit, "HEAD");
  } else {
    git(root, "worktree", "add", "--detach", path, before);
    // Conflicts stay outside the main checkout for explicit inspection/resolution.
    git(
      path,
      "-c",
      "user.name=Rarp",
      "-c",
      "user.email=rarp@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "-m",
      `Integrate Rarp task ${workspace.taskId}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
      workspace.commit,
    );
  }
  return { before, path, commit: git(path, "rev-parse", "HEAD") };
}
function finishIntegration(root: string, plan: IntegrationPlan) {
  if (
    git(root, "rev-parse", "HEAD") !== plan.before ||
    git(root, "status", "--porcelain")
  )
    throw new Error("Main checkout changed during integration");
  if (
    git(plan.path, "rev-parse", "HEAD") !== plan.commit ||
    git(plan.path, "status", "--porcelain")
  )
    throw new Error("Integration workspace changed during verification");
  if (plan.path !== root)
    git(
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--ff-only",
      plan.commit,
    );
  return plan.commit;
}
export function integrateWorkspace(root: string, workspace: Workspace) {
  const plan = planIntegration(root, workspace);
  if (plan.done) return plan.done;
  workspace.integrationEvidence = verifyWorkspace({
    ...workspace,
    path: plan.path,
  });
  return finishIntegration(root, plan);
}
export async function integrateWorkspaceAsync(
  root: string,
  workspace: Workspace,
  verify: (workspace: Workspace) => Promise<string>,
) {
  const plan = planIntegration(root, workspace);
  if (plan.done) return plan.done;
  workspace.integrationEvidence = await verify({
    ...workspace,
    path: plan.path,
  });
  return finishIntegration(root, plan);
}
