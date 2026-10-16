import { useState } from "react";
import {
  parsePermissionDenial,
  generateAntigravityAllowSnippet,
} from "../../src/core/planview";

export interface PermissionAlertProps {
  note?: string | null;
  blockedCommand?: string | null;
  onResume?: () => void;
  busy?: boolean;
}

export function PermissionAlert({
  note,
  blockedCommand,
  onResume,
  busy = false,
}: PermissionAlertProps) {
  const [copied, setCopied] = useState(false);

  // Trích xuất lệnh bị chặn từ note hoặc dùng prop truyền vào
  const command = blockedCommand ?? (note ? parsePermissionDenial(note) : null);
  const snippet = generateAntigravityAllowSnippet(command ?? "*");

  const handleCopy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet);
      } else if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = snippet;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      console.error("Không thể sao chép snippet:", e);
    }
  };

  return (
    <div className="permission-alert" role="alert" aria-live="polite">
      <div className="permission-alert-header">
        <div className="permission-alert-title">
          <span className="permission-icon" aria-hidden="true">🛡️</span>
          <h3>Cảnh báo bảo mật: Lệnh bị từ chối quyền (waiting_permission)</h3>
        </div>
        <span className="permission-badge">Cần can thiệp</span>
      </div>

      <div className="permission-alert-body">
        <p>
          Worker Antigravity bị từ chối quyền thực thi lệnh công cụ. Kế hoạch tạm dừng ở trạng
          thái an toàn, <strong>không bị tính là lượt hỏng</strong> và giữ nguyên round hiện tại.
        </p>

        {command && (
          <div className="blocked-command-card">
            <span className="blocked-command-label">Lệnh bị chặn:</span>
            <code className="blocked-command-text">{command}</code>
          </div>
        )}

        <div className="snippet-section">
          <div className="snippet-header">
            <strong>JSON snippet cấu hình (permissions.allow):</strong>
            <button
              type="button"
              className="copy-snippet-btn"
              onClick={handleCopy}
              aria-label="Sao chép JSON snippet cấu hình vào clipboard"
            >
              {copied ? "✓ Đã sao chép!" : "Sao chép JSON snippet"}
            </button>
          </div>
          <pre className="snippet-block">
            <code>{snippet}</code>
          </pre>
        </div>

        <div className="permission-guide">
          <h4>Hướng dẫn cấp quyền:</h4>
          <ol>
            <li>
              Mở file cấu hình <code>~/.gemini/antigravity-cli/settings.json</code> trên máy của bạn.
            </li>
            <li>
              Dán đoạn JSON snippet ở trên vào mảng <code>permissions.allow</code> (hoặc thêm thư
              mục dự án vào <code>trustedWorkspaces</code>).
            </li>
            <li>Lưu file <code>settings.json</code>.</li>
            <li>
              Bấm nút <strong>"Đã cấp quyền, tiếp tục"</strong> để runtime tiếp tục thực thi plan.
            </li>
          </ol>
          <p className="muted">
            <em>Tùy chọn khác:</em> Nếu muốn cấp toàn quyền cho worker Antigravity mà không hỏi lại
            lệnh trong plan này, bạn có thể lưu revision mới với <strong>Quyền Antigravity</strong> bật.
          </p>
        </div>
      </div>

      {onResume && (
        <div className="permission-alert-footer">
          <button
            type="button"
            className="primary resume-btn"
            onClick={onResume}
            disabled={busy}
          >
            {busy ? "Đang xử lý..." : "Đã cấp quyền, tiếp tục"}
          </button>
        </div>
      )}
    </div>
  );
}
