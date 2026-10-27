# Changelog

## Chưa phát hành

- Command `define <screen>` và `flows <screen>`, tool MCP `get_screen_definition`, `get_screen_flows` (docs/05-data-flow.md): item của màn hình SwiftUI hoặc UIKit dựng bằng code, nguồn của từng giá trị (API kèm endpoint, type và JSON key; UserDefaults, Keychain, file; localization kèm ngôn ngữ thiếu; input), điều kiện hiển thị; luồng xử lý từ mỗi điểm vào qua các lớp, kèm DI, generic, closure async, cảnh báo (ép kiểu luôn thất bại, JSON literal không hợp lệ, hàm xử lý lỗi rỗng, input không được đọc).
- `define`: `datasource` của ô nhập ghi placeholder/prompt đã localize (key, bản dịch, ngôn ngữ thiếu); `Text` truyền làm `prompt:` không còn là item riêng.
- `flows --layers ViewModel,Repository`: chỉ bước của các lớp chọn; nguồn và kết quả của bước bị ẩn gộp vào bước còn giữ.
- Output ít token: định dạng `compact` (mặc định của tool MCP) cho `define` và `flows`; `define` mặc định chỉ in `ITEMS` và `SUMMARY` (`--detail` cho `DATA`, `CONDITIONS`); `flows` gộp cảnh báo. Trên fixture, `define` còn 17–31%, `flows` còn 58–66% kích thước trước.
- `flows` mặc định in bản rút gọn: `path`, `success` (dữ liệu ghi vào ViewModel, field JSON nguồn của từng field sau `map`, item hiển thị), `failure`, `stores`; `--steps` in mọi bước.
- `flows` in cách luồng xử lý lỗi (`errors:`: `catch`, closure failure, `try?` bỏ qua lỗi, luồng gọi API không xử lý lỗi); `define` có nguồn `error` (lỗi bắt được trong `catch`, kèm API ném ra). Extractor ghi nhánh `catch` và `try`/`try?`/`try!` của lời gọi (`EXTRACTOR_VERSION` 10).
- Rule kiến trúc theo dự án: `swiftgraph.json` và preset `swiftui`, `uikit`, `combine`, `concurrency`, `alamofire`, `foundation-storage`, `swinject`, `coredata`, `swiftdata`, `mvvm-clean` (`src/rules/`).
- Resolver: lời gọi trên receiver có type generic nối tới requirement của constraint; type của property khởi tạo bằng chuỗi lời gọi (`DIContainer.shared.getLoginRepository()`); `IMPLEMENTS` qua protocol kế thừa.
- Fixture `test/fixtures/clean-app` (UIKit + SwiftUI, Alamofire, UserDefaults, Keychain, file, Swinject, Combine + async/await).
- Format code bằng Prettier (`npm run format`, kiểm tra trong CI).
- Tách khỏi repo `tree-sitter-swift` thành repo riêng; phụ thuộc grammar qua package `tree-sitter-swift` (ADR-0001).
- Thiết kế luồng dữ liệu tới view: command `define <screen>` (item màn hình và quan hệ datasource, kèm mẫu output), command `flows <screen>` riêng (luồng xử lý), rule tuỳ biến theo dự án: `docs/05-data-flow.md` (giai đoạn GF).
- Extractor ghi facts data flow (`FileFacts.flow`): giá trị argument, phép gán, binding, return, closure, cây lời gọi, điều kiện `if`/`guard`/`switch`, `await`.
- Sửa: lời gọi và phép gán qua optional chain (`viewModel?.state = .main`, `viewModel?.login()`) mất receiver nên không thành edge.
- Hướng dẫn sử dụng `docs/04-usage.md`.
- Eval trong CI (`.github/workflows/eval.yml`): `eval/run-bench.sh` (benchmark token, ngưỡng số câu đúng và tỉ lệ token), `eval/run-indexstore.sh` (precision so với index store); `bench/proxy.ts --min-correct/--min-ratio`, `eval/compare-calls.ts --min-precision`.
- Hiệu năng trên repo 10k file: RSS đỉnh của build lần đầu 2,95 GB xuống khoảng 1,6–1,95 GB; partial update 3,1 s xuống 1,7 s; build không đổi 0,84 s xuống 0,25 s (ADR-0003). Extract và build lại toàn bộ graph chạy trong process con; facts dạng JSON trong bảng `file_facts`; bỏ dependency `@msgpack/msgpack`. Database cũ được build lại một lần.
- Sửa: partial update làm mất edge của extension nằm dưới chỗ sửa (ID extension nay là số thứ tự trong file); symbol khai báo ở hai file; build bị dừng giữa chừng để lại graph cũ.
- Module map cho dự án Xcode: thư mục cạnh `*.xcodeproj` thành module; `--module` được lưu giữa các lần build, thêm `--reset-modules`.
- `swiftgraph view`: trang HTML tự chứa để xem graph, không truy cập mạng.
- Report: mục "Unusual links between areas".
- Conformance do macro phổ biến sinh ra (`@Observable`, `@Model`, `@Reducer`, `@ObservableState`, `@DependencyClient`).
- G0–G6, GL: extractor, resolver, lưu trữ SQLite (có mã hoá), build incremental, community/PageRank, report, query CLI, MCP server, install/hook cho agent, dữ liệu localization, eval với index store, benchmark proxy.
