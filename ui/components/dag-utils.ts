export interface DependencyNode {
  id: string;
  taskId?: string;
  title: string;
  status?: string;
  dependencies?: string[];
  workerRef?: string;
  scope?: string[];
  check?: string[];
  round?: number;
  retries?: number;
  feedback?: string;
}

export interface LayoutNode {
  node: DependencyNode;
  waveIndex: number;
  colIndex: number;
  rowIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  sourceId: string;
  targetId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dash?: boolean;
}

export const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  running: {
    label: "Đang làm",
    color: "#0067c0",
    bg: "rgba(0, 103, 192, 0.08)",
    border: "#0067c0",
  },
  reviewing: {
    label: "Đang review",
    color: "#0284c7",
    bg: "rgba(2, 132, 199, 0.08)",
    border: "#0284c7",
  },
  accepted: {
    label: "Đã nghiệm thu",
    color: "#24613c",
    bg: "rgba(36, 97, 60, 0.08)",
    border: "#24613c",
  },
  blocked: {
    label: "Bị chặn",
    color: "#d97706",
    bg: "rgba(217, 119, 6, 0.08)",
    border: "#d97706",
  },
  failed: {
    label: "Lỗi",
    color: "#ad2838",
    bg: "rgba(173, 40, 56, 0.08)",
    border: "#ad2838",
  },
  changes_requested: {
    label: "Cần sửa",
    color: "#e11d48",
    bg: "rgba(225, 29, 72, 0.08)",
    border: "#e11d48",
  },
  submitted: {
    label: "Đã nộp",
    color: "#7c3aed",
    bg: "rgba(124, 58, 237, 0.08)",
    border: "#7c3aed",
  },
  waiting_permission: {
    label: "Chờ quyền",
    color: "#ea580c",
    bg: "rgba(234, 88, 12, 0.08)",
    border: "#ea580c",
  },
  waiting_input: {
    label: "Chờ input",
    color: "#d97706",
    bg: "rgba(217, 119, 6, 0.08)",
    border: "#d97706",
  },
  queued: {
    label: "Chờ chạy",
    color: "#64748b",
    bg: "rgba(100, 116, 139, 0.08)",
    border: "#94a3b8",
  },
  ready: {
    label: "Sẵn sàng",
    color: "#64748b",
    bg: "rgba(100, 116, 139, 0.08)",
    border: "#94a3b8",
  },
};

export const DEFAULT_STATUS_CONFIG = {
  label: "Chưa bắt đầu",
  color: "#64748b",
  bg: "rgba(100, 116, 139, 0.08)",
  border: "#cbd5e1",
};

export const DAG_LAYOUT_CONFIG = {
  nodeWidth: 210,
  nodeHeight: 74,
  colGap: 64,
  rowGap: 22,
  padX: 28,
  padY: 24,
  headerHeight: 44,
};

/**
 * Computes topological wave groupings for a collection of dependency nodes
 */
export function computeWaves(
  tasks: DependencyNode[],
  explicitWaves?: string[][],
): DependencyNode[][] {
  if (!tasks.length) return [];

  const taskMap = new Map<string, DependencyNode>();
  for (const t of tasks) {
    taskMap.set(t.id, t);
    if (t.taskId && t.taskId !== t.id) {
      taskMap.set(t.taskId, t);
    }
  }

  const columns: DependencyNode[][] = [];

  if (explicitWaves && explicitWaves.length > 0) {
    const placed = new Set<string>();
    for (const waveKeys of explicitWaves) {
      const col: DependencyNode[] = [];
      for (const key of waveKeys) {
        const task = taskMap.get(key);
        if (task && !placed.has(task.id)) {
          col.push(task);
          placed.add(task.id);
        }
      }
      if (col.length > 0) {
        columns.push(col);
      }
    }
    const remaining: DependencyNode[] = [];
    for (const t of tasks) {
      if (!placed.has(t.id)) {
        remaining.push(t);
        placed.add(t.id);
      }
    }
    if (remaining.length > 0) {
      columns.push(remaining);
    }
    return columns;
  }

  // Topological longest path calculation
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const getDepth = (id: string): number => {
    if (visiting.has(id)) return 0; // prevent cycle crash
    if (memo.has(id)) return memo.get(id)!;
    visiting.add(id);
    const task = taskMap.get(id);
    let maxDep = -1;
    if (task && task.dependencies) {
      for (const depId of task.dependencies) {
        if (taskMap.has(depId)) {
          maxDep = Math.max(maxDep, getDepth(depId));
        }
      }
    }
    visiting.delete(id);
    const depth = maxDep + 1;
    memo.set(id, depth);
    return depth;
  };

  const depthBuckets = new Map<number, DependencyNode[]>();
  for (const t of tasks) {
    const depth = getDepth(t.id);
    const list = depthBuckets.get(depth) ?? [];
    list.push(t);
    depthBuckets.set(depth, list);
  }

  const sortedDepths = [...depthBuckets.keys()].sort((a, b) => a - b);
  for (const d of sortedDepths) {
    columns.push(depthBuckets.get(d)!);
  }

  return columns.length > 0 ? columns : [tasks];
}

