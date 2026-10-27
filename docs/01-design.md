# swiftgraph — Thiết kế

Tên làm việc: **swiftgraph**. Công cụ biến một codebase Swift thành knowledge graph để agent (Claude Code, Cursor, Codex, ...) truy vấn thay vì grep và đọc lại file thô. Ý tưởng tương tự [graphify](https://github.com/Graphify-Labs/graphify), nhưng chuyên sâu cho Swift và dựng trên grammar [`tree-sitter-swift`](../../tree-sitter-swift) (repo riêng).

## 1. Bối cảnh và mục tiêu

Agent làm việc với codebase lớn tốn nhiều token cho việc tìm vị trí: grep, mở file, đọc lại phần đã đọc. Graph lưu sẵn câu trả lời cho các câu hỏi cấu trúc ("ai gọi hàm này", "type này conform protocol nào", "sửa file này ảnh hưởng gì"). Agent chỉ đọc source khi cần chi tiết.

graphify là công cụ đa ngôn ngữ. Nó dùng tree-sitter để lấy class, function, import, call graph, và gắn mỗi quan hệ một mức tin cậy `EXTRACTED`/`INFERRED`/`AMBIGUOUS`. swiftgraph giữ các ý tưởng đó và bổ sung phần Swift cần mà công cụ đa ngôn ngữ thường bỏ qua:

- Extension: member nằm rải ở nhiều file và nhiều module.
- Protocol conformance, kể cả conformance khai báo qua extension, và default implementation.
- Định danh hàm theo argument label: `move(to:)` khác `move(by:)`.
- Property wrapper, result builder, macro, SwiftUI view composition.
- `#if`: code trong mọi nhánh đều vào graph, có gắn điều kiện.

### Mục tiêu

| ID | Mục tiêu |
|----|----------|
| SG1 | Build graph cho một repo 2.000 file Swift trong < 30 s; cập nhật incremental < 1 s cho mỗi file đổi. |
| SG2 | Mỗi edge có mức tin cậy và bằng chứng (file, dòng). |
| SG3 | Query < 50 ms. Kết quả dạng text gọn, có giới hạn token. |
| SG4 | So với SourceKit index trên repo tham chiếu: precision CALLS ≥ 95% với edge `EXTRACTED` + `INFERRED`. |
| SG5 | Trên bộ câu hỏi benchmark, agent dùng graph tốn ít token hơn ít nhất 5 lần so với agent không dùng graph, với tỉ lệ trả lời đúng không giảm. |
| SG6 | Chạy offline, không gọi LLM ở đường chính. |

### Non-goals (v1)

- Type checking đầy đủ: không suy luận generic, overload theo type, hay kiểu trả về của chuỗi gọi dài.
- Graph cho ngôn ngữ khác (Objective-C, C) ngoài node "external symbol".
- Trích khái niệm từ tài liệu bằng LLM. Để giai đoạn sau (mục 11).

### Phạm vi file được đọc

swiftgraph **chỉ đọc nội dung** của 4 loại file:

| Phần mở rộng | Dùng cho |
|--------------|----------|
| `.swift` | code, kể cả `Package.swift` (module map) |
| `.strings`, `.stringsdict` | localization (trong `*.lproj/`) |
| `.xcstrings` | String Catalog |

Mọi file khác (`project.pbxproj`, `Info.plist`, `.gitignore`, asset, storyboard, ...) không bị mở. Thư mục được duyệt bằng tên file; quy tắc duyệt ở mục 2.1.

## 2. Kiến trúc tổng quan

```
             ┌──────────────┐
 Swift repo ─┤ 1. Discover  │  file .swift + .strings/.stringsdict/.xcstrings, module map
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │ 2. Parse     │  tree-sitter-swift (binding Node), cache theo hash nội dung
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │ 3. Extract   │  facts cục bộ của từng file: declaration, reference, import
             └──────┬───────┘   (src/extract/swift.ts, chạy trong process con)
                    ▼
             ┌──────────────┐
             │ 4. Resolve   │  symbol table toàn repo, nối reference với declaration,
             └──────┬───────┘   gắn confidence
                    ▼
             ┌──────────────┐
             │ 5. Analyze   │  community, centrality, entry point, hotspot
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │ 6. Store     ├───► .swiftgraph/graph.db (SQLite: facts, node, edge, FTS5)
             └──────┬───────┘     report/HTML sinh theo yêu cầu từ graph.db
                    ▼
      ┌─────────────┴─────────────┐
      ▼                           ▼
 CLI `swiftgraph ...`     MCP server (stdio) ──► agent
```

### 2.1 Discover

- Duyệt cây thư mục từ gốc repo, chỉ giữ file có phần mở rộng ở bảng trên (so sánh không phân biệt hoa thường).
- Không đi theo symlink; bỏ qua file lớn hơn giới hạn (mặc định 5 MB cho `.swift`, 50 MB cho file localization).
- Bỏ qua các thư mục mặc định: `.git`, `.build`, `.swiftpm`, `.swiftgraph`, `DerivedData`, `Pods`, `Carthage`, `node_modules`, `*.xcodeproj`, `*.xcworkspace`, `*.xcassets`. Thêm thư mục bỏ qua bằng `--exclude <glob>`.
- `--git-tracked-only`: lấy danh sách đường dẫn từ `git ls-files -co --exclude-standard` (git tự áp dụng `.gitignore`; swiftgraph không đọc file này). Danh sách vẫn được lọc theo phần mở rộng.
- Module map: đọc `Package.swift` bằng tree-sitter-swift (lời gọi `.target`, `.executableTarget`, `.testTarget`, `.macro` với `name:`/`path:`); thư mục mặc định `Sources/<name>`, `Tests/<name>`. Dự án Xcode (không đọc `project.pbxproj`): mỗi thư mục cạnh một `*.xcodeproj` có file Swift là một module, tên theo quy tắc `PRODUCT_MODULE_NAME` (`My App` → `My_App`); thư mục tên chung (`Source`, `Src`, `Classes`, `Code`) lấy tên project. Thứ tự ưu tiên: `--module`, rồi `Package.swift`, rồi thư mục Xcode, rồi quy ước `Sources/<Name>`. File không thuộc target nào: module là tên thư mục cấp cao nhất chứa nó, hoặc tên thư mục gốc repo. Giá trị `--module` được lưu trong database để các lần build sau (git hook) dùng lại; `--reset-modules` xoá chúng.

Bước 3 chỉ phụ thuộc vào một file, nên cache được theo hash (trong bảng `file_facts` của SQLite) và chạy song song trên pool process con (`src/extract/pool.ts`). Mỗi process được thay sau 100 file: node-tree-sitter không giải phóng bộ nhớ native của syntax tree (đo được khoảng 0,9 MB mỗi lần parse file 60 KB, GC không thu hồi). Dùng process thay cho thread vì bộ nhớ một thread giải phóng vẫn nằm lại trong process (allocator giữ), còn process thoát thì trả lại hết ([ADR-0003](adr/0003-build-processes.md)). Kết quả được ghi vào DB ngay khi về. Bước 4 và 5 chạy trên toàn repo nhưng làm việc trên facts đọc từ DB, không parse lại; build lại toàn bộ graph chạy trong một process con riêng (`src/rebuild-worker.ts`).

## 3. Mô hình dữ liệu

### 3.1 Node

| Kind | Ví dụ | Ghi chú |
|------|-------|---------|
| `module` | `ComposableArchitecture`, `SwiftUI` (external) | target SPM, hoặc module ngoài được import |
| `file` | `Sources/App/Store.swift` | |
| `type` | class, struct, enum, actor, protocol | thuộc tính `type_kind` |
| `extension` | `extension Store: ObservableObject` | một node cho mỗi khối extension |
| `function` | func top-level, method, `init`, `subscript`, operator | thuộc tính `function_kind` |
| `property` | `var`, `let` (member hoặc global) | gồm computed property và property wrapper |
| `enum_case` | `case loading` | |
| `typealias` / `associatedtype` | | |
| `macro` | `macro Observable()` | |
| `external_symbol` | `UIViewController`, `Task` | symbol không có declaration trong repo |
| `localization_table` | `Localizable` (`.strings`/`.xcstrings`) | xem [03-localization.md](03-localization.md) |
| `localized_string` | key `welcome_title` | bản dịch nằm trong bảng `translations`, không phải node |

Schema SQLite cho localization (`localization_tables`, `localized_strings`, `translations`, `localization_issues`, `string_fts`) nằm trong [03-localization.md](03-localization.md), mục 3.

Thuộc tính chung của node:

```json
{
  "id": "swift:App/Store.send(_:)",
  "kind": "function",
  "name": "send(_:)",
  "qualified_name": "App.Store.send(_:)",
  "signature": "func send(_ action: Action) -> StoreTask",
  "access": "public",
  "modifiers": ["@discardableResult", "@MainActor"],
  "file": "Sources/App/Store.swift",
  "range": [120, 4, 134, 5],
  "doc": "Sends an action to the store.",
  "conditions": ["swift(>=5.9)"],
  "community": 3,
  "metrics": { "fan_in": 42, "fan_out": 7, "pagerank": 0.0123 }
}
```

Cột `nodes.kind` lưu loại chi tiết thay cho `type` + `type_kind`: `class`, `struct`, `enum`, `actor`, `protocol`, `extension`, `function`, `initializer`, `deinitializer`, `subscript`, `property`, `enum_case`, `typealias`, `associatedtype`, `macro`, cùng `module`, `file`, `external_symbol` (kind SDK nằm ở `signature`). Node `module`/`file` có ID `module:<Name>` và `file:<path>`.

### 3.2 Định danh ổn định (ID)

`swift:<Module>/<Container>.<name><selector>`

- Function dùng selector có label: `move(to:)`, `init(from:)`, `subscript(_:)`.
- Member khai báo trong extension vẫn gắn vào type gốc: `swift:App/Store.scope(state:action:)`. Node `extension` riêng có ID `swift:App/Store+ext@Sources/App/Store+Scope.swift#1` (extension thứ 1 của `Store` trong file; không dùng số dòng để ID không đổi khi sửa thân hàm phía trên).
- Khi trùng ID (overload khác type tham số), thêm hậu tố hash ngắn của signature: `…map(_:)#a1f3`.
- Node nằm trong nhánh `#if` có thuộc tính `conditions`. ID vẫn giữ nguyên nếu chỉ một nhánh khai báo symbol đó.

ID không phụ thuộc số dòng (trừ node `extension`), nên graph diff giữa các commit có ý nghĩa.

### 3.3 Edge

| Kind | Từ → Đến | Nguồn |
|------|----------|-------|
| `CONTAINS` | module→file, file→decl, type→member | cú pháp |
| `EXTENDS` | extension → type | cú pháp + resolve tên |
| `INHERITS` | class → class | inheritance clause (phần tử là class) |
| `CONFORMS_TO` | type/extension → protocol | inheritance clause (phần tử là protocol) |
| `IMPLEMENTS` | function/property → yêu cầu của protocol | cùng tên + label trong type conform |
| `OVERRIDES` | method → method của superclass | modifier `override` + tên + label |
| `CALLS` | function → function | `call_expression` |
| `INSTANTIATES` | function → type | `Foo(...)`, `.init(...)` |
| `REFERENCES` | decl → type | type trong signature, annotation, generic constraint, cast |
| `READS` / `WRITES` | function → property | `navigation_expression`, vế trái của `assignment_expression` |
| `IMPORTS` | file → module | `import_declaration` |
| `WRAPS` | property → type | attribute là property wrapper (`@Published`, `@State`, custom) |
| `EXPANDS` | decl → macro | attribute macro / `#macro(...)` |
| `RENDERS` | View.body → View | SwiftUI: gọi type conform `View` trong `body` hoặc builder |
| `TESTS` | test function → symbol | XCTest `test*` / Swift Testing `@Test` gọi tới symbol |
| `USES_STRING` | function/property → localized_string | `NSLocalizedString`, `String(localized:)`, SwiftUI `Text("key")`, ... ([03-localization.md](03-localization.md)) |

Thuộc tính chung của edge:

```json
{
  "source": "swift:App/AppView.body",
  "target": "swift:App/Store.send(_:)",
  "kind": "CALLS",
  "confidence": "INFERRED",
  "weight": 1.0,
  "evidence": [{ "file": "Sources/App/AppView.swift", "line": 48 }],
  "count": 3
}
```

### 3.4 Confidence

| Mức | Khi nào |
|-----|---------|
| `EXTRACTED` | Đọc thẳng từ cú pháp, không cần đoán: `CONTAINS`, `IMPORTS`, extension của type duy nhất, `super.foo()`, `Self.foo()`, gọi hàm có receiver kiểu đã khai báo tường minh (`let x: Foo`, tham số `x: Foo`). |
| `INFERRED` | Resolve tên theo heuristic và chỉ còn đúng một ứng viên. |
| `AMBIGUOUS` | Còn nhiều ứng viên. Tạo edge tới từng ứng viên với `weight = 1/n`. Query mặc định ẩn các edge này, trừ khi yêu cầu `include_ambiguous`. |

## 4. Trích xuất (bước 3)

Thực hiện bằng **một lượt duyệt cây** trong `src/extract/swift.ts`. Bản thiết kế đầu dự định dùng các query `.scm`, nhưng trích xuất cần ngữ cảnh mà query không giữ được: declaration bao ngoài, biến cục bộ đang trong scope cùng type của chúng, và điều kiện của các nhánh `#if` bao ngoài. Một lượt duyệt lấy đủ các thông tin sau:

| Nhóm | Node của grammar |
|------|------------------|
| Declaration | class/struct/enum/actor/protocol/extension/func/init/deinit/subscript/var/let/case/typealias/associatedtype/macro; tên, selector, modifiers, attributes, doc comment, range, `#if` |
| Kế thừa | `inheritance_clause` → `inherits` + reference `inherit` |
| Lời gọi | `call_expression`: callee, label, trailing closure, receiver |
| Type | `user_type` trong annotation, signature, cast, generic argument |
| Đọc/ghi member | `navigation_expression`, vế trái của `assignment_expression`, identifier trong vị trí giá trị |
| Attribute, macro | `attribute`, `macro_expansion_expression` |
| Import | `import_declaration` |

Kết quả của mỗi file là một `FileFacts` (kiểu đầy đủ ở `src/schema/types.ts`), mã hoá JSON UTF-8 (`src/store/facts-codec.ts`) và lưu trong `file_facts.facts`; `file_facts.declarations` giữ riêng imports và declarations để resolver dựng bảng symbol mà không decode reference:

```ts
interface FileFacts {
  version: number;               // EXTRACTOR_VERSION; đổi version thì mọi file được trích lại
  imports: string[];
  declarations: Declaration[];   // localId, parent, kind, selector, signature, range, conditions, ...
  references: Reference[];       // { from: localId | null, kind, name, selector?, receiver?, line, column }
  hasErrors: boolean;
}
```

Hash và module không nằm trong facts mà nằm ở cột `files.hash`/`files.module_id`: sửa `Package.swift` đổi module của file mà không cần trích lại.

Declaration cục bộ (biến, hàm lồng trong thân hàm) không thành node; reference bên trong chúng thuộc về declaration bao ngoài. Biến cục bộ chỉ dùng để gợi ý type cho receiver.

Một số quy tắc trích xuất:

- **Selector của lời gọi**: lấy từ label trong `value_arguments`. Trailing closure không nhãn được tính là `_`. Ví dụ `foo(x, by: 1) { }` có selector `foo(_:by:_:)`; resolver thử thêm biến thể không có closure cuối (`foo(_:by:)`).
- **Receiver hint**: `self.x`, `Self.x`, `super.x`, `TypeName.x` (tên viết hoa); biến cục bộ hoặc tham số có annotation; `let x = Foo(...)`; `guard let x = y as? Foo`.
- **Phạm vi gọi**: reference gắn với declaration gần nhất bao ngoài (function, property, hoặc closure trong property). Code top-level gắn với node `file`.
- **`#if`**: dùng node `if_directive`; điều kiện được ghi lại dạng chuỗi.

## 5. Resolve (bước 4)

Thuật toán xử lý từng reference, dừng ở bước đầu tiên tìm được ứng viên:

1. **Scope cục bộ**: biến và tham số trong function. Những reference này không tạo edge, nhưng cung cấp type hint cho receiver.
2. **Receiver đã biết type T**: tìm member của T và các extension của T. Nếu không thấy, đi lên superclass rồi tới protocol mà T conform (default implementation). Kết quả `EXTRACTED` nếu type của receiver khai báo tường minh, `INFERRED` nếu type được suy ra.
3. **Gọi không có receiver bên trong type T**: member của T, theo cùng thứ tự như bước 2; sau đó tới hàm top-level của module.
4. **Tên viết hoa được gọi** (`Foo(...)`): sinh edge `INSTANTIATES` tới type `Foo`, và `CALLS` tới `Foo.init(<selector>)` nếu tìm thấy.
5. **Theo module**: module hiện tại, rồi các module trong `imports` của file.
6. **Không có trong repo**: tạo `external_symbol` (ví dụ `SwiftUI.Text`) nếu tên khớp một module đã import. Danh sách symbol của SDK có thể nạp từ file `.swiftinterface` (tuỳ chọn).

Khớp tên dùng `name` + `selector`. Nếu selector không khớp chính xác (do default argument hoặc variadic), resolver thử khớp theo base name với `confidence = INFERRED` và giảm `weight`.

Các lượt resolve chạy sau vòng lặp chính:

- **Conformance**: phân biệt superclass và protocol trong inheritance clause. Protocol thì không có stored property mà có requirement; type ngoài thì tra danh sách protocol phổ biến của SDK.
- **IMPLEMENTS / OVERRIDES**: so tên + selector giữa member của type và requirement của protocol, hoặc method của superclass.
- **RENDERS** (SwiftUI): trong `body` hoặc hàm có `@ViewBuilder`, mỗi `INSTANTIATES` tới type conform `View` sinh thêm một edge `RENDERS`.

### Chế độ chính xác (tuỳ chọn, giai đoạn sau)

Trên macOS, nếu repo có index store (`.build/.../index/store` hoặc `DerivedData`), swiftgraph đọc nó qua `indexstore-db` để thay các edge `INFERRED`/`AMBIGUOUS` bằng edge chính xác (`confidence = EXTRACTED`, `source = "index"`). Cũng chính index store này được dùng làm ground truth để đo SG4.

## 6. Phân tích (bước 5)

| Phân tích | Cách làm | Dùng cho |
|-----------|----------|----------|
| Community | Louvain/Leiden trên đồ thị vô hướng có trọng số (`CALLS`, `REFERENCES`, `CONFORMS_TO`, ...), mỗi kind có trọng số riêng | nhóm "feature" cho report và `explain` |
| Tên community | Type có PageRank cao nhất trong nhóm, cộng thư mục chung dài nhất | report dễ đọc |
| God node | Top fan-in và PageRank | biết symbol nào là xương sống |
| Entry point | `@main`, `App`, `AppDelegate`, `main.swift`, public API của library target | chỗ bắt đầu đọc |
| Hotspot | fan-in cao kết hợp số khai báo trong file | ưu tiên review và refactor |
| Cầu nối bất ngờ | Edge nối hai community có rất ít liên kết với nhau | phát hiện coupling lạ |

## 7. Lưu trữ (bước 6): SQLite là nguồn dữ liệu duy nhất

Vì yêu cầu bảo mật, toàn bộ dữ liệu của graph nằm trong **một file SQLite**: `.swiftgraph/graph.db`. Không còn `graph.json`, không còn thư mục cache dạng file rời. Xem [ADR-0002](adr/0002-sqlite-storage.md).

### 7.1 Schema

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,           -- schema_version, grammar_version, built_at, repo_root_hash
  value TEXT NOT NULL
);

