# swiftgraph — Kế hoạch triển khai

Thiết kế: [01-design.md](01-design.md). Mỗi giai đoạn kết thúc khi tiêu chí "Xong khi" đạt, test pass và docs được cập nhật. Thời lượng là ước lượng cho một người làm toàn thời gian.

## Tổng quan

| Giai đoạn | Nội dung | Ước lượng | Phụ thuộc |
|-----------|----------|-----------|-----------|
| G0 | Spike, chốt schema, khung package | 3–4 ngày | — |
| G1 | Discover + Extract | 1,5 tuần | G0 |
| G2 | Resolve + bộ đánh giá với index store | 2 tuần | G1 |
| G3 | Lưu trữ + incremental | 1 tuần | G2 |
| GL | Localization: `.strings`, `.stringsdict`, `.xcstrings` | 1,5 tuần | G3 |
| G4 | Phân tích + report + trình xem | 1 tuần | G3 |
| G5 | Query API, CLI, MCP server | 1,5 tuần | G3 (G4 cho `community`) |
| G6 | Tích hợp agent + benchmark token | 1 tuần | G5 |
| G7 | Hardening, docs, release v1 | 1 tuần | G6 |

Tổng: khoảng 10,5–11,5 tuần. GL, G4 và G5 có thể chạy song song sau G3.

Repo tham chiếu dùng lại `scripts/repos.txt` của tree-sitter-swift (clone vào `../tree-sitter-swift/test/repos` bằng `scripts/parse-repos.sh`); các con số `test/repos` bên dưới là thư mục đó. Thêm một app SwiftUI có dự án Xcode (ví dụ `nalexn/clean-architecture-swiftui`) để kiểm tra module map ngoài SPM.

## G0 — Spike và khung ✅

- [x] Khung package (ban đầu là npm workspace trong repo grammar; từ 2026-10-27 là repo riêng, phụ thuộc `tree-sitter-swift` qua `file:../tree-sitter-swift`, xem ADR-0001).
- [x] Spike: trích xuất declaration + call trên repo tham chiếu; đo tỉ lệ call có receiver hint (kết quả ở cuối file).
- [x] Chốt schema node/edge/ID (`01-design.md`, mục 3) và schema SQLite (mục 7.1): `src/schema/types.ts` + `src/store/migrations/001_init.sql` (gồm cả bảng localization).
- [x] Spike SQLite: đo recursive CTE trên graph tổng hợp 60k node / 300k edge (kết quả ở cuối file).
- [x] Fixture `test/fixtures/mini-app` (10 file Swift + 4 file localization + `Info.plist`/`project.pbxproj` làm mồi phải bị bỏ qua; biên dịch được bằng `swift build`), kèm graph kỳ vọng viết tay `test/expected/mini-app.edges.tsv` và `mini-app.issues.tsv`.

**Xong khi:** schema được review; fixture và graph kỳ vọng được commit; CI chạy test của package. ✅

## G1 — Discover và Extract ✅

- [x] `discover`: chỉ lấy `.swift`, `.strings`, `.stringsdict`, `.xcstrings` (`01-design.md`, mục 2.1); thư mục bỏ qua mặc định, `--exclude`, `--git-tracked-only`; không theo symlink; giới hạn kích thước. Module map từ `Package.swift` (đọc bằng tree-sitter), fallback theo thư mục.
- [x] Trích xuất bằng một lượt duyệt cây (`src/extract/swift.ts`) thay cho các query `.scm` (`01-design.md`, mục 4).
- [x] Container, selector, doc comment, `conditions` của `#if`, receiver hint, type suy ra của property.
- [x] `FileFacts` + cache theo hash trong SQLite; extract song song bằng pool worker thread, thay worker sau 100 file vì node-tree-sitter rò bộ nhớ native.
- [x] Golden test: facts của từng file trong fixture (`test/golden/`, chạy `UPDATE_GOLDEN=1` để sinh lại).
- [x] CLI: `swiftgraph build|stats|clean`.

**Xong khi:** facts của fixture khớp golden; extract 2.266 file của bộ repo tham chiếu trong < 20 s; không crash trên file có `ERROR`. ✅ (3.463 file trong 3,4 s, 55 file có `ERROR` vẫn trích được)

## G2 — Resolve và đánh giá (gần xong: còn đo trên repo thật)

