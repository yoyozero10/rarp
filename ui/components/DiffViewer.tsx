import React, { useMemo, useState } from "react";
import {
  parseDiff,
  buildSplitRows,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type DiffLineType,
  type SplitRow,
} from "./diff-utils";

export { parseDiff, buildSplitRows };
export type { DiffFile, DiffHunk, DiffLine, DiffLineType, SplitRow };

export type DiffMode = "unified" | "split";

export interface DiffViewerProps {
  diff: string;
  stat?: string;
  message?: string;
  defaultMode?: DiffMode;
  className?: string;
}

export function DiffViewer({
  diff,
  stat,
  message,
  defaultMode = "unified",
  className = "",
}: DiffViewerProps) {
  const [mode, setMode] = useState<DiffMode>(() => {
    const saved = localStorage.getItem("rarp-diff-mode");
    return saved === "split" || saved === "unified" ? saved : defaultMode;
  });

  const [selectedFileId, setSelectedFileId] = useState<string>("all");
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const files = useMemo(() => parseDiff(diff), [diff]);

  const toggleMode = (newMode: DiffMode) => {
    setMode(newMode);
    localStorage.setItem("rarp-diff-mode", newMode);
  };

  const toggleCollapse = (fileId: string) => {
    setCollapsedFiles((prev) => ({
      ...prev,
      [fileId]: !prev[fileId],
    }));
  };

  const copyDiff = () => {
    if (!diff) return;
    void navigator.clipboard.writeText(diff).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const displayedFiles =
    selectedFileId === "all"
      ? files
      : files.filter((f) => f.id === selectedFileId);

  if (!diff && !message) {
    return (
      <div className={`diff-viewer empty ${className}`}>
        <p className="muted">Không có dữ liệu diff.</p>
      </div>
    );
  }

  return (
    <section className={`diff-viewer ${className}`} aria-label="Bộ xem diff mã nguồn">
      {/* Top Header & Controls */}
      <div className="diff-header-bar">
        <div className="diff-summary-group">
          <strong>Diff checkpoint</strong>
          {files.length > 0 && (
            <span className="diff-stats-badge">
              {files.length} file thay đổi
              <span className="diff-stat-add">+{totalAdditions}</span>
              <span className="diff-stat-del">-{totalDeletions}</span>
            </span>
          )}
        </div>

        <div className="diff-controls-group">
          {/* Mode Switcher */}
          <div className="diff-mode-switcher" role="radiogroup" aria-label="Chế độ xem diff">
            <button
              type="button"
              className={mode === "unified" ? "active" : ""}
              aria-checked={mode === "unified"}
              role="radio"
              onClick={() => toggleMode("unified")}
            >
              Unified
            </button>
            <button
              type="button"
              className={mode === "split" ? "active" : ""}
              aria-checked={mode === "split"}
              role="radio"
              onClick={() => toggleMode("split")}
            >
              Split (Side-by-side)
            </button>
          </div>

          {diff && (
            <button
              type="button"
              className="diff-copy-btn"
              onClick={copyDiff}
              title="Sao chép toàn bộ diff"
            >
              {copied ? "Đã sao chép!" : "Sao chép diff"}
            </button>
          )}
        </div>
      </div>

      {message && <p className="muted diff-message-note">{message}</p>}

      {stat && (
        <details className="diff-stat-details">
          <summary>Thống kê git diff (--stat)</summary>
          <pre className="diff-stat-pre">{stat}</pre>
        </details>
      )}

      {/* File List Navigation Pills */}
      {files.length > 1 && (
        <nav className="diff-file-nav" aria-label="Danh sách file thay đổi">
          <button
            type="button"
            className={`diff-file-pill ${selectedFileId === "all" ? "active" : ""}`}
            onClick={() => setSelectedFileId("all")}
          >
            Tất cả file ({files.length})
          </button>
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              className={`diff-file-pill ${selectedFileId === file.id ? "active" : ""}`}
              onClick={() => setSelectedFileId(file.id)}
            >
              <span className={`diff-status-tag ${file.status}`}>
                {file.status === "added"
                  ? "A"
                  : file.status === "deleted"
                    ? "D"
                    : file.status === "renamed"
                      ? "R"
                      : "M"}
              </span>
              <span className="diff-file-pill-name">{file.displayPath}</span>
              <span className="diff-file-pill-counts">
                +{file.additions} -{file.deletions}
              </span>
            </button>
          ))}
        </nav>
      )}

      {/* Render each file's diff */}
      {displayedFiles.length === 0 ? (
        <p className="muted diff-empty-files">Không có file nào có thay đổi text.</p>
      ) : (
        <div className="diff-files-container">
          {displayedFiles.map((file) => {
            const isCollapsed = Boolean(collapsedFiles[file.id]);

            return (
              <article key={file.id} className="diff-file-card">
                {/* File Header */}
                <header
                  className="diff-file-header"
                  onClick={() => toggleCollapse(file.id)}
                  tabIndex={0}
                  role="button"
                  aria-expanded={!isCollapsed}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleCollapse(file.id);
                    }
                  }}
                >
                  <span className="diff-collapse-icon">
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                  <span className={`diff-file-status-badge ${file.status}`}>
                    {file.status === "added"
                      ? "Thêm mới"
                      : file.status === "deleted"
                        ? "Đã xóa"
                        : file.status === "renamed"
                          ? "Đổi tên"
                          : "Đã sửa"}
                  </span>
                  <span className="diff-file-path">
                    {file.status === "renamed" ? (
                      <>
                        <span className="muted">{file.oldPath}</span> →{" "}
                        <strong>{file.newPath}</strong>
                      </>
                    ) : (
                      <strong>{file.displayPath}</strong>
                    )}
                  </span>
                  <span className="diff-file-counts">
                    <span className="diff-stat-add">+{file.additions}</span>
                    <span className="diff-stat-del">-{file.deletions}</span>
                  </span>
                </header>

                {/* File Diff Body */}
                {!isCollapsed && (
                  <div className="diff-file-content">
                    {file.isBinary ? (
                      <div className="diff-binary-note">
                        <em>File nhị phân đã thay đổi; không hiển thị diff text.</em>
                      </div>
                    ) : file.hunks.length === 0 ? (
                      <div className="diff-empty-hunks">
                        <em>Không có nội dung thay đổi dòng trong file này.</em>
                      </div>
                    ) : mode === "unified" ? (
                      /* Unified Diff View */
                      <div className="diff-table-wrapper">
                        <table className="diff-table unified">
                          <colgroup>
                            <col className="col-gutter" />
                            <col className="col-gutter" />
                            <col className="col-marker" />
                            <col className="col-code" />
                          </colgroup>
                          <tbody>
                            {file.hunks.map((hunk, hIdx) => (
                              <React.Fragment key={`hunk-${hIdx}`}>
                                <tr className="diff-row hunk-header">
                                  <td colSpan={2} className="diff-gutter hunk-gutter">
                                    …
                                  </td>
                                  <td colSpan={2} className="diff-code hunk-text">
                                    <code>{hunk.header}</code>
                                  </td>
                                </tr>
                                {hunk.lines.map((line, lIdx) => (
                                  <tr
                                    key={`line-${lIdx}`}
                                    className={`diff-row ${line.type}`}
                                  >
                                    <td className="diff-gutter old-num">
                                      {line.oldLineNumber ?? ""}
                                    </td>
                                    <td className="diff-gutter new-num">
                                      {line.newLineNumber ?? ""}
                                    </td>
                                    <td className="diff-marker">
                                      {line.type === "addition"
                                        ? "+"
                                        : line.type === "deletion"
                                          ? "-"
                                          : " "}
                                    </td>
                                    <td className="diff-code">
                                      <code>{line.text}</code>
                                    </td>
                                  </tr>
                                ))}
                              </React.Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      /* Split (Side-by-side) Diff View */
                      <div className="diff-table-wrapper">
                        <table className="diff-table split">
                          <colgroup>
                            <col className="col-gutter" />
                            <col className="col-marker" />
                            <col className="col-code-half" />
                            <col className="col-gutter" />
                            <col className="col-marker" />
                            <col className="col-code-half" />
                          </colgroup>
                          <thead>
                            <tr className="diff-split-header">
                              <th colSpan={3} className="diff-split-side-header">
                                Bản cũ ({file.oldPath || file.displayPath})
                              </th>
                              <th colSpan={3} className="diff-split-side-header">
                                Bản mới ({file.newPath || file.displayPath})
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {file.hunks.map((hunk, hIdx) => {
                              const splitRows = buildSplitRows(hunk);
                              return (
                                <React.Fragment key={`split-hunk-${hIdx}`}>
                                  {splitRows.map((row, rIdx) => {
                                    if (row.type === "hunk-header") {
                                      return (
                                        <tr
                                          key={`split-row-${rIdx}`}
                                          className="diff-row hunk-header"
                                        >
                                          <td
                                            colSpan={6}
                                            className="diff-code hunk-text"
                                          >
                                            <code>{row.hunkHeader}</code>
                                          </td>
                                        </tr>
                                      );
                                    }

                                    const left = row.left;
                                    const right = row.right;

                                    return (
                                      <tr
                                        key={`split-row-${rIdx}`}
                                        className="diff-row split-row"
                                      >
                                        {/* Left Side */}
                                        <td
                                          className={`diff-gutter old-num ${left?.type ?? ""}`}
                                        >
                                          {left?.lineNumber ?? ""}
                                        </td>
                                        <td
                                          className={`diff-marker ${left?.type ?? ""}`}
                                        >
                                          {left?.type === "deletion"
                                            ? "-"
                                            : " "}
                                        </td>
                                        <td
                                          className={`diff-code left-side ${left?.type ?? ""}`}
                                        >
                                          <code>{left?.text ?? ""}</code>
                                        </td>

                                        {/* Right Side */}
                                        <td
                                          className={`diff-gutter new-num ${right?.type ?? ""}`}
                                        >
                                          {right?.lineNumber ?? ""}
                                        </td>
                                        <td
                                          className={`diff-marker ${right?.type ?? ""}`}
                                        >
                                          {right?.type === "addition"
                                            ? "+"
                                            : " "}
                                        </td>
                                        <td
                                          className={`diff-code right-side ${right?.type ?? ""}`}
                                        >
                                          <code>{right?.text ?? ""}</code>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default DiffViewer;