CREATE TABLE modules (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('target', 'external'))
);

CREATE TABLE files (
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,     -- đường dẫn tương đối với gốc repo
  module_id INTEGER REFERENCES modules(id),
  hash      TEXT NOT NULL,            -- sha256 nội dung
  parsed_at INTEGER NOT NULL
  -- cùng mtime_ms, size, declaration_digest (002_incremental.sql)
);

-- Blob nằm ở bảng riêng: SQLite đọc overflow page của một blob để tới các cột
-- đứng sau nó, nên blob trong `files` làm mọi lần quét `files` đọc cả facts.
CREATE TABLE file_facts (
  file_id      INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  declarations BLOB,                  -- imports + declarations (JSON), đứng trước blob lớn
  facts        BLOB NOT NULL          -- FileFacts (JSON), thay cho thư mục cache
);

CREATE TABLE nodes (
  id             INTEGER PRIMARY KEY,
  symbol_id      TEXT NOT NULL UNIQUE,  -- swift:App/Store.send(_:)
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  signature      TEXT,
  access         TEXT,
  modifiers      TEXT,                  -- JSON array
  file_id        INTEGER REFERENCES files(id) ON DELETE CASCADE,
  start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER,
  doc            TEXT,
  conditions     TEXT,                  -- JSON array điều kiện #if
  community      INTEGER,
  fan_in INTEGER, fan_out INTEGER, pagerank REAL
);