/**
 * Computes exact 2D layout coordinates and directed Bezier edges
 */
export function computeDagLayout(
  tasks: DependencyNode[],
  explicitWaves?: string[][],
) {
  const columns = computeWaves(tasks, explicitWaves);
  const { nodeWidth, nodeHeight, colGap, rowGap, padX, padY, headerHeight } =
    DAG_LAYOUT_CONFIG;

  if (columns.length === 0) {
    return {
      waveColumns: [] as DependencyNode[][],
      layoutNodes: [] as LayoutNode[],
      layoutEdges: [] as LayoutEdge[],
      svgWidth: 300,
      svgHeight: 160,
    };
  }

  const nodeLayoutMap = new Map<string, LayoutNode>();
  const layoutNodes: LayoutNode[] = [];

  columns.forEach((col, colIndex) => {
    const colX = padX + colIndex * (nodeWidth + colGap);
    col.forEach((node, rowIndex) => {
      const nodeY = padY + headerHeight + rowIndex * (nodeHeight + rowGap);
      const layoutNode: LayoutNode = {
        node,
        waveIndex: colIndex,
        colIndex,
        rowIndex,
        x: colX,
        y: nodeY,
        width: nodeWidth,
        height: nodeHeight,
      };
      layoutNodes.push(layoutNode);
      nodeLayoutMap.set(node.id, layoutNode);
      if (node.taskId && node.taskId !== node.id) {
        nodeLayoutMap.set(node.taskId, layoutNode);
      }
    });
  });

  const layoutEdges: LayoutEdge[] = [];
  const edgeKeySet = new Set<string>();

  for (const targetNode of layoutNodes) {
    const deps = targetNode.node.dependencies ?? [];
    for (const depId of deps) {
      const sourceNode = nodeLayoutMap.get(depId);
      if (!sourceNode) continue;

      const edgeKey = `${sourceNode.node.id}->${targetNode.node.id}`;
      if (edgeKeySet.has(edgeKey)) continue;
      edgeKeySet.add(edgeKey);

      const x1 = sourceNode.x + sourceNode.width;
      const y1 = sourceNode.y + sourceNode.height / 2;
      const x2 = targetNode.x;
      const y2 = targetNode.y + targetNode.height / 2;

      const sStatus = sourceNode.node.status ?? "";
      const tStatus = targetNode.node.status ?? "";

      let color = "#94a3b8";
      let dash = false;
      if (sStatus === "accepted" && tStatus === "accepted") {
        color = "#24613c";
      } else if (sStatus === "accepted" && tStatus === "running") {
        color = "#0067c0";
        dash = true;
      } else if (tStatus === "running") {
        color = "#0067c0";
      } else if (sStatus === "blocked" || tStatus === "blocked") {
        color = "#d97706";
      } else if (
        sStatus === "failed" ||
        tStatus === "failed" ||
        tStatus === "changes_requested"
      ) {
        color = "#ad2838";
      }

      layoutEdges.push({
        id: edgeKey,
        sourceId: sourceNode.node.id,
        targetId: targetNode.node.id,
        x1,
        y1,
        x2,
        y2,
        color,
        dash,
      });
    }
  }

  const maxRows = Math.max(...columns.map((c) => c.length), 1);
  const svgWidth =
    padX * 2 +
    columns.length * nodeWidth +
    Math.max(0, columns.length - 1) * colGap;
  const svgHeight =
    padY * 2 + headerHeight + maxRows * (nodeHeight + rowGap) - rowGap;

  return {
    waveColumns: columns,
    layoutNodes,
    layoutEdges,
    svgWidth,
    svgHeight,
  };
}
