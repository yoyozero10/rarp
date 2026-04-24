# Rarp

CLI điều phối nhiều AI agent trên máy local: lập kế hoạch, giao việc, nhận kết quả, nghiệm thu và yêu cầu sửa. Stack: TypeScript + Node.js; SQLite cho dữ liệu bền vững. UI trực quan sẽ dùng cùng runtime.

## Trạng thái

Phase 4 bổ sung Git worktree riêng cho worker, kiểm tra scope, commit/test evidence, tích hợp tuần tự và recovery có lease/idempotency. Giữ các chức năng Phase 3: SQLite, task/dependency, review và worker Codex/Antigravity. Chưa có UI. Kiểm thử live hai worker nối tiếp bằng GPT-6.1 Sol đã đạt; xem [kiểm chứng Phase 4](docs/PHASE4-VALIDATION.md). Mỗi dự án hiện chạy tối đa một worker tại một thời điểm.

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

## Phase 4: worktree và phục hồi có kiểm soát

Workflow có thể chạy trong Git worktree riêng; checkout chính phải sạch, `.rarp/` phải được bỏ qua bởi Git. Scope là danh sách file/thư mục tương đối với repo, không phải sandbox bảo mật. Lệnh kiểm tra chạy bằng executable và argv, không qua shell.

```powershell
node dist/cli/index.js workflow run TASK_ID --isolated --scope src --check-json '["node","--test"]' --request-key feature-v1
node dist/cli/index.js task integrate TASK_ID
node dist/cli/index.js events --after 0
```

Worker tạo commit, chạy check, manager review. Chỉ task `accepted` mới được tích hợp. Runtime merge trong worktree tích hợp, chạy lại check trên kết quả chung, rồi fast-forward checkout chính. Conflict hoặc check lỗi giữ nguyên checkout chính; sửa và commit conflict trong worktree tích hợp được báo lỗi, sau đó gọi lại `task integrate`.

Sau crash, không tự chạy lại worker:

```powershell
node dist/cli/index.js runtime recover
node dist/cli/index.js runtime start
node dist/cli/index.js workflow run TASK_ID --isolated --resume-review --request-key review-v2
```

Recovery chỉ cho phép khi runtime/host không còn sống và lease 15 giây đã hết. Task đang chạy thành `failed`, file sửa được giữ; manager phải kiểm tra rồi chuyển `queued` và dùng request key mới nếu muốn retry. Review gián đoạn trở về `submitted`, có thể dùng `--resume-review`; task đã accepted không review lại. Cùng request key và cùng nội dung trả run cũ, không tạo attempt mới. Scope/check của workspace đã tạo không được thay đổi. Event có cursor `--after` để đọc tiếp; không có consumer tự replay side effect.

Kiểm thử hai worker sửa feature và tích hợp tuần tự, không dùng tài khoản AI:

```powershell
npm run build
node scripts/smoke-phase4.mjs --fixture
```

Bỏ `--fixture` để dùng Codex thật, có tiêu thụ hạn mức tài khoản. Fixture reviewer không thay thế nghiệm thu bằng model thật. Chưa bảo đảm containment tiến trình cố ý tách cây, tự tiếp tục phiên model, hay tự giải quyết conflict. Worktree được giữ để kiểm tra thủ công.

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

## Phase 3: workflow tự review và sửa

```sh
node dist/cli/index.js runtime start
node dist/cli/index.js workflow run TASK_ID --adapter antigravity --max-rounds 3 --timeout-ms 120000 --total-timeout-ms 600000
node dist/cli/index.js runtime status
node dist/cli/index.js task show TASK_ID --json
node dist/cli/index.js runtime stop
```

`--adapter codex` là mặc định. Có thể chọn `--agy PATH` khi start runtime. Manager hiện dùng Codex ở sandbox read-only, độc lập với worker. Manager nhận yêu cầu gốc và báo cáo worker, kiểm tra file rồi trả JSON theo `schemas/review.json`; Rarp kiểm tra lại bằng Zod. Quyết định bắt buộc có feedback và evidence. Model review vẫn có thể đánh giá sai; cần kiểm thử phù hợp trước khi tích hợp code quan trọng.

`changes_requested` được lưu cùng evidence rồi chuyển thành feedback cho attempt mới. Hết max-rounds thì task giữ `changes_requested`; manager có thể đưa lại queued thủ công. Output review không hợp lệ, timeout, quyền công cụ bị từ chối hoặc cancel sẽ dừng workflow, không tự retry lỗi hạ tầng và không tự accept. Lỗi trong review chuyển task sang failed nhưng giữ nguyên attempt đã submitted. Events phân biệt worker.output và review.output, cùng task/attempt ID.

Một workflow chạy từng worker/reviewer nối tiếp trong cùng thư mục. Chưa tự phân rã mục tiêu, tự nhận task từ queue, chạy nhiều worker song song hoặc phục hồi vòng đang chạy sau crash. Task dependency vẫn cần accepted trước khi dispatch.

Antigravity mặc định dùng sandbox, không tự bỏ duyệt quyền. Headless có thể trả SUCCESS nhưng kèm denied_actions; adapter coi đây là thất bại. Script kiểm thử thật `node scripts/smoke-phase3.mjs` chạy hai task nối tiếp qua Antigravity và Codex; `--codex-only` thử riêng Codex. Tùy chọn `--allow-agy-auto-approve` chỉ dành cho bài test tạm khi người dùng cho phép rõ ràng: nó thêm dangerously-skip-permissions cho tiến trình Antigravity đó, không sửa cấu hình lâu dài và không phải một sandbox giới hạn thư mục.