CREATE TABLE edges (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  weight     REAL NOT NULL DEFAULT 1.0,
  count      INTEGER NOT NULL DEFAULT 1,
  evidence   TEXT,                    -- JSON [[file_id, line], ...], tối đa 20 cặp
  UNIQUE (source_id, target_id, kind)
);

CREATE TABLE communities (
  id    INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  size  INTEGER NOT NULL
);

CREATE VIRTUAL TABLE symbol_fts USING fts5(
  name, qualified_name, doc, content='nodes', content_rowid='id'
);

CREATE INDEX edges_source ON edges(source_id, kind);
CREATE INDEX edges_target ON edges(target_id, kind);
CREATE INDEX nodes_file   ON nodes(file_id);
```

Truy vấn đồ thị (callers nhiều cấp, `impact`) dùng recursive CTE ngay trong SQLite, nên không cần nạp cả graph vào bộ nhớ khi query:

```sql
WITH RECURSIVE callers(id, depth) AS (
  SELECT :target, 0
  UNION
  SELECT e.source_id, c.depth + 1
  FROM edges e JOIN callers c ON e.target_id = c.id
  WHERE e.kind = 'CALLS' AND e.confidence != 'AMBIGUOUS' AND c.depth < :max_depth
)
SELECT n.qualified_name, n.file_id, n.start_line, MIN(c.depth) AS depth
FROM callers c JOIN nodes n ON n.id = c.id
WHERE c.depth > 0
GROUP BY n.id ORDER BY depth, n.pagerank DESC LIMIT :limit;
```

`path` (đường ngắn nhất) cũng chạy bằng CTE (BFS có giới hạn độ sâu). Bước phân tích (community, PageRank) nạp edge từ SQLite vào graphology rồi ghi kết quả ngược lại vào `nodes` và `communities`.

### 7.2 Output khác

| Output | Cách tạo | Lưu trên đĩa? |
|--------|----------|---------------|
| `GRAPH_REPORT.md` | `swiftgraph report` sinh từ `graph.db` | chỉ khi gọi `--write`; mặc định in ra stdout |
| `graph.html` | `swiftgraph view` dựng HTML tạm, mở bằng trình duyệt | file tạm trong thư mục tạm của OS, xoá khi thoát |
| Export JSON | `swiftgraph export --json` | chỉ khi người dùng yêu cầu |

### 7.3 Bảo mật

| Yêu cầu | Cách làm |
|---------|----------|
| Dữ liệu chỉ ở máy local | Không có lệnh nào gửi dữ liệu ra mạng; không telemetry; MCP server chỉ chạy qua stdio, không mở port. |
| Một chỗ để quản lý, sao lưu, xoá | Mọi dữ liệu nằm trong `graph.db`; `swiftgraph clean` xoá file này. `swiftgraph install` in hướng dẫn thêm `.swiftgraph/` vào `.gitignore` (không tự sửa file đó). |
| Quyền truy cập file | Tạo thư mục với quyền `0700` và `graph.db` với quyền `0600`; cảnh báo nếu quyền rộng hơn. |
| Mã hoá khi lưu (tuỳ chọn) | SQLCipher qua `better-sqlite3-multiple-ciphers` (driver duy nhất của swiftgraph). Khoá lấy từ biến môi trường `SWIFTGRAPH_KEY` hoặc Keychain macOS (service `swiftgraph`, account = gốc repo), không bao giờ ghi vào file cấu hình hay command line. `swiftgraph rekey` mã hoá, giải mã hoặc đổi khoá. |
| Giảm dữ liệu nhạy cảm lưu lại | Không lưu thân hàm hay source; chỉ lưu signature, doc comment, vị trí. `get_source` đọc trực tiếp từ file đang có trên đĩa. Tuỳ chọn `--no-doc` bỏ doc comment; `--no-literals` bỏ chuỗi literal trong signature/default value. |
| Chống injection | Mọi câu SQL dùng prepared statement có tham số. Input FTS được escape. Tool MCP không có tham số SQL tự do. |
| Kết nối chỉ đọc khi query | CLI query và MCP server mở DB ở chế độ `readonly` + `query_only`; chỉ `build` có quyền ghi. |
| Toàn vẹn | `PRAGMA journal_mode = WAL`, `foreign_keys = ON`; build ghi trong một transaction; `PRAGMA integrity_check` trong `swiftgraph doctor`. |
| Giới hạn phạm vi đọc file | `get_source` chỉ trả về file có trong bảng `files` và nằm dưới gốc repo (chặn path traversal và symlink ra ngoài). |
| Tách biệt theo repo | Mỗi repo một `graph.db` riêng; không có DB dùng chung toàn máy. |

## 8. Giao diện truy vấn

### 8.1 CLI

```
swiftgraph build [--incremental] [--precise]
swiftgraph find <text>                       # tìm symbol theo tên/doc (FTS)
swiftgraph explain <symbol>                  # vai trò, signature, quan hệ chính, community
swiftgraph callers <symbol> [--depth N]
swiftgraph callees <symbol> [--depth N]
swiftgraph path <from> <to>                  # đường ngắn nhất, có kind của từng edge
swiftgraph impact <file|symbol>...           # symbol/test bị ảnh hưởng khi sửa
swiftgraph conformers <protocol>
swiftgraph neighbors <symbol> [--kinds CALLS,REFERENCES]
swiftgraph community <id|symbol>
swiftgraph report
```

Mọi lệnh có `--json` và `--budget <tokens>` (cắt kết quả theo độ quan trọng: confidence, rồi PageRank).

### 8.2 MCP server

`swiftgraph mcp` (stdio). Các tool:

| Tool | Input | Output |
|------|-------|--------|
| `search_symbols` | `query`, `kinds?`, `limit?` | danh sách `{id, kind, qualified_name, file:line}` |
| `get_symbol` | `id` | node, signature, doc, edge tóm tắt theo kind |
| `get_neighbors` | `symbol`, `direction?`, `edge_kinds?`, `include_ambiguous?`, `limit?` | quan hệ trực tiếp dạng text |
| `get_callers`, `get_callees` | `symbol`, `depth?`, `include_ambiguous?`, `limit?` | lời gọi bắc cầu, gần nhất trước |
| `find_path` | `from`, `to`, `max_depth?` | chuỗi node/edge |
| `get_impact` | `files?` hoặc `symbols?`, `depth?` | symbol, file, test bị ảnh hưởng (xếp hạng) |
| `get_community` | `id` hoặc `symbol` | thành viên chính, cầu nối ra ngoài |
| `get_source` | `id`, `context_lines?` | đúng đoạn source của symbol |
| `search_strings`, `get_string`, `get_strings_for_symbol`, `get_localization_issues` | xem [03-localization.md](03-localization.md), mục 7 | chuỗi localization, bản dịch, nơi dùng, issue |
| `get_screen_definition`, `get_screen_flows` | xem [05-data-flow.md](05-data-flow.md), mục 6 | item màn hình và nguồn dữ liệu; luồng xử lý |
| `graph_overview` | — | report tổng quan sinh từ `graph.db` (rút gọn) |

Định dạng output tối ưu cho token. Ví dụ:

```
Store.send(_:)  [function, public, App/Store.swift:120]
  callers (12, showing 5 by pagerank):
    AppView.body                     App/AppView.swift:48        INFERRED
    TestStore.send(_:assert:)        App/TestStore.swift:301     EXTRACTED
    ...
  calls: Store.receive(_:) · Effect.run(_:) · Logger.log(_:)
  conforms-via: ObservableObject (ext Store+Observation.swift:12)