- [x] Symbol table: type, member (kể cả qua extension), top-level, theo module (`src/resolve/resolve.ts`).
- [x] Quy tắc resolve theo receiver (`01-design.md`, mục 5); khớp selector có default argument, variadic, trailing closure; confidence; edge `AMBIGUOUS` có trọng số `1/n`, bỏ khi quá 3 ứng viên.
- [x] Các lượt sau: `CONFORMS_TO`/`INHERITS`, `EXTENDS`, `IMPLEMENTS`, `OVERRIDES`, `INSTANTIATES`, `RENDERS`, `TESTS`, `WRAPS`, `EXPANDS`, `READS`/`WRITES`, `REFERENCES`.
- [x] Bảng symbol SDK (Swift, Foundation, Combine, Observation, SwiftUI, UIKit, AppKit, XCTest, SwiftData) trong `src/resolve/sdk.ts`. Tên không có trong bảng và không khai báo trong repo thì không tạo node (có thể là generic parameter).
- [x] Ghi graph vào SQLite trong một transaction (`src/store/write-graph.ts`); build không có thay đổi thì giữ nguyên graph.
- [x] Bộ đánh giá `eval/`: `indexstore-calls` (Swift, indexstore-db `swift-6.4.0-RELEASE`) xuất lời gọi từ index store; `compare-calls.ts` tính precision/recall cho `CALLS`/`INSTANTIATES` và `READS`/`WRITES`. Đã bỏ khỏi project (2026-10-28).
- [x] Test: graph của fixture khớp `test/expected/mini-app.edges.tsv` (trừ `USES_STRING` thuộc GL), test selector, `#if`, `AMBIGUOUS`.
- [ ] Đo SG4 trên repo tham chiếu: không làm, bộ đánh giá `eval/` đã bỏ (2026-10-28).

**Xong khi:** fixture khớp graph kỳ vọng ✅; trên repo tham chiếu precision `CALLS` (EXTRACTED + INFERRED) ≥ 95% (SG4), có báo cáo recall; tỉ lệ `AMBIGUOUS` được ghi lại làm baseline ✅.

## G3 — Lưu trữ SQLite, bảo mật và incremental ✅ (trừ hai mục chuyển sang G5)

- [x] Module `store`: migration theo `meta.schema_version` (`001_init.sql`, `002_incremental.sql`), ghi trong một transaction, `facts` dạng MessagePack trong bảng `files`.
- [x] FTS5 cho tên/doc symbol; index cho `edges`.
- [x] Bảo mật: quyền `0700`/`0600` (cả file WAL), kết nối `readonly` + `query_only`, prepared statement, test tĩnh "không có code mạng" (`test/no-network.test.ts`).
- [x] Mã hoá tuỳ chọn: một driver duy nhất `better-sqlite3-multiple-ciphers` (SQLCipher) cho cả DB thường lẫn DB mã hoá; `build --encrypt`; khoá từ `SWIFTGRAPH_KEY` hoặc Keychain macOS (`swiftgraph key create`; khoá đi qua stdin của `security -i`, không xuất hiện trong command line); `swiftgraph rekey --encrypt|--decrypt|--rotate`.
- [x] `swiftgraph clean`, `swiftgraph doctor` (`integrity_check`, quyền file, trạng thái mã hoá, phiên bản schema).
- [x] Build incremental (`01-design.md`, mục 9): bỏ qua file theo mtime + size; module map cache theo mtime của các `Package.swift`; khi file đổi giữ nguyên *declaration digest* (sửa thân hàm, comment, doc) thì chỉ resolve lại reference của file đó và chỉ thay phần graph có nguồn trong file đó; ngược lại build lại toàn bộ.
- [x] Test nhất quán: sau một chuỗi sửa, graph cập nhật từng phần giống hệt graph build đầy đủ (node, edge, evidence, fan-in/out, FTS) — `test/incremental.test.ts`.
- [x] Test mã hoá: DB mã hoá không đọc được khi thiếu khoá hoặc sai khoá, file không chứa tên symbol dạng rõ, rekey các chiều — `test/encryption.test.ts`.
- [ ] Escape FTS và giới hạn `get_source` trong repo (chặn `../`, symlink): làm cùng query API ở G5, kèm test input độc hại cho tool MCP.

**Xong khi:** SG1 đạt trên repo tham chiếu (< 30 s đầy đủ, < 1 s cho mỗi file đổi), kể cả khi bật mã hoá; test nhất quán và test bảo mật pass.

Kết quả (3.463 file, 82.391 node, 395.579 edge):

| Thao tác | Không mã hoá | Mã hoá (SQLCipher) |
|----------|--------------|--------------------|
| Build đầy đủ | 8,3 s | 10,9 s |
| Build lại, không đổi file | 0,21 s | — |
| Sửa thân hàm trong 1 file (cập nhật từng phần) | 0,83–1,1 s | 1,45 s |
| Sửa khai báo (build lại toàn bộ) | khoảng 5 s | — |

