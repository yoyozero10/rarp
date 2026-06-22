# Phase 7 — Nhận mục tiêu, lập kế hoạch và duyệt trước khi chạy

Trạng thái: đã đóng nghiệm thu ngày 2026-10-25. UI/CLI/API, SQLite v4, planner read-only, approval revision/hash và executor đã đạt; 59/59 tests, CI Windows/Linux, live Codex đơn và mixed Codex/Antigravity hoàn tất đến integration. Antigravity dùng ngoại lệ quyền test được người dùng duyệt riêng, không đổi mặc định runtime. Xem [báo cáo kiểm chứng](PHASE7-VALIDATION.md).

## Luồng người dùng

1. Người dùng nhập mục tiêu, yêu cầu nghiệm thu và giới hạn mong muốn.
2. Planner đọc repository ở chế độ read-only, kiểm tra phần đã có và điểm còn thiếu. Chỉ lượt phân tích được phép chạy ở bước này; chưa khởi động worker thực thi.
3. Rarp trình kế hoạch: các đầu việc, dependency, phạm vi file, cách kiểm thử, số worker đề xuất, số slot đồng thời và lý do chọn.
4. Người dùng sửa kế hoạch nếu cần và chọn CLI cho từng worker hoặc một CLI chung. Giai đoạn đầu hỗ trợ Codex/Antigravity, có thể trộn trong một kế hoạch.
5. Người dùng bấm **Duyệt và chạy**. Runtime xác nhận đúng revision/hash, cấu hình CLI và trạng thái repository rồi mới tạo task, đăng ký worker logic và enqueue.
6. Executor giao việc theo dependency; reviewer kiểm tra, tích hợp tuần tự theo chính sách đã duyệt, rồi giải phóng task phụ thuộc. UI cập nhật tiến độ và các điểm cần quyết định.

Nếu mục tiêu chưa rõ, trạng thái là `needs_clarification`: hỏi người dùng trước khi chốt kế hoạch. Không suy diễn việc người dùng im lặng, planner ghi “đã duyệt” hoặc một phiên chat khác đồng ý thành phê duyệt.

## Đầu việc và worker là hai con số khác nhau

- **Đầu việc** là đơn vị có đầu ra, scope và tiêu chí nghiệm thu riêng. Không tách nhỏ chỉ để tăng số task.
- **Worker logic** là agent có ID và CLI được chọn, có thể xử lý nhiều task nối tiếp.
- **Slot đồng thời** là giới hạn workflow đang chạy của scheduler; một worker ID chỉ nhận một workflow mỗi lần.
- Planner và reviewer được báo riêng, không tính vào số worker thực thi được đề xuất. Lượt review vẫn chịu giới hạn Phase 6 và workflow chờ review vẫn giữ slot.

Planner ưu tiên một task/một worker cho sửa nhỏ. Tách khi có đầu ra độc lập, có ranh giới file/module rõ hoặc cần một bước nền tảng trước bước khác. Các thay đổi trong cùng phạm vi file được gom cho một worker, hoặc sắp thứ tự dependency để tránh sửa chồng nhau.

Số slot đề xuất không vượt `min(runtime.maxWorkers, mức song song an toàn của DAG, giới hạn người dùng)`. Giảm thêm khi task quá nhỏ, phần lớn phụ thuộc nối tiếp hoặc chi phí khởi động/review lớn so với công việc. Mức song song được tính sau khi xét scope, worker ownership, review và integration gate; không lấy số task làm số worker. Mặc định đề xuất tối đa 4 vì đây là mức đã kiểm chứng; cấu hình cao hơn cần người dùng chọn rõ.

Ví dụ một mục tiêu có thể thành 5 đầu việc nhưng chỉ cần 2 worker:

| Đầu việc | Phụ thuộc | Worker được tái sử dụng |
|---|---|---|
| Chốt contract dữ liệu/API | Không | W1 |
| Backend | Contract | W1 |
| Frontend | Contract | W2 |
| Kiểm thử backend | Backend | W1 |
| Kiểm thử tích hợp UI/API | Frontend, kiểm thử backend | W2 |

Người dùng có thể chọn W1 = Codex, W2 = Antigravity. Backend/frontend chạy song song sau khi contract được nghiệm thu và tích hợp. Không cần worker thứ ba chỉ để nhận task cuối.

## Nội dung đề xuất phải xem được trước khi duyệt

