# Kiểm chứng Phase 7

Nghiệm thu đóng phase: 2026-10-25 (Asia/Saigon). Môi trường Windows, Node.js 26. Vòng rà soát ban đầu: 2026-10-24.

## Kết quả

- `npm run typecheck`: đạt backend/frontend.
- `npm test`: build TypeScript/Vite thành công; 59/59 tests đạt.
- Tests Phase 7 bao phủ DAG/scope/argv, clarification, revision/hash cũ, materialization transaction rollback, approval trùng/restart, profile/repository thay đổi, hủy riêng execution, replan và dependency chờ integration; giới hạn execution không vượt slot đã duyệt.
- Trình duyệt thật, repository fixture tạm: lưu mục tiêu, phân tích read-only, xem CLI/profile/model; trước approval vẫn 0 task. Reload giữ kế hoạch, checkbox không tự duyệt. Bấm duyệt rõ ràng; task accepted, commit tích hợp, kế hoạch completed.
- Bàn giao trước ghi nhận Codex thật đã hoàn tất đến integration. Vòng nghiệm thu 2026-10-24 xác minh planner thật và worker Codex ghi đúng bytes/qua verification trong bài hỗn hợp, nhưng chưa hoàn tất cả chu trình: Antigravity từ chối quyền công cụ. Lượt Codex đơn kế tiếp dừng vì tài khoản báo usage limit. Không tính các lượt này là live end-to-end đạt.
- Script `node scripts/phase7-live.mjs` (Codex) và `node scripts/phase7-live.mjs --mixed` (Codex + Antigravity) giữ repository tạm trong TEMP, in đường dẫn và lưu `.rarp/phase7-result.json` khi execution kết thúc. Approval tự gửi chỉ thuộc smoke test chủ động; planner/UI không tự duyệt.

## Kết luận nghiệm thu

**Đã đóng Phase 7 ngày 2026-10-25.** Contract/storage, API/CLI/UI, 59/59 tests, CI Windows/Linux và live Codex đơn/hỗn hợp đã đạt.

### Nghiệm thu cuối

