# ADR-0002: SQLite là nơi lưu trữ duy nhất của swiftgraph

- Trạng thái: Chấp nhận
- Ngày: 2026-10-26

## Bối cảnh

Bản thiết kế đầu lưu graph ở nhiều nơi: `graph.json` (có thể commit), `graph.db`, thư mục cache `FileFacts`, `GRAPH_REPORT.md` và `graph.html`. Người dùng yêu cầu dùng SQLite làm database vì lý do bảo mật. Dữ liệu graph chứa cấu trúc, tên symbol và doc comment của codebase, nên có giá trị như chính source code.

## Quyết định

- Toàn bộ dữ liệu (facts theo file, node, edge, metric, community, index tìm kiếm) nằm trong một file SQLite: `.swiftgraph/graph.db`.
- Bỏ `graph.json` và thư mục cache rời. Report và HTML được sinh khi cần từ DB và mặc định không ghi ra đĩa.
- Truy vấn đồ thị bằng SQL (recursive CTE, FTS5). Chỉ bước phân tích nạp graph vào bộ nhớ.
- Có các biện pháp bảo mật trong `docs/01-design.md`, mục 7.3: quyền file, kết nối chỉ đọc, prepared statement, giới hạn đọc source, không mạng, và mã hoá SQLCipher tuỳ chọn.

## Lý do

- Một file duy nhất dễ kiểm soát quyền truy cập, mã hoá, sao lưu và xoá hơn nhiều file rời.
- SQLite chạy trong tiến trình, không mở cổng mạng, không cần server.
- Hỗ trợ transaction và WAL: reader không bao giờ thấy graph dở dang.
- FTS5 và recursive CTE đáp ứng các query chính mà không phải nạp toàn bộ graph.

## Hệ quả

- Mất khả năng commit `graph.json` để chia sẻ graph qua git; mỗi máy tự build (cache theo hash giữ build lại nhanh).
- Query nhiều bước (path, impact) phụ thuộc hiệu năng của recursive CTE; G0 có spike để đo, nếu chậm thì thêm bảng cache.
- Bật mã hoá cần bản build `better-sqlite3-multiple-ciphers` và quản lý khoá (Keychain hoặc biến môi trường).
