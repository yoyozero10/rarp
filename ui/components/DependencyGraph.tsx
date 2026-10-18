import React, { useId, useMemo } from "react";
import {
  computeDagLayout,
  computeWaves,
  STATUS_CONFIG,
  DEFAULT_STATUS_CONFIG,
  type DependencyNode,
  type LayoutNode,
  type LayoutEdge,
} from "./dag-utils";

export { computeDagLayout, computeWaves, STATUS_CONFIG, DEFAULT_STATUS_CONFIG };
export type { DependencyNode, LayoutNode, LayoutEdge };

export interface DependencyGraphProps {
  tasks?: DependencyNode[];
  waves?: string[][];
  selectedId?: string;
  onSelectTask?: (id: string) => void;
  className?: string;
}

function StatusIcon({ status, color }: { status: string; color: string }) {
  switch (status) {
    case "accepted":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" fill={color} />
          <path
            d="M5 8.2L7 10.2L11 5.8"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "running":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className="dag-spin"
        >
          <circle
            cx="8"
            cy="8"
            r="6.5"
            stroke={color}
            strokeWidth="2"
            strokeDasharray="28"
            strokeDashoffset="9"
          />
        </svg>
      );
    case "reviewing":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M1.5 8C2.5 5 5 3 8 3C11 3 13.5 5 14.5 8C13.5 11 11 13 8 13C5 13 2.5 11 1.5 8Z"
            stroke={color}
            strokeWidth="1.5"
          />
          <circle cx="8" cy="8" r="2.5" fill={color} />
        </svg>
      );
    case "blocked":
    case "waiting_permission":
    case "waiting_input":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect
            x="2"
            y="2"
            width="12"
            height="12"
            rx="3"
            fill={color}
          />
          <line
            x1="5"
            y1="8"
            x2="11"
            y2="8"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "failed":
    case "changes_requested":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" fill={color} />
          <line
            x1="5.5"
            y1="5.5"
            x2="10.5"
            y2="10.5"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <line
            x1="10.5"
            y1="5.5"
            x2="5.5"
            y2="10.5"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "submitted":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" fill={color} />
          <path
            d="M5 8L8 5M8 5L11 8M8 5V11"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle
            cx="8"
            cy="8"
            r="6.5"
            stroke={color}
            strokeWidth="1.5"
          />
          <circle cx="8" cy="8" r="2" fill={color} />
        </svg>
      );
  }
}

