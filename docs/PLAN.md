# Kế hoạch triển khai Rarp

Ngày lập: 2026-10-21. Mục tiêu: một trưởng nhóm điều phối 2–4 worker khác loại, duy trì vòng giao việc–nghiệm thu–sửa, có thể khôi phục và trực quan hóa sau này.

## Phạm vi và thứ tự

Windows trước; CLI trước UI; Codex adapter đầu tiên rồi Antigravity. Manager độc lập nhà cung cấp, có thể là agent ngoài gọi CLI. Manager do runtime quản lý cần adapter hỗ trợ resume/wakeup rõ ràng.

Một repo `rarp` chứa CLI, runtime, adapter, storage, tài liệu và UI tương lai. Không cần repo riêng cho mỗi agent. Remote GitHub đã public theo yêu cầu: https://github.com/yoyozero10/rarp.

## M0 — Nền dự án

- Khởi tạo Git, TypeScript strict, CLI help/version, lockfile, tài liệu kiến trúc và kế hoạch.
- Giữ bài thử cũ làm dữ liệu tham khảo, không commit logs/credentials.
- Đạt khi cài sạch, typecheck, build và CLI help/about chạy được.

## M1 — Task và lưu trữ

Trạng thái: đã triển khai và kiểm thử local. CLI chuyển trạng thái thủ công để kiểm chứng workflow; chạy worker tự động thuộc M2–M3.

- Xác định schema SQLite: projects, agents, tasks, attempts, reviews, events; migration có version.
- Cài các lệnh init, task create/list/show, status --json.
- State machine kiểm tra chuyển trạng thái, dependency và quyền nghiệm thu.
- Đạt khi restart vẫn giữ task; cập nhật và event nguyên tử; chuyển sai bị từ chối; dependency lỗi không tự chạy.

## M2 — Runtime và một worker thật

Trạng thái 2026-10-23: đã có runtime nền single-owner, API loopback có token, dispatch một task, adapter Codex, log theo attempt và timeout/cancel/stop. Test Codex thật tạo file giỏ hàng và submitted thành công. Trạng thái chờ tương tác chưa hỗ trợ do adapter non-interactive; process-tree cleanup đã kiểm chứng với cây thông thường, chưa bảo đảm tiến trình cố ý tách cây. Crash reconciliation thuộc M4.

- Runtime start/status/stop; khóa tránh hai runtime cùng dự án.
- Adapter Codex: start, structured events, kết thúc lượt, lỗi, timeout, cancellation.
- Phân biệt starting/ready/working/waiting_input/waiting_permission/idle/exited/failed.
- Đạt khi một task thật hoàn thành, log được gắn attempt và stop không để lại cây tiến trình do Rarp tạo.

## M3 — Vòng nghiệm thu và nhiều loại agent

Triển khai 2026-10-24: adapter Antigravity, workflow run, Codex reviewer read-only với JSON Schema, feedback qua các attempt, giới hạn vòng/thời gian và cancel/stop toàn vòng. Có 21 test local, gồm cố ý sai rồi sửa, vượt giới hạn, JSON review lỗi và deadline/cancel/stop khi review. Test live và điều kiện quyền Antigravity xem docs/PHASE3-VALIDATION.md.

- Adapter Antigravity; manager nhận sự kiện submitted và trả accepted/changes_requested với feedback.
- Runtime chờ sự kiện và kích hoạt lượt tiếp; giới hạn số lần sửa, thời gian và retry.
- Đạt khi manager giao worker tạo giỏ hàng, nghiệm thu, giao giảm giá; chạy thêm tình huống cố ý sai để chứng minh vòng sửa. Hai loại CLI hoàn tất, dừng sạch, không cần nhắc tiếp trong bài thử có giới hạn.
- Đây là mốc MVP chức năng. Các bài thử JSON chưa đủ chứng minh sửa feature thật.

## M4 — Sửa code và phục hồi

Trạng thái 2026-10-24: đã có worktree theo task, scope, checkpoint commit, check trước review và sau merge, tích hợp idempotent, durable request key, lease/heartbeat và recovery tường minh. Test bao gồm crash thật, giữ file sửa, review tiếp không lặp worker và xử lý conflict trong worktree riêng. Smoke hai worker có chế độ fixture; live GPT-6.1 Sol đã đạt với hai worker nối tiếp, reviewer độc lập và test trên kết quả tích hợp (2 test, 0 lỗi). Event cursor hỗ trợ đọc tiếp, chưa có tự replay side effect hay resume phiên model.

- Worktree cho worker, phạm vi file, kết quả gồm commit/diff và bằng chứng test.
- Manager tích hợp tuần tự, xử lý conflict và test trên kết quả chung.
- Lease, idempotency, restart reconciliation, khôi phục event chưa xử lý.
- Đạt khi ngắt worker/runtime giữa task và khôi phục có kiểm soát; không lặp thao tác hoàn tất; sửa một feature nhỏ bằng hai worker và review đạt.

## M5 — UI quan sát

Trạng thái 2026-10-24: đã triển khai dashboard React local, snapshot nhất quán, SSE replay/cursor, log phân trang, dependency edges, diff/evidence và thao tác điều khiển. Xem docs/PHASE5-VALIDATION.md. Canvas kéo/thả và nhiều worker song song là mở rộng riêng.

