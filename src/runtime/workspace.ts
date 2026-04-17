import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
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
    realpathSync(git(root, "rev-parse", "--show-toplevel")).toLowerCase() !==
    realpathSync(root).toLowerCase()
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
export function integrateWorkspace(root: string, workspace: Workspace) {
  if (!workspace.commit) throw new Error("No reviewed commit");
  if (workspace.integrated) {
    git(root, "merge-base", "--is-ancestor", workspace.integrated, "HEAD");
    return workspace.integrated;
  }
  if (git(root, "status", "--porcelain"))
    throw new Error("Main checkout must be clean");
  // Recovery after a fast-forward but before the database update must not merge twice.
  const ancestor = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", workspace.commit, "HEAD"],
    { windowsHide: true },
  );
  if (ancestor.status === 0) {
    workspace.integrationEvidence = verifyWorkspace({
      ...workspace,
      path: root,
    });
    return git(root, "rev-parse", "HEAD");
  }
  const before = git(root, "rev-parse", "HEAD");
  const target = join(root, ".rarp", "integrations", workspace.taskId);
  if (existsSync(target)) {
    if (git(target, "status", "--porcelain"))
      throw new Error(
        "Integration conflict/edits remain; inspect and resolve in integration workspace",
      );
    git(target, "merge-base", "--is-ancestor", before, "HEAD");
    git(target, "merge-base", "--is-ancestor", workspace.commit, "HEAD");
  } else {
    git(root, "worktree", "add", "--detach", target, before);
    // Conflicts remain in this isolated directory, leaving the main checkout unchanged.
    git(
      target,
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
  workspace.integrationEvidence = verifyWorkspace({
    ...workspace,
    path: target,
  });
  const merged = git(target, "rev-parse", "HEAD");
  if (
    git(root, "rev-parse", "HEAD") !== before ||
    git(root, "status", "--porcelain")
  )
    throw new Error("Main checkout changed during integration");
  git(root, "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", merged);
  return merged;
}