```

### 8.3 Tích hợp agent

- **CLAUDE.md / AGENTS.md**: `swiftgraph install` chèn một đoạn hướng dẫn (có marker, `swiftgraph uninstall` gỡ được): gọi `graph_overview` trước; dùng tool graph cho câu hỏi cấu trúc; chỉ grep với chuỗi literal.
- **Skill** `/swiftgraph` cho Claude Code: build/update graph, trả lời câu hỏi qua CLI.
- **Hook PostToolUse** trên `Grep`/`Glob`: nếu pattern trông như tên symbol Swift, thêm `additionalContext` gợi ý tool graph tương ứng (chỉ nhắc, không chặn).
- **`.mcp.json`**: khai báo server `swiftgraph` cho cả project.
- **Git hook** post-commit/post-checkout: chạy `swiftgraph build --incremental`.
- **Cursor**: rules file với `alwaysApply: true`.

## 9. Incremental

1. Đọc danh sách file và hash của từng file, so với bảng `files` (file có `mtime`/`size` không đổi thì không đọc lại). Chỉ file mới hoặc đổi hash mới parse và extract lại; `FileFacts` cũ nằm ở `file_facts`. File đã bị xoá được xoá khỏi `files` (facts, node và edge xoá theo `ON DELETE CASCADE`). Facts mới, file bị xoá và cờ `meta.graph_pending = 1` được commit trong một transaction.
2. Nếu mọi file Swift đổi giữ nguyên `declaration_digest` (chỉ sửa thân hàm hoặc comment) và không file nào khai báo chung một symbol với file khác (`meta.shared_symbol_files`, ví dụ biến thể `#if` ở hai file): partial update, chỉ resolve lại reference của các file đó và thay phần đóng góp của chúng. Ngược lại: build lại toàn bộ graph trong một process con. ID của node không phụ thuộc số dòng (extension đánh số thứ tự trong file), nên sửa thân hàm không đổi ID.
3. Analyze: chạy lại community khi số edge đổi vượt ngưỡng (mặc định 5%). Nếu không, chỉ cập nhật metric cục bộ.
4. Graph được ghi trong một transaction. Reader (MCP server) luôn thấy graph cũ hoặc graph mới hoàn chỉnh nhờ WAL. Xong thì `meta.graph_pending = 0`; nếu build dừng trước đó, lần build sau build lại toàn bộ graph.