Pha của lần cập nhật từng phần (không mã hoá, 834 ms): discover 122 ms, stat 31 ms, extract 72 ms, ghi `files` 25 ms, đọc summary khai báo 182 ms, resolve 375 ms (dựng lại bảng symbol), ghi graph 21 ms. Khi mã hoá, phần đọc chậm hơn vì mỗi trang đọc từ đĩa phải giải mã; page cache 256 MiB giảm thời gian từ 2,7 s xuống 1,45 s. Mục tiêu < 1 s khi bật mã hoá chưa đạt.

## GL — Localization ✅ (trừ đối chiếu với Xcode)

Thiết kế: [03-localization.md](03-localization.md).

- [x] Discover: `*.lproj/*.strings`, `*.lproj/*.stringsdict`, `*.xcstrings`; module, table và ngôn ngữ.
- [x] Lexer `.strings` (UTF-8, UTF-16 có/không BOM, comment, escape, khoá không ngoặc kép, số dòng, khôi phục sau lỗi).
- [x] `.stringsdict`: parser plist tự viết, không mở rộng entity của DTD (chặn XXE); `.xcstrings`: `JSON.parse` + kiểm tra cấu trúc, trải phẳng variation/substitution.
- [x] Schema: `files.kind`/`language`, `localization_tables`, `localized_strings`, `translations`, `localization_issues`, `string_fts` (migration `003_string_search.sql`: thêm cột `string_id`, `language` không index).
- [x] Extractor Swift (`EXTRACTOR_VERSION = 3`): key literal của `NSLocalizedString`, `String(localized:)`, `LocalizedStringResource`, `LocalizedStringKey`, 24 view và 12 modifier SwiftUI; interpolation → format specifier theo type (`%?` khi chưa biết); key không phải literal → `dynamic_key_usage`.
- [x] Resolver: node `localization_table`/`localized_string`, edge `USES_STRING` (`EXTRACTED` cho API Foundation, `INFERRED` cho SwiftUI, khớp mẫu `%?` → `INFERRED`/`AMBIGUOUS`).
- [x] Issue: `missing_key`, `unused_key`, `missing_translation`, `stale`, `needs_review`, `format_mismatch`, `duplicate_key`, `parse_error`, `dynamic_key_usage`.
- [x] CLI `swiftgraph strings find|show|usages|of|issues` (query dùng chung trong `src/query/strings.ts`, cho G5).
- [x] Bảo mật: `--no-string-values` (giá trị bị loại ngay khi đọc file, không vào blob facts; đổi tuỳ chọn thì đọc lại mọi file localization), `--languages`, giới hạn 50 MB.
- [x] Test: parser (kể cả XXE, UTF-16), extractor, issue của fixture khớp `test/expected/mini-app.issues.tsv`, edge `USES_STRING` khớp `mini-app.edges.tsv`, `--no-string-values` không để lại văn bản trong file DB, cập nhật từng phần khi sửa Swift, build lại khi sửa file localization, input độc hại cho query.
- [ ] Đối chiếu số key và % hoàn thành với String Catalog editor của Xcode trên một dự án thật (cần dự án có localization; repo tham chiếu hiện không có file `.strings`/`.xcstrings`).

**Xong khi:** golden test của fixture pass ✅; trên một dự án thật, số key và % hoàn thành theo ngôn ngữ khớp với String Catalog editor của Xcode; build lại khi sửa một file `.xcstrings` < 1 s.

Ghi chú: sửa file localization hiện build lại toàn bộ graph (khoảng 5–8 s trên 3.463 file Swift). Cập nhật riêng phần localization để đạt < 1 s là việc còn lại.

## G4 — Phân tích và report ✅ (trừ trình xem HTML)

- [x] Community: Louvain có seed cố định (kết quả ổn định giữa các lần build) trên đồ thị vô hướng có trọng số theo loại edge (`CONTAINS`/`EXTENDS` 3, `CONFORMS_TO`/`INHERITS` 2, `CALLS`/`INSTANTIATES`/`RENDERS`/`IMPLEMENTS`/`OVERRIDES` 1, `READS`/`WRITES`/`REFERENCES` 0,5; bỏ edge `AMBIGUOUS`). Tên community = type có PageRank cao nhất + thư mục chung.
- [x] PageRank trên đồ thị có hướng (ai phụ thuộc vào symbol); fan-in/out; entry point (`@main`, conform `App`/`UIApplicationDelegate`/`NSApplicationDelegate`, `main.swift`).
- [x] Chạy lại sau build đầy đủ, hoặc khi số edge thay đổi quá 5% so với lần phân tích trước (`meta.analyzed_edges`).
- [x] `swiftgraph report [--write <file>]`: tổng quan, module, community, symbol được phụ thuộc nhiều nhất, entry point, localization (% hoàn thành theo ngôn ngữ, issue), cách query. In ra stdout; chỉ ghi file khi có `--write` (quyền `0600`).
- [ ] `swiftgraph view` (HTML với sigma.js, bundle inline, không tải gì từ mạng): hoãn sang G7.
- [ ] Liệt kê cầu nối bất ngờ giữa các community: hoãn sang G7.

