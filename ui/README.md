# Dashboard local

React và Vite build vào `dist/ui`; runtime phục vụ HTML/assets ở `/ui/`. Không có dev proxy hoặc credential hardcode. `rarp ui` in liên kết chứa token fragment; client giữ token trong sessionStorage và gửi Authorization header qua fetch, bao gồm stream SSE.

`client.ts`: API, token bootstrap, parser SSE và hợp nhất event theo ID. `main.tsx`: board, agent, dependency, timeline và task drawer. `style.css`: theme hệ thống/sáng/tối và responsive. `vite.config.ts` và `tsconfig.json`: build/typecheck frontend tách backend.

Snapshot khởi tạo có recentEvents/cursor trong cùng transaction. Khi stream mất kết nối, giữ cursor đã nhận, refresh snapshot, rồi replay phần còn thiếu; ID loại bỏ bản sao. Không suy diễn suy nghĩ nội bộ của agent từ log. Thao tác điều khiển sử dụng API runtime và state machine hiện có.
