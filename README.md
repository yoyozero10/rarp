# Rarp

CLI điều phối nhiều AI agent trên máy local: lập kế hoạch, giao việc, nhận kết quả, nghiệm thu và yêu cầu sửa. Stack: TypeScript + Node.js; SQLite cho dữ liệu bền vững. UI trực quan sẽ dùng cùng runtime.

## Trạng thái

Phase 2 đã triển khai: SQLite, task/dependency, attempt, review, durable events, runtime local và worker Codex. Chưa có vòng review tự động, adapter khác hay UI.

## Phát triển

Yêu cầu Node.js >=24 và npm.

```sh
npm ci
npm run dev -- --help
npm run typecheck
npm run build
node dist/cli/index.js about
```

Kế hoạch: [docs/PLAN.md](docs/PLAN.md). Quyết định kiến trúc: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Các thư mục thử nghiệm cũ `.squad-smoke/` và `router-model-test/` được giữ ngoài Git. Không đưa API key, log agent hoặc dữ liệu phiên vào repo.

## Phase 1: dùng thử

Chạy sau `npm run build` (hoặc dùng `npm run dev --` thay cho `node dist/cli/index.js`).

```sh
node dist/cli/index.js init
node dist/cli/index.js agent register manager --role manager
node dist/cli/index.js agent register worker --role worker
node dist/cli/index.js task create --title "Create cart" --actor manager --assignee worker
node dist/cli/index.js task list --json
node dist/cli/index.js status --json
```

Thay `TASK_ID` bằng ID trả về từ lệnh create:

```sh
node dist/cli/index.js task transition TASK_ID running --actor worker --note "Started"
node dist/cli/index.js task transition TASK_ID submitted --actor worker --note "Tests passed"
node dist/cli/index.js task transition TASK_ID reviewing --actor manager --note "Reviewing output"
node dist/cli/index.js task transition TASK_ID accepted --actor manager --note "Verified result"
node dist/cli/index.js task show TASK_ID --json
node dist/cli/index.js events --json
```

- Dùng `changes_requested` thay cho `accepted` để yêu cầu sửa; manager chuyển lại `queued`, worker nhận `running` để tạo attempt mới.
- `--depends-on ID1 ID2` khi tạo task: các dependency phải tồn tại và đều `accepted` trước khi worker bắt đầu. Phase 1 không sửa dependency sau khi tạo, nên cạnh luôn hướng tới task đã tồn tại và không thể tạo chu kỳ qua CLI.
- `--project PATH` chọn thư mục dự án chính xác; không tự dò thư mục cha. Database nằm ở `PATH/.rarp/state.db`. Khi dùng dự án khác, thêm `.rarp/` vào gitignore của dự án đó.
- Init/đăng ký lại cùng agent là idempotent. Chuyển trạng thái lặp lại bị từ chối; chưa có cơ chế retry/idempotency key của runtime.
- Mọi chuyển trạng thái cần `--note`. Chỉ worker được giao nhận/nộp việc; chỉ manager tạo task đó có quyền review và nghiệm thu.
- `--actor` là ID do người gọi khai báo trong môi trường local tin cậy, chưa phải xác thực bảo mật. Người có quyền sửa database vẫn có thể thay dữ liệu.
- Output là JSON; `--json` xuất gọn một dòng. Lỗi trả exit code 1. `events` hiện trả toàn bộ lịch sử; phân trang/cursor sẽ bổ sung trước UI.

SQLite dùng `node:sqlite` có sẵn trong Node, không cần native npm addon. Test local đã chạy trên Windows với Node 26; CI kiểm tra Node 24/26 trên Windows/Linux.

```sh
npm run typecheck
npm test
```

## Phase 2: chạy worker Codex

Yêu cầu Codex CLI đã đăng nhập, hỗ trợ `--no-daemon`, `exec --json`, `--ephemeral`. Bản đã kiểm tra: 0.162.1. Chạy build trước, sau đó init, đăng ký manager/worker và tạo task như trên.

```sh
node dist/cli/index.js runtime start
node dist/cli/index.js worker run TASK_ID --timeout-ms 120000
node dist/cli/index.js runtime status
node dist/cli/index.js task show TASK_ID --json
node dist/cli/index.js runtime cancel
node dist/cli/index.js runtime stop
```

`worker run` trả về ngay khi dispatch; theo dõi bằng runtime status. Có thể dùng `runtime start --codex ABSOLUTE_PATH_TO_CODEX_EXE` nếu Codex không nằm trên PATH. Đường dẫn là executable thật, không phải chuỗi lệnh shell hay file .cmd. `--project PATH` dùng chung cho tất cả lệnh.

Runtime chạy nền độc lập với CLI, bind 127.0.0.1 và giữ token/port trong `.rarp/runtime.json`; file này cũng là khóa tạo độc quyền. Sau stop sạch khóa được xóa. Nếu runtime crash, khóa được giữ để tránh tự chạy trùng; cần kiểm tra tiến trình/task trước khi xóa khóa thủ công. Không tự kill PID đọc từ khóa cũ.

Một runtime xử lý một task mỗi lần. Worker xong chỉ chuyển sang `submitted`, manager vẫn review bằng CLI. Timeout/cancel/lỗi chuyển sang `failed` và lưu lý do; cancel runtime không đồng nghĩa hủy task vĩnh viễn. Có thể cho retry bằng manager chuyển `queued`. Không thao tác chuyển trạng thái thủ công của task đang được runtime chạy.

Trạng thái runtime là starting/ready/working/stopping; kết quả worker là exited/failed. Adapter hiện chạy non-interactive với approval never: không hỗ trợ tiếp tục từ waiting_input/waiting_permission và không suy diễn hai trạng thái đó từ log. Khi bị từ chối công cụ, xem kết quả và log trước khi nghiệm thu.

Log JSONL/stderr được lưu dưới events với taskId/attemptId, tối đa 8 MiB output mỗi lượt và 1 MiB mỗi khung JSONL. Logs có thể chứa nội dung công việc; database luôn nằm ngoài Git. Cleanup dùng taskkill /T /F trên Windows và process group trên Unix, đã test với tiến trình con còn trong cây. Tiến trình cố ý tách khỏi cây và khôi phục khi hệ thống crash chưa được bảo đảm; cần cơ chế containment mạnh hơn trước khi chạy tác vụ dài không giám sát.

Chạy test thật có sử dụng tài khoản Codex (workspace tạm, timeout 120 giây):

```sh
npm run build
node scripts/smoke-phase2.mjs
```

Kết quả kiểm chứng ngày 2026-10-23: worker tạo cart.json đúng số liệu, task submitted, runtime stop thành công. CI chỉ chạy fixtures giả lập, không dùng tài khoản/model thật.