- API snapshot và event stream, auth local, reconnect cursor, phân trang log.
- Dashboard React: agent list, task board, graph dependencies, timeline và diff/test evidence.
- Thêm thao tác cancel/reassign/approve với trạng thái pending/succeeded/failed.
- Đạt khi reload/reconnect không mất hoặc nhân đôi sự kiện; UI phản ánh đúng database; đóng UI không làm runtime dừng.

## M6 — Nhiều worker song song

Trạng thái 2026-10-24: đã triển khai maxWorkers/maxReviewers, queue bền vững, scope/worker ownership, dependency gate, cancel/recovery theo task và integration tuần tự. Mặc định 2 slot, cấu hình 1–16; 4 worker được kiểm chứng bằng barrier và crash thật. Xem docs/PHASE6-VALIDATION.md.

- Một slot giữ toàn workflow; review FIFO có giới hạn riêng, verification bất đồng bộ có cancellation.
- Queue tồn đọng sau restart paused; dispatch bị ngắt không tự replay.
- UI hiển thị workers[], queue, slot, stage/PID và lý do chờ; active cũ chỉ là workflow đầu tiên.
- Đạt khi 4 worker chạy độc lập đồng thời, cancel một task không dừng task khác, dependency chờ integration và kết quả chung qua test.

## M7 — Planner và phê duyệt trước thực thi

Trạng thái: đã đóng nghiệm thu 2026-10-25; 59/59 tests, CI Windows/Linux và live Codex đơn/hỗn hợp đạt. Ngoại lệ quyền Antigravity chỉ áp dụng bài test đã được người dùng duyệt. Chi tiết: [PHASE7-PLAN.md](PHASE7-PLAN.md) và [báo cáo nghiệm thu](PHASE7-VALIDATION.md).

- Nhận mục tiêu, phân tích read-only, đề xuất đầu việc/dependency/scope và số worker có giải thích.
- Người dùng xem/sửa, chọn Codex hoặc Antigravity cho từng worker, duyệt revision/hash trước khi tạo worker thực thi.
- Materialize idempotent, chạy qua scheduler Phase 6, review/integration theo chính sách đã duyệt; thay đổi scope hoặc kế hoạch cần duyệt lại.
- Thứ tự: contract/storage → planner → approval UI/CLI/API → executor → fixture/live/CI.

## M8 — Khôi phục plan và vòng sửa có giới hạn

Trạng thái: đã triển khai 2026-10-28, nghiệm thu UI và CI Windows/Ubuntu Node 24/26 đạt 2026-10-29 tại commit `4b99c39`. Chi tiết: [báo cáo nghiệm thu](PHASE8-VALIDATION.md).

- Task accepted giữ ID, lịch sử, workspace và ngân sách đã tiêu qua revision; không đổi nội dung task đã accepted.
- Tích hợp thủ công khi plan `paused`; kiểm tra fingerprint/HEAD/scope/check; conflict giữ workspace, không tự tăng quyền.
- `resume` idempotent; retry lỗi tạm thời có backoff; dừng khi hết ngân sách, thiếu quyền, conflict hoặc không tiến triển.
- `completed` chỉ sau khi mọi task tích hợp và lệnh check của plan chạy lại thành công trên checkout cuối.

## Nhánh mở rộng — Model API qua 9router

- Hai endpoint đã qua smoke test kết nối trong chat; cần test riêng tool calling, streaming, lỗi và khả năng tương thích trước khi dùng làm worker.
- Adapter API cần tool loop đọc/sửa file/chạy lệnh với kiểm soát workspace, giới hạn lượt và ghi sự kiện. Một lần chat completion chưa tạo thành coding agent.
- Ưu tiên sau M3, trừ khi chọn API làm manager sớm; khi đó thực hiện spike tool-calling trước M2.

## Kiểm chứng và tiêu chí phát hành

- Unit tests tập trung vào state machine, lease, idempotency và transaction.
- Integration tests dùng subprocess giả lập để tái hiện crash, timeout, fragmented output, duplicate events và stop.
- Live smoke tests chạy riêng, có giới hạn chi phí/thời gian; lưu kết quả đã loại bỏ secrets.
- CI: npm ci, typecheck, build; thêm test khi module có hành vi. Thử Windows trước, mở rộng OS sau.
- Release MVP chỉ khi M1–M3 đạt; công bố rõ phục hồi/worktree/UI còn ở mốc sau.

## Việc tiếp theo

Phase 8 đã triển khai recovery và vòng sửa có ngân sách, live manager 9router + hai worker agy đạt với ngoại lệ quyền được duyệt riêng. UI đã nghiệm thu trên runtime fixture ngày 2026-10-29; CI Windows/Ubuntu Node 24/26 đạt tại commit `4b99c39`. Xem [kiểm chứng Phase 8](PHASE8-VALIDATION.md).

1. M7 đã đóng. Khi dùng Antigravity thường xuyên, cấu hình quyền công cụ phù hợp; runtime giữ nguyên approval gate và không tự bỏ duyệt. Xem [kiểm chứng Phase 7](PHASE7-VALIDATION.md).
2. Benchmark tải/log và tài khoản thực tế trước khi nâng capacity trên 4.
3. Trước tác vụ dài không giám sát: containment tiến trình Windows mạnh hơn và mở rộng kiểm chứng crash recovery.
4. Bổ sung giao thức waiting_input/waiting_permission khi có adapter tương tác.

Không cam kết lịch theo ngày trước spike M2: độ ổn định adapter và vòng đời tiến trình Windows là hai yếu tố chưa được đo đủ.
