# Changelog

## Chưa phát hành

### Màn hình: `define` và `flows`

- Command `define <screen>` và `flows <screen>`, tool MCP `get_screen_definition`, `get_screen_flows` (docs/05-data-flow.md): item của màn hình SwiftUI hoặc UIKit dựng bằng code, nguồn của từng giá trị (API kèm endpoint, type và JSON key; UserDefaults, Keychain, file; localization kèm ngôn ngữ thiếu; input), điều kiện hiển thị; luồng xử lý từ mỗi điểm vào qua các lớp, kèm DI, generic, closure async, cảnh báo (ép kiểu luôn thất bại, JSON literal không hợp lệ, hàm xử lý lỗi rỗng, input không được đọc).
- MCP server gửi instruction cách đọc output `define`/`flows` (legend, id item, cột `ITEMS`, `SUMMARY`, bước dữ liệu, `success`/`failure`, cảnh báo `⚠`).
- `define` mặc định chỉ in `ITEMS` và `SUMMARY` (`--detail` cho `DATA`, `CONDITIONS`). `datasource` của ô nhập ghi placeholder/prompt đã localize (key, bản dịch, ngôn ngữ thiếu); `Text` truyền làm `prompt:` không còn là item riêng. Nguồn `error`: lỗi bắt được trong `catch`, kèm API ném ra.
- `flows` mặc định là góc nhìn dữ liệu: mỗi bước là get/set datasource hoặc biến ViewModel (giá trị ghi xuống storage), bỏ lớp ở giữa; bước đọc datasource ghi biến được gán (`vm.notificationsEnabled ← read userDefaults "notificationsEnabled"`). Bản tóm tắt gồm `path`, `success` (dữ liệu ghi vào ViewModel, field JSON nguồn của từng field sau `map`, item hiển thị), `failure`, `stores`; `success`/`failure` chỉ giữ thay đổi dữ liệu.
- `flows --calls`: các lời gọi qua từng lớp, đánh số. `--steps`: mọi bước theo thứ tự thực thi.
- `flows --until Repository`: mọi bước từ view tới Repository (UseCase, Mapper, toán tử biến đổi kèm closure, subscription, điều kiện), phần dưới Repository gộp vào bước Repository; bản rút gọn đánh số cả toán tử biến đổi dữ liệu và subscription, ghi điều kiện của bước, liên kết request với subscription xử lý nó.
- `flows --layers ViewModel,Repository`: chỉ bước của các lớp chọn; nguồn và kết quả của bước bị ẩn gộp vào bước còn giữ.
- `flows` in cách luồng xử lý lỗi (`errors:`: `catch`, closure failure, `try?` bỏ qua lỗi, luồng gọi API không xử lý lỗi) và gộp cảnh báo.
- Output ít token: `text` (mặc định) và `compact` (mặc định của tool MCP) không căn cột, có legend, chỉ ghi tag lớp khi lớp đổi, bỏ tên màn hình; bản căn cột là `--format pretty`. Trên fixture, `define` còn 17–31%, `flows` còn 58–66% kích thước trước.

### Phân tích

- Rule kiến trúc theo dự án: `swiftgraph.json` và preset `swiftui`, `uikit`, `combine`, `concurrency`, `alamofire`, `foundation-storage`, `swinject`, `coredata`, `swiftdata`, `mvvm-clean` (`src/rules/`). Preset `swiftui`: `.alert(_:isPresented:actions:message:)` là item; `isPresented` thành điều kiện hiển thị, nội dung `message` là dữ liệu của alert.
- Extractor ghi facts data flow (`FileFacts.flow`): giá trị argument, phép gán, binding, return, closure, cây lời gọi, điều kiện `if`/`guard`/`switch`, `await`, nhánh `catch` và `try`/`try?`/`try!` của lời gọi (`EXTRACTOR_VERSION` 10).
- Resolver: lời gọi trên receiver có type generic nối tới requirement của constraint; type của property khởi tạo bằng chuỗi lời gọi (`DIContainer.shared.getLoginRepository()`); `IMPLEMENTS` qua protocol kế thừa.
- Conformance do macro phổ biến sinh ra (`@Observable`, `@Model`, `@Reducer`, `@ObservableState`, `@DependencyClient`).
- Module map cho dự án Xcode: thư mục cạnh `*.xcodeproj` thành module; `--module` được lưu giữa các lần build, thêm `--reset-modules`.
- Report: mục "Unusual links between areas".
- `swiftgraph view`: trang HTML tự chứa để xem graph, không truy cập mạng. Sidebar: tìm symbol, thông tin symbol (kind, area, file, degree), danh sách neighbor bấm được kèm loại edge và chiều, legend area bấm để ẩn/hiện, thống kê. Edge vẽ có chiều; `EXTRACTED` nét liền, `INFERRED` nét đứt; symbol trung tâm nhất luôn có nhãn; hover hiện tên.

### Hiệu năng

- Trên repo 10k file: RSS đỉnh của build lần đầu 2,95 GB xuống khoảng 1,6–1,95 GB; partial update 3,1 s xuống 1,7 s; build không đổi 0,84 s xuống 0,25 s (ADR-0003). Extract và build lại toàn bộ graph chạy trong process con; facts dạng JSON trong bảng `file_facts`; bỏ dependency `@msgpack/msgpack`. Database cũ được build lại một lần.

### Sửa lỗi

- Lời gọi và phép gán qua optional chain (`viewModel?.state = .main`, `viewModel?.login()`) mất receiver nên không thành edge.
- Partial update làm mất edge của extension nằm dưới chỗ sửa (ID extension nay là số thứ tự trong file); symbol khai báo ở hai file; build bị dừng giữa chừng để lại graph cũ.

### Dự án, tài liệu, kiểm thử

- Tách khỏi repo `tree-sitter-swift` thành repo riêng; phụ thuộc grammar qua package `tree-sitter-swift` (ADR-0001).
- Tài liệu: hướng dẫn sử dụng `docs/04-usage.md`; thiết kế luồng dữ liệu tới view `docs/05-data-flow.md` (giai đoạn GF).
- Fixture `test/fixtures/clean-app` (UIKit + SwiftUI, Alamofire, UserDefaults, Keychain, file, Swinject, Combine + async/await).
- `bench/proxy.ts --min-correct/--min-ratio`: ngưỡng số câu đúng và tỉ lệ token; repo tham chiếu ở `bench/repos.txt`.
- Bỏ bộ đánh giá `eval/` (so với index store của compiler) và workflow `.github/workflows/eval.yml`.
- Format code bằng Prettier (`npm run format`, kiểm tra trong CI).
- G0–G6, GL: extractor, resolver, lưu trữ SQLite (có mã hoá), build incremental, community/PageRank, report, query CLI, MCP server, install/hook cho agent, dữ liệu localization, benchmark proxy.
