# Dashboard local

React và Vite build vào `dist/ui`; runtime phục vụ HTML/assets ở `/ui/`. Không có dev proxy hoặc credential hardcode. `rarp ui` in liên kết chứa token fragment; client giữ token trong sessionStorage và gửi Authorization header qua fetch, bao gồm stream SSE.

`planning.tsx`: wizard mục tiêu, đề xuất, làm rõ/chỉnh sửa revision, chọn CLI/profile và duyệt tường minh; trạng thái kế hoạch lấy từ runtime. Draft mục tiêu và lựa chọn binding chưa duyệt giữ trong localStorage; approval không tự khôi phục bằng checkbox sau reload. Chỉ thao tác **Duyệt và chạy** gửi approval đúng revision/hash. Nhật ký planner tách khỏi task. `client.ts`: API, token bootstrap, parser SSE và hợp nhất event theo ID. `main.tsx`: board, agent, dependency, timeline và task drawer. `style.css`: theme hệ thống/sáng/tối và responsive. `vite.config.ts` và `tsconfig.json`: build/typecheck frontend tách backend.

Snapshot khởi tạo có recentEvents/cursor trong cùng transaction. Khi stream mất kết nối, giữ cursor đã nhận, refresh snapshot, rồi replay phần còn thiếu; ID loại bỏ bản sao. Không suy diễn suy nghĩ nội bộ của agent từ log. Thao tác điều khiển sử dụng API runtime và state machine hiện có.

Manager profile: chạy `runtime start --manager-profile 9router` để planner/reviewer dùng native Codex CLI profile đó. `/profiles` trả metadata profile cho hai vai trò; wizard hiển thị profile reviewer hiện tại. Cấu hình worker độc lập. Đổi profile cần restart runtime.
