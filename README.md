# Rarp

CLI điều phối nhiều AI agent trên máy local: lập kế hoạch, giao việc, nhận kết quả, nghiệm thu và yêu cầu sửa. Stack: TypeScript + Node.js; SQLite cho dữ liệu bền vững. UI trực quan sẽ dùng cùng runtime.

## Trạng thái

Phase 7 đã triển khai, chưa đóng nghiệm thu do live Antigravity còn bị từ chối quyền công cụ. Phase 7 bổ sung mục tiêu, planner read-only, đề xuất có revision/hash và duyệt rõ ràng trước thực thi. Đã kiểm chứng UI fixture và Codex thật đến tích hợp local; xem [kiểm chứng Phase 7](docs/PHASE7-VALIDATION.md). Phase 6 bổ sung hàng chờ bền vững và nhiều workflow cách ly chạy đồng thời. Mặc định 2 slot workflow, 1 reviewer; cấu hình 1–16 slot và đã kiểm chứng 4 worker bằng barrier. Dashboard hiển thị mọi workflow, slot trống, reviewer và lý do chờ. Giữ các chức năng worktree/recovery, diff/evidence và event replay. Xem [kiểm chứng Phase 6](docs/PHASE6-VALIDATION.md).

## Phase 7: mục tiêu và duyệt kế hoạch

Dashboard mở tab **Mục tiêu & kế hoạch**. Nhập mục tiêu, yêu cầu, tiêu chí nghiệm thu và giới hạn worker; lưu rồi yêu cầu phân tích read-only. Planner không được chạy build/test hoặc worker triển khai trước approval.

Xem đề xuất, scope, dependency, wave, argv kiểm thử và chính sách review. Trả lời câu hỏi chưa rõ hoặc sửa JSON để tạo revision mới. Chọn Codex/Antigravity và profile riêng cho từng worker, giới hạn slot/reviewer, chính sách tích hợp; xác nhận rồi bấm **Duyệt và chạy**. Runtime kiểm tra revision/hash và trạng thái repository; CLI/profile không có sẽ báo lỗi, không fallback. Đóng hoặc reload trang không đồng nghĩa duyệt.

Kế hoạch lưu trong SQLite; draft nhập liệu và binding chưa duyệt giữ ở trình duyệt. Tạm dừng chỉ chặn lượt giao việc mới của kế hoạch; hủy chỉ tác động các task liên quan. Tích hợp `reviewed-local` không push/deploy; `manual` cần thao tác tích hợp riêng trước khi dependency tiếp tục.

## Phase 6: nhiều worker

```powershell
npm run build
node dist/cli/index.js runtime start --max-workers 4 --max-reviewers 1
node dist/cli/index.js workflow run TASK_ID --isolated --scope src/feature.mjs --check-json '["node","--test","tests/feature.test.mjs"]' --enqueue --request-key feature-v1
node dist/cli/index.js runtime status
node dist/cli/index.js runtime queue
node dist/cli/index.js runtime cancel --task TASK_ID
node dist/cli/index.js runtime pause
node dist/cli/index.js runtime resume
```

Gửi các task độc lập với worker khác nhau và scope không chồng nhau. `--enqueue` lưu yêu cầu để chờ slot, worker, scope và dependency; bỏ cờ này thì yêu cầu chưa sẵn sàng trả lỗi ngay. Mỗi task chỉ có một dispatch đang chờ/chạy. Cùng request key không tạo attempt mới; retry đã thất bại cần key mới. Queue không tự phân rã hoặc tự lấy mọi task queued: chỉ nhận yêu cầu đã gửi vào scheduler.

Một slot giữ toàn bộ vòng worker → verification → chờ reviewer → review → sửa. `maxReviewers` giới hạn riêng số lượt review thực sự đang chạy trong các slot đó. Cùng worker ID không nhận hai workflow; phạm vi file/thư mục chồng nhau phải chờ. Task `accepted` chưa tích hợp vẫn giữ phạm vi để tránh task sau bắt đầu từ code cũ. Task phụ thuộc chờ cả nghiệm thu và tích hợp của dependency cách ly.

```powershell
node dist/cli/index.js task integrate ACCEPTED_TASK_ID
```

Tích hợp được xếp nối tiếp, có thể chạy trong lúc các worktree độc lập khác hoạt động. Checkout chính chỉ cập nhật sau kiểm thử trên kết quả chung. Verification chạy bất đồng bộ, có timeout và cleanup cây tiến trình. UI gửi yêu cầu tích hợp bất đồng bộ, hiển thị trạng thái thực tế; API `{taskId, async:true}` trả 202, mặc định vẫn đợi kết quả để tương thích CLI. Các thao tác Git ngắn vẫn đồng bộ.

