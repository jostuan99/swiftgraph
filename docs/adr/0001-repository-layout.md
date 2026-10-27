# ADR-0001: swiftgraph là repo riêng, tách khỏi tree-sitter-swift

- Trạng thái: Chấp nhận (thay quyết định cũ "npm workspace trong repo grammar")
- Ngày: 2026-10-27

## Bối cảnh

swiftgraph được bắt đầu như npm workspace `packages/swiftgraph` bên trong repo `tree-sitter-swift`, import binding Node bằng đường dẫn tương đối. Người dùng yêu cầu tách hai dự án thành hai source riêng biệt, kể cả tài liệu.

## Quyết định

- `tree-sitter-swift` và `swiftgraph` là hai thư mục/repo cạnh nhau:
  ```
  Startup/
  ├── tree-sitter-swift/   grammar, scanner, queries, bindings, docs của grammar
  └── swiftgraph/          code graph, MCP server, docs của swiftgraph
  ```
- swiftgraph phụ thuộc grammar như một package npm bình thường: `import Swift from 'tree-sitter-swift'`. Khi grammar chưa publish, `package.json` khai báo `"tree-sitter-swift": "file:../tree-sitter-swift"`.
- swiftgraph tự khai báo `tree-sitter` (binding Node) trong dependencies.
- Tài liệu swiftgraph nằm ở `swiftgraph/docs/`; ADR đánh số lại từ 0001. Repo grammar giữ docs của grammar (`docs/01`–`07`, ADR-0001, ADR-0002 của grammar).
- CI của swiftgraph checkout cả hai repo cạnh nhau và build grammar trước.

## Lý do

- Hai dự án có vòng đời và người dùng khác nhau: grammar dùng cho mọi editor và công cụ; swiftgraph là sản phẩm cho agent.
- Phụ thuộc qua tên package buộc swiftgraph chỉ dùng API công khai của grammar (binding Node), giống người dùng bên ngoài.

## Hệ quả

- Thay đổi grammar làm vỡ swiftgraph chỉ lộ ra khi CI của swiftgraph chạy (CI dùng nhánh `main` của grammar).
- Cần checkout hai repo cạnh nhau để phát triển; khi grammar publish npm thì đổi dependency sang version.
- Package grammar sửa `"types"` thành `bindings/node/index.d.ts` để TypeScript (ESM) tìm được kiểu của binding.
- Code TypeScript của swiftgraph vẫn chạy trực tiếp bằng type stripping của Node (≥ 22.18), chỉ dùng cú pháp xoá được. Trước khi publish phải biên dịch ra JavaScript.
