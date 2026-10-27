# swiftgraph

Code graph của dự án Swift cho coding agent (Claude Code, Cursor, Codex, ...), lưu trong SQLite. Agent hỏi graph qua MCP hoặc CLI thay vì grep và đọc lại file thô. Dựng trên grammar [tree-sitter-swift](../tree-sitter-swift) (repo riêng).

> Trạng thái: G0–G7 xong, trừ hai phép đo cần chạy ngoài: benchmark với agent thật (tốn token) và so với index store trên repo thật (build repo đó). Bắt đầu từ [docs/04-usage.md](docs/04-usage.md). Xem [docs/02-plan.md](docs/02-plan.md).

## Tài liệu

| File | Nội dung |
|------|----------|
| [docs/04-usage.md](docs/04-usage.md) | **Hướng dẫn sử dụng**: cài đặt, build, gắn vào agent, truy vấn, bảo mật, khắc phục sự cố |
| [docs/01-design.md](docs/01-design.md) | Thiết kế: mô hình dữ liệu, resolve, lưu trữ SQLite, bảo mật, query, MCP |
| [docs/02-plan.md](docs/02-plan.md) | Kế hoạch G0–G7 và kết quả đo |
| [docs/03-localization.md](docs/03-localization.md) | Dữ liệu `.strings`/`.stringsdict`/`.xcstrings` |
| [docs/05-data-flow.md](docs/05-data-flow.md) | Luồng dữ liệu tới view: `define` (item màn hình và nguồn dữ liệu), `flows` (luồng xử lý), rule tuỳ biến theo dự án (`swiftgraph.json`) |
| [docs/adr/](docs/adr/) | ADR-0001 bố cục repo, ADR-0002 SQLite là nơi lưu trữ duy nhất, ADR-0003 build trong process con |
| [eval/README.md](eval/README.md) | Đánh giá: benchmark token, so với index store của compiler |

## Phạm vi

Chỉ đọc nội dung file `.swift`, `.strings`, `.stringsdict`, `.xcstrings`. Mọi dữ liệu nằm trong `<repo>/.swiftgraph/graph.db` (thư mục quyền `0700`, file quyền `0600`). Không gọi mạng.

## Dùng

Cần Node ≥ 22.18 (chạy TypeScript trực tiếp) và grammar `tree-sitter-swift` checkout cạnh repo này (chưa publish npm):

```
Startup/
├── tree-sitter-swift/    (cd tree-sitter-swift && npm install)  # build binding Node của grammar
└── swiftgraph/           (cd swiftgraph && npm install)
```

```sh
node src/cli.ts build /path/to/swift-repo
node src/cli.ts stats /path/to/swift-repo
node src/cli.ts doctor /path/to/swift-repo
node src/cli.ts clean /path/to/swift-repo
```

Truy vấn graph (các lệnh nhận `--root <repo>` hoặc `--db <path>`, `--budget <tokens>`):

```sh
node src/cli.ts report /path/to/swift-repo                       # tổng quan cho agent
node src/cli.ts find EventLoop --root /path/to/swift-repo
node src/cli.ts explain 'Store.send(_:)' --root /path/to/swift-repo
node src/cli.ts callers 'Store.send(_:)' --depth 2 --root ...
node src/cli.ts path MiniApp.body 'Logging.log(_:)' --root ...
node src/cli.ts impact Sources/Core/Model.swift --root ...
node src/cli.ts area Store --root ...
node src/cli.ts source 'Store.reduce(_:)' --root ...
node src/cli.ts view /path/to/swift-repo --open                  # trang HTML, không truy cập mạng
```

Gắn vào agent (CLAUDE.md, `.mcp.json`, skill, hook; tuỳ chọn AGENTS.md, Cursor, git hook):

```sh
node src/cli.ts install /path/to/swift-repo --targets claude,agents,cursor,git
node src/cli.ts uninstall /path/to/swift-repo
```

Hoặc chỉ thêm MCP server:

```sh
claude mcp add swiftgraph -- node /path/to/swiftgraph/src/cli.ts mcp /path/to/swift-repo
```

Benchmark và đánh giá (chi tiết ở [eval/README.md](eval/README.md)):

