# Phase 9: câu hỏi trong quá trình thực thi

Ngày đóng nghiệm thu: 2026-10-31. Phase 9 đạt nghiệm thu chức năng/browser và ma trận runner Windows/Ubuntu × Node 24/26. Ma trận chạy cục bộ trên source đã đối chiếu hash; không phải GitHub Actions hoặc chứng nhận các image hosted `windows-latest`/`ubuntu-latest`.

Sau nghiệm thu, người dùng cho phép commit và push trong comment RAR-15 `ccae6b05-43db-4020-a14d-b6048c850b15` ngày 2026-10-31. Chỉ dẫn mới thay giới hạn không push của các lượt kiểm chứng trước; kết quả commit/push được ghi trên issue. Các mô tả chưa push trong lịch sử bên dưới phản ánh đúng thời điểm kiểm chứng, không phải trạng thái bàn giao source sau chỉ dẫn mới. Không phát hành npm hoặc deploy trong phạm vi này.

## Contract

- Worker thuộc plan có thể trả final response JSON đúng dạng `{"rarp_input":{"question":"Nội dung câu hỏi"}}`. Không suy đoán trạng thái chờ từ văn bản tự do. Giao thức này dùng final response của Codex/Antigravity; không mở stdin tương tác hoặc phục hồi phiên model.
- Sau khi subprocess kết thúc và được cleanup, task chuyển `blocked`, plan chuyển `waiting_input`. Không checkpoint, check, review hoặc tích hợp phần việc dở. Worktree được giữ để lượt tiếp theo xử lý.
- Câu hỏi lưu trong `execution.tasks[taskId].input`, gồm `requestId` là attempt ID, `question` và câu trả lời khi có. SQLite hiện tại không cần migration. Chỉ giữ câu hỏi gần nhất; báo cáo worker và sự kiện usage giữ lịch sử.
- `POST /plans/:id/answer` nhận `{taskId, requestId, answer}`. API/storage kiểm tra task thuộc plan đã duyệt, task blocked, request hiện tại và attempt cuối của task. Câu trả lời 1–12000 ký tự sau trim; không chấp nhận field lạ. Gửi lại cùng nội dung là idempotent; thay câu trả lời đã lưu hoặc gửi request của attempt trước bị từ chối.
- Trả lời chỉ lưu dữ liệu, chưa dispatch. `resume` yêu cầu trả lời đủ câu hỏi, còn ngân sách, fingerprint/HEAD và profile đã duyệt vẫn khớp. Câu trả lời được đưa vào `USER_INPUT` trong prompt mới, không thay approval/quyền/phạm vi/check.
- Lượt hỏi vẫn tiêu một round, không tiêu retry. Thời gian executing trước khi chờ được giữ; thời gian ở trạng thái chờ không tính. Hết lượt/thời gian cần revision mới và duyệt lại, không tự cộng ngân sách.
- CLI: `rarp plan answer PLAN_ID --file answer.json`, rồi `rarp plan resume PLAN_ID`. UI hiển thị câu hỏi theo task, cho lưu câu trả lời và tiếp tục bằng thao tác riêng. Cancel vẫn có hiệu lực.

## Ma trận runner đã xác minh ngày 2026-10-31

Theo comment người dùng `a33c7048-0130-4f50-8ef7-bcd661208017`, [bundle ma trận, snapshot, manifest và log](/api/attachments/79006a4a-a3a8-41aa-9228-263b35306848/content?download=1) có SHA256 `5e09cafe9fd452e5cee324bf26cd1b8d48b07bffb3a18ee02ccd1a94d4297128`. Agent tải bundle và kiểm tra checksum, đọc báo cáo, environment, script runner, results, log test/package và source-check; không chạy lại các bước đã đạt.

| Runner | Node | npm ci | typecheck | npm test | package check |
| --- | --- | --- | --- | --- | --- |
| Windows 11 build 26300 | 24.22.2 | exit 0 | exit 0 | exit 0, 93/93 | exit 0 |
| Windows 11 build 26300 | 26.13.0 | exit 0 | exit 0 | exit 0, 93/93 | exit 0 |
| Ubuntu 24.04 container x64 | 24.22.2 | exit 0 | exit 0 | exit 0, 93/93 | exit 0 |
| Ubuntu 24.04 container x64 | 26.13.0 | exit 0 | exit 0 | exit 0, 93/93 | exit 0 |