`runtime cancel --task ID` dừng đúng một workflow hoặc bỏ dispatch khỏi hàng chờ; các workflow khác tiếp tục. Khi có nhiều workflow, `runtime cancel` không có ID bị từ chối. `runtime stop` dừng mọi cây tiến trình do runtime quản lý. Pause chỉ ngăn dispatch mới, không dừng công việc đang chạy. Sau restart có queue tồn đọng, scheduler luôn paused; dùng `runtime resume` để tiếp tục. Sau crash phải `runtime recover` trước; dispatch đang chạy thành interrupted, không tự replay side effect. Kết quả accepted và commit được giữ; review gián đoạn có thể resume bằng key mới.

Snapshot có `workers[]`, `queue[]`, `limits`, `paused`, `integration`, `lastIntegration`. `active` vẫn là workflow đầu tiên để giữ tương thích client cũ; client nhiều worker phải dùng `workers[]`. Có thể đăng ký nhiều worker, nhưng 16 chỉ là giới hạn cấu hình, không phải khẳng định khả năng tài khoản/máy.

Demo tạm không gọi model: `node scripts/demo-phase6.mjs`; Enter giải phóng barrier worker/reviewer. Bài AI thật có tiêu thụ hạn mức: `node scripts/smoke-phase6.mjs --model gpt-6.1-sol --plain-tools`. Cờ `--plain-tools` tắt user hooks chỉ cho tiến trình test; giữ sandbox/approval. `--codex PATH` chọn executable có sẵn. Chi tiết và giới hạn xem báo cáo kiểm chứng.

## Phase 5: dashboard local

```powershell
npm ci
npm run build
node dist/cli/index.js runtime start
node dist/cli/index.js ui
```

Mở liên kết được in bởi `ui` trong trình duyệt. Dự án cần `init` và agent như hướng dẫn bên dưới. Dashboard được phục vụ từ chính runtime, không cần Vite dev server. Token nằm trong URL fragment, được xóa khỏi thanh địa chỉ sau khi đọc và giữ trong sessionStorage của tab để reload; không đưa liên kết này vào issue hoặc chia sẻ công khai. Runtime chỉ bind `127.0.0.1`, không hỗ trợ truy cập từ xa.

UI cho phép đăng ký agent, tạo task/dependency, chạy workflow trong worktree riêng, dừng workflow, đưa task lại queued, đổi worker, review thủ công, hủy task và tích hợp commit. Mọi thao tác hiển thị pending/succeeded/failed; lỗi đầu vào hoặc trạng thái cũ không được báo thành công. Actor vẫn là ID trong môi trường local tin cậy, không phải hệ thống tài khoản đa người dùng.

Đóng UI không dừng runtime. Khi mở lại, snapshot và cursor tải trạng thái hiện tại; stream reconnect tiếp từ sự kiện đã nhận. Tổng quan giữ tối đa 200 sự kiện; log theo task có phân trang (100 mỗi trang, tối đa 1.000 trong bộ nhớ UI). Lịch sử đầy đủ vẫn nằm trong SQLite/CLI. Quan hệ dependency được trình bày bằng các cạnh có thể chọn, chưa có canvas kéo/thả. Diff giới hạn 2 MiB và hiển thị commit checkpoint, không phải thay đổi chưa commit. Lệnh verification/merge vẫn chạy đồng bộ như Phase 4 nên có thể làm UI chờ phản hồi.

Chạy demo tạm, không gọi model trả phí:

```powershell
node scripts/demo-phase5.mjs
```

Demo in thư mục repository tạm và URL dashboard; dùng fixture cho worker/reviewer. `Ctrl+C` dừng demo. Xem [kiểm chứng Phase 5](docs/PHASE5-VALIDATION.md).

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

`worker run` sửa trực tiếp thư mục dự án nên chạy độc quyền; nhiều workflow cách ly dùng scheduler Phase 6 ở trên. Worker xong chỉ chuyển sang `submitted`, manager vẫn review bằng CLI. Timeout/cancel/lỗi chuyển sang `failed` và lưu lý do; cancel runtime không đồng nghĩa hủy task vĩnh viễn. Có thể cho retry bằng manager chuyển `queued`. Không thao tác chuyển trạng thái thủ công của task đang được runtime chạy.

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

Một workflow chạy worker/reviewer nối tiếp trong cùng worktree; nhiều workflow cách ly có thể chạy song song qua Phase 6. Chưa tự phân rã mục tiêu, tự nhận mọi task queued hoặc resume phiên model sau crash. Queue chỉ chứa yêu cầu enqueue tường minh; dependency cần accepted và integrated trước khi dispatch cách ly.

Antigravity mặc định dùng sandbox, không tự bỏ duyệt quyền. Headless có thể trả SUCCESS nhưng kèm denied_actions; adapter coi đây là thất bại. Script kiểm thử thật `node scripts/smoke-phase3.mjs` chạy hai task nối tiếp qua Antigravity và Codex; `--codex-only` thử riêng Codex. Tùy chọn `--allow-agy-auto-approve` chỉ dành cho bài test tạm khi người dùng cho phép rõ ràng: nó thêm dangerously-skip-permissions cho tiến trình Antigravity đó, không sửa cấu hình lâu dài và không phải một sandbox giới hạn thư mục.
