# swiftgraph — Hướng dẫn sử dụng

swiftgraph đọc một dự án Swift, dựng code graph (declaration, lời gọi, conformance, chuỗi localization) và lưu vào một file SQLite trong repo. Coding agent (Claude Code, Cursor, Codex, ...) hỏi graph qua MCP hoặc CLI thay vì grep rồi đọc lại file thô. Mọi thứ chạy trên máy, không gọi mạng, không dùng LLM.

Thiết kế chi tiết: [01-design.md](01-design.md). Dữ liệu localization: [03-localization.md](03-localization.md).

## 1. Cài đặt

Cần:

- Node ≥ 22.18 (chạy TypeScript trực tiếp, không cần build).
- Grammar `tree-sitter-swift` checkout cạnh repo này (chưa publish lên npm). `npm install` trong grammar build binding Node, cần trình biên dịch C (Xcode Command Line Tools trên macOS, `build-essential` trên Linux).

```
<thư mục>/
├── tree-sitter-swift/    # https://github.com/JosSteve/tree-sitter-swift — chạy `npm install`
└── swiftgraph/           # repo này — chạy `npm install`
```

Các ví dụ dưới đây gọi `swiftgraph`; nếu chưa có lệnh này trong `PATH`, thay bằng `node /path/to/swiftgraph/src/cli.ts`.

## 2. Dựng graph

```sh
swiftgraph build /path/to/MyApp
```

Lần đầu, swiftgraph parse mọi file `.swift` và file localization, rồi ghi `MyApp/.swiftgraph/graph.db`. Thêm `.swiftgraph/` vào `.gitignore` của dự án; database không được commit (xem mục 7).

Chạy lại `build` sau khi sửa code. swiftgraph chỉ parse lại file có nội dung đổi, rồi chọn một trong ba cách cập nhật (in ở cuối dòng kết quả, `graph update: ...`):

| Cập nhật | Khi nào | Thời gian (repo 3.500 file) |
|----------|---------|-----------------------------|
| `none` | không file nào đổi | 0,12 s |
| `partial` | chỉ sửa thân hàm, comment hoặc doc (khai báo giữ nguyên), tối đa 50 file | khoảng 0,7 s |
| `full` | thêm, xoá, đổi tên khai báo; xoá file; sửa `Package.swift` hoặc file localization | khoảng 10 s |

`swiftgraph install --targets git` (mục 3) thêm git hook chạy `build` nền sau commit, checkout và merge.

Kiểm tra và dọn:

```sh
swiftgraph stats /path/to/MyApp     # số file, node, edge, module
swiftgraph doctor /path/to/MyApp    # toàn vẹn, quyền file, mã hoá
swiftgraph clean /path/to/MyApp     # xoá database
```

### Tuỳ chọn của `build`

| Tuỳ chọn | Ý nghĩa |
|----------|---------|
| `--exclude <glob>` | bỏ qua đường dẫn khớp glob, ví dụ `--exclude 'Generated/**'` (lặp được) |
| `--git-tracked-only` | chỉ lấy file git theo dõi (`git ls-files`, tôn trọng `.gitignore`) |
| `--module <dir>=<Name>` | gán thư mục cho module (lặp được); được lưu cho các lần build sau |
| `--reset-modules` | bỏ các giá trị `--module` đã lưu |
| `--force` | parse lại mọi file và dựng lại toàn bộ graph |
| `--encrypt` | tạo database mã hoá (mục 7) |
| `--no-string-values` | không lưu nội dung bản dịch, chỉ key, comment, trạng thái |
| `--languages <list>` | chỉ lưu các ngôn ngữ liệt kê, ví dụ `en,vi` |
| `--workers <n>` | số process parse song song (mặc định: số CPU − 1, tối đa 8) |
| `--db <path>` | đường dẫn database (mặc định `<repo>/.swiftgraph/graph.db`) |

Thư mục luôn bỏ qua: `.git`, `.build`, `.swiftpm`, `.swiftgraph`, `DerivedData`, `Pods`, `Carthage`, `node_modules`, `*.xcodeproj`, `*.xcworkspace`, `*.xcassets`.

