import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, buildSplitRows } from "../ui/components/diff-utils.ts";
import { computeWaves, computeDagLayout } from "../ui/components/dag-utils.ts";

test("diff-utils: parseDiff handles empty or whitespace input", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("   \n  \n"), []);
});

test("diff-utils: parseDiff parses standard git unified diff with additions, deletions and context", () => {
  const sampleDiff = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcdef 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,5 +10,6 @@ function run() {
   const a = 1;
-  const b = 2;
+  const b = 20;
+  const c = 30;
   return a + b;
 }`;

  const files = parseDiff(sampleDiff);
  assert.equal(files.length, 1);
  const file = files[0];
  assert.equal(file.oldPath, "src/app.ts");
  assert.equal(file.newPath, "src/app.ts");
  assert.equal(file.displayPath, "src/app.ts");
  assert.equal(file.status, "modified");
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);

  const hunk = file.hunks[0];
  assert.equal(hunk.oldStart, 10);
  assert.equal(hunk.newStart, 10);
  assert.equal(hunk.heading, "function run() {");

  // Verify line numbers in hunk
  const context1 = hunk.lines[0];
  assert.equal(context1.type, "context");
  assert.equal(context1.oldLineNumber, 10);
  assert.equal(context1.newLineNumber, 10);

  const del = hunk.lines[1];
  assert.equal(del.type, "deletion");
  assert.equal(del.text, "  const b = 2;");
  assert.equal(del.oldLineNumber, 11);
  assert.equal(del.newLineNumber, undefined);

  const add1 = hunk.lines[2];
  assert.equal(add1.type, "addition");
  assert.equal(add1.text, "  const b = 20;");
  assert.equal(add1.oldLineNumber, undefined);
  assert.equal(add1.newLineNumber, 11);

  const add2 = hunk.lines[3];
  assert.equal(add2.type, "addition");
  assert.equal(add2.newLineNumber, 12);
});

test("diff-utils: parseDiff identifies added, deleted, renamed and binary files", () => {
  const multiDiff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/deleted-file.ts b/deleted-file.ts
deleted file mode 100644
--- a/deleted-file.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const old = 1;
-const dead = 2;
diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ`;

  const files = parseDiff(multiDiff);
  assert.equal(files.length, 4);

  assert.equal(files[0].status, "added");
  assert.equal(files[0].displayPath, "new-file.ts");
  assert.equal(files[0].additions, 2);

  assert.equal(files[1].status, "deleted");
  assert.equal(files[1].displayPath, "deleted-file.ts");
  assert.equal(files[1].deletions, 2);

  assert.equal(files[2].status, "renamed");
  assert.equal(files[2].oldPath, "old-name.ts");
  assert.equal(files[2].newPath, "new-name.ts");
  assert.equal(files[2].displayPath, "new-name.ts");

  assert.equal(files[3].isBinary, true);
  assert.equal(files[3].displayPath, "logo.png");
});

test("diff-utils: buildSplitRows aligns deletions and additions side-by-side with padding", () => {
  const hunk = {
    header: "@@ -1,3 +1,4 @@",
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 4,
    lines: [
      { type: "context", text: "line 1", oldLineNumber: 1, newLineNumber: 1 },
      { type: "deletion", text: "line 2 old", oldLineNumber: 2 },
      { type: "addition", text: "line 2 new", newLineNumber: 2 },
      { type: "addition", text: "line 2.5 extra", newLineNumber: 3 },
      { type: "context", text: "line 3", oldLineNumber: 3, newLineNumber: 4 },
    ],
  };

  const rows = buildSplitRows(hunk);

  // Row 0: Hunk header
  assert.equal(rows[0].type, "hunk-header");
  assert.equal(rows[0].hunkHeader, "@@ -1,3 +1,4 @@");

  // Row 1: Context line 1 on both sides
  assert.equal(rows[1].type, "line");
  assert.equal(rows[1].left.type, "context");
  assert.equal(rows[1].left.lineNumber, 1);
  assert.equal(rows[1].right.type, "context");
  assert.equal(rows[1].right.lineNumber, 1);

  // Row 2: Aligned replacement (deletion on left, addition on right)
  assert.equal(rows[2].left.type, "deletion");
  assert.equal(rows[2].left.text, "line 2 old");
  assert.equal(rows[2].left.lineNumber, 2);
  assert.equal(rows[2].right.type, "addition");
  assert.equal(rows[2].right.text, "line 2 new");
  assert.equal(rows[2].right.lineNumber, 2);

  // Row 3: Padded addition on right (empty on left)
  assert.equal(rows[3].left.type, "empty");
  assert.equal(rows[3].right.type, "addition");
  assert.equal(rows[3].right.text, "line 2.5 extra");
  assert.equal(rows[3].right.lineNumber, 3);

  // Row 4: Context line 3 on both sides
  assert.equal(rows[4].left.type, "context");
  assert.equal(rows[4].left.lineNumber, 3);
  assert.equal(rows[4].right.type, "context");
  assert.equal(rows[4].right.lineNumber, 4);
});