**Xong khi:** report của TCA và swift-nio được review thủ công là đúng về nhóm chức năng chính; HTML mở được graph 50k node.

Kết quả trên `test/repos` (82.391 node, 395.579 edge): 226 community, phân tích 1,5 s, build đầy đủ kèm phân tích 8,9 s, report 6,2 KB (khoảng 1.500 token). Community lớn nhất bám đúng các khối chức năng: `SwiftSyntax.SyntaxProtocol`, `SwiftSyntax.RawSyntax`, `SwiftLint.Rule`, `NIOCore.EventLoopPromise`.

## G5 — Query, CLI, MCP ✅

- [x] Query API dùng chung (`src/query/graph.ts`, `src/query/strings.ts`): tìm symbol (id, tên đầy đủ, hậu tố `Store.send(_:)`, tên gốc `log`), tìm full-text (prefix), láng giềng, callers/callees (CTE đệ quy, mặc định 3 cấp, tối đa 6, dừng ở 20.000 node), đường đi ngắn nhất (BFS hai chiều theo frontier), impact (file hoặc symbol → declaration, file, test bị ảnh hưởng), community, đọc source.
- [x] Định dạng text gọn có giới hạn token (`src/query/text.ts`); khi nhiều symbol khớp thì trả danh sách để chọn.
- [x] CLI: `find`, `explain`, `neighbors`, `callers`, `callees`, `path`, `impact`, `area`, `source`, `report`, `strings ...`, `mcp`.
- [x] MCP server stdio (`@modelcontextprotocol/sdk`), 14 tool chỉ đọc (`readOnlyHint`): `graph_overview`, `search_symbols`, `get_symbol`, `get_neighbors`, `get_callers`, `get_callees`, `find_path`, `get_impact`, `get_community`, `get_source`, `search_strings`, `get_string`, `get_strings_for_symbol`, `get_localization_issues`. Input có giới hạn (độ dài, độ sâu ≤ 6, budget ≤ 8.000 token).
- [x] Bảo mật query: tham số bind, FTS dạng phrase, LIKE được escape, `get_source` chỉ đọc file có trong bảng `files`, nằm trong gốc repo sau khi resolve symlink, từ chối symlink.
- [x] Test: query trên fixture, chặn symlink file và thư mục khi đọc source, input độc hại, MCP qua `InMemoryTransport` (danh sách tool, kết quả, input vượt giới hạn bị schema từ chối).

**Xong khi:** mọi query < 50 ms trên graph của TCA (SG3); MCP server chạy được trong Claude Code (`claude mcp add`). ✅ (đo trên graph 82.391 node của cả 8 repo; chưa thử `claude mcp add` trong một phiên Claude Code thật)

Độ trễ (graph 82.391 node, 395.579 edge; lần gọi thứ hai):

| Tool | Thời gian | Kích thước output |
|------|-----------|-------------------|
| `search_symbols` | 1,1 ms | 2,3 KB |
| `get_symbol` | 21–25 ms | 1,0–1,2 KB |
| `get_callers` / `get_callees` (3 cấp) | 21–23 ms | 1,4–6,0 KB |
| `find_path` | 43,5 ms | 0,4 KB |
| `get_impact` (1 file, 3 cấp) | 28,3 ms | 6,0 KB |
| `get_community` (community 7.140 node) | 34,3 ms (114 ms trước khi thêm index `nodes(community, pagerank)`) | 2,5 KB |

## G6 — Tích hợp agent và benchmark (gần xong: còn chạy benchmark với agent thật)

- [x] `swiftgraph install [--targets claude,agents,cursor,git] [--command ...]` (`src/install.ts`):
  - Claude Code: khối hướng dẫn trong `CLAUDE.md`, server `swiftgraph` trong `.mcp.json`, skill `.claude/skills/swiftgraph/SKILL.md`, hook `PostToolUse` cho `Grep|Glob` trong `.claude/settings.json`.
  - `AGENTS.md`, `.cursor/rules/swiftgraph.mdc` (`alwaysApply: true`), git hook `post-commit`/`post-checkout`/`post-merge` chạy `build` nền.
  - Mọi thứ được đánh dấu và gộp với nội dung sẵn có; chạy lại không đổi gì; `swiftgraph uninstall` trả các file về nguyên trạng. Không sửa `.gitignore` (chỉ in hướng dẫn).