## 10. Cấu trúc package

Theo [ADR-0001](adr/0001-repository-layout.md):

```
swiftgraph/                  # repo riêng, cạnh tree-sitter-swift/
├── package.json             # bin: swiftgraph; dependency tree-sitter-swift (file:../tree-sitter-swift)
├── src/
│   ├── discover/            # file list, module map (Package.swift, thư mục)
│   ├── extract/             # swift.ts (duyệt cây → FileFacts), pool.ts + worker.ts (process con)
│   ├── localization/        # đọc .strings/.stringsdict/.xcstrings, khớp key, issue
│   ├── resolve/             # symbol table, quy tắc resolve, confidence
│   ├── analyze/             # community, centrality, entry point
│   ├── store/               # SQLite: schema, migration, ghi transaction, mở readonly, mã hoá
│   ├── query/               # API query dùng chung cho CLI và MCP
│   ├── report/              # report tổng quan, HTML tạm (`view`)
│   ├── cli.ts
│   └── mcp.ts
└── test/
    ├── fixtures/            # mini repo Swift có graph kỳ vọng (golden)
    └── eval/                # so với indexstore, benchmark token
```

Thư viện dự kiến:

| Việc | Thư viện | Lý do |
|------|----------|-------|
| Parse | `tree-sitter` + `tree-sitter-swift` (package grammar) | binding Node đã test của grammar |
| Đồ thị, community, PageRank | `graphology`, `graphology-communities-louvain`, `graphology-metrics` | thuần JS, đủ nhanh cho vài trăm nghìn edge |
| SQLite | `better-sqlite3-multiple-ciphers` | API của better-sqlite3, có FTS5, recursive CTE và mã hoá SQLCipher; một driver cho cả DB thường lẫn DB mã hoá |
| MCP | `@modelcontextprotocol/sdk` | SDK chính thức |
| CLI | `commander` | phổ biến |
| Song song | `node:child_process` (`fork`) | parse/extract theo file; build lại toàn bộ graph |
| Trình xem | `sigma.js` (bundle vào HTML) | render đồ thị lớn bằng WebGL |

