# Rarp

CLI điều phối nhiều AI agent trên máy local: lập kế hoạch, giao việc, nhận kết quả, nghiệm thu và yêu cầu sửa. Stack: TypeScript + Node.js; SQLite cho dữ liệu bền vững. UI trực quan sẽ dùng cùng runtime.

## Trạng thái

Đã tạo bộ khung CLI và kế hoạch. Chưa có runtime, adapter agent hay UI hoạt động.

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