- [x] Hook: `swiftgraph hook post-tool-use` đọc JSON của Claude Code; khi pattern của Grep/Glob trông như symbol Swift (`Store.send(_:)`, `func send`, tên UpperCamelCase, không phải chữ in hoa như `TODO`) và repo có graph, thêm `additionalContext` nhắc dùng tool graph. Không bao giờ chặn tool. (Thiết kế ban đầu ghi `PreToolUse`; `PostToolUse` được chọn vì `additionalContext` của nó đi vào ngữ cảnh của agent.)
- [x] Bộ câu hỏi `bench/questions.ts`: 15 câu trên swift-nio, TCA, swift-argument-parser (định nghĩa, ai gọi, conformance, impact, đường đi, area), mỗi câu có chuỗi bắt buộc và chuỗi bị loại; đáp án kiểm lại bằng grep trên source.
- [x] Benchmark proxy không dùng LLM (`bench/proxy.ts`): so số token của output tool graph với "grep symbol rồi đọc các file nhiều kết quả nhất".
- [x] Runner với agent thật (`bench/agent.ts`): mỗi câu hỏi chạy `claude -p` hai lần (chỉ Read/Grep/Glob, và thêm MCP swiftgraph), so token, lượt, chi phí, độ đúng.
- [ ] Chạy `bench/agent.ts`: tốn token của tài khoản Claude, chờ người dùng đồng ý.

**Xong khi:** SG5 đạt (giảm token ≥ 5 lần, độ đúng không giảm); kết quả ghi vào docs.

Kết quả benchmark proxy (2026-10-27; token ≈ ký tự / 4):

| Question | Graph tokens | Graph calls | Grep+read tokens | Grep+read calls | Ratio | Expected found |
|---|---|---|---|---|---|---|
| nio-definition | 274 | 1 | 28650 | 3 | 104.6× | yes |
| nio-conformers | 1497 | 1 | 106241 | 6 | 71.0× | yes |
| nio-callers | 1457 | 1 | 100251 | 6 | 68.8× | yes |
| nio-impact | 1509 | 1 | 37496 | 6 | 24.8× | yes |
| nio-path | 155 | 1 | 66623 | 7 | 429.8× | NO ("no path along calls") |
| tca-definition | 264 | 1 | 12723 | 4 | 48.2× | yes |
| tca-conformers | 1495 | 1 | 39766 | 6 | 26.6× | yes |
| tca-callers | 47 | 1 | 68597 | 6 | 1459.5× | NO (missing ComposableArchitectureTests) |
| tca-impact | 1488 | 1 | 21518 | 6 | 14.5× | yes |
| tca-area | 684 | 1 | 6016 | 2 | 8.8× | yes |
| ap-callees | 117 | 1 | 2597 | 2 | 22.2× | yes |
| ap-conformers | 1486 | 1 | 27955 | 6 | 18.8× | yes |
| ap-instantiations | 1364 | 1 | 17099 | 5 | 12.5× | yes |
| ap-path | 87 | 1 | 6626 | 5 | 76.2× | yes |
| ap-impact | 1509 | 1 | 27797 | 6 | 18.4× | yes |

Total: graph 13433 tokens, grep+read 569955 tokens, ratio 42.4×; expected answers found in 13/15.

Diễn giải:

- Proxy đánh giá cao hơn thực tế ở phía "grep + đọc": agent thật thường đọc một phần file và dừng sớm. Con số cần được xác nhận bằng `bench/agent.ts`.
- Hai câu sai là giới hạn đã biết của resolver:
  - `tca-callers`: `TestStore.receive` có 5 overload chỉ khác type tham số; không có type checker nên lời gọi bị đánh dấu `AMBIGUOUS` và bị ẩn (hơn 3 ứng viên thì không tạo edge).
  - `nio-path`: luồng từ `bind0` tới `addHandler` đi qua closure lưu trong property (`childChannelInit`), không có edge `CALLS`; tool trả về chuỗi quan hệ vô hướng và tự đánh dấu "no path along calls".
- Lỗi sửa trong lúc làm benchmark: generic parameter (`Value`, `Action`) bị nối nhầm với type trùng tên ở module không được import; type lồng nhau bị tìm theo tên đơn; macro `@Reducer` chiếm ID của `protocol Reducer`; lọc `kind` của `search_symbols` áp sau `LIMIT`; `find_path` đi xuyên symbol SDK; danh sách test trong `get_impact` bị cắt (nay gộp theo type test).

## G7 — Hardening và release v1