- Codex đơn: `rarp-phase7-live-Em8r8e`, một task/worker, completed; reviewer accepted, verification và integration đạt ngay attempt đầu. HEAD cuối `969e065c51483c9f3ef9ee984f6d0029d381b61d`.
- Hỗn hợp: `rarp-phase7-live-Y9rdiF`, hai task/worker độc lập (Codex và Antigravity `gemini-3.8-flash-medium`), chạy song song; cả hai accepted, verification và integration đạt ngay attempt đầu. HEAD cuối `9e2337766078a47f54b714f6040568257ba14408`.
- Kiểm tra độc lập sau runtime: file đúng bytes `[97,102,116,101,114,10]`, main checkout sạch, mọi task integrated, runtime đã dừng. SQLite và `.rarp/phase7-result.json` giữ trong các thư mục TEMP để đối chiếu.
- Antigravity `accept-edits` và `auto` thông thường đều từ chối RunCommand trên máy này. Người dùng đã duyệt riêng `--dangerously-skip-permissions` cho bài test TEMP ngày 2026-10-25. Lượt mixed đạt dùng đúng quyền này, giữ `--sandbox`; không đổi profile/runtime mặc định hay cấu hình toàn cục. Đây không phải xác nhận luồng non-interactive hoạt động với cấu hình quyền mặc định của Antigravity.
- Script chỉ bật override khi gọi rõ `--mixed --ag-test-skip-permissions`; kiểm tra guard xác nhận không thể dùng cờ này ngoài mixed smoke. Lần test tương lai cần quyền phù hợp, không kế thừa phê duyệt tạm của lần này.
- Bộ test 59/59 và ma trận Node 24/26 trên Windows/Ubuntu đạt tại commit `ca6fc62`: [CI](https://github.com/yoyozero10/rarp/actions/runs/40111260383). Thay đổi đóng phase chỉ bổ sung tùy chọn smoke và báo cáo; `npm run build`, syntax check và guard smoke đạt.

Các lỗi đã sửa trong vòng nghiệm thu:

- Windows giữ handle thư mục test: chuyển fixture ra TEMP, retry cleanup có giới hạn.
- Dispatch lỗi trước khi worker chạy: kế hoạch chuyển paused kèm nguyên nhân, tránh treo executing.
- Profile Antigravity: chèn `--model` trước `--print`, không để option trở thành prompt.
- CLI/API analyze: timeout 130 giây, dài hơn deadline planner 120 giây; các request khác giữ 20 giây.
- Approval: từ chối checkout bẩn trước materialization kể cả fingerprint khớp; không tạo task/dispatch.
- Codex stream: giữ thông báo lỗi có cấu trúc để UI hiển thị usage limit/authentication thay vì lỗi exit chung.

Bổ sung test hồi quy cho dispatch failure, dirty checkout, model argument ordering, error details và hai protocol Codex/Antigravity cùng kế hoạch. UI được kiểm chứng lại bằng trình duyệt: 0 task trước duyệt, reload bỏ checkbox xác nhận, sau duyệt accepted và integrated.

Bằng chứng live (TEMP, không commit database/log tài khoản):

- `rarp-phase7-live-3bnVus`: phát hiện lỗi vị trí `--model`, đã sửa.
- `rarp-phase7-live-6A1x5w`: phát hiện timeout analyze 20 giây, đã sửa.
- `rarp-phase7-live-CFvK8u`: Codex qua verification; Antigravity bị từ chối quyền.
- `rarp-phase7-live-Oa6nno`: thử lại Antigravity với `--mode accept-edits`, vẫn bị từ chối quyền; execution paused. Không dùng cờ bỏ duyệt.
- `rarp-phase7-live-OnkGTI`: planner Codex đạt; worker bị tài khoản chặn vì usage limit.

Các điều kiện đóng đã được kiểm chứng trong vòng nghiệm thu cuối ở trên. Các runtime thử nghiệm đã dừng.

## Sử dụng

Runtime cần đang chạy. UI mặc định tab Mục tiêu & kế hoạch. CLI dùng JSON file:

```powershell
node dist/cli/index.js goal create --file goal.json
node dist/cli/index.js plan analyze PLAN_ID
node dist/cli/index.js plan show PLAN_ID
node dist/cli/index.js plan update PLAN_ID --file revision.json
node dist/cli/index.js plan approve PLAN_ID --file approval.json
node dist/cli/index.js plan pause PLAN_ID
node dist/cli/index.js plan cancel PLAN_ID
```

Goal: `title`, `requirements`, `acceptance` (mảng), `maxWorkers`. Update: `revision`, `proposal`. Approval: `revision`, `contentHash`, `actor: "human"`, `maxWorkers`, `maxReviewers`, `workers` gồm `workerRef/adapter/profile`, `integration` = `reviewed-local` hoặc `manual`. Dùng đúng nội dung proposal/hash trả về; thay đổi yêu cầu phải tạo revision và duyệt lại.

Profile do người dùng cung cấp trong `.rarp/profiles.json`, key `adapter:profile`. Mỗi entry gồm `adapter`, `command` (`file`, `args`, tùy chọn `protocol`/`promptArgument`), `model`, `authenticated`. Không chứa API key. Runtime kiểm tra executable và cấu hình; Codex mặc định dùng `login status`. `/profiles` chỉ trả metadata không chứa credential. Profile thay đổi sau approval làm execution dừng trước dispatch.

## Giới hạn

- Antigravity thật và mixed protocol đã đạt với quyền test được người dùng duyệt riêng. Khi dùng thường, cần cấu hình quyền công cụ phù hợp; runtime không tự thêm cờ bỏ duyệt hoặc fallback Codex.
- Môi trường local tin cậy, không phải sandbox chống tiến trình cùng tài khoản cố ý đọc token/database. Planner không nhận token approval từ prompt.
- Pause chặn dispatch mới, không đình chỉ workflow đang chạy. Failed work cần revision được xem/duyệt lại. Không push hoặc deploy.
- Git newline conversion Windows có thể làm verification/integration dừng đúng thiết kế; live smoke cấu hình LF trên repository tạm.
- UI cho sửa JSON, xem lịch sử revision thô; chưa có trình so sánh diff trực quan. Chưa benchmark capacity trên 4 worker; live hỗn hợp đạt với ngoại lệ quyền test nêu trên.
