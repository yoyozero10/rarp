# Rarp

CLI điều phối nhiều AI agent trên máy local: lập kế hoạch, giao việc, nhận kết quả, nghiệm thu và yêu cầu sửa. Stack: TypeScript + Node.js; SQLite cho dữ liệu bền vững. UI trực quan sẽ dùng cùng runtime.

## Trạng thái

Phase 1 đã triển khai: SQLite, task/dependency, attempt, review, durable events và CLI. Chưa có runtime tự động, adapter agent hay UI hoạt động.

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
