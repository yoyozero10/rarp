/**
 * Pure presentation rules for the planning screen, so they can be tested
 * without a DOM or a browser.
 */
const stateNames: Record<string, string> = { received: "Đã nhận", analyzing: "Đang phân tích", needs_clarification: "Cần làm rõ", awaiting_approval: "Chờ duyệt", executing: "Đang thực thi", completed: "Hoàn tất", paused: "Tạm dừng", waiting_permission: "Chờ cấp quyền", failed: "Lỗi", rejected: "Đã từ chối", cancelled: "Đã hủy", revision_requested: "Cần phân tích lại" };
const editableStates = ["received", "awaiting_approval", "needs_clarification", "failed", "revision_requested", "rejected", "paused"];
const terminalStates = ["completed", "cancelled", "rejected"];
export type PlanAction = "reject" | "pause" | "resume" | "cancel";
export const planLabel = (status: string) => stateNames[status] ?? status;
/** A plan waiting for permission is not editable: the proposal is unchanged. */
export const planEditable = (status: string) => editableStates.includes(status);
export const planActions = (status: string): PlanAction[] => {
  const actions: PlanAction[] = [];
  if (planEditable(status) && status !== "paused") actions.push("reject");
  if (status === "executing") actions.push("pause");
  if (status === "paused" || status === "waiting_permission") actions.push("resume");
  if (!terminalStates.includes(status)) actions.push("cancel");
  return actions;
};
export const planRemaining = (used: number, cap: number) => Math.max(0, cap - used);
/** Integration of an accepted task is allowed while the plan is live or paused. */
export const planCanIntegrate = (status: string) => ["executing", "paused", "waiting_permission"].includes(status);
const actionLabels: Record<PlanAction, string> = { reject: "Từ chối", pause: "Tạm dừng kế hoạch", resume: "Tiếp tục kế hoạch", cancel: "Hủy riêng kế hoạch" };
/** A plan waiting for permission resumes with a label that names the cause. */
export const planActionLabel = (action: PlanAction, status: string) =>
  action === "resume" && status === "waiting_permission" ? "Đã cấp quyền, tiếp tục" : actionLabels[action];