### Module

Module của mỗi file quyết định tên symbol (`swift:App/Store.send(_:)`) và việc resolve qua `import`. Thứ tự ưu tiên:

1. `--module <dir>=<Name>`.
2. Target trong `Package.swift` (đọc bằng parser, không chạy SwiftPM).
3. Dự án Xcode: mỗi thư mục cạnh `*.xcodeproj` có file Swift là một module, tên theo quy tắc của Xcode (`My App` → `My_App`). Thư mục tên chung (`Source`, `Src`, `Classes`, `Code`) lấy tên project. `project.pbxproj` không được đọc.
4. Quy ước `Sources/<Name>`, `Tests/<Name>`; nếu không, thư mục cấp cao nhất.

Nếu layout không theo các quy tắc trên, khai báo một lần:

```sh
swiftgraph build . --module App/Features=Features --module App/Core=CoreKit
```

## 3. Gắn vào coding agent

```sh
swiftgraph install /path/to/MyApp                                # Claude Code
swiftgraph install /path/to/MyApp --targets claude,agents,cursor,git
swiftgraph uninstall /path/to/MyApp                              # trả mọi file về như cũ
```

| Target | Thêm gì |
|--------|---------|
| `claude` | khối hướng dẫn trong `CLAUDE.md`, server `swiftgraph` trong `.mcp.json`, skill `.claude/skills/swiftgraph/`, hook `PostToolUse` nhắc dùng graph khi agent grep tên symbol Swift |
| `agents` | khối hướng dẫn trong `AGENTS.md` (Codex và các agent đọc file này) |
| `cursor` | `.cursor/rules/swiftgraph.mdc` |
| `git` | hook `post-commit`, `post-checkout`, `post-merge` chạy `build` nền |

Nội dung swiftgraph thêm vào được đánh dấu và gộp với nội dung sẵn có; chạy lại `install` không đổi gì. `install` không sửa `.gitignore`, chỉ in hướng dẫn. Nếu swiftgraph không nằm ở chỗ `install` tự tìm thấy, truyền lệnh khởi động bằng `--command`.

Chỉ thêm MCP server (Claude Code):

```sh
claude mcp add swiftgraph -- node /path/to/swiftgraph/src/cli.ts mcp /path/to/MyApp
```

MCP server chỉ đọc, gồm 14 tool:

| Tool | Trả lời |
|------|---------|
| `graph_overview` | tổng quan: module, khu vực chức năng, symbol quan trọng, entry point |
| `search_symbols` | tìm khai báo theo tên hoặc doc |
| `get_symbol` | chữ ký, doc, khu vực và quan hệ của một symbol |
| `get_neighbors` | quan hệ trực tiếp |
| `get_callers`, `get_callees` | ai gọi, gọi ai (nhiều cấp) |
| `find_path` | chuỗi quan hệ ngắn nhất giữa hai symbol |
| `get_impact` | sửa file hoặc symbol này có thể ảnh hưởng gì, kể cả test |
| `get_community` | một khu vực chức năng của codebase |
| `get_source` | source của một khai báo |
| `search_strings`, `get_string`, `get_strings_for_symbol`, `get_localization_issues` | chuỗi localization |
| `get_screen_definition` | item của màn hình và nguồn dữ liệu của từng item (`define`) |
| `get_screen_flows` | luồng xử lý của màn hình (`flows`) |

## 4. Truy vấn từ dòng lệnh

Các lệnh nhận `--root <repo>` (mặc định thư mục hiện tại) hoặc `--db <path>`, và `--budget <tokens>` để giới hạn độ dài kết quả (mặc định 1.500).

```sh
swiftgraph report .                                # tổng quan dạng Markdown
swiftgraph find EventLoop
swiftgraph explain 'Store.send(_:)'
swiftgraph neighbors Store --direction in --kinds CONFORMS_TO
swiftgraph callers 'Store.send(_:)' --depth 2
swiftgraph callees 'AppView.body'
swiftgraph path MiniApp.body 'Logging.log(_:)'
swiftgraph impact Sources/Core/Model.swift
swiftgraph area Store
swiftgraph source 'Store.reduce(_:)' --context 2
swiftgraph view . --open                           # trang HTML xem graph, không truy cập mạng
```