Cả bốn log test có fail/cancelled/skipped/todo bằng 0; `npm test` gồm build TypeScript/Vite. Package check trên từng tổ hợp xác nhận tarball allowlist, installed bin, production dependencies, doctor, dashboard assets, planner, worker, review và integration; không quy đổi thành số assertion. Source-check Linux xác nhận đủ 84 hash. Agent độc lập đọc từng file trong `source.tar` bằng TarReader và xác minh đủ 84/84 SHA256 với full manifest; 15 mục manifest artifact gốc cũng khớp snapshot. SHA256 `source.tar`: `12f43aed273340e1eadd45c733427a358ae863367b14965f27722467731d670c`; base HEAD `e09fdb4ab753b8c6b76e623f2f718d020cbd2d25`.

Trước khi cập nhật tài liệu kết thúc, workspace khớp 83/84 file snapshot. Chỉ `docs/PHASE9-VALIDATION.md` khác do ghi chú chẩn đoán runner của run `34d7d440`, không phải thay đổi implementation. Code, tests, package/lockfile, config và workflow đều khớp source đã chạy ma trận. Lượt đóng nghiệm thu này chỉ sửa báo cáo/README/PLAN; `git diff --check` được kiểm tra lại.

Ubuntu Node 26 ban đầu không chạy được npm vì thiếu `libatomic.so.1` (install exit 127). Log ban đầu được giữ; Dockerfile runner bổ sung `libatomic1`, rồi chạy lại toàn bộ bốn lệnh đạt. Đây là sửa dependency image runner, không sửa implementation hoặc bỏ test. Ubuntu base digest `sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852`; image Node 24 `sha256:9bec0c35b61455936ea2a42239490f3c3ca05890d83531572348363fca9de443`; image Node 26 `sha256:5fd1a549ee59b76b1e8e5d36c0b93e344ae6a21f234ac493bc518549a005ad9e`.

Docker Desktop được người vận hành khởi động theo yêu cầu thực hiện của người dùng; báo cáo xác nhận container đã kết thúc, image/cache và Docker Desktop còn trên máy. Agent không tự dừng service hoặc xóa cache của người dùng. Không đổi approval/bảo mật, không cài distro mới, không push/publish/deploy. GitHub Actions chưa được kích hoạt; không dùng nhãn "CI hosted xanh" cho kết quả này.

## Kiểm chứng Windows/browser đã xác minh trước ma trận

### Full suite, package và browser đạt

Người dùng `local-board` đã trả lời thẻ `12cf2af3-3070-4e21-ba32-9c73589a89f0` lúc 2026-10-31 06:30:47 UTC, cung cấp [log, screenshot và báo cáo nghiệm thu](/api/attachments/1ed5addd-7a02-4679-bbac-1d14ed8521d5/content?download=1). Kiểm chứng ngoài sandbox dùng source hiện tại có cả hai sửa lỗi stale attempt/UI answer; không sửa source trong lượt kiểm chứng. Agent đã tải và đọc `results.json`, `input.log`, `suite.log`, `package.log`, JSON integration/browser và xem screenshot; không tự chạy lại các bước đã có bằng chứng đạt.

| Kiểm tra ngoài sandbox | Exit code | Bằng chứng |
| --- | --- | --- |
| `npm run typecheck` | 0 | `results.json`, `typecheck.log` |
| `node --test --test-timeout=30000 tests/input.test.mjs` | 0 | 3/3, không fail/cancel/skip/todo; 4.512 giây |
| `npm test` | 0 | 93/93, fail/cancel/skip/todo đều 0; test runner 61.684 giây, gồm build trước test |
| `npm run test:package` | 0 | Tarball allowlist, installed bin, production dependencies, doctor, dashboard assets, planner, worker, review và integration đạt; không gán số assertion cho quy trình này |
| `git diff --check` | 0 | Chỉ có cảnh báo LF/CRLF, không có lỗi whitespace |

Browser trong ứng dụng dùng runtime thật và fixture `tests/fixtures/input-agent.mjs`, không gọi model thật: câu hỏi hiển thị; nhập/lưu `done` khóa textarea; reload giữ answer; sau lưu/reload plan vẫn `waiting_input`, rounds=1, task blocked và không có workflow chạy. Bấm tiếp tục mới chuyển executing rồi completed, task accepted và integrated. JSON xác nhận `execution.verification.passed=true`, `a.txt=done`, commit tích hợp `8794a13ad1f79652687502ecb02890da28d3b5bb`. Screenshot cho thấy plan Hoàn tất, task accepted/đã tích hợp và runtime không có workflow đang chạy. Gửi answer cũ sau completed qua HTTP API trả 400 `Stale or unavailable input request`; đây là kiểm tra API, không phải thao tác UI (form đã biến mất).

