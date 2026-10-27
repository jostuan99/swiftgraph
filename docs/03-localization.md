# swiftgraph — Dữ liệu localization

Bổ sung cho [01-design.md](01-design.md). Đưa chuỗi localization của dự án Xcode vào `graph.db`. Mục đích: agent trả lời được "key này hiển thị ở đâu", "màn hình này dùng chuỗi nào", "chuỗi nào thiếu bản dịch" mà không phải mở từng file `.strings` hay `.xcstrings`.

## 1. Phạm vi

| Định dạng | Ví dụ | Ghi chú |
|-----------|-------|---------|
| `.strings` | `en.lproj/Localizable.strings`, `vi.lproj/InfoPlist.strings` | text dạng `"key" = "value";`, có thể là UTF-16 |
| `.stringsdict` | `en.lproj/Localizable.stringsdict` | plist XML cho số nhiều; đi cùng `.strings` nên xử lý chung |
| `.xcstrings` | `Localizable.xcstrings` | String Catalog (Xcode 15+), JSON chứa mọi ngôn ngữ |

Ngoài phạm vi v1: `.xliff`/`.xcloc` (định dạng xuất ra để dịch), chuỗi trong storyboard/xib.

## 2. Mô hình dữ liệu

### 2.1 Node mới

| Kind | ID | Ví dụ |
|------|----|-------|
| `localization_table` | `l10n:<Module>/<Table>` | `l10n:App/Localizable` |
| `localized_string` | `l10n:<Module>/<Table>/<key>` | `l10n:App/Localizable/welcome_title` |

- Tên table là tên file bỏ phần mở rộng: `Localizable`, `InfoPlist`, `Settings`.
- Một table gom mọi file cùng tên trong các thư mục `*.lproj` của cùng module (`en.lproj/Localizable.strings` và `vi.lproj/Localizable.strings` là một table), hoặc là một file `.xcstrings`.
- Nếu một module có cả `Localizable.strings` và `Localizable.xcstrings` (đang chuyển đổi), cả hai cùng gộp vào một table; mỗi bản dịch ghi rõ file nguồn.
- Bản dịch **không** là node, mà là dòng trong bảng `translations` (mục 3). Một key có thể có hàng chục ngôn ngữ; để mỗi bản dịch là node sẽ làm graph phình to mà không thêm quan hệ mới.

### 2.2 Edge mới

| Kind | Từ → Đến | Nguồn |
|------|----------|-------|
| `CONTAINS` | module → localization_table → localized_string | file localization |
| `USES_STRING` | function/property/file → localized_string | lời gọi API localization trong Swift (mục 5) |

## 3. Schema SQLite

Bổ sung vào schema ở `01-design.md`, mục 7.1:

```sql
-- files.kind phân biệt file Swift và file localization.
ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'swift'
  CHECK (kind IN ('swift', 'strings', 'stringsdict', 'xcstrings'));
ALTER TABLE files ADD COLUMN language TEXT;   -- 'en', 'vi', 'Base' (lấy từ <lang>.lproj); NULL với .xcstrings

CREATE TABLE localization_tables (
  node_id         INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  module_id       INTEGER REFERENCES modules(id),
  name            TEXT NOT NULL,              -- Localizable
  source_language TEXT,                       -- sourceLanguage của .xcstrings, hoặc cấu hình
  UNIQUE (module_id, name)
);

CREATE TABLE localized_strings (
  node_id          INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  table_id         INTEGER NOT NULL REFERENCES localization_tables(node_id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  comment          TEXT,                      -- comment của developer
  extraction_state TEXT,                      -- xcstrings: manual, extracted_with_value, stale, ...
  should_translate INTEGER NOT NULL DEFAULT 1,
  UNIQUE (table_id, key)
);

CREATE TABLE translations (
  id             INTEGER PRIMARY KEY,
  string_id      INTEGER NOT NULL REFERENCES localized_strings(node_id) ON DELETE CASCADE,
  language       TEXT NOT NULL,
  variation_path TEXT NOT NULL DEFAULT '',    -- '' hoặc 'plural.one', 'device.iphone', 'plural.other|device.mac'
  value          TEXT,                        -- NULL khi bật --no-string-values
  value_hash     TEXT NOT NULL,               -- sha256, dùng để so sánh mà không cần giá trị
  state          TEXT,                        -- translated, needs_review, new, stale
  format_args    TEXT,                        -- JSON: ["%@", "%lld"] trích từ value
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line           INTEGER,                     -- với .strings; NULL với .xcstrings
  UNIQUE (string_id, language, variation_path, file_id)
);

CREATE VIRTUAL TABLE string_fts USING fts5(
  key, comment, value,
  string_id UNINDEXED, language UNINDEXED
);

CREATE INDEX translations_string ON translations(string_id, language);
```

