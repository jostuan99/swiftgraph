# Changelog

## Chưa phát hành

### Màn hình: `define` và `flows`

- Command `define <screen>` và `flows <screen>`, tool MCP `get_screen_definition`, `get_screen_flows` (docs/05-data-flow.md): item của màn hình SwiftUI hoặc UIKit dựng bằng code, nguồn của từng giá trị (API kèm endpoint, type và JSON key; UserDefaults, Keychain, file; localization kèm ngôn ngữ thiếu; input), điều kiện hiển thị; luồng xử lý từ mỗi điểm vào qua các lớp, kèm DI, generic, closure async, cảnh báo (ép kiểu luôn thất bại, JSON literal không hợp lệ, hàm xử lý lỗi rỗng, input không được đọc).
- MCP server gửi instruction cách đọc output `define`/`flows` (legend, id item, cột `ITEMS`, `SUMMARY`, bước dữ liệu, `success`/`failure`, cảnh báo `⚠`).
- `define` và `flows` dừng ở màn hình được mở bằng navigation (`NavigationLink`, `.navigationDestination`, `.sheet`, `.fullScreenCover`, `.popover`, `pushViewController`, `present`, …): màn hình đích ghi trong `children` với kiểu chuyển (`navigation push`, `navigation modal`), item và luồng của nó không còn bị gộp vào; `flows` ghi bước `push X` / `modal X`. Method router của dự án bọc các lời gọi này (`TopRoutingManager.shared.push(DetailView(), animated: true)`) được nhận ra tự động: không đọc tiếp vào router. Loại rule mới `navigation` (kèm `transition`) trong `swiftgraph.json` và preset; preset `uikit` áp dụng cả khi dự án chỉ import SwiftUI.
- Command `sync`: cập nhật database có sẵn với file đã đổi, dùng lại tuỳ chọn của lần `build` trước (`--exclude`, `--git-tracked-only`, localization); `--list` in file thêm/sửa/xoá. Git hook và skill dùng `sync`.
- `flows` in `INPUT` (sau dòng đầu: dữ liệu màn hình nhận khi được tạo, nơi tạo màn hình hoặc gọi method nhận dữ liệu, với giá trị truyền và nguồn) và `OUTPUT` (màn hình push/modal, trigger, điều kiện, parameter truyền kèm nguồn); JSON có `inputs`, `callers`, `outputs`. Không in khi chỉ lấy một luồng (`--entry`). `define` ghi màn hình đích trong `children:` (`navigation push`, `navigation modal`). Lời gọi trong `#Preview` không tính là nơi tạo màn hình.
- Loại rule mới `inputs` (preset `swift`: tham số initializer, memberwise; `swiftui`: `@Binding`, `@Environment`, `@EnvironmentObject`, bỏ `@State` và wrapper màn hình tự giữ; `uikit`: bỏ `init(coder:)`): `initializer`, `method` (`configure(with:)`), `attribute`, `memberwise`, `ignore`, `match`. Rule `navigation` nhận `transition` tuỳ ý (`replace`, `tab`) và `to` (màn hình cố định cho method của coordinator, argument của lời gọi là parameter).
- Command `rules [--kind inputs,navigation|all] [--write]`: in rule đang áp dụng (preset và `swiftgraph.json`) thành template `swiftgraph.json`, mỗi rule một dòng kèm `id`; sửa rule giữ nguyên `id` để thay rule của preset. `--write` ghi vào `swiftgraph.json`, giữ các key khác.
- Rule `sources` nhận `member` (property đọc trên một giá trị: `Localization.localized`) và `keyFrom`: key nằm trên giá trị đó thay vì argument: `rawValue` (raw value của case enum, không có thì tên case), `case`, `self` (`"login.title".localized`), hoặc tên property (`LocalizedKey(key:).text`). Dùng được với `call` (`L10n.text()`); `table` chọn bảng strings. Biến giữ một trong nhiều case cho ra mọi key có thể. Preset `foundation-storage` thêm `Bundle.localizedString(forKey:value:table:)`.
- Fixture `custom-clean-app`: enum `Localization` khớp `Localizable.strings` (en, ja), `swiftgraph.json` khai báo rule `Localization.localized` theo `rawValue`.
- Ngôn ngữ mặc định của localization: `defaultLocalization` trong `Package.swift`, `developmentRegion` trong `project.pbxproj` (sau `sourceLanguage` của String Catalog), dùng làm source language của bảng strings. `define`/`flows` ghi bản dịch mặc định trước với `default` (`default ja "First Name"`), `missing default ja` khi ngôn ngữ mặc định thiếu key, SUMMARY ghi `Localizable (default ja)`; JSON có `defaultLanguage`.
- Loại rule mới `localization` (`defaultLanguage`, `module`, `table`): đặt ngôn ngữ mặc định, thay ngôn ngữ tìm được trong project. `swiftgraph rules` in thêm kind `localization`, gồm ngôn ngữ tìm được của từng module (`project.default-language.<Module>`) để sửa.
- `define`/`flows` ghi chữ hiển thị ở ngôn ngữ mặc định thay cho key (`localization "First Name"`); key khi ngôn ngữ mặc định thiếu bản dịch (`missing default ja`). Key vẫn có trong `--detail` và JSON (thêm `value`).
- `OUTPUT` của `flows`: `parameters` là giá trị màn hình tiếp theo nhận, đặt tên theo tham số của nó; thêm property gán và method nhận dữ liệu gọi trên màn hình trước khi chuyển (`detail.item = row`, `detail.configure(with:)`). `INPUT` liệt kê property mà nơi tạo màn hình gán (`property`). Nguồn `literal` không in lại sau giá trị.
- File rule của dự án viết bằng YAML: `swiftgraph.yaml` hoặc `swiftgraph.yml` (vẫn đọc `swiftgraph.json`; nhiều file cùng lúc là lỗi). `swiftgraph rules` in template YAML, mỗi rule một dòng; `--write` ghi vào file rule có sẵn (giữ định dạng), chưa có thì tạo `swiftgraph.yaml`. Thêm dependency `yaml`.
- `define`/`flows` ghi `localized "First Name"`: chữ ở ngôn ngữ mặc định, không kèm ngôn ngữ khác; `localized missing` khi ngôn ngữ mặc định không có chữ. SUMMARY ghi `localized …`. Key và bản dịch ở `--detail` và JSON.
- Fixture `custom-clean-app` dùng `swiftgraph.yaml`.
- Output `flows`: section `INPUT`, `OUTPUT`, `FLOWS (n)` cách nhau một dòng trống (markdown: `## Flows`); luồng bỏ bước push/modal và luồng chỉ mở màn hình khác, vì `OUTPUT` đã ghi (`--steps` giữ mọi bước).
- Test bỏ thư mục `.swiftgraph/` khi copy fixture.
- `define` mặc định chỉ in `ITEMS` và `SUMMARY` (`--detail` cho `DATA`, `CONDITIONS`). `datasource` của ô nhập ghi placeholder/prompt đã localize (key, bản dịch, ngôn ngữ thiếu); `Text` truyền làm `prompt:` không còn là item riêng. Nguồn `error`: lỗi bắt được trong `catch`, kèm API ném ra.
- `flows` mặc định là góc nhìn dữ liệu: mỗi bước là get/set datasource hoặc biến ViewModel (giá trị ghi xuống storage), bỏ lớp ở giữa; bước đọc datasource ghi biến được gán (`vm.notificationsEnabled ← read userDefaults "notificationsEnabled"`). Bản tóm tắt gồm `path`, `success` (dữ liệu ghi vào ViewModel, field JSON nguồn của từng field sau `map`, item hiển thị), `failure`, `stores`; `success`/`failure` chỉ giữ thay đổi dữ liệu.
- `flows --calls`: các lời gọi qua từng lớp, đánh số. `--steps`: mọi bước theo thứ tự thực thi.
- `flows --until Repository`: mọi bước từ view tới Repository (UseCase, Mapper, toán tử biến đổi kèm closure, subscription, điều kiện), phần dưới Repository gộp vào bước Repository; bản rút gọn đánh số cả toán tử biến đổi dữ liệu và subscription, ghi điều kiện của bước, liên kết request với subscription xử lý nó.
- `flows --layers ViewModel,Repository`: chỉ bước của các lớp chọn; nguồn và kết quả của bước bị ẩn gộp vào bước còn giữ.
- `flows` in cách luồng xử lý lỗi (`errors:`: `catch`, closure failure, `try?` bỏ qua lỗi, luồng gọi API không xử lý lỗi) và gộp cảnh báo.
- Output ít token: `text` (mặc định) và `compact` (mặc định của tool MCP) không căn cột, có legend, chỉ ghi tag lớp khi lớp đổi, bỏ tên màn hình; bản căn cột là `--format pretty`. Trên fixture, `define` còn 17–31%, `flows` còn 58–66% kích thước trước.