- [x] Module map cho dự án Xcode không có `Package.swift`: thư mục cạnh `*.xcodeproj` thành module (không đọc `project.pbxproj`); `--module <dir>=<Name>` được lưu cho các lần build sau, `--reset-modules` để xoá. Trên Alamofire: `watchOS Example WatchKit Extension/` → `watchOS_Example_WatchKit_Extension`, `Example/Source/` → `iOS_Example`.
- [x] Conformance do macro phổ biến sinh ra: `@Observable` → `Observable`, `@Model` → `PersistentModel`, TCA `@Reducer` → `Reducer`, `@ObservableState` → `ObservableState`, `@DependencyClient` → `Sendable` (edge `CONFORMS_TO`, INFERRED). Attribute được resolve thành macro trước, rồi mới thành type (`@Reducer` cạnh `protocol Reducer`).
- [x] `swiftgraph view`: một trang HTML tự chứa (canvas, dữ liệu nhúng, CSP `default-src 'none'`), layout ForceAtlas2 tính sẵn, file quyền `0600` trong thư mục tạm riêng. 50.000 node: dựng trong 19 s, file 10 MB.
- [x] Report có mục "Unusual links between areas": cặp community lớn (≥ 20 node) chỉ nối nhau bằng một edge, bỏ code test.
- [x] Hiệu năng: profile và giảm bộ nhớ cho repo 10k file (ADR-0003, bảng dưới). Partial update dưới 1 s chưa đạt: cần giữ bảng symbol giữa các lần build (xem cuối mục).
- [x] Tách repo: swiftgraph và tree-sitter-swift là hai repo riêng (ADR-0001); CI riêng checkout cả hai.
- [x] Docs người dùng: [04-usage.md](04-usage.md).
- [x] CI chạy eval trên repo tham chiếu (`.github/workflows/eval.yml`). Đã bỏ khỏi project cùng `eval/` (2026-10-28); benchmark chạy tay bằng `bench/proxy.ts`.

Số đo trên repo tổng hợp 10.389 file `.swift` (3 bản sao của `test/repos`, 107 MB; 260.341 node, 1.356.467 edge). RSS là tổng của process chính và các process con:

| Thao tác | Trước (2026-10-27) | Sau |
|----------|--------------------|-----|
| Build lần đầu (8 process) | 33,1 s; 2,95 GB | 29–32 s; 1,6–1,95 GB (process chính 0,95–1,05 GB) |
| Build lại, không file nào đổi | 0,84 s; 0,49 GB | 0,22–0,27 s; 0,13 GB |
| Sửa thân hàm 1 file (partial update) | 3,1 s; 1,34 GB | 1,7 s; 0,86 GB |
| Kích thước database | 616 MB | 688 MB |

Thay đổi chính, theo mức đóng góp:

- Extract và build lại toàn bộ graph chạy trong process con; facts được ghi ngay khi về (ADR-0003).
- Bảng `file_facts` tách blob khỏi `files`: build không đổi gì không còn đọc 400 MB facts từ đĩa.
- Facts dạng JSON thay cho MessagePack (decode nhanh gấp khoảng 1,9 lần); resolver đọc reference từng file khi cần.
- Resolver: key của edge dùng số thay cho chuỗi symbol id (trung bình 125 xuống 14 ký tự); danh sách type/member nối thêm phần tử thay vì sao chép (trước là O(n²)); type của extension được resolve một lần; partial update không tạo edge `CONTAINS`/`IMPORTS` của file khác.
- Ghi graph: bỏ index phụ rồi tạo lại sau bulk insert, tính fan-in/out trong JS (8,9 s xuống khoảng 8 s).
- Phân tích: duyệt edge theo stream và cộng weight theo cặp node trước khi đưa vào graphology.
- Discover: tra module theo thư mục cha thay vì duyệt mọi entry (265 ms xuống gần 0 trên repo nhiều `Package.swift`). Cache SQLite của build 64 MB thay vì 256 MB.

Lỗi tìm ra khi đối chiếu partial update với build đầy đủ trên repo này, đã sửa và có test:

- ID của extension chứa số dòng (`Store+ext@Store.swift:457`), nên sửa thân hàm phía trên làm mất edge của extension. Nay là số thứ tự trong file (`Store+ext@Store.swift#1`).
- Symbol khai báo ở hai file (biến thể `#if`) chỉ giữ edge của một file sau partial update. Nay file như vậy luôn build lại toàn bộ.
- Build dừng sau khi commit facts (lỗi hoặc bị kill) khiến lần sau báo "không đổi" với graph cũ. Nay có cờ `meta.graph_pending`.

Partial update còn 1,7 s: 0,4 s decode summary của mọi file, 1,0 s dựng lại bảng symbol và node của 10k file. Muốn dưới 1 s cần giữ bảng symbol giữa các lần build (ví dụ trong một process chạy nền); để sau v1.

Số đo các mục tiêu (2026-10-27):

