import { useState, useEffect } from "react";

export interface InputModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskTitle: string;
  taskId: string;
  stepKey?: string;
  question: string;
  requestId: string;
  initialAnswer?: string;
  busy?: boolean;
  onSubmit: (answer: string) => Promise<void> | void;
}

export function InputModal({
  isOpen,
  onClose,
  taskTitle,
  taskId,
  stepKey,
  question,
  requestId,
  initialAnswer = "",
  busy = false,
  onSubmit,
}: InputModalProps) {
  const storageKey = `rarp_draft_input_${taskId}_${requestId}`;

  const [answer, setAnswer] = useState<string>(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? initialAnswer;
    } catch {
      return initialAnswer;
    }
  });

  // Đồng bộ draft từ sessionStorage hoặc initialAnswer khi mở modal hoặc thay đổi request
  useEffect(() => {
    if (!isOpen) return;
    try {
      const saved = sessionStorage.getItem(storageKey);
      setAnswer(saved ?? initialAnswer ?? "");
    } catch {
      setAnswer(initialAnswer ?? "");
    }
  }, [isOpen, storageKey, initialAnswer]);

  // Lưu draft tạm thời vào sessionStorage khi người dùng gõ
  const handleAnswerChange = (val: string) => {
    setAnswer(val);
    try {
      if (val.trim()) {
        sessionStorage.setItem(storageKey, val);
      } else {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      // Bỏ qua lỗi sessionStorage nếu bị hạn chế
    }
  };

  // Đóng modal bằng phím Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, busy, onClose]);

  if (!isOpen) return null;

  const charCount = answer.length;
  const isOverLimit = charCount > 12000;
  const isNearLimit = charCount >= 11000 && !isOverLimit;
  const canSubmit = !busy && answer.trim().length > 0 && !isOverLimit;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(answer.trim());
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Bỏ qua
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="input-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <div className="modal-header-info">
            <span className="badge badge-waiting">waiting_input</span>
            <h2 id="input-modal-title">Action Center · Trả lời câu hỏi</h2>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Đóng"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-task-info">
            <div className="task-info-row">
              <strong>Đầu việc:</strong> <span>{taskTitle}</span>
            </div>
            <div className="task-info-row">
              <small className="muted">
                Task ID: <code>{taskId}</code>
                {stepKey ? ` · Step: ${stepKey}` : ""} · Attempt: <code>{requestId}</code>
              </small>
            </div>
          </div>

          <div className="modal-question-box">
            <h4>Câu hỏi từ Worker:</h4>
            <p className="question-text">{question}</p>
          </div>

          <form onSubmit={handleSubmit} id="input-modal-form">
            <label htmlFor="input-modal-textarea">
              <strong>Câu trả lời của bạn:</strong>
              <textarea
                id="input-modal-textarea"
                required
                maxLength={12000}
                rows={6}
                disabled={busy}
                placeholder="Nhập câu trả lời cụ thể để worker có thể tiếp tục triển khai..."
                value={answer}
                onChange={(e) => handleAnswerChange(e.target.value)}
              />
            </label>

            <div
              className={`char-counter ${
                isOverLimit ? "limit-exceeded" : isNearLimit ? "limit-near" : ""
              }`}
              aria-live="polite"
            >
              {charCount.toLocaleString()} / 12,000 ký tự
              {isOverLimit && " (Vượt quá độ dài tối đa cho phép)"}
            </div>

            <p className="muted modal-help-text">
              Bản nháp được tự động lưu tạm vào sessionStorage. Câu trả lời làm rõ yêu cầu task
              và không làm thay đổi phạm vi hoặc quyền đã duyệt.
            </p>
          </form>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Đóng
          </button>
          <button
            type="submit"
            form="input-modal-form"
            className="primary"
            disabled={!canSubmit}
          >
            {busy ? "Đang lưu..." : "Lưu và tiếp tục"}
          </button>
        </div>
      </div>
    </div>
  );
}