Tên symbol nhận ID đầy đủ (`swift:App/Store.send(_:)`), tên có type (`Store.send(_:)`) hoặc tên gốc (`send`). Khi nhiều symbol khớp, lệnh in danh sách để chọn.

Mỗi quan hệ có mức tin cậy:

- `EXTRACTED`: đọc thẳng từ cú pháp (`struct A: B`, `self.foo()`).
- `INFERRED`: suy ra qua quy tắc resolve (type của biến, import).
- `AMBIGUOUS`: nhiều ứng viên, ví dụ overload chỉ khác type tham số. Mặc định bị ẩn; thêm `--include-ambiguous` để xem.

Localization:

```sh
swiftgraph strings find "Chào mừng"                     # theo key, comment hoặc nội dung
swiftgraph strings show welcome_title                   # bản dịch, ngôn ngữ thiếu, nơi dùng
swiftgraph strings usages welcome_title
swiftgraph strings of OnboardingView.body --depth 2     # chuỗi một view dùng
swiftgraph strings issues --language vi --kind missing_translation
```

Màn hình và luồng dữ liệu ([05-data-flow.md](05-data-flow.md)):

```sh
swiftgraph define LoginView                         # item của màn hình, nguồn dữ liệu của từng item, điều kiện hiển thị
swiftgraph define ProductListViewController --source api,local
swiftgraph define LoginView --item LoginView#5      # một item, in đủ đường đi
swiftgraph define LoginView --detail                # thêm DATA (đường đi của từng giá trị) và CONDITIONS
swiftgraph define LoginView --format compact        # ít token nhất (mặc định của tool MCP)
swiftgraph define LoginView --format json           # hoặc markdown
swiftgraph flows LoginView                          # các luồng xử lý (rút gọn): path, success + mapping field, failure, stores
swiftgraph flows LoginView --steps                  # mọi bước theo thứ tự thực thi
swiftgraph flows LoginView --layers ViewModel,Repository   # chỉ tác động giữa ViewModel và Repository
swiftgraph flows LoginView --entry LoginView#5      # luồng của một item (id từ define) hoặc LoginView/F2
swiftgraph flows LoginView --format mermaid         # sequence diagram theo lớp kiến trúc
```

Tool MCP tương ứng: `get_screen_definition`, `get_screen_flows`; mặc định trả `compact`.

Tiết kiệm token khi agent đọc: hỏi hẹp (`--item`, `--entry`, `--source api`, `--no-children`), dùng `compact`, chỉ thêm `--detail`/`--steps` khi cần. `compact` bỏ căn cột, ghi file một lần cho các dòng liên tiếp (`@:49`), và đưa host API, view model, binding DI lên legend đầu output (`# api = https://api.example.com`, `# vm = ProductListViewModel`, `# di: …`). Trên fixture, `define` còn 17–31% và `flows` còn 58–66% kích thước bản trước.

Kiến trúc của dự án khai báo trong `swiftgraph.json` ở gốc repo (không bắt buộc). Không có file thì preset được chọn theo `import` của dự án: `swiftui`, `uikit`, `combine`, `alamofire`, `swinject`, `coredata`, `swiftdata` khi có import tương ứng; `concurrency`, `foundation-storage`, `mvvm-clean` luôn bật. Ví dụ khai báo wrapper Keychain riêng:

```json
{
  "sources": [
    { "id": "app.token-read", "kind": "local.keychain", "call": "TokenStore.read(key:)", "key": "key", "type": { "fixed": "String?" } }
  ]
}
```

Rule của dự án được ưu tiên hơn preset; `extends` chọn preset, `disable` tắt rule theo `id`. Định dạng: mục 5 của [05-data-flow.md](05-data-flow.md), preset trong `src/rules/presets/`. swiftgraph không chạy code nào của repo.

## 5. Hiệu năng và tài nguyên

Đo trên MacBook (Apple Silicon, 8 process parse):

