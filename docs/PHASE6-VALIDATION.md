# Kiểm chứng Phase 6

Ngày 2026-10-24. Windows, Node 26.2.0.

## Chức năng

- Schema SQLite v3 thêm dispatch bền vững; migration từ v2 giữ task/attempt/review/events/workspace/runs.
- Scheduler mặc định 2 slot workflow và 1 reviewer; giới hạn cấu hình 1–16. Worktree và scope độc lập, không nhận hai task vào cùng worker ID, không sửa đồng thời phạm vi chồng nhau.
- Queue chỉ chạy yêu cầu đã enqueue; dependency cách ly cần accepted + integrated. Scope accepted chưa tích hợp giữ task chồng phạm vi trong hàng chờ.
- Request key bền vững, journal run/PID/lease giữ nguyên; crash không tự chạy lại worker. Queue tồn đọng sau restart bắt đầu paused.
- Verification bất đồng bộ dùng worker-host có timeout/cancel/tree cleanup. Reviewer FIFO có thể cancel/deadline khi chờ slot.
- Tích hợp tuần tự, verification có thể hủy, run journal ghi cả host kiểm thử tích hợp; retry sau crash không nhân đôi commit.
- CLI cấu hình capacity, queue/pause/resume/cancel theo ID. UI hiển thị mọi slot, stage/PID, hàng chờ và tích hợp đang chạy; cancel không nhắm nhầm workflow khác.

## Test tự động

Typecheck/build và **44/44 test local đạt**, gồm:

- Barrier chứng minh 4 worker cùng tồn tại; task thứ 5 chờ slot, task queued chưa tạo attempt.
- Cancel một worker, cancel khi chờ reviewer, cancel queue; các task khác vẫn chạy; maxReviewers=1 được giữ.
- Commit của ba task còn lại tích hợp tuần tự, checkout chính sạch, kiểm tra kết quả chung đạt.
- Worker ID/scope chồng nhau chờ; dependency chỉ được bắt đầu sau tích hợp.
- Queue/key giữ qua restart; request trùng đồng thời không tạo attempt mới.
- Verification giữ API phản hồi; stop dọn host/child đang chạy.
- Kill runtime có 4 worker: giữ file partial, recovery sau PID/lease, 4 dispatch interrupted và queue còn lại chờ resume.
- Kill runtime trong integration: task vẫn accepted, main HEAD không đổi; retry tích hợp không chạy lại worker.
- Migration v2 → v3; capacity không hợp lệ bị từ chối trước khi tạo lock.

## AI thật

Script opt-in `scripts/smoke-phase6.mjs`: 4 helper giỏ hàng độc lập, 1 task checkout phụ thuộc bốn helper; acceptance tests cố định ngoài scope worker. Worker/reviewer dùng `gpt-6.1-sol`, maxWorkers=4, maxReviewers=1. Đo peak từ stage/PID; chỉ nghiệm thu khi 5 task accepted/integrated, peakWorking=4 và toàn bộ test kết quả chung đạt.

**Kết quả cuối: đạt** với Codex CLI 0.162.1, `gpt-6.1-sol`, `--plain-tools`. Peak: 4 workflow/4 worker thực thi, tối đa 1 reviewer. Cả 5 task accepted và integrated, mỗi task 1 attempt; checkout chỉ bắt đầu sau khi bốn dependency đã tích hợp. Kiểm thử kết quả chung: 5/5 đạt, 0 lỗi; main checkout sạch. Thời gian khoảng 181 giây cho workload này, không phải benchmark tổng quát. Commit cuối trong repository thử nghiệm: `837a96179b4b4a8754919db6d479a128709e5159`. Báo cáo đầy đủ nằm ở `.rarp/phase6-result.json` của repository thử nghiệm `rarp-phase6-QBmHBg`; không commit log/token phiên.

Các lượt đầu với bài phí giao hàng theo ngưỡng bị scope guard từ chối vì file ngoài phạm vi tên `500`. Tái hiện cả khi tắt user hooks và đổi Codex CLI cài sẵn, nên chưa đủ cơ sở quy lỗi cho RTK. Các worktree lỗi được giữ để kiểm tra; không mở rộng scope hoặc tự xóa artifact. Bài feature cuối dùng phí cố định 30; tiêu chí scheduler, dependency, scope và tích hợp giữ nguyên. Một lượt harness đưa phương thức ghi file vào yêu cầu chức năng cũng bị reviewer từ chối vì không có tool trace để kiểm chứng. Harness cuối chỉ yêu cầu chức năng, phạm vi file và test quan sát được; không nới kiểm tra của runtime/reviewer.

## UI và giới hạn

Demo fixture local: 4 worker, 0/4 slot trống, task thứ 5 chờ; pause/resume giữ công việc đang chạy. UI sử dụng token cùng origin và SSE từ Phase 5. Không benchmark trên 4 worker hoặc khẳng định hạn mức provider. Không có distributed scheduler, rebase tự động, tự giải quyết conflict hoặc containment với tiến trình cố ý tách cây. Workflow chờ reviewer vẫn chiếm slot; pause không ngắt lượt đang chạy. Git worktree/merge/diff vẫn có thao tác đồng bộ ngắn.
