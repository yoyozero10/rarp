# Rarp

Hệ thống runtime và giao diện dòng lệnh (CLI) điều phối đa tác tử AI (Multi-Agent Orchestration) trên máy cục bộ. Rarp hỗ trợ lập kế hoạch theo mục tiêu, phân rã công việc, thực thi mã nguồn trong môi trường Git worktree cô lập, tự động kiểm thử, nghiệm thu kết quả và tích hợp an toàn vào nhánh chính.

---

## Mục lục

- [Tổng quan kiến trúc](#tổng-quan-kiến-trúc)
- [Tính năng cốt lõi](#tính-năng-cốt-lõi)
- [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
- [Cài đặt và Đóng gói](#cài-đặt-và-đóng-gói)
- [Hướng dẫn sử dụng nhanh](#hướng-dẫn-sử-dụng-nhanh)
- [Quy trình hoạt động chi tiết](#quy-trình-hoạt-động-chi-tiết)
  - [Lập kế hoạch theo mục tiêu và phê duyệt](#1-lập-kế-hoạch-theo-mục-tiêu-và-phê-duyệt)
  - [Điều phối đa tác tử và quản lý hàng đợi](#2-điều-phối-đa-tác-tử-và-quản-lý-hàng-đợi)
  - [Cô lập môi trường và tích hợp nguyên tử](#3-cô-lập-môi-trường-và-tích-hợp-nguyên-tử)
  - [Khôi phục sau sự cố](#4-khôi-phục-sau-sự-cố)
- [Tra cứu lệnh CLI](#tra-cứu-lệnh-cli)
- [Bảo mật và Kiểm soát quyền](#bảo-mật-và-kiểm-soát-quyền)
- [Phát triển và Kiểm thử](#phát-triển-và-kiểm-thử)

---

## Tổng quan kiến trúc

Rarp được xây dựng bằng TypeScript và Node.js, sử dụng kiến trúc phân tách rõ ràng giữa giao diện người dùng, bộ điều phối trung tâm và các tác tử thực thi:

```text
[CLI / Web UI] 
      |
      v (HTTP / SSE / Token Auth qua 127.0.0.1)
[Runtime Daemon] <-------------------> [SQLite Database (node:sqlite)]
      |                                  - Task state machine
      +---> [Planner / Manager]          - Event sourcing journal
      |       (Read-only Sandbox)        - Locks & Scheduler queue
      |
      +---> [Scheduler Engine]
              |
              +---> [Worker 1] (Git Worktree A) ---> Verification Check
              |
              +---> [Worker 2] (Git Worktree B) ---> Verification Check
              |
              v
       [Reviewer Loop] ---> [Atomic Integration Worker] ---> Main Branch
```

- **Runtime Daemon**: Tiến trình nền độc lập quản lý vòng đời tác vụ, bộ lập lịch và luồng sự kiện.
- **Lưu trữ bền vững**: Sử dụng `node:sqlite` tích hợp sẵn trong Node.js, vận hành ở chế độ Write-Ahead Logging (WAL) và giao dịch nghiêm ngặt.
- **Tác tử AI**: Kết nối với Codex CLI và Antigravity CLI thông qua adapter kiểm soát tiến trình con, có cơ chế ngắt cây tiến trình và giới hạn thời gian chạy.

---

## Tính năng cốt lõi

- **Lập kế hoạch tự động (Goal-Driven Planning)**: Tác tử Planner phân tích kho mã nguồn ở chế độ chỉ đọc, đề xuất danh sách công việc, mối quan hệ phụ thuộc (dependencies), đợt thực thi (waves) và lệnh kiểm thử tương ứng.
- **Cơ chế phê duyệt tường minh (Explicit Plan Approval)**: Mọi kế hoạch đều yêu cầu người dùng xác nhận cấu hình phân bổ worker, giới hạn số vòng lặp và cấp quyền thực thi trước khi mã nguồn được phép thay đổi.
- **Cô lập hoàn toàn qua Git Worktree**: Mỗi tác vụ được thực hiện trên một worktree độc lập. Thư mục làm việc chính chỉ tiếp nhận thay đổi khi quá trình kiểm tra và nghiệm thu đã hoàn tất thành công.
- **Bộ lập lịch đa tác tử (Concurrent Scheduler)**: Hỗ trợ cấu hình từ 1 đến 16 luồng làm việc song song và giới hạn số lượng tác tử đánh giá (Reviewer) đồng thời. Tự động kiểm tra và ngăn chặn xung đột phạm vi tập tin (scope overlap).
- **Vòng lặp nghiệm thu và tự sửa đổi (Automated Review Loop)**: Tác tử Reviewer đối chiếu kết quả với tiêu chí đề ra kèm bằng chứng cụ thể. Nếu phát hiện lỗi, tác vụ được gửi lại cho Worker cùng phản hồi chi tiết để khắc phục trong giới hạn ngân sách cho phép.
- **Tương tác yêu cầu đầu vào (Human-in-the-Loop Input)**: Hỗ trợ trạng thái `waiting_input` khi Worker cần làm rõ yêu cầu, cho phép người dùng trả lời trực tiếp từ CLI hoặc Web UI mà không làm gián đoạn kế hoạch.
- **Tích hợp nguyên tử (Atomic Integration)**: Hợp nhất các nhánh công việc đã nghiệm thu trong worktree tích hợp riêng, chạy lại toàn bộ bài kiểm tra trước khi chuyển tiếp (fast-forward) vào nhánh chính.
- **Giao diện Web Dashboard cục bộ**: Bảng điều khiển React tích hợp sẵn trong runtime, kết nối thông qua Server-Sent Events (SSE) để hiển thị sơ đồ trạng thái, tiến độ và nhật ký chi tiết.

---

## Yêu cầu hệ thống

- **Node.js**: Phiên bản 24.0.0 trở lên (yêu cầu hỗ trợ module `node:sqlite`).
- **Git**: Đã cài đặt trên hệ thống; kho lưu trữ mục tiêu phải có ít nhất một commit ban đầu và trạng thái working tree sạch sẽ.
- **CLI Agent**: Cần có ít nhất một trong các công cụ sau đã được cài đặt và đăng nhập:
  - **Codex CLI**: Phiên bản hỗ trợ `--no-daemon`, `exec --json`, `--ephemeral`.
  - **Antigravity CLI (`agy`)**: Đã cấu hình xác thực hợp lệ.
- **Hệ điều hành**: Windows, Linux hoặc macOS.

---

## Cài đặt và Đóng gói

### Đóng gói từ mã nguồn

Trong thư mục mã nguồn Rarp, thực hiện:

```sh
npm ci
npm pack
```

Lệnh `npm pack` sẽ kích hoạt `prepack` để biên dịch mã nguồn TypeScript và đóng gói ứng dụng thành tệp nén `rarp-0.1.0.tgz`. Tệp đóng gói chỉ chứa mã thực thi đã biên dịch, giao diện Web UI, lược đồ JSON và tài liệu; không bao gồm mã kiểm thử hoặc thông tin bảo mật.

### Cài đặt toàn cục

Cài đặt gói thực thi vào môi trường hệ thống:

```sh
npm install --global ./rarp-0.1.0.tgz
```

Kiểm tra cài đặt:

```sh
rarp --version
```

### Chẩn đoán môi trường với `rarp doctor`

Trước khi khởi chạy dự án, sử dụng lệnh `doctor` để kiểm tra toàn bộ điều kiện tiên quyết của môi trường:

```sh
rarp --project "C:\duong-dan\du-an" doctor
```

Các tham số bổ sung:
- `--codex <path>`: Đường dẫn tệp thực thi Codex CLI.
- `--agy <path>`: Đường dẫn tệp thực thi Antigravity CLI.
- `--manager-profile <name>`: Profile của Codex CLI dùng cho Planner và Reviewer.
- `--json`: Xuất kết quả dưới định dạng JSON phục vụ tự động hóa.

Lưu ý: `rarp doctor` là lệnh chỉ đọc, không ghi dữ liệu, không thay đổi tệp, không gọi API AI trả phí và không cấp quyền tự động.

---

## Hướng dẫn sử dụng nhanh

### Bước 1: Khởi tạo kho lưu trữ cho dự án

```sh
rarp --project "C:\duong-dan\du-an" init
```

Lệnh này tạo thư mục cấu hình `.rarp` và cơ sở dữ liệu SQLite tại đường dẫn dự án. Hãy thêm `.rarp/` vào tệp `.gitignore` của dự án.

### Bước 2: Khởi động Runtime Daemon

Khởi động tiến trình nền quản lý tác vụ:

```sh
rarp --project "C:\duong-dan\du-an" runtime start --max-workers 2 --max-reviewers 1
```

Nếu muốn Planner và Reviewer sử dụng profile riêng của Codex (ví dụ: `9router`):

```sh
rarp --project "C:\duong-dan\du-an" runtime start --manager-profile 9router --max-workers 2 --max-reviewers 1
```

### Bước 3: Mở Web Dashboard

Lấy liên kết truy cập bảng điều khiển giao diện web:

```sh
rarp --project "C:\duong-dan\du-an" ui
```

Mở đường dẫn xuất hiện trên màn hình (dạng `http://127.0.0.1:<port>/ui/#token=<token>`) bằng trình duyệt web. Mã token xác thực sẽ tự động được lưu trữ an toàn trong `sessionStorage` của tab trình duyệt.

### Bước 4: Tạo mục tiêu và phê duyệt kế hoạch

1. Trên giao diện Web Dashboard, chuyển đến tab **Mục tiêu & kế hoạch**.
2. Nhập mục tiêu công việc, yêu cầu kỹ thuật và tiêu chí nghiệm thu.
3. Nhấn **Yêu cầu phân tích**. Planner sẽ phân tích kho mã nguồn ở chế độ chỉ đọc và tạo bản kế hoạch dự thảo.
4. Xem xét danh sách tác vụ, phạm vi tập tin (scope), đợt thực thi (waves) và lệnh kiểm thử.
5. Lựa chọn tác tử (Codex hoặc Antigravity), thiết lập ngân sách số vòng lặp và nhấn **Duyệt và chạy**.

---

## Quy trình hoạt động chi tiết

### 1. Lập kế hoạch theo mục tiêu và phê duyệt

- **Phân tích chỉ đọc**: Quá trình phân tích kế hoạch được thực hiện trong môi trường sandbox chỉ đọc. Planner không được phép sửa đổi tập tin hay chạy các lệnh thay đổi trạng thái trước khi có sự chấp thuận của người dùng.
- **Quản lý phiên bản kế hoạch (Revisions)**: Mọi điều chỉnh về mục tiêu, danh sách tác vụ hoặc cấu hình phân bổ đều tạo ra một phiên bản kế hoạch mới kèm mã băm (hash) toàn vẹn.
- **Xử lý phản hồi từ Worker (`waiting_input`)**: Khi gặp điểm chưa rõ ràng, Worker có thể gửi câu hỏi dạng `rarp_input`. Kế hoạch tạm dừng và chuyển sang trạng thái chờ đầu vào. Người dùng có thể trả lời thông qua Web UI hoặc dòng lệnh:
  ```sh
  rarp --project "C:\duong-dan\du-an" plan answer PLAN_ID --file answer.json
  rarp --project "C:\duong-dan\du-an" plan resume PLAN_ID
  ```
  Nội dung tệp `answer.json` bao gồm `{ taskId, requestId, answer }`.

### 2. Điều phối đa tác tử và quản lý hàng đợi

- **Quản lý khe thực thi (Execution Slots)**: Tham số `--max-workers` quy định số lượng tác vụ được phép chạy đồng thời (từ 1 đến 16). Mỗi khe bao gồm toàn bộ chu kỳ: phân bổ -> thực thi -> kiểm thử -> chờ đánh giá -> nghiệm thu.
- **Giới hạn số lượng Reviewer**: Tham số `--max-reviewers` giới hạn số phiên đánh giá thực sự diễn ra song song để tránh làm quá tải tài nguyên API.
- **Chống xung đột phạm vi (Scope Conflict)**: Hai tác vụ có phạm vi tập tin hoặc thư mục giao thoa sẽ không được phân bổ chạy cùng thời điểm. Tác vụ đến sau sẽ tự động nằm trong hàng đợi chờ tác vụ trước giải phóng phạm vi.
- **Quản lý phụ thuộc (Dependencies)**: Tác vụ phụ thuộc chỉ bắt đầu khi tất cả tác vụ tiên quyết đã được nghiệm thu (`accepted`) và tích hợp hoàn tất vào mã nguồn chung.

### 3. Cô lập môi trường và tích hợp nguyên tử

- **Git Worktree riêng biệt**: Mỗi tác vụ hoạt động trên một nhánh và thư mục worktree riêng biệt được tạo từ điểm commit mới nhất của nhánh chính.
- **Kiểm tra cục bộ tự động**: Sau khi Worker hoàn tất mã nguồn và tạo commit, runtime tự động chạy các lệnh kiểm thử được chỉ định trong cấu hình (ví dụ: `npm test`, `npm run build`).
- **Nghiệm thu độc lập**: Tác tử Reviewer kiểm tra sự thay đổi và kết quả kiểm thử. Khi đạt yêu cầu, tác vụ chuyển sang trạng thái `accepted`.
- **Tích hợp tuần tự (Sequential Integration)**:
  ```sh
  rarp --project "C:\duong-dan\du-an" task integrate TASK_ID
  ```
  Runtime tiến hành hợp nhất nhánh công việc vào một worktree tích hợp tạm thời, chạy lại toàn bộ bộ kiểm thử của dự án trên kết quả hợp nhất. Chỉ khi tất cả kiểm tra đều thành công, nhánh chính mới được cập nhật chuyển tiếp (fast-forward).

### 4. Khôi phục sau sự cố

- **Cơ chế giữ khóa (Lease Mechanism)**: Tiến trình runtime duy trì khóa phiên với thời hạn 15 giây.
- **Phục hồi trạng thái sau khi dừng đột ngột**: Nếu hệ thống gặp sự cố mất điện hoặc tiến trình bị buộc dừng:
  ```sh
  rarp --project "C:\duong-dan\du-an" runtime recover
  rarp --project "C:\duong-dan\du-an" runtime start
  ```
- **Xử lý tác vụ dở dang**: Lệnh `recover` sẽ rà soát cơ sở dữ liệu, chuyển các tác vụ đang thực thi dở dang thành `interrupted` hoặc `failed`, đồng thời bảo toàn các nhánh worktree và các tác vụ đã `accepted`. Sau khi khởi động lại, bộ lập lịch sẽ ở trạng thái tạm dừng để người dùng kiểm tra trước khi kích hoạt `resume`.

---

## Tra cứu lệnh CLI

Mọi lệnh đều hỗ trợ cờ toàn cục `--project <path>` (mặc định là thư mục hiện tại) và `--json` (xuất dữ liệu định dạng JSON).

### Nhóm chẩn đoán và thông tin

| Lệnh | Mô tả |
| :--- | :--- |
| `rarp doctor` | Chẩn đoán toàn diện môi trường thực thi (chỉ đọc, không gọi model). |
| `rarp about` | Hiển thị thông tin phiên bản và các tính năng chính. |
| `rarp status` | Xem trạng thái cơ sở dữ liệu và số lượng tác vụ hiện tại. |
| `rarp events [--after <id>]` | Truy vấn nhật ký sự kiện, hỗ trợ đọc phân trang qua con trỏ `after`. |

### Nhóm điều khiển Runtime Daemon

| Lệnh | Mô tả |
| :--- | :--- |
| `rarp runtime start` | Khởi động tiến trình daemon nền (`--max-workers`, `--max-reviewers`, `--manager-profile`, `--codex`, `--agy`). |
| `rarp runtime status` | Xem trạng thái hoạt động của daemon, các tác vụ đang chạy và hàng đợi. |
| `rarp runtime stop` | Dừng an toàn tiến trình daemon và toàn bộ cây tiến trình liên quan. |
| `rarp runtime pause` | Tạm dừng nhận tác vụ mới vào bộ lập lịch. |
| `rarp runtime resume` | Tiếp tục bộ lập lịch tác vụ. |
| `rarp runtime recover` | Phục hồi trạng thái dữ liệu sau sự cố dừng đột ngột. |
| `rarp runtime queue` | Xem danh sách các điều phối đang nằm trong hàng đợi. |
| `rarp runtime cancel [--task <id>]` | Hủy một tác vụ cụ thể hoặc hủy toàn bộ tác vụ đang chờ. |
| `rarp ui` | In ra đường dẫn truy cập Web Dashboard kèm token bảo mật. |

### Nhóm quản lý Mục tiêu và Kế hoạch

| Lệnh | Mô tả |
| :--- | :--- |
| `rarp goal create --file <path>` | Tạo mục tiêu mới từ tệp JSON. |
| `rarp goal list` | Liệt kê danh sách các mục tiêu đã ghi nhận. |
| `rarp goal show <id>` | Xem chi tiết nội dung của một mục tiêu. |
| `rarp plan list` | Liệt kê toàn bộ các kế hoạch thực thi. |
| `rarp plan show <id>` | Xem chi tiết cấu trúc tác vụ của kế hoạch. |
| `rarp plan analyze <id>` | Kích hoạt tác tử phân tích mã nguồn và lập kế hoạch chi tiết. |
| `rarp plan approve <id> [--file <path>]` | Phê duyệt kế hoạch kèm cấu hình phân bổ worker. |
| `rarp plan reject <id>` | Từ chối bản kế hoạch. |
| `rarp plan pause <id>` | Tạm dừng kế hoạch đang chạy. |
| `rarp plan resume <id>` | Tiếp tục kế hoạch đã tạm dừng. |
| `rarp plan answer <id> --file <path>` | Gửi câu trả lời cho yêu cầu đầu vào từ tác tử Worker. |

### Nhóm quản lý Tác vụ và Luồng làm việc

| Lệnh | Mô tả |
| :--- | :--- |
| `rarp task create` | Tạo tác vụ thủ công (`--title`, `--actor`, `--assignee`, `--body`, `--depends-on`). |
| `rarp task list [--status <name>]` | Danh sách tác vụ, có thể lọc theo trạng thái. |
| `rarp task show <id>` | Xem chi tiết tác vụ, lịch sử nộp bài và đánh giá. |
| `rarp task workspace <id>` | Xem thông tin đường dẫn Git worktree của tác vụ. |
| `rarp task integrate <id>` | Tích hợp tác vụ đã nghiệm thu vào nhánh chính của kho lưu trữ. |
| `rarp workflow run <taskId>` | Chạy quy trình làm việc độc lập (`--isolated`, `--adapter`, `--scope`, `--check-json`, `--max-rounds`). |

---

## Bảo mật và Kiểm soát quyền

1. **Giới hạn kết nối mạng cục bộ**:
   - Runtime Daemon chỉ lắng nghe duy nhất trên giao diện mạng vòng `127.0.0.1`.
   - Không hỗ trợ kết nối từ xa. Mọi yêu cầu HTTP/SSE đều bắt buộc mang theo token xác thực ngẫu nhiên được tạo ra tại thời điểm khởi động daemon.
2. **Quyền hạn của tác tử Planner và Reviewer**:
   - Được ép buộc chạy trong cấu hình sandbox chỉ đọc.
   - Không thể tự ý chạy các lệnh shell hoặc chỉnh sửa mã nguồn dự án trong giai đoạn lập kế hoạch và đánh giá.
3. **Quyền hạn của tác tử Worker**:
   - Mặc định, các tác tử hoạt động dưới quyền hạn sandbox chuẩn của công cụ nền tảng.
   - Khi sử dụng Antigravity CLI, cờ bỏ qua kiểm tra quyền (`--dangerously-skip-permissions`) chỉ được bổ sung khi và chỉ khi người dùng chủ động lựa chọn tùy chọn cấp toàn quyền trong bước duyệt kế hoạch.
4. **Bảo vệ khóa bí mật (Secrets Protection)**:
   - Cơ sở dữ liệu và nhật ký sự kiện của Rarp tuyệt đối không lưu trữ khóa API hoặc thông tin đăng nhập cá nhân.
   - Các tác tử kế thừa cấu hình chứng thực từ phiên đăng nhập cục bộ sẵn có của Codex CLI hoặc Antigravity CLI trên máy của người dùng.

---

## Phát triển và Kiểm thử

### Cài đặt môi trường phát triển

```sh
git clone https://github.com/yoyozero10/rarp.git
cd rarp
npm ci
```

### Các tập lệnh kiểm tra chất lượng

Kiểm tra kiểu dữ liệu tĩnh:
```sh
npm run typecheck
```

Biên dịch ứng dụng:
```sh
npm run build
```

Chạy toàn bộ bộ kiểm thử tự động:
```sh
npm test
```

Kiểm tra tính toàn vẹn của gói đóng gói trong môi trường độc lập:
```sh
npm run test:package
```

Tập lệnh `test:package` sẽ đóng gói bản build, cài đặt dependencies vào thư mục tạm độc lập, khởi tạo runtime và kiểm tra vòng lặp Planner -> Worker -> Review -> Integration bằng fixtures giả lập.

---

## Giấy phép

Dự án này là phần mềm nội bộ (Private / Proprietary). Mọi quyền được bảo lưu.
