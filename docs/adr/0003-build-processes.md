# ADR-0003: Build trong process con, facts dạng JSON trong bảng riêng

- Trạng thái: Chấp nhận
- Ngày: 2026-10-27

## Bối cảnh

Trên repo 10.389 file `.swift` (260.342 node, 1,36 triệu edge), build lần đầu có RSS đỉnh 2,95 GB; partial update khi sửa một file mất 3,1 s. Profile cho thấy:

- Bộ nhớ native mà worker thread (tree-sitter) giải phóng vẫn nằm lại trong process: allocator giữ nó, nên sau bước extract RSS còn khoảng 1,1 GB dù heap JS chỉ khoảng 30 MB. Heap của bước resolve (khoảng 1,1 GB) cộng thêm lên trên, rồi tới bước phân tích.
- Rác của graph đã resolve chưa được GC thu khi bước phân tích cấp phát, nên hai phần cộng dồn.
- Trong bảng `files`, các cột `mtime_ms`, `size`, `declaration_digest` nằm sau blob `facts`. SQLite phải đọc overflow page của blob để tới các cột phía sau, nên mọi lần quét `files` (kể cả build không đổi gì) đọc hết facts từ đĩa.
- Decode MessagePack bằng JavaScript chậm gấp khoảng 1,9 lần `JSON.parse` trên cùng dữ liệu.

## Quyết định

- Extract chạy trên pool **process con** (`child_process.fork`), không dùng worker thread. Mỗi process được thay sau 100 file. Kết quả được ghi vào DB ngay khi về, theo thứ tự path, trong một transaction.
- Build lại toàn bộ graph (resolve rồi ghi) chạy trong một process con riêng (`src/rebuild-worker.ts`). Khoá mã hoá được gửi qua kênh IPC, không qua tham số dòng lệnh hay biến môi trường. Partial update vẫn chạy trong process chính.
- Facts nằm trong bảng `file_facts (file_id, declarations, facts)`, tách khỏi `files`; cột nhỏ `declarations` đứng trước blob `facts` (migration `005_file_facts.sql`).
- Facts mã hoá JSON UTF-8 (`src/store/facts-codec.ts`). Bỏ dependency `@msgpack/msgpack`.
- Resolver đọc reference của từng file khi cần (`loadReferences`), thay vì giữ reference của cả repo trong bộ nhớ.

## Lý do

- Process thoát thì trả lại toàn bộ bộ nhớ cho hệ thống. Bước resolve và phân tích bắt đầu từ một process nhỏ, nên đỉnh bộ nhớ là đỉnh của từng bước chứ không phải tổng các bước.
- JSON decode nhanh hơn và không cần dependency; đổi lại database lớn hơn khoảng 12% (616 MB lên 688 MB trên repo 10k file).

## Hệ quả

- Spawn process tốn khoảng 1 s cho build lần đầu (extract 8,9 s lên khoảng 10 s), bù lại bằng phần ghi graph nhanh hơn.
- Đổi định dạng facts và ID của extension nâng `EXTRACTOR_VERSION` lên 5: database cũ được trích lại và build lại toàn bộ một lần.
- Facts được commit trước khi graph được build lại. Cờ `meta.graph_pending` đánh dấu khoảng này; nếu build dừng giữa chừng, lần build sau build lại toàn bộ graph.
