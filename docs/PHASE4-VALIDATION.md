# Kiểm chứng Phase 4

Ngày 2026-10-24, Windows, Node 26.2.0.

- `npm run typecheck`: đạt.
- `npm test`: 29/29 đạt, gồm ngắt runtime thật, bảo toàn file, lease/PID, request trùng sau restart, resume review không chạy lại worker, scope/rename, conflict và tích hợp lại sau giải quyết conflict.
- `node scripts/smoke-phase4.mjs --fixture`: đạt. Hai worker sửa total/discount ở worktree riêng; review fixture, kiểm tra test cố định và tích hợp tuần tự đều đạt. Kết quả chung chạy 2 test, 0 lỗi. Đây là kiểm chứng runtime, chưa thay thế review bởi model thật.
- Bài Codex thật tại workspace tạm `rarp-phase4-BD9pmg`: task total được review accepted và tích hợp; worker discount hoàn thành và qua verification, nhưng reviewer thứ hai thoát lỗi trước khi có quyết định. Bản ghi thử tiếp theo báo hết hạn mức Codex. Chưa nghiệm thu trọn luồng hai worker bằng AI thật.

## Nghiệm thu bằng GPT-6.1 Sol

Chạy lại ngày 2026-10-24 với `--model gpt-6.1-sol` cho cả worker và reviewer: **đạt**. Hai task total và discount đều accepted ở attempt đầu, tích hợp tuần tự thành công. Kiểm tra kết quả chung: 2 test đạt, 0 lỗi. Commit cuối trong repository thử nghiệm: `445f2129f02df6d378d9379c27af0b8e91125684`.

Reviewer read-only gặp `spawn EPERM` với test isolation mặc định và dùng `--test-isolation=none` để kiểm tra; verification do runtime chạy vẫn đạt với `node --test` thông thường. Runtime stop sạch. Bài này kiểm chứng hai worker nối tiếp, không đo tải song song. Rarp hiện chỉ giữ một workflow active cho mỗi runtime/dự án.

Chạy lại:

```powershell
npm run build
node scripts/smoke-phase4.mjs --model gpt-6.1-sol
```

Worktree và database thử nghiệm nằm ngoài repository. Scope là kiểm tra thay đổi Git trước review, không phải ranh giới bảo mật hệ điều hành. Lệnh verification chạy đồng bộ, có timeout 120 giây; trong lúc đó API có thể chưa phản hồi. Recovery không tự chạy lại worker hoặc phiên model; tiến trình cố ý tách cây vẫn cần containment mạnh hơn.