| Repo | Build đầy đủ | Partial update | Không đổi | Bộ nhớ đỉnh | Database |
|------|--------------|----------------|-----------|-------------|----------|
| 3.463 file `.swift` | 10,6 s | 0,65 s | 0,12 s | 1,5 GB | 218 MB |
| 10.389 file `.swift` | 29–32 s | 1,7 s | 0,25 s | 1,6–1,95 GB | 688 MB |

Bộ nhớ đỉnh là tổng của process chính và các process con. Máy ít RAM: giảm `--workers`. Query qua MCP hoặc CLI dưới 50 ms trên graph 80.000 node.

## 6. Giới hạn đã biết

swiftgraph đọc cú pháp, không chạy type checker của Swift:

- Overload chỉ khác type tham số, hoặc lời gọi trên kết quả của chuỗi gọi phức tạp, thường thành `AMBIGUOUS`.
- Luồng qua closure lưu trong property (`childChannelInit`) không có edge `CALLS`; `path` khi đó trả về chuỗi quan hệ khác và tự ghi "no path along calls".
- Code do macro sinh ra không được đọc. Một số macro phổ biến được hiểu sẵn (`@Observable`, `@Model`, `@Reducer`, `@ObservableState`, `@DependencyClient`).
- Key path (`\.id`), `$0.id` và ghi qua method `mutating` (`items.append(x)`) chưa được ghi nhận đầy đủ là đọc/ghi property.

Độ chính xác của edge `CALLS` được đo với index store của compiler (`eval/README.md`).

## 7. Dữ liệu và bảo mật

- swiftgraph chỉ mở file `.swift`, `.strings`, `.stringsdict`, `.xcstrings` (và `Package.swift` để lấy module). Không đọc `Info.plist`, `project.pbxproj` hay file khác; không theo symlink; không gọi mạng.
- Mọi dữ liệu nằm trong một file: `.swiftgraph/graph.db` (thư mục quyền `0700`, file `0600`). Database chứa tên symbol, chữ ký, doc comment và bản dịch, nên có giá trị như chính source code: không commit, không chia sẻ. `doctor` cảnh báo khi quyền file quá rộng.
- MCP server và các lệnh query mở database ở chế độ chỉ đọc. `get_source` chỉ đọc file có trong graph, nằm trong repo.

Mã hoá database (SQLCipher):

```sh
swiftgraph key create /path/to/MyApp            # macOS: tạo khoá, lưu trong Keychain
export SWIFTGRAPH_KEY=$(openssl rand -hex 32)   # nơi khác: khoá qua biến môi trường
swiftgraph build /path/to/MyApp --encrypt
swiftgraph rekey /path/to/MyApp --encrypt       # mã hoá database sẵn có
swiftgraph rekey /path/to/MyApp --rotate        # đổi khoá
swiftgraph rekey /path/to/MyApp --decrypt
```

Khoá được tìm theo thứ tự: biến môi trường `SWIFTGRAPH_KEY`, rồi Keychain (macOS). Khoá không bao giờ xuất hiện trên dòng lệnh của process nào.

## 8. Khắc phục sự cố

| Hiện tượng | Cách xử lý |
|------------|-----------|
| `no graph database at ...` | chạy `swiftgraph build <repo>` trước, hoặc truyền `--root`/`--db` đúng |
| Kết quả có vẻ cũ sau khi sửa code | chạy `build`; nếu vẫn sai, `build --force` |
| Symbol nằm sai module | xem mục 2 (Module), dùng `--module` |
| `with syntax errors: N` | N file có cú pháp grammar chưa hiểu; phần còn lại của mỗi file vẫn được đọc |
| Cảnh báo `DEP0151 ... tree-sitter-swift` khi chạy | cảnh báo của Node về `package.json` của grammar, vô hại |
| Thiếu RAM khi build repo lớn | giảm `--workers`, hoặc `--exclude` code sinh tự động |
| `... is accessible by other users` | `chmod 700 .swiftgraph && chmod 600 .swiftgraph/graph.db` |
| Database mã hoá không mở được | kiểm tra `SWIFTGRAPH_KEY` hoặc Keychain; `doctor` cho biết database có mã hoá không |