```sh
eval/run-bench.sh --min-correct 13 --min-ratio 5               # clone repo tham chiếu, benchmark không dùng LLM (CI)
eval/run-indexstore.sh swift-argument-parser --min-precision 95 # so với index store (macOS, Swift 6.4)
node bench/agent.ts eval/graphs eval/repos                      # chạy claude -p, tốn token
```

Localization (`.strings`, `.stringsdict`, `.xcstrings`):

```sh
node src/cli.ts strings find "Chào mừng"                  # theo key, comment hoặc nội dung
node src/cli.ts strings show welcome_title                # bản dịch, ngôn ngữ thiếu, nơi dùng
node src/cli.ts strings of OnboardingView.body --depth 2  # chuỗi một view dùng
node src/cli.ts strings issues --language vi
```

Các lệnh `strings` nhận `--root <repo>` hoặc `--db <path>`.

Màn hình và luồng dữ liệu ([docs/05-data-flow.md](docs/05-data-flow.md)):

```sh
node src/cli.ts define LoginView --root <repo>                    # item, nguồn dữ liệu (API/local/file/localization), điều kiện hiển thị
node src/cli.ts flows LoginView --entry LoginView#5 --root <repo> # luồng xử lý của một item, qua các lớp
```

Mã hoá database (SQLCipher):

```sh
node src/cli.ts key create /path/to/swift-repo          # macOS: khoá lưu trong Keychain
export SWIFTGRAPH_KEY=$(openssl rand -hex 32)                              # nơi khác: khoá qua biến môi trường
node src/cli.ts build /path/to/swift-repo --encrypt
node src/cli.ts rekey /path/to/swift-repo --encrypt|--decrypt|--rotate
```

Tuỳ chọn của `build`:

| Tuỳ chọn | Ý nghĩa |
|----------|---------|
| `--exclude <glob>` | bỏ qua đường dẫn khớp glob (lặp được) |
| `--git-tracked-only` | lấy danh sách file từ `git ls-files` |
| `--module <dir>=<Name>` | gán thư mục cho module (lặp được; được lưu cho các lần build sau) |
| `--reset-modules` | bỏ các giá trị `--module` đã lưu |
| `--force` | trích lại mọi file và build lại toàn bộ graph |
| `--encrypt` | tạo database mã hoá |
| `--no-string-values` | không lưu nội dung bản dịch (chỉ key, comment, trạng thái, hash) |
| `--languages <list>` | chỉ lưu các ngôn ngữ liệt kê (`en,vi`) |
| `--workers <n>` | số process parse song song |
| `--db <path>` | đường dẫn database |

## Phát triển

```sh
npm test                        # node:test
npx tsc -p .                    # type-check
UPDATE_GOLDEN=1 npm test        # sinh lại golden facts, rồi review diff
```

| Thư mục | Nội dung |
|---------|----------|
| `src/discover/` | liệt kê file, module map từ `Package.swift` |
| `src/extract/` | `swift.ts` (duyệt cây → `FileFacts`), pool process con |
| `src/resolve/` | symbol table, quy tắc resolve, bảng SDK |
| `src/localization/` | parser `.strings`/`.stringsdict`/`.xcstrings`, khớp key, issue |
| `src/query/` | truy vấn chỉ đọc và định dạng text dùng chung cho CLI và MCP |
| `src/analyze/`, `src/report/` | community, PageRank, report tổng quan |
| `src/rules/` | rule kiến trúc: nạp `swiftgraph.json`, preset JSON |
| `src/flow/` | engine luồng dữ liệu, `define`, `flows` |
| `src/mcp.ts` | MCP server stdio |
| `src/install.ts` | install/uninstall cho agent, hook |
| `bench/` | bộ câu hỏi, benchmark proxy và với agent thật |
| `src/store/` | mở SQLite (quyền file, readonly), migration, ghi graph |
| `eval/` | đánh giá với index store của compiler (`eval/README.md`) |
| `src/schema/types.ts` | kiểu dữ liệu chung |
| `test/fixtures/mini-app/` | dự án Swift nhỏ (biên dịch được) dùng cho mọi test |
| `test/expected/` | edge và issue kỳ vọng viết tay cho G2/GL |
| `test/golden/` | facts kỳ vọng của từng file fixture |