| Mục tiêu | Số đo | Đạt |
|----------|-------|-----|
| SG1: 2.000 file < 30 s; incremental < 1 s mỗi file | 3.463 file: build đầy đủ 10,6 s, partial update 0,65 s; 10.389 file: 29–32 s và 1,7 s | ✅ (ở cỡ mục tiêu) |
| SG2: mỗi edge có mức tin cậy và bằng chứng | mọi edge có `confidence`; evidence (file, dòng) tối đa 20 vị trí | ✅ |
| SG3: query < 50 ms | 1–44 ms trên graph 82k node (G5) | ✅ |
| SG4: precision `CALLS` ≥ 95% so với index store | fixture: 100% (25/25); repo thật: không đo (`eval/` đã bỏ) | ⏳ |
| SG5: ít token hơn ≥ 5 lần, độ đúng không giảm | proxy: 42,4×, 13/15 câu; với agent thật: chưa chạy (`bench/agent.ts`, tốn token) | ⏳ |
| SG6: offline, không LLM | không có lời gọi mạng hay LLM trong `src/` | ✅ |

**Xong khi:** mọi mục tiêu SG1–SG6 có số đo trong docs; CI xanh.

## GF — Luồng dữ liệu tới view

Thiết kế: [05-data-flow.md](05-data-flow.md). Ước lượng 5–6 tuần, sau v1. Kết quả đầu tiên cần dùng được: command `define <screen>` (item màn hình và quan hệ datasource, mục 6.1 của thiết kế; mẫu output trên `../test/fixtures/custom-clean-app` là đáp án kiểm chứng), rồi command riêng `flows <screen>` (luồng xử lý của màn hình, mục 6.2), nên F1–F3 làm trước phần nó cần, phần còn lại sau.

- [ ] F0 (3 ngày), phần lớn xong: nạp `swiftgraph.json` và gộp preset (`extends`, `id`, `disable`, preset mặc định theo `import`), kiểm tra cấu trúc khi nạp (`src/rules/load.ts`). Còn lại: JSON Schema, `swiftgraph rules check`, `rules explain`. Hash rule trong `meta` không cần nữa vì rule áp lúc query (05-data-flow.md, mục 9).
- [x] F1: extractor (`FileFacts.flow`, `genericConstraints`, `initializerChain`, `closure` của phép gán, nhánh `catch`, `try`/`try?`/`try!`; `EXTRACTOR_VERSION` 10), resolver (`IMPLEMENTS` qua protocol kế thừa, receiver generic → requirement, type của property từ chuỗi lời gọi), engine luồng dữ liệu lúc query (`src/flow/engine.ts`: type biểu thức, generic và associatedtype, dispatch theo DI, lần ngược giá trị, ép kiểu luôn thất bại). Edge `FLOWS_TO`/`DISPATCHES` không lưu vào database (05-data-flow.md, mục 9).
- [x] F2: rule và preset `swiftui`, `uikit`, `combine`, `concurrency`, `alamofire`, `foundation-storage`, `swinject`, `mvvm-clean`; layer, nguồn, sink, item view, DI, điểm vào áp lúc query. Edge `INJECTS`, `DISPLAYS`, `SOURCES`, `nodes.layer`, `nodes.tags` chưa lưu.
- [ ] F3, phần lớn xong: `define` (text, json, markdown) và tool MCP `get_screen_definition`; `flows` (text, json, markdown, Mermaid) và tool `get_screen_flows`. Còn lại: `data_usage`, `layer_check`.
- [x] F4: fixture `test/fixtures/clean-app` theo stack của dự án thật: UIKit + SwiftUI, MVVM + Clean, mapper generic như `../test/fixtures/custom-clean-app`, Alamofire (callback, `publishDecodable`, `serializingDecodable` + `await`), UserDefaults, wrapper Keychain, cache file, Swinject, Combine và async/await lẫn nhau, một `UITableViewCell` và một row SwiftUI trong `List`. Output kiểm chứng `test/expected/clean-app.*` (`test/data-flow.test.ts`); Alamofire mới có `serializingDecodable` + `await` trong fixture.

**Xong khi:**

- Trên `clean-app`, `define` của mỗi màn hình và item view ra đúng mọi giá trị hiển thị cùng nguồn của nó; `flows` của mỗi màn hình khớp đáp án.
- Trên `../test/fixtures/custom-clean-app`, `define LoginView` khớp mẫu output ở mục 6.1; `flows LoginView` khớp mẫu output ở mục 6.2.
- Đổi một quy ước kiến trúc (tên wrapper Keychain, protocol mapper) chỉ cần sửa `swiftgraph.json`.

## Sau v1

- Chế độ chính xác qua index store (`--precise`).
- Node tài liệu từ README/DocC.
- `impact` cho PR (diff → community bị chạm).

## Kết quả G0–G1 (2026-10-26)