`string_fts` lưu một dòng cho mỗi key (key + comment) và một dòng cho mỗi bản dịch có giá trị; cột `string_id` và `language` (không index) trỏ về chuỗi và ngôn ngữ. Agent tìm được bằng cả key ("welcome_title") lẫn nội dung hiển thị ("Chào mừng"). Khi bật `--no-string-values`, cột `value` của FTS để trống.

## 4. Đọc file

Mỗi file localization cũng sinh `FileFacts`, lưu trong `files.facts`, cache theo hash như file Swift.

### 4.1 `.strings`

Viết lexer nhỏ bằng TypeScript, không phụ thuộc `plutil` (vì phải chạy được ngoài macOS):

- Encoding: UTF-16 (LE/BE theo BOM) hoặc UTF-8; không có BOM thì thử UTF-8 trước.
- Cú pháp: `"key" = "value";`, key và value không có ngoặc kép (ký tự chữ, số, `_.-`), comment `/* */` và `//`. Comment ngay trước một entry được lấy làm `comment` của key.
- Escape: `\"`, `\\`, `\n`, `\t`, `\r`, `\Uxxxx`.
- Ghi số dòng của từng entry để làm bằng chứng.
- Gặp key trùng trong một file: giữ entry cuối (giống runtime) và tạo cảnh báo `duplicate_key`.
- File hỏng: ghi cảnh báo `parse_error` kèm dòng; không dừng cả lần build.
- Ngôn ngữ lấy từ thư mục `<lang>.lproj`. `Base.lproj` có ngôn ngữ `Base`.

### 4.2 `.stringsdict`

- Đọc plist XML (thư viện `plist`). Mỗi key có `NSStringLocalizedFormatKey` và các biến số nhiều. Mỗi dạng (`one`, `few`, `other`, ...) là một bản dịch với `variation_path = 'plural.<biến>.<dạng>'`.

### 4.3 `.xcstrings`

- `JSON.parse`, kiểm tra cấu trúc (`sourceLanguage`, `strings`, `version`); trường lạ thì bỏ qua và cảnh báo.
- Mỗi phần tử của `strings`: `comment`, `extractionState`, `shouldTranslate`, `localizations.<lang>`.
- `stringUnit` cho ra một bản dịch có `state`. `variations.plural.*` / `variations.device.*` (có thể lồng nhau) được trải phẳng thành `variation_path`. `substitutions` được lưu theo `variation_path = 'sub.<tên>.<...>'`.
- Key có trong catalog nhưng không có bản dịch nào: vẫn tạo `localized_string` (key nguồn chính là giá trị của ngôn ngữ nguồn).

## 5. Liên kết code Swift → chuỗi (`USES_STRING`)

Phần extract (G1) có thêm query `queries/graph/localization.scm`, bắt các lời gọi có **string literal** làm key:

| Mẫu trong Swift | Key | Table | Confidence |
|-----------------|-----|-------|-----------|
| `NSLocalizedString("k", comment: …)` | `k` | `tableName:` hoặc `Localizable` | `EXTRACTED` |
| `NSLocalizedString("k", tableName: "T", bundle: …)` | `k` | `T` | `EXTRACTED` |
| `String(localized: "k")`, `String(localized: "k", table: "T")` | `k` | như trên | `EXTRACTED` |
| `LocalizedStringResource("k")`, `LocalizedStringKey("k")` | `k` | `Localizable` | `EXTRACTED` |
| `Text("k")`, `Button("k")`, `Label("k", …)`, `Toggle("k", …)`, `.navigationTitle("k")`, `.alert("k", …)` và danh sách view/modifier SwiftUI nhận `LocalizedStringKey` | `k` | `tableName:` hoặc `Localizable` | `INFERRED` (literal có thể là `String` verbatim) |
| `Text(verbatim: "k")` | không phải localization | — | — |
| Symbol do Xcode sinh từ String Catalog (`Text(.welcomeTitle)`, `String(localized: .welcomeTitle)`) | ánh xạ tên symbol ↔ key theo quy tắc của Xcode | `Localizable` | `INFERRED` |

Literal có interpolation: `String(localized: "Hello \(name), \(count) items")` có key trong catalog là `"Hello %@, %lld items"`. Resolver chuyển interpolation thành format specifier:

1. Nếu biết type của biểu thức (tham số hoặc biến có annotation): `String` → `%@`, `Int` → `%lld`, `Double` → `%lf`, ... Khớp → `EXTRACTED`.
2. Nếu không biết type: khớp dạng mẫu, mỗi interpolation tương ứng một specifier bất kỳ. Một kết quả → `INFERRED`; nhiều kết quả → `AMBIGUOUS`.

Key dựng động (`NSLocalizedString(variable, …)`) không resolve được. Lời gọi đó được ghi lại là `dynamic_key_usage` để report thống kê.

Module và bundle: dùng module của file Swift; `bundle: .module` hoặc `Bundle.module` trỏ về module hiện tại. Nếu chỉ định bundle khác, tìm table cùng tên ở các module đã import → `INFERRED`.

## 6. Phân tích

Các phân tích này chạy sau resolve, kết quả ghi vào bảng `localization_issues`:

```sql
CREATE TABLE localization_issues (
  id        INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL,     -- missing_key, unused_key, missing_translation, stale, needs_review,
                               -- format_mismatch, duplicate_key, parse_error, dynamic_key_usage
  string_id INTEGER REFERENCES localized_strings(node_id) ON DELETE CASCADE,
  node_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,  -- nơi gọi trong code (missing_key)
  language  TEXT,
  file_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,
  line      INTEGER,
  detail    TEXT
);
```

| Issue | Điều kiện |
|-------|-----------|
| `missing_key` | Code dùng key (đã resolve được table) nhưng table không có key đó |
| `unused_key` | Key không có `USES_STRING` nào và `extraction_state` khác `manual` |
| `missing_translation` | Key cần dịch (`should_translate`) thiếu bản dịch ở một ngôn ngữ mà module hỗ trợ |
| `stale` / `needs_review` | `extractionState = stale` hoặc `state = needs_review`/`new` |
| `format_mismatch` | Bản dịch có tập format specifier khác ngôn ngữ nguồn (ví dụ `%@` so với `%d`) |
| `duplicate_key` / `parse_error` | Phát sinh khi đọc file |

Ngôn ngữ mà module hỗ trợ = mọi ngôn ngữ xuất hiện trong các table của module (không đọc `knownRegions` vì không mở `project.pbxproj`). Có thể khai báo bằng `--languages`.

## 7. Truy vấn

### CLI

```
swiftgraph strings find <text>               # tìm theo key, comment hoặc nội dung
swiftgraph strings show <key> [--table T]    # bản dịch theo ngôn ngữ, state, nơi dùng
swiftgraph strings usages <key>              # function/view dùng key
swiftgraph strings of <symbol>               # chuỗi mà một view/function dùng (kể cả qua callee, --depth)
swiftgraph strings issues [--kind K] [--language L]
```

### MCP tool