test("dag-utils: computeWaves groups tasks into parallel wave columns", () => {
  // Empty
  assert.deepEqual(computeWaves([]), []);

  // Parallel tasks with no dependencies -> Wave 0
  const parallelTasks = [
    { id: "task-1", title: "Task 1" },
    { id: "task-2", title: "Task 2" },
  ];
  const parallelWaves = computeWaves(parallelTasks);
  assert.equal(parallelWaves.length, 1);
  assert.equal(parallelWaves[0].length, 2);

  // Linear chain: T1 -> T2 -> T3
  const chainTasks = [
    { id: "t1", title: "T1" },
    { id: "t2", title: "T2", dependencies: ["t1"] },
    { id: "t3", title: "T3", dependencies: ["t2"] },
  ];
  const chainWaves = computeWaves(chainTasks);
  assert.equal(chainWaves.length, 3);
  assert.equal(chainWaves[0][0].id, "t1");
  assert.equal(chainWaves[1][0].id, "t2");
  assert.equal(chainWaves[2][0].id, "t3");

  // Diamond dependency:
  //      T1
  //     /  \
  //   T2    T3
  //     \  /
  //      T4
  const diamondTasks = [
    { id: "t1", title: "T1" },
    { id: "t2", title: "T2", dependencies: ["t1"] },
    { id: "t3", title: "T3", dependencies: ["t1"] },
    { id: "t4", title: "T4", dependencies: ["t2", "t3"] },
  ];
  const diamondWaves = computeWaves(diamondTasks);
  assert.equal(diamondWaves.length, 3);
  assert.equal(diamondWaves[0].length, 1); // t1 in Wave 1
  assert.equal(diamondWaves[1].length, 2); // t2, t3 in Wave 2
  assert.equal(diamondWaves[2].length, 1); // t4 in Wave 3
  assert.equal(diamondWaves[2][0].id, "t4");

  // Explicit waves respected
  const explicit = computeWaves(diamondTasks, [["t1", "t2"], ["t3", "t4"]]);
  assert.equal(explicit.length, 2);
  assert.deepEqual(explicit[0].map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(explicit[1].map((t) => t.id), ["t3", "t4"]);
});

test("dag-utils: computeDagLayout computes valid 2D coordinates and directed edges", () => {
  const tasks = [
    { id: "step-a", title: "Step A", status: "accepted" },
    { id: "step-b", title: "Step B", status: "running", dependencies: ["step-a"] },
    { id: "step-c", title: "Step C", status: "queued", dependencies: ["step-a"] },
  ];

  const layout = computeDagLayout(tasks);
  assert.equal(layout.waveColumns.length, 2);
  assert.equal(layout.layoutNodes.length, 3);
  assert.equal(layout.layoutEdges.length, 2);
  assert.ok(layout.svgWidth > 400);
  assert.ok(layout.svgHeight > 100);

  // Check coordinates
  const nodeA = layout.layoutNodes.find((n) => n.node.id === "step-a");
  const nodeB = layout.layoutNodes.find((n) => n.node.id === "step-b");
  assert.ok(nodeA);
  assert.ok(nodeB);
  assert.ok(nodeB.x > nodeA.x, "Step B column must be to the right of Step A");

  // Check edge connecting A to B
  const edgeAB = layout.layoutEdges.find(
    (e) => e.sourceId === "step-a" && e.targetId === "step-b",
  );
  assert.ok(edgeAB);
  assert.equal(edgeAB.x1, nodeA.x + nodeA.width);
  assert.equal(edgeAB.x2, nodeB.x);
  assert.equal(edgeAB.color, "#0067c0"); // Accepted -> Running edge color
  assert.equal(edgeAB.dash, true);
});