| Đo | Kết quả |
|----|---------|
| Build lần đầu, toàn bộ `test/repos` (3.463 file `.swift`) | 3,4 s, RSS đỉnh khoảng 0,96 GB (8 worker) |
| Build lại không đổi file | 14 file fixture: 11 ms |
| Kích thước DB (chỉ facts) | 70 MB cho 3.463 file |
| Facts | 85.877 declaration, 509.166 reference, 204.240 call |

Receiver của 204.240 lời gọi:

| Receiver | Tỉ lệ | Ý nghĩa cho G2 |
|----------|-------|----------------|
| `none` | 51,5% | hàm tự do, member của type bao ngoài, hoặc `Type(...)` |
| `expression` | 11,0% | chuỗi gọi phức tạp, chưa biết type → dễ thành `AMBIGUOUS` |
| `implicit` (`.foo`) | 7,8% | cần type từ ngữ cảnh |
| `variable` không type | 6,4% | |
| `type` | 5,7% | resolve chắc chắn |
| `variable` có type | 5,6% | resolve chắc chắn |
| `self_member` | 4,6% | cần type của property (có annotation hoặc `inferredType`) |
| `self` | 4,1% | resolve chắc chắn |
| `instance` | 2,9% | resolve chắc chắn |
| `type_member`, `super` | 0,5% | |

Spike recursive CTE (60.000 node, 300.000 edge `CALLS`):

| Query | Thời gian |
|-------|-----------|
| `callers` độ sâu 2–3 (tới 2.100 node) | 0,1–3,3 ms |
| `callers` độ sâu 5 từ node bình thường (6.600 node) | 12 ms |
| `callers` độ sâu 5 từ hub (39.000 node) | 89 ms |
| `path` độ sâu ≤ 3 | < 1 ms |

Quyết định: không cần bảng closure. `callers`/`callees` mặc định độ sâu 3 và có tham số `max_nodes` để dừng sớm. `path` dài hơn 3 bước dùng BFS hai chiều trong TypeScript, mỗi bước là một query theo frontier, vì CTE `UNION ALL` bùng nổ theo độ sâu.

## Kết quả G2 (2026-10-26)

Graph của toàn bộ `test/repos` (3.463 file): 82.391 node, 405.594 edge; build đầy đủ 8,1 s; build lại không đổi file 0,43 s.

| Edge | EXTRACTED | INFERRED | AMBIGUOUS |
|------|-----------|----------|-----------|
| `CALLS` | 16.075 | 42.824 | 32.673 (36%) |
| `INSTANTIATES` | — | 27.587 | 2.241 |
| `REFERENCES` | 71.070 | 10.904 | 17.000 |
| `READS` / `WRITES` | 28.829 | 17.938 | 1.130 |
| `CONFORMS_TO` / `INHERITS` | 8.833 | 463 | 38 |
| `EXTENDS` | 5.298 | 242 | 200 |
| `IMPLEMENTS` / `OVERRIDES` | 394 | 12.596 | 69 |

`REFERENCES AMBIGUOUS` cao một phần vì 8 repo được gộp dưới một gốc nên nhiều tên type trùng giữa các repo.

Đánh giá với index store trên fixture (26 lời gọi trong index):

| | Precision (EXTRACTED + INFERRED) | Recall |
|-|----------------------------------|--------|
| `CALLS` + `INSTANTIATES` | 100% (25/25) | 96,2% |
| `READS` + `WRITES` | 100% (18/18) | 81,8% |

Phần recall bị thiếu: key path (`\.id`), closure `$0.id`, ghi qua method `mutating` (`items.append`), thuộc tính đọc trên kết quả của chuỗi gọi.

Tối ưu ghi: lưu evidence thành cột JSON trong `edges` (thay bảng `edge_evidence`), tự gán id node, tắt kiểm tra foreign key trong lúc ghi hàng loạt; thời gian ghi giảm từ 18,5 s xuống 2,7 s.

## Quyết định cần chốt trước G0

| Câu hỏi | Đề xuất |
|---------|---------|
| Package nằm trong repo grammar hay repo riêng? | Repo riêng `swiftgraph`, cạnh `tree-sitter-swift` (ADR-0001). |
| Lưu trữ | Chỉ SQLite (`.swiftgraph/graph.db`), theo yêu cầu bảo mật (ADR-0002). Không có `graph.json`. |
| Có bật mã hoá mặc định không? | Cần xác nhận: mặc định tắt (chỉ quyền file `0600`); bật bằng `--encrypt` nếu chính sách yêu cầu mã hoá khi lưu. |
| Có dùng LLM không? | Không ở v1 (SG6). Node tài liệu bằng LLM để sau v1. |
| Ngôn ngữ cài đặt | TypeScript trên Node ≥ 22.18 (type stripping); phần đọc index store bằng Swift. |
