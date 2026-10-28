export type DiffLineType = "context" | "addition" | "deletion" | "eof";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  heading?: string;
  lines: DiffLine[];
}

export interface DiffFile {
  id: string;
  oldPath: string;
  newPath: string;
  displayPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary?: boolean;
}

export interface SplitRow {
  type: "hunk-header" | "line";
  hunkHeader?: string;
  left?: {
    lineNumber?: number;
    type: "context" | "deletion" | "empty" | "eof";
    text: string;
  };
  right?: {
    lineNumber?: number;
    type: "context" | "addition" | "empty" | "eof";
    text: string;
  };
}

/**
 * Robust parser for git unified diff output
 */
export function parseDiff(rawDiff: string): DiffFile[] {
  if (!rawDiff || !rawDiff.trim()) return [];

  const files: DiffFile[] = [];
  const lines = rawDiff.split("\n");

  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentOldLine = 0;
  let currentNewLine = 0;
  let fileIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("diff --git ")) {
      // Start of a new file diff
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        files.push(currentFile);
      }

      fileIndex++;
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const oldPath = match ? match[1]! : "";
      const newPath = match ? match[2]! : "";

      currentFile = {
        id: `file-${fileIndex}`,
        oldPath,
        newPath,
        displayPath: newPath || oldPath || `file-${fileIndex}`,
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!currentFile) {
      // Handle diff that does not start with "diff --git"
      if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
        currentFile = {
          id: `file-${fileIndex++}`,
          oldPath: "changes",
          newPath: "changes",
          displayPath: "Thay đổi",
          status: "modified",
          additions: 0,
          deletions: 0,
          hunks: [],
        };
      } else {
        continue;
      }
    }

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      currentFile.status = "renamed";
      currentFile.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.newPath = line.slice("rename to ".length);
      currentFile.displayPath = currentFile.newPath;
      continue;
    }
    if (line.startsWith("Binary files ") && line.includes("differ")) {
      currentFile.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // File header lines (--- a/... or +++ b/...)
      if (line.startsWith("--- /dev/null")) {
        currentFile.status = "added";
      } else if (line.startsWith("+++ /dev/null")) {
        currentFile.status = "deleted";
      }
      continue;
    }
    if (line.startsWith("index ")) {
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ heading
    if (line.startsWith("@@")) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
      if (match) {
        const oldStart = parseInt(match[1]!, 10);
        const oldCount = match[2] !== undefined ? parseInt(match[2]!, 10) : 1;
        const newStart = parseInt(match[3]!, 10);
        const newCount = match[4] !== undefined ? parseInt(match[4]!, 10) : 1;
        const heading = match[5]?.trim();

        currentOldLine = oldStart;
        currentNewLine = newStart;

        currentHunk = {
          header: line,
          oldStart,
          oldCount,
          newStart,
          newCount,
          heading,
          lines: [],
        };
      }
      continue;
    }

    if (!currentHunk) continue;

    // Process hunk content lines
    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "addition",
        text: line.slice(1),
        newLineNumber: currentNewLine++,
      });
      currentFile.additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "deletion",
        text: line.slice(1),
        oldLineNumber: currentOldLine++,
      });
      currentFile.deletions++;
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({
        type: "eof",
        text: line,
      });
    } else {
      // Context line (starts with ' ' or empty)
      const text = line.startsWith(" ") ? line.slice(1) : line;
      currentHunk.lines.push({
        type: "context",
        text,
        oldLineNumber: currentOldLine++,
        newLineNumber: currentNewLine++,
      });
    }
  }

  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Builds side-by-side rows for a hunk, aligning deletions and additions
 */
export function buildSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [
    {
      type: "hunk-header",
      hunkHeader: hunk.header,
    },
  ];

  let delBuf: DiffLine[] = [];
  let addBuf: DiffLine[] = [];

  const flushChanges = () => {
    const count = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < count; i++) {
      const del = delBuf[i];
      const add = addBuf[i];

      rows.push({
        type: "line",
        left: del
          ? {
              lineNumber: del.oldLineNumber,
              type: "deletion",
              text: del.text,
            }
          : {
              type: "empty",
              text: "",
            },
        right: add
          ? {
              lineNumber: add.newLineNumber,
              type: "addition",
              text: add.text,
            }
          : {
              type: "empty",
              text: "",
            },
      });
    }
    delBuf = [];
    addBuf = [];
  };

  for (const line of hunk.lines) {
    if (line.type === "deletion") {
      delBuf.push(line);
    } else if (line.type === "addition") {
      addBuf.push(line);
    } else if (line.type === "context") {
      flushChanges();
      rows.push({
        type: "line",
        left: {
          lineNumber: line.oldLineNumber,
          type: "context",
          text: line.text,
        },
        right: {
          lineNumber: line.newLineNumber,
          type: "context",
          text: line.text,
        },
      });
    } else if (line.type === "eof") {
      flushChanges();
      rows.push({
        type: "line",
        left: { type: "eof", text: line.text },
        right: { type: "eof", text: line.text },
      });
    }
  }

  flushChanges();
  return rows;
}