export function DependencyGraph({
  tasks = [],
  waves: explicitWaves,
  selectedId,
  onSelectTask,
  className = "",
}: DependencyGraphProps) {
  const graphId = useId().replace(/:/g, "_");

  // Partition tasks and compute layout
  const { waveColumns, layoutNodes, layoutEdges, svgWidth, svgHeight } =
    useMemo(
      () => computeDagLayout(tasks, explicitWaves),
      [tasks, explicitWaves],
    );

  if (!tasks.length) {
    return (
      <div className={`dag-container empty ${className}`}>
        <p className="muted">Chưa có đồ thị phụ thuộc.</p>
      </div>
    );
  }

  // Summary counts
  const totalTasks = tasks.length;
  const acceptedTasks = tasks.filter((t) => t.status === "accepted").length;
  const runningTasks = tasks.filter((t) =>
    ["running", "reviewing"].includes(t.status ?? ""),
  ).length;
  const blockedTasks = tasks.filter((t) =>
    ["blocked", "waiting_permission", "waiting_input"].includes(t.status ?? ""),
  ).length;

  return (
    <div className={`dag-container ${className}`}>
      <div className="dag-header-bar">
        <div className="dag-title-group">
          <strong className="dag-header-title">Đồ thị phụ thuộc (DAG)</strong>
          <span className="dag-meta">
            {waveColumns.length} wave · {totalTasks} task
            {acceptedTasks > 0 && ` · ${acceptedTasks} hoàn thành`}
            {runningTasks > 0 && ` · ${runningTasks} đang chạy`}
            {blockedTasks > 0 && ` · ${blockedTasks} chờ/bị chặn`}
          </span>
        </div>
        <div className="dag-legend">
          <span className="dag-legend-item">
            <span className="dag-legend-dot accepted" /> Hoàn thành
          </span>
          <span className="dag-legend-item">
            <span className="dag-legend-dot running" /> Đang chạy
          </span>
          <span className="dag-legend-item">
            <span className="dag-legend-dot blocked" /> Chờ/Bị chặn
          </span>
          <span className="dag-legend-item">
            <span className="dag-legend-dot queued" /> Chờ chạy
          </span>
        </div>
      </div>

      <div className="dag-scroll-pane">
        <svg
          className="dag-svg"
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        >
          <defs>
            {/* Arrowhead markers */}
            <marker
              id={`${graphId}-arrow-default`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#94a3b8" />
            </marker>
            <marker
              id={`${graphId}-arrow-accepted`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#24613c" />
            </marker>
            <marker
              id={`${graphId}-arrow-running`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#0067c0" />
            </marker>
            <marker
              id={`${graphId}-arrow-blocked`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#d97706" />
            </marker>
            <marker
              id={`${graphId}-arrow-failed`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#ad2838" />
            </marker>

            {/* Gradients and Filters */}
            <filter id={`${graphId}-shadow`} x="-4%" y="-4%" width="108%" height="114%">
              <feDropShadow
                dx="0"
                dy="2"
                stdDeviation="2.5"
                floodColor="#000"
                floodOpacity="0.08"
              />
            </filter>
            <filter id={`${graphId}-shadow-active`} x="-6%" y="-6%" width="112%" height="118%">
              <feDropShadow
                dx="0"
                dy="3"
                stdDeviation="4"
                floodColor="#0067c0"
                floodOpacity="0.25"
              />
            </filter>
          </defs>

          {/* Wave Column Backgrounds and Headers */}
          {waveColumns.map((col, colIndex) => {
            const colX = 28 + colIndex * (210 + 64);
            const colHeight = svgHeight - 24 * 2;

            return (
              <g key={`col-${colIndex}`} className="dag-wave-column">
                <rect
                  x={colX - 10}
                  y={24}
                  width={210 + 20}
                  height={colHeight}
                  rx="10"
                  className="dag-col-bg"
                />
                <text
                  x={colX + 210 / 2}
                  y={24 + 20}
                  textAnchor="middle"
                  className="dag-col-title"
                >
                  Wave {colIndex + 1}
                </text>
                <text
                  x={colX + 210 / 2}
                  y={24 + 35}
                  textAnchor="middle"
                  className="dag-col-sub"
                >
                  {col.length} {col.length === 1 ? "task" : "tasks"}
                </text>
              </g>
            );
          })}

          {/* Directed Bezier Edges */}
          <g className="dag-edges">
            {layoutEdges.map((edge) => {
              const dx = Math.max(32, Math.abs(edge.x2 - edge.x1) * 0.45);
              const pathData = `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2} ${edge.y2}`;

              let markerType = "default";
              if (edge.color === "#24613c") markerType = "accepted";
              else if (edge.color === "#0067c0") markerType = "running";
              else if (edge.color === "#d97706") markerType = "blocked";
              else if (edge.color === "#ad2838") markerType = "failed";

              return (
                <path
                  key={edge.id}
                  d={pathData}
                  fill="none"
                  stroke={edge.color}
                  strokeWidth="2.2"
                  strokeDasharray={edge.dash ? "6,4" : undefined}
                  className={edge.dash ? "dag-edge-animated" : undefined}
                  markerEnd={`url(#${graphId}-arrow-${markerType})`}
                  opacity="0.85"
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g className="dag-nodes">
            {layoutNodes.map((lNode) => {
              const { node, x, y, width, height } = lNode;
              const status = node.status ?? "ready";
              const cfg = STATUS_CONFIG[status] ?? DEFAULT_STATUS_CONFIG;
              const isSelected =
                Boolean(selectedId) &&
                (selectedId === node.id || selectedId === node.taskId);

              // Target ID to open when clicked
              const targetId = node.taskId ?? node.id;

              return (
                <g
                  key={node.id}
                  transform={`translate(${x}, ${y})`}
                  className={`dag-node-group ${isSelected ? "selected" : ""} ${status}`}
                  onClick={() => onSelectTask?.(targetId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectTask?.(targetId);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Task: ${node.title}, Trạng thái: ${cfg.label}`}
                  style={{ cursor: "pointer" }}
                >
                  <title>{`${node.title}\nID: ${targetId}\nTrạng thái: ${cfg.label}${node.workerRef ? `\nWorker: ${node.workerRef}` : ""}${node.dependencies?.length ? `\nPhụ thuộc: ${node.dependencies.join(", ")}` : ""}`}</title>

                  {/* Card Background */}
                  <rect
                    x="0"
                    y="0"
                    width={width}
                    height={height}
                    rx="8"
                    className="dag-card-bg"
                    filter={
                      isSelected
                        ? `url(#${graphId}-shadow-active)`
                        : `url(#${graphId}-shadow)`
                    }
                    stroke={isSelected ? "var(--accent)" : cfg.border}
                    strokeWidth={isSelected ? "2.2" : "1.2"}
                  />

                  {/* Left status accent strip */}
                  <rect
                    x="0"
                    y="0"
                    width="5"
                    height={height}
                    rx="3"
                    fill={cfg.color}
                  />

                  {/* Top Bar: Icon + Status Pill + WorkerRef */}
                  <foreignObject x="12" y="8" width={width - 20} height="20">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "11px",
                        lineHeight: "14px",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                      }}
                    >
                      <StatusIcon status={status} color={cfg.color} />
                      <span
                        style={{
                          fontWeight: 600,
                          color: cfg.color,
                        }}
                      >
                        {cfg.label}
                      </span>
                      {node.workerRef && (
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: "10px",
                            padding: "1px 5px",
                            borderRadius: "3px",
                            background: "var(--wash)",
                            color: "var(--muted)",
                            border: "1px solid var(--border)",
                            fontFamily: "monospace",
                          }}
                        >
                          {node.workerRef}
                        </span>
                      )}
                    </div>
                  </foreignObject>

                  {/* Task Title */}
                  <foreignObject x="12" y="28" width={width - 24} height="26">
                    <div
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        lineHeight: "22px",
                      }}
                    >
                      {node.title}
                    </div>
                  </foreignObject>

                  {/* Bottom details: Step key or Task ID + dependencies */}
                  <foreignObject x="12" y="52" width={width - 24} height="18">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "10px",
                        color: "var(--muted)",
                        fontFamily: "monospace",
                      }}
                    >
                      <span>{node.id}</span>
                      {node.dependencies && node.dependencies.length > 0 && (
                        <span>
                          {node.dependencies.length} phụ thuộc
                        </span>
                      )}
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

export default DependencyGraph;