| Tool | Input | Output |
|------|-------|--------|
| `search_strings` | `query`, `language?`, `limit?` | `{key, table, language, value (rút gọn), state}` |
| `get_string` | `key`, `table?` | comment, bản dịch theo ngôn ngữ/variation, nơi dùng |
| `get_strings_for_symbol` | `id`, `depth?` | các key mà symbol (và callee của nó tới `depth`) dùng, kèm giá trị ở ngôn ngữ nguồn |
| `get_localization_issues` | `kind?`, `language?`, `table?`, `limit?` | danh sách issue có vị trí |

Ví dụ output của `get_string`:

```
welcome_title  [Localizable, App]  "Shown on the onboarding screen"
  en  "Welcome to %@"            translated
  vi  "Chào mừng đến với %@"     needs_review
  ja  —                          missing
  used by: OnboardingView.body (Onboarding/OnboardingView.swift:24, EXTRACTED)
```

Report tổng quan (`graph_overview`) có thêm phần "Localization": số table, số key, ngôn ngữ, % hoàn thành theo ngôn ngữ, số issue theo loại.

## 8. Bảo mật

Bản dịch có thể chứa nội dung chưa phát hành (tên tính năng, văn bản pháp lý), nên áp dụng cùng chính sách với phần còn lại của `graph.db` (`01-design.md`, mục 7.3), cộng thêm:

| Biện pháp | Chi tiết |
|-----------|----------|
| `--no-string-values` | Chỉ lưu key, comment, `value_hash`, `state`, `format_args`; không lưu `value`. Phân tích vẫn chạy được, trừ tìm kiếm theo nội dung. |
| `--languages en,vi` | Chỉ nạp các ngôn ngữ được liệt kê. |
| Giới hạn kích thước | Bỏ qua file localization > 50 MB (có cấu hình) và cảnh báo, tránh làm cạn bộ nhớ. |
| Parser an toàn | `.stringsdict` đọc bằng parser plist không xử lý external entity (XXE); `.xcstrings` dùng `JSON.parse` kèm kiểm tra cấu trúc. |
| Output cho agent | Tool trả về bản dịch đã cắt độ dài (mặc định 200 ký tự), kèm `budget` như các tool khác. |

## 9. Quy tắc đã triển khai

- Table gom các file cùng tên trong một module: `en.lproj/Localizable.strings` + `vi.lproj/Localizable.strings` + `en.lproj/Localizable.stringsdict` là một table `Localizable`.
- Ngôn ngữ nguồn của table: `sourceLanguage` của `.xcstrings`; nếu không có thì `en`, rồi `Base`, rồi ngôn ngữ đầu tiên.
- `missing_translation`: so với mọi ngôn ngữ xuất hiện trong các table của module (trừ `Base`); key chưa có bản dịch nào ở ngôn ngữ nguồn của `.xcstrings` thì key chính là văn bản nguồn.
- `format_mismatch`: so tập format specifier của bản dịch với bản ở ngôn ngữ nguồn cùng variation; bỏ qua dạng số nhiều (dạng `one` có thể không có số).
- `unused_key`: không có edge `USES_STRING` nào và `extractionState` khác `manual`; tính lại bằng SQL sau mỗi lần cập nhật graph.
- Edge và issue gắn với code (`USES_STRING`, `missing_key`, `dynamic_key_usage`) được cập nhật từng phần khi chỉ sửa file Swift; sửa file localization thì build lại toàn bộ graph.

## 10. Kiểm thử

- Fixture `test/fixtures/mini-app` có thêm:
  - `en.lproj`/`vi.lproj` `Localizable.strings` (bản `vi` là UTF-16) và `Localizable.stringsdict`.
  - `Settings.xcstrings` có plural, device variation và substitution.
  - Code Swift dùng đủ các mẫu ở mục 5, kể cả key thiếu, key không dùng và format lệch.
- Golden test cho facts từng file và cho bảng `localization_issues`.
- Fuzz lexer `.strings` bằng input ngẫu nhiên: không crash, không treo.
- Đối chiếu với Xcode trên một dự án thật: số key và % hoàn thành theo ngôn ngữ phải khớp con số Xcode hiển thị trong String Catalog editor.