## 11. Mở rộng sau v1

- Node `doc`/`concept` từ README và DocC (`.docc`): trích tiêu đề, liên kết symbol (`` ``Store/send(_:)`` ``) theo cách deterministic. Nếu cần trích khái niệm thì dùng LLM, gắn `confidence = INFERRED`.
- Chế độ chính xác qua index store (mục 5).
- Phân tích PR: `impact` của diff kèm cảnh báo khi PR chạm nhiều community.
- Đa ngôn ngữ: node `external_symbol` cho Objective-C header (`@objc`).

## 12. Rủi ro

| Rủi ro | Ảnh hưởng | Giảm thiểu |
|--------|-----------|------------|
| Không có type inference nên `x.foo()` với `x` chưa rõ type tạo nhiều `AMBIGUOUS` | graph nhiễu | Ẩn `AMBIGUOUS` mặc định; receiver hint; chế độ chính xác qua index store |
| Overload theo type tham số trùng selector | gộp sai node | ID có hậu tố hash signature; edge `AMBIGUOUS` |
| Module map của dự án Xcode (không SPM) không lấy được vì không đọc `project.pbxproj` | module sai, edge giữa module bị gộp | Suy module theo thư mục; cho phép khai báo map thư mục → module bằng `--module <dir>=<Name>` |
| Graph quá lớn so với context của agent | tốn token | Mọi output có `budget`; report chỉ chứa phần tóm tắt |
| Macro sinh code không có trong source | thiếu member (`@Observable`, TCA `@Reducer`) | Bảng macro phổ biến → member tổng hợp với `confidence = INFERRED`; chế độ chính xác |
