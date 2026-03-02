# Kiến trúc ban đầu

Ngày: 2026-10-21. Trạng thái: thiết kế đề xuất cho triển khai.

Một repo TypeScript, chia module theo trách nhiệm. Chỉ tách package khi có nhu cầu chia sẻ hoặc phát hành độc lập.

```text
CLI / UI tương lai -> API local -> Runtime -> Agent adapters -> Agent CLI
                                  |                       -> API + tool loop
                                  v
                             SQLite + events
```

- Core độc lập với CLI, UI và nhà cung cấp model.
- Runtime là tiến trình riêng; đóng màn hình theo dõi không dừng đội.
- CLI dùng Commander; validation dùng Zod; SQLite driver sẽ được chọn qua thử nghiệm tương thích và đóng gói Windows ở M1.
- MVP dùng subprocess với output có cấu trúc. PTY bổ sung theo nhu cầu từng CLI.
- Một runtime sở hữu database của một dự án. API local bind loopback, xác thực bằng token phiên; không mở ra mạng mặc định.
- Mỗi sự kiện có id tăng dần, schemaVersion, timestamp, type, projectId; agentId/taskId/attemptId/correlationId khi liên quan. UI reconnect từ cursor; snapshot và event stream phải có ranh giới nhất quán.
- Task: queued -> running -> submitted -> reviewing -> accepted; reviewing -> changes_requested -> queued tạo attempt mới. Nhánh kết thúc/ngoại lệ: blocked, failed, cancelled. Task phụ thuộc chỉ chạy khi dependencies accepted.
- Worker nộp kết quả; manager quyết định nghiệm thu. PID còn sống không chứng minh agent đang làm việc hoặc task đã đạt.
- Lưu thay đổi task và event trong cùng transaction. Dispatch có idempotency key, attempt owner và lease; phục hồi phải kiểm tra tác dụng đã xảy ra trước khi chạy lại.
- Quản lý cây tiến trình trên Windows cần cơ chế riêng; kill PID cha không được coi là đã dừng toàn bộ worker.
- Mỗi worker sửa code dùng Git worktree riêng; manager tích hợp tuần tự rồi kiểm tra kết quả chung.
- Config chỉ chứa tên biến môi trường cho credentials. Adapter 9router dùng base URL/model cấu hình được; API key không lưu trong repository hoặc events.

## Quan hệ với Squad

Tham khảo thiết kế và test hành vi của https://github.com/mco-org/squad. Rarp là triển khai TypeScript riêng, không chuyển toàn bộ Rust từng dòng. Chưa sao chép mã nguồn Squad. Nếu tái sử dụng mã, lưu nguồn, revision và thông báo license tương ứng.

REA là công cụ điều tra tùy chọn, không phải dependency bắt buộc của runtime.

## UI tương lai

React cho dashboard; React Flow cho đồ thị task. Snapshot API + event stream hỗ trợ board, timeline, log và reconnect. Chọn SSE hoặc WebSocket tại M5 theo nhu cầu tương tác; lệnh điều khiển dùng API có xác nhận kết quả. Hiển thị trạng thái quan sát được, không suy diễn suy nghĩ nội bộ của model.
