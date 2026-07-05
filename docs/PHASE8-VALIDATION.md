# Phase 8: khôi phục plan và vòng sửa có giới hạn

Ngày kiểm chứng: 2026-10-28, Windows, Node.js 26.2.0.

## Contract

- Revision giữ ID, attempts, reviews, workspace và ngân sách đã tiêu của task không đổi. Task accepted chưa tích hợp được giữ lại; không cho thay nội dung hoặc cây dependency của task accepted.
- Tích hợp thủ công được phép trong plan executing/paused đã duyệt. Kiểm tra repo fingerprint, scope/check, HEAD và độ sạch của workspace trước khi merge. Conflict giữ nguyên workspace tích hợp, không tự tăng quyền hoặc sửa conflict.
- `resume` idempotent, chỉ tạo dispatch mới nếu task chưa accepted và chưa có dispatch chờ/chạy. Không tạo task mới để retry. Revision đã đổi vô hiệu hóa approval cũ.
- `execution.tasks` lưu rounds, retries, retryAt, feedback, signature và stopReason trong JSON plan của SQLite v4. Event `execution.usage` lưu từng thay đổi ngân sách. Không cần migration phá dữ liệu.
- `maxRounds` là tổng lượt làm, gồm lượt đầu; `maxRetries` dùng chung cho lỗi tạm thời của worker/reviewer trên mỗi task. Retry dùng backoff 1/2/4/... giây, tối đa 30 giây. Bộ đếm được ghi trước lần gọi tiếp theo.
- Tổng thời gian là thời gian plan đang thực thi, tính cả chờ slot/review/integration. Pause lưu elapsedMs; resume/revision không xóa thời gian đã tiêu. Crash khi executing tính cả khoảng ngừng đến lúc phục hồi để không cấp thêm ngân sách. Runtime recovery vẫn yêu cầu tiến trình cũ đã chết và lease hết hạn.
- Review/check không đạt tạo feedback cho lượt làm tiếp. Feedback và diff giống lần trước dừng sớm `no-progress`. Lỗi quyền/auth/CLI dừng `configuration`. Stop reason còn phân biệt human, budget, worker, review, integration, verification và repository.
- Sau tích hợp, chạy lại toàn bộ lệnh check của các task trên checkout cuối; lưu HEAD và evidence. Chỉ lúc này mới chuyển completed. Check lỗi có thể mở lại đúng task sở hữu check, trong ngân sách cũ; tạo worktree sửa mới, giữ worktree cũ và lịch sử acceptance.

## Kiểm thử

Lệnh: `npm run typecheck`, `npm run build`, `node --test tests/*.test.mjs`.

Kết quả cuối: 76/76 tests đạt, typecheck/build đạt, `git diff --check` sạch.

`tests/phase8.test.mjs` bao phủ backend accepted/frontend cần sửa, giữ task chưa tích hợp qua revision, repo drift, workspace bị thay đổi sau review, review/check tự sửa, retry 429, thiếu quyền, không tiến triển, ngân sách qua restart, resume lặp, sửa sau lỗi tích hợp và lỗi check cuối. Bộ kiểm thử cũ tiếp tục bao phủ conflict, lease/crash, shutdown, idempotency và isolation.

UI bổ sung ngân sách duyệt, thời gian/lượt còn lại, stop reason, feedback và nút tích hợp/sửa revision. TypeScript và build đạt.

Nghiệm thu UI 2026-10-29 trên runtime fixture tạm (`rarp-phase8-ui-DG0FSZ`, agent giả, không gọi model): chọn plan đã duyệt hiển thị revision/hash, ngân sách còn lại, task `accepted` chưa tích hợp kèm feedback; bấm **Tích hợp task đã duyệt** commit thành công; **Tiếp tục kế hoạch** dispatch lại task `changes_requested` trong ngân sách cũ; sau khi tích hợp cả hai và chạy lại check trên checkout cuối, plan chuyển `Hoàn tất`, `git status` sạch, `a.txt`/`b.txt` bằng `done`. Runtime fixture đã dừng và thư mục tạm được xoá.

## Nghiệm thu live

`node scripts/phase8-live.mjs` chạy hai Antigravity worker với model `gemini-3.8-flash-medium`; reviewer Codex dùng profile `9router`. Plan và checks xác định sẵn để nghiệm thu execution, không thử planner ở lần này.

1. Cấu hình mặc định: dừng `configuration` khi Antigravity báo quyền công cụ bị từ chối. Không tự retry hoặc bỏ kiểm soát quyền.
2. Sau khi người dùng cho phép tăng quyền riêng cho bài test: `node scripts/phase8-live.mjs --ag-test-skip-permissions` đạt completed. Flag chỉ nằm trong script opt-in; adapter/runtime mặc định không đổi.

Kết quả đạt:

- Hai task accepted và integrated, mỗi task một lượt làm, không retry.
- `backend.txt`, `frontend.txt` đúng bytes `[97,102,116,101,114,10]`; checkout sạch.
- Cả hai check chạy lại trên checkout cuối và pass; elapsedMs: 135665.
- HEAD cuối: `1da893d84649617dd4aede4fc92df9f7f4e1c198`.
- Báo cáo: `C:\Users\User\AppData\Local\Temp\rarp-phase8-live-TiBGk7\.rarp\phase8-result.json`.
- Runtime live đã dừng. Không chỉnh sửa hoặc tiếp tục OrderMatrix.

Chưa kiểm chứng CI Linux trong lượt này. Không bảo đảm mọi lỗi đều tự sửa được; thay đổi phạm vi, hết ngân sách hoặc không tiến triển vẫn cần quyết định mới.