### Truy vấn

- Command `outline <file hoặc type>`, tool MCP `get_outline`: chữ ký, modifier (`@Published private(set)`), dòng bắt đầu–kết thúc và dòng đầu doc của các khai báo trong một file, hoặc một type kèm extension ở file khác, không có thân hàm.
- `callers`/`callees` đi qua protocol requirement và override tới implementation (`via Protocol.method()`, `→ Impl.method()`), in dạng cây theo nơi gọi; symbol SDK gom vào một dòng `SDK:`.
- Output truy vấn ngắn hơn: bỏ tên module khi dự án chỉ có một module; `:N` thay cho đường dẫn đã in ở dòng trên; member của symbol trong heading ghi `.member`; `neighbors` nhóm theo hướng và loại edge, chỉ ghi mức tin cậy khi khác `EXTRACTED`, bỏ edge `CONTAINS` từ file.
- `find`: tên khớp chính xác trước, rồi type, rồi member; bỏ node file (trừ khi chọn `--kind file`).
- `impact` với file: khai báo trong chính file đã sửa không còn tính là bị ảnh hưởng.
- `report`/`graph_overview`: mục `Screens` (view controller và SwiftUI view gốc, view nằm trong view khác ghi một dòng); bỏ module không có khai báo (manifest `Package.swift`); bỏ mục `How to query` dành cho CLI.
- MCP instruction rút từ ~1.250 xuống ~200 token; legend đọc output `define`/`flows` gửi kèm câu trả lời đầu tiên của từng tool trong session.

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

- `private(set) var` được lưu với access `private`; nay chỉ setter bị giới hạn, declaration giữ access của nó (mặc định `internal`). Database cũ được trích lại khi build.
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