Agent đã đối chiếu SHA256 của ba file với báo cáo; cả ba khớp source trong workspace:

- `src/storage/store.ts`: `DCFB274CB593019F83D4B54B3ECAC3F271A1797E2B4D7BB0CC42B5F0FB852E29`.
- `ui/planning.tsx`: `6020CFF0EAEBFE6497DBCD31666059EFF1B6DDAD5C16C548877A59D4E85158B8`.
- `tests/input.test.mjs`: `BF862A86C9451DCB5E794A108FA3A7221082E2E323680C7ACF3E2A9E10488ED3`.

Kết quả này hoàn tất các bước chức năng/full-suite/package/browser còn thiếu ở lượt trước. Bằng chứng ma trận bổ sung sau đó nằm ở phần trên. Không chứng minh nguyên nhân gốc lỗi sandbox hoặc containment đầy đủ; không coi CI của Phase 8 là CI của Phase 9.

### Lịch sử kiểm chứng trong sandbox và tái hiện ban đầu

Kết quả do người dùng cung cấp trong comment RAR-15 `4bc87079-fe2e-4322-84ad-823d6a310024`: trước hai sửa lỗi dưới đây, test toàn luồng `input wait survives restart, rejects stale answers and resumes to verified integration` đạt khoảng 5 giây; `node --test --test-timeout=30000 tests/input.test.mjs` đạt 3/3 ngoài sandbox, với TEMP/TMP `C:\Users\User\Documents\Codex\2026-10-30\kie\work\rar15-repro`. Đây là bằng chứng của người dùng, không phải full suite hoặc kết quả agent tự chạy. Thử sandbox MXC của người dùng gặp `EPERM lstat C:\` trước khi chạy test; chưa xác định nguyên nhân gốc.

Lượt agent trước (`621bb362`) dùng Windows Node 26.2.0, TEMP/TMP nằm trong thư mục được cấp quyền `paperclip-run-rar-15-621bb362-fad-7kVSn0`. Bảng sau là lịch sử tại thời điểm đó; các gate full-suite/package/browser đã được bổ sung bằng chứng đạt ở phần mới nhất bên trên:

| Kiểm tra | Kết quả thực tế |
| --- | --- |
| `npm run typecheck`, `npm run build` | Đạt sau sửa lỗi |
| `node --test --test-name-pattern='input protocol\|durable answers' tests/input.test.mjs` | 2/2 đạt: schema, storage restart, HTTP API thật, answer cũ/sai task/field lạ/rỗng/quá dài, idempotency, budget, attempt hiện tại |
| `node --test tests/store.test.mjs tests/planview.test.mjs tests/doctor.test.mjs` | 15/15 đạt, exit 0; đây là test chọn lọc |
| `npm test` | Đã chạy; worker-host không tới waiting_input, test báo không đạt sau khoảng 25 giây; cleanup không kết thúc nên ngắt phiên, không có tổng kết full suite |
| `npm test -- --test-timeout=30000` sau sửa lỗi | Đã chạy; cùng test báo không đạt sau 25,17 giây và runner tiếp tục treo; đã ngắt phiên, không có tổng kết full suite |
| `npm run test:package` | Đã chạy trước và sau sửa lỗi; tarball/install/production bin/doctor/dashboard assets qua được, nhưng exit 1 tại planner do `Worker cleanup failed: ... taskkill /PID 10516 /T /F` ở lần cuối (lần đầu PID 23612). Không coi package check là đạt |
| UI DOM component React thật | 9 kiểm tra đạt trong jsdom 30.1.3, HTTP giả lập; xem phần dưới |
| UI browser thật | Chưa đạt: browser connector bị từ chối bởi approval policy `never`; Edge headless thoát 3221225477, Chrome headless thoát 2147483651 ngay cả với `about:blank`, trước khi tải UI. Không đổi sandbox hoặc browser security flags |
| `git diff --check` | Sạch |
| CI Windows/Ubuntu × Node 24/26 | Chưa chạy cho source Phase 9; CI cũ không chứng minh source hiện tại. Workflow hiện chỉ trigger bằng push/PR, lượt này không push/publish/deploy |

Không kết luận lỗi treo là lỗi code hoặc đã xác định nguyên nhân sandbox. Lỗi cleanup nằm trên đường chạy subprocess đã có từ trước (cả planner trong package check); lượt hiện tại không thay cơ chế cleanup hoặc quyền. Lỗi `taskkill` xác thực của lượt trước được giữ như lịch sử, không dùng thay bằng chứng mới.

## Hai lỗi code đã tái hiện và sửa

1. Sau khi task chuyển sang attempt mới rồi blocked vì lý do khác, storage vẫn nhận lại answer của attempt cũ nếu request còn trong usage. Regression test đã thất bại với `Missing expected exception`, sau đó đạt khi kiểm tra request ID trùng attempt cuối.
2. Sau khi API lưu answer đã trim, textarea disabled vẫn hiển thị draft cũ. Kiểm tra DOM đã thất bại với `' done ' !== 'done'`; đã sửa để ưu tiên answer được lưu từ API. Cũng phản ánh đúng answer do tab/CLI khác gửi khi refresh.

Kiểm tra UI dùng component `Planning` thật, bundle bằng esbuild sẵn có; React/ReactDOM của dự án. jsdom chỉ cài vào TEMP, không thêm dependency hoặc đổi lockfile dự án. Chín kiểm tra: nhãn/câu hỏi, nút lưu disabled khi rỗng, maxLength, không tự submit, lỗi stale giữ draft, answer đã lưu/chuẩn hóa hiển thị đúng, lưu không tự resume, remount đọc lại answer, resume tường minh đổi trạng thái và bỏ form. Không thay thế nghiệm thu Chromium, live worker hoặc SSE reconnect. Harness `validation/check-ui.mjs` và `validation/ui-result.json` được đính kèm artifact trên RAR-15. Để tái chạy, cài jsdom 30.1.3 trong thư mục `validation` của artifact rồi gọi script bằng Node từ gốc checkout.

## Đối chiếu gate và quyết định nghiệm thu

`docs/PLAN.md`, mục "Kiểm chứng và tiêu chí phát hành", yêu cầu "CI: npm ci, typecheck, build; thêm test khi module có hành vi. Thử Windows trước, mở rộng OS sau." Workflow hiện có cụ thể hóa ma trận Windows/Ubuntu × Node 24/26 và bốn bước npm ci/typecheck/test/test:package. Không có yêu cầu nghiệm thu riêng bắt buộc nhà cung cấp GitHub Actions hoặc đúng image hosted `windows-latest`/`ubuntu-latest`; `runs-on` là cấu hình workflow hiện có, không phải một gate hosted bổ sung trong roadmap.

Runner cục bộ đã thực hiện đầy đủ bốn tổ hợp, cùng các bước và source đã đối chiếu hash. Vì vậy gate kiểm chứng đa OS/Node của Phase 9 đã đạt; không miễn hoặc thay bằng test chọn lọc. Nghiệm thu browser/runtime và full suite/package cũng đã đạt. Không còn điều kiện bắt buộc chưa hoàn thành trong phạm vi tính năng `waiting_input`; RAR-15 đủ điều kiện đóng done. GitHub Actions hosted chưa chạy và không được báo là đạt; không cần push để đóng gate chức năng này.

Các lỗi Docker pipe/WSL access của run `34d7d440` và lỗi cleanup sandbox cũ là lịch sử môi trường. Người dùng đã cung cấp ma trận runner thành công sau khi khởi động Docker Desktop theo yêu cầu; không dùng các lỗi cũ làm blocker hiện tại. Không phát sinh yêu cầu chạy lại chức năng/browser hoặc model thật.

## Windows Job Object có bắt buộc cho Phase 9 không?

Roadmap `docs/PLAN.md`, mục Việc tiếp theo, dòng nội dung "Trước tác vụ dài không giám sát" đặt Windows Job Object làm điều kiện containment đầy đủ. `docs/ARCHITECTURE.md` cũng yêu cầu quản lý cây tiến trình Windows riêng; kill PID cha không đủ. Đây là giới hạn còn tồn tại của runtime trước khi tuyên bố an toàn cho tác vụ dài không giám sát, không phải điều kiện được ghi riêng để nghiệm thu giao thức `waiting_input`. Phase 9 không thêm cam kết containment hoặc tác vụ dài không giám sát; không cần triển khai Job Object chỉ để đóng tính năng này. Không được bỏ qua giới hạn đó khi đánh giá phát hành/runtime unattended. Windows Job Object vẫn chưa triển khai; không có kiểm chứng mới về tiến trình chủ động tách cây.
