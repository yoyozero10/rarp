# Kiểm chứng Phase 5

Ngày 2026-10-24, Windows, Node 26.2.0.

## Triển khai theo thứ tự

1. Storage snapshot đọc task, attempt, review, workspace, agent và cursor trong cùng transaction; API log phân trang và SSE replay từ cursor/Last-Event-ID.
2. Dashboard React/Vite chạy cùng origin với runtime: task board, agent list, dependency edges và timeline. Không có dịch vụ hosting ngoài máy.
3. Chi tiết task hiển thị diff checkpoint, base/commit/integrated SHA, kết quả worker, review evidence và kiểm thử sau tích hợp.
4. Các thao tác có pending/succeeded/failed: tạo task/agent, workflow, cancel, retry, reassign, review, hủy task và integrate. Thay đổi trạng thái và reassign kiểm tra expectedStatus trong transaction.

## Kiểm tra tự động

- Typecheck/build và toàn bộ 36/36 test local đạt.
- Typecheck backend và frontend, build cả CLI/runtime và UI.
- Test API xác minh snapshot cursor, phân trang, lọc task, đọc thay đổi từ Store ngoài runtime, SSE reconnect không lặp, ngắt UI không dừng runtime và stop đóng stream.
- Auth bắt buộc cho API; từ chối origin/host không đúng, không nhúng token vào HTML, tài nguyên UI được phục vụ đúng MIME/CSP.
- Task control từ chối trạng thái cũ và manager không sở hữu task; reassign và dependency được lưu bền vững.
- Diff chỉ đọc commit checkpoint và không đổi khi có sửa file chưa commit.

## Kiểm tra giao diện thực tế

Trình duyệt trong Codex, repository demo tạm. Đã kiểm tra:

- Board, số task/worker và dependency khớp dữ liệu; chi tiết diff/test evidence hiển thị đúng.
- Tạo task có dependency và reload trang: task được giữ, kết nối khôi phục qua session token.
- Retry task lỗi → queued → workflow fixture trong worktree → accepted → integrate thành công, trạng thái tự cập nhật qua stream.
- Đầu vào JSON không hợp lệ hiển thị lỗi trong drawer và cho phép sửa lại.
- Theme sáng/tối, layout hiện tại và viewport mobile 390 × 844; focus rõ, drawer giữ focus và hỗ trợ Escape.

Worker/reviewer trong bài UI là fixture có kiểm tra file thật; không gọi model AI. Các adapter AI đã được kiểm chứng ở Phase 3/4. Chưa có benchmark log khối lượng lớn, canvas dependency kéo/thả, nhiều worker song song hoặc quyền nhiều người dùng. Stream polling SQLite mỗi 500 ms; giao diện refresh snapshot có debounce 200 ms. Tổng quan/log UI có giới hạn bộ nhớ; database giữ lịch sử đầy đủ.