- Mục tiêu gốc; yêu cầu đã hiểu; giả định và câu hỏi chưa giải quyết.
- Danh sách step với khóa ổn định, tiêu đề, yêu cầu, deliverable, dependency và workerRef.
- Scope tương đối với repo, command kiểm thử dạng executable + argv, điều kiện nghiệm thu.
- Số task, worker, slot; các wave chạy; lý do tách/gom và nút thắt nối tiếp.
- Kích thước công việc tương đối và độ tin cậy; không bịa thời gian, token hay chi phí chính xác khi chưa có số đo.
- Base HEAD, revision/hash của kế hoạch và chính sách retry/review/integration.
- Cấu hình CLI/model/profile người dùng chọn; reviewer và giới hạn lượt/thời gian.

UI dùng wizard gọn: **Mục tiêu → Đề xuất → Chọn CLI & duyệt → Thực thi**. Có nút sửa, yêu cầu lập lại, từ chối và duyệt. CLI/API phải thể hiện cùng vòng đời, không chỉ UI có gate.

## Planner và validation

Ban đầu dùng Codex CLI read-only trả JSON theo JSON Schema, rồi kiểm tra bằng Zod như reviewer hiện có. Planner chỉ đề xuất; runtime kiểm tra và materialize. Không chạy build/test từ planner khi chưa duyệt, vì lệnh được gọi có thể sửa file hoặc tạo tiến trình ngoài lượt phân tích.

Validator phải kiểm tra:

- Schema, số lượng task/worker và giới hạn kích thước; mỗi step có đầu ra, scope và test/tiêu chí kiểm chứng.
- Step/workerRef không trùng, dependency tồn tại, DAG không có chu trình, mọi step tham chiếu worker hợp lệ.
- Scope là đường dẫn tương đối an toàn, không có `.git`, `.rarp` hoặc traversal. Scope chồng nhau cần serialization rõ ràng, không được đề xuất chạy song song.
- Adapter nằm trong allowlist đã triển khai. CLI chưa có adapter hiển thị “chưa hỗ trợ”, không tự fallback sang CLI khác.
- Lệnh kiểm thử là argv, không là chuỗi shell do model tự nối. Không chấp nhận cờ tự bỏ duyệt/sandbox do planner tự thêm.
- Tiêu chí nghiệm thu phải quan sát được bởi reviewer. Hướng dẫn cách dùng tool không được biến thành yêu cầu lịch sử thực thi mà reviewer không có bằng chứng để xác minh.

Nếu validator sửa cấu trúc đề xuất, phải tạo revision mới và hiển thị lại; không sửa ngầm sau khi người dùng đã duyệt.

## Duyệt và chọn CLI

Chọn CLI theo worker, không theo tên role chung. Binding được chốt trong approval:

```json
{
  "planId": "plan-…",
  "revision": 2,
  "contentHash": "…",
  "maxWorkers": 2,
  "maxReviewers": 1,
  "workers": [
    { "workerRef": "W1", "adapter": "codex", "profile": "default" },
    { "workerRef": "W2", "adapter": "antigravity", "profile": "default" }
  ],
  "integration": "reviewed-local"
}
```

Profile do người dùng cấu hình/allowlist cung cấp executable và model; không lưu API key trong plan hoặc events. Trước approve-and-run, kiểm tra executable có sẵn, khả năng hỗ trợ adapter và cấu hình đăng nhập bằng kiểm tra không làm lộ credential. Thiếu CLI/model/profile phải báo lỗi trước dispatch, không đổi lựa chọn của người dùng.

Mọi sửa đổi mục tiêu, dependency, scope, worker binding, model hoặc giới hạn đã duyệt làm approval cũ không còn hiệu lực. Người dùng xem lại revision trước khi chạy tiếp phần bị thay đổi. Phê duyệt khớp chính xác revision/hash; HEAD hoặc nội dung file liên quan thay đổi từ lúc phân tích thì cần đánh giá lại trước dispatch.

Planner không được giữ quyền gọi endpoint approve/dispatch. Gate ở runtime/API kiểm tra trạng thái và quyền approval riêng, không tin trạng thái do model trả về. Các agent cùng tài khoản Windows vẫn thuộc mô hình local tin cậy; đây không thay thế filesystem/process isolation trước tiến trình có chủ ý đọc credential hoặc sửa database.

## Trạng thái và lưu trữ dự kiến

Giữ nguyên state machine task. Thêm vòng đời cho mục tiêu/kế hoạch:

`received → analyzing → needs_clarification | awaiting_approval → approved → materializing → executing → completed`

Các nhánh bổ sung: `revision_requested`, `rejected`, `paused`, `failed`, `cancelled`. Draft sau restart tiếp tục chờ duyệt; một revision đã bị thay thế không thể chạy bằng approval cũ.

SQLite migration v4 dự kiến:

- `goals`: yêu cầu gốc và trạng thái.
- `plans`: goal, revision, JSON validated, base HEAD/file fingerprint, content hash và trạng thái.
- `plan_approvals`: revision/hash, worker bindings, chính sách và người/thời điểm duyệt.
- `plan_task_links`: unique `(plan_id, step_key)` và taskId để materialize/retry không tạo task trùng. Worker bindings có ID ổn định trong approval.

Task/worker links và dispatch được tạo nguyên tử trong storage. Approval và trạng thái materialization được ghi trước khi bắt đầu process. Request key sinh từ plan/revision/step; double-click hoặc crash giữa approve/materialize/start không tạo attempt hoặc worker trùng. Sau crash áp dụng recovery Phase 6; không tự chạy lại side effect đã hoàn tất.

## Executor và thay đổi cần có trong scheduler

- Materialize task theo thứ tự topo, map workerRef sang worker ID đã duyệt; adapter/profile đi cùng dispatch của task đó.
- `maxWorkers` của approval là giới hạn riêng cho execution và không vượt capacity runtime. Không chỉ hiển thị một con số trong UI rồi vẫn chạy theo global limit lớn hơn.
- Dùng queue, scope/worker gate, journal, review pool và cancellation Phase 6.
- Chính sách `reviewed-local` được hiển thị rõ lúc duyệt: tự review và tích hợp các commit accepted vào checkout/branch đã chốt để dependency có thể chạy. Không tự push/deploy. Nếu chọn tích hợp thủ công, dependency chờ và UI giải thích lý do.
- Test fail, conflict, hết vòng sửa/thời gian hoặc thay đổi yêu cầu làm execution paused/needs-decision. Không tự mở rộng scope, thêm worker/CLI hoặc bỏ dependency để tiếp tục.
- Đề xuất replan là revision mới, hiển thị diff với kế hoạch đã duyệt và giữ task/commit đã hoàn thành. Worker mới chỉ được tạo sau lần duyệt tiếp theo.
- Dừng một execution chỉ cancel task/dispatch/integration của execution đó; không vô tình dừng các task khác trong runtime.

## Thứ tự triển khai

1. **M7.1 — Contract/storage:** schema plan, validator DAG/scope, state machine, migration và materialization idempotent. Test approval cũ/trùng/crash trước khi nối model.
2. **M7.2 — Planner:** đọc repo giới hạn, JSON proposal, clarification và đề xuất worker có giải thích. Giữ run phân tích tách run thực thi.
3. **M7.3 — Approval UI/CLI/API:** xem/sửa proposal, dependency/wave, chọn CLI từng worker và duyệt đúng revision. Chưa có approval hợp lệ thì không có worker thực thi.
4. **M7.4 — Executor:** binding CLI/profile, queue theo execution, auto review/integration theo chính sách, pause/cancel/replan có kiểm soát.
5. **M7.5 — Kiểm chứng:** fixture trước, live Codex/Antigravity sau; UI reload/reconnect, crash và CI Windows/Linux.

## Điều kiện nghiệm thu

- Nhận mục tiêu tự đề xuất đầu việc/worker; sửa nhỏ không bị tách thừa. Người dùng thấy lý do và chỉnh được.
- Trước duyệt không có worker thực thi, task con chạy hoặc thay đổi code; planner read-only được ghi log riêng.
- Người dùng chọn Codex/Antigravity riêng từng worker; command thực tế khớp binding, không fallback ngầm.
- Approve trùng hoặc crash không nhân đôi task/attempt; approval sai revision/hash hoặc repo stale bị từ chối.
- Giới hạn execution được giữ, scope/dependency được tôn trọng; task phụ thuộc chỉ bắt đầu sau integration.
- Nghiệm thu live một mục tiêu nhỏ qua toàn chu trình đề xuất → duyệt/chọn CLI → worker → review → integrate → kiểm tra chung. Tình huống cố ý thiếu yêu cầu phải hỏi lại; conflict hoặc task lỗi phải dừng đúng phạm vi.
- Đóng/reload UI hoặc restart runtime không làm mất draft/lựa chọn/approval và không biến kế hoạch chưa duyệt thành công việc đang chạy.
