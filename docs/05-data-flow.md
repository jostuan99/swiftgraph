# swiftgraph — Luồng dữ liệu tới view (thiết kế)

Trạng thái: đã cài đặt `define`, `flows` (CLI và MCP), rule và preset; chưa có `data_usage`, `layer_check`, `rules check`/`rules explain`. Kế hoạch: [02-plan.md](02-plan.md), giai đoạn GF. Phần khác với thiết kế ban đầu: mục 9.

## 1. Mục tiêu

Trả lời ba câu hỏi trên dự án iOS (UIKit dựng bằng code + SwiftUI, MVVM + Clean, Alamofire, UserDefaults/Keychain/file, Combine + async/await). Câu hỏi đầu tiên là ưu tiên số một (mục 6.1).

1. **View hiển thị gì, lấy từ đâu**: một view hoặc item view (cell, row) hiển thị những dữ liệu nào: response từ API, dữ liệu local (UserDefaults, Keychain, file), chuỗi localization. Mỗi giá trị đi qua những bước nào: DTO → mapper → domain → view model → view.
2. **Trình tự xử lý**: từ một điểm vào (nút bấm, `onAppear`, `viewDidLoad`), các bước chạy theo thứ tự nào, qua các lớp nào, kể cả qua `await`, closure của Combine (`sink`, `map`) và completion handler.
3. **Một field được dùng ở đâu**: ví dụ `AnonymousSession.sessionId` tới những view nào.

Yêu cầu không đổi so với graph hiện tại: chỉ đọc source, không build dự án, không chạy code của dự án, không gọi mạng.

Yêu cầu mới: **kiến trúc khác nhau giữa các dự án** (tên lớp, wrapper Keychain, cách DI, quy ước mapper). Những phần đó phải khai báo được trong cấu hình của dự án, không sửa code swiftgraph.

## 2. Hiện trạng trên `../test/fixtures/custom-clean-app`

Graph trước GF (đo 2026-10-27). Cả ba lỗi đã sửa: `WRITES` qua optional chain; `IMPLEMENTS` qua protocol kế thừa; receiver có type generic nối tới requirement của constraint, property khởi tạo bằng chuỗi lời gọi (`DIContainer.shared.getLoginRepository()`) lấy type trả về.

| Câu hỏi | Kết quả | Nguyên nhân |
|---------|---------|-------------|
| Ai ghi `LoginViewModel.state` | không thấy | phép gán qua optional chain `viewModel?.state = .main` không được ghi nhận là `WRITES` |
| `RegisterViewModelMapper.mapping(_:)` cài đặt `ViewModelMapper.mapping(_:)` | không thấy | type conform `RequestViewModelMapper: ViewModelMapper`; `IMPLEMENTS` chưa đi qua protocol kế thừa |
| `LoginUseCaseImpl.anonymous(_:)` gọi gì | chỉ `AnonymousEntityMapper()` | thiếu `repository.anonymousSession(_:)`: type của `repository` lấy từ kiểu trả về của `DIContainer.getLoginRepository()`; thiếu `mapper.mapping(_:)`: receiver có type generic `Mapper: ViewModelMapper` |
| Chuỗi localization trên `LoginView` | đúng: 6 key, đều `missing_key` (`Localizable.xcstrings` rỗng) | |

Luồng đúng của nút Login, theo source:

```
LoginView.body  Button(action:)
 → LoginViewModel.anonymousSession()                    [ViewModel]
 → LoginUseCaseImpl.anonymous(_:)  mapper = AnonymousViewModelMapper   [UseCase]
   → AnonymousEntityMapper()                             [Mapper]
   → LoginRepositoryImpl.anonymousSession(_:)            [Repository]  (DI: LoginRepository → LoginRepositoryImpl)
     → JSONDecoder.decode(AnonymousSession.self, from:)  [response: AnonymousSession]
   → sink receiveValue: domain: AnonymousSession
     → domain as? String   (Mapper.EntityResult của AnonymousViewModelMapper)
     → AnonymousViewModelMapper.mapping(_:)
       → LoginViewModel.login()
         → LoginUseCaseImpl.register(_:)  mapper = RegisterViewModelMapper
           → … → RegisterViewModelMapper.mapping(_:)
             → LoginViewModel.state = .main
 → LoginView.body đọc vm.state → hiển thị Text("Hello, user")
```

Đây là loại kết quả GF phải sinh ra. Trên luồng này, tracer cũng nên chỉ ra được hai điểm đáng ngờ trong sample. Thứ nhất, `domain` có type `AnonymousSession`, nên `domain as? String` luôn thất bại và đi vào `mapper.error`; `EntityMapper.mapping(_:)` (chuyển thành `sessionId`) không được gọi trên luồng này. Thứ hai, chuỗi JSON mẫu `{ session_id="…" }` không phải JSON hợp lệ.

## 3. Ba lớp

```
┌──────────────────────────────────────────────────────────────────────┐
│ 3. Query: define, flows, data_usage, layer_check (CLI + MCP)          │
├──────────────────────────────────────────────────────────────────────┤
│ 2. Rule (khai báo, theo dự án): layer, source, sink, item view,       │
│    DI, toán tử luồng, mapper, điểm vào                                │
│    preset có sẵn  +  swiftgraph.json của dự án                        │
├──────────────────────────────────────────────────────────────────────┤
│ 1. Ngữ nghĩa Swift (cố định): truyền argument → parameter, phép gán,  │
│    return, closure, generic constraint, associatedtype, protocol      │
│    kế thừa, thứ tự lời gọi, await                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Lớp 1 nằm trong extractor và resolver, giống nhau cho mọi dự án Swift.
- Lớp 2 chỉ chạy ở bước resolve, trên facts đã trích. Sửa rule thì graph được dựng lại mà không parse lại file (rule có hash riêng trong `meta`).
- Rule chỉ là dữ liệu khai báo. swiftgraph **không chạy code** do repo cung cấp (không có plugin JS/Swift trong repo): `build` được git hook và agent gọi tự động, nên cấu hình của repo không được phép thành đường chạy code.

## 4. Lớp 1: facts ngữ nghĩa mới

Extractor ghi thêm (nâng `EXTRACTOR_VERSION`):

| Fact | Ví dụ | Dùng cho |
|------|-------|----------|
| Argument của lời gọi | `ItemRow(item: vm.items[i])`: label `item` ← biểu thức đọc `vm.items` | `FLOWS_TO` argument → parameter |
| Phép gán | `cell.titleLabel.text = model.name`, `viewModel?.state = .main` | `WRITES` (sửa lỗi optional chain), `FLOWS_TO` vế phải → vế trái |
| Return | `func mapping(_ e: AnonymousSession) -> String { e.sessionId }` | `FLOWS_TO` biểu thức → kết quả hàm |
| Closure truyền vào lời gọi | `.sink(receiveCompletion: {…}) { domain in … }`: closure nào ứng với label nào, tham số tên gì | nối output của publisher với tham số closure (qua rule) |
| Generic constraint | `func anonymous<Mapper: ViewModelMapper>(_ mapper: Mapper)` | receiver `mapper` có type ràng buộc → requirement của protocol |
| Binding associatedtype | `typealias ResponseEntity = AnonymousSession`; suy từ chữ ký `mapping(_ entity: String)` | `Mapper.ResponseEntity` → `AnonymousSession` khi biết mapper cụ thể |
| Type trả về của hàm làm type biến | `let repository = DIContainer.shared.getLoginRepository()` | receiver `repository: LoginRepository` |
| Thứ tự và `await` | cột, dòng, `await`, `try` của mỗi lời gọi trong một thân hàm | `flows` |
| Ép kiểu | `domain as? Mapper.EntityResult` | ghi lại điểm ép kiểu, cảnh báo khi hai type đã biết không khớp |

Resolver:

- `IMPLEMENTS` đi qua protocol kế thừa (`RequestViewModelMapper: ViewModelMapper`).
- Lời gọi trên receiver là protocol hoặc generic có ràng buộc thì nối tới requirement, rồi tới các implementation (`DISPATCHES`, `INFERRED`). Nếu tại call site biết type cụ thể (giá trị truyền vào là `AnonymousViewModelMapper`), chỉ giữ implementation đó (`EXTRACTED`).
- Data flow chỉ trong phạm vi hàm, rồi nối giữa các hàm qua argument → parameter và return → kết quả. Không phân tích con trỏ hay alias; giá trị qua `Any`, reflection hoặc collection không rõ type thì bị đứt, được đánh dấu.

## 5. Lớp 2: rule

### 5.1. File cấu hình

`swiftgraph.json` ở gốc repo. File này được commit: nó mô tả kiến trúc, không chứa dữ liệu nhạy cảm.

```json
{
  "$schema": "./node_modules/swiftgraph/schema/rules.schema.json",
  "extends": ["swiftui", "uikit", "combine", "concurrency", "alamofire", "foundation-storage", "swinject", "mvvm-clean"],
  "layers": [
    { "layer": "Mapper", "match": { "conformsTo": ["EntityMapper", "ViewModelMapper"] } }
  ],
  "mappers": [
    { "protocol": "EntityMapper", "method": "mapping(_:)", "input": "ResponseEntity", "output": "DomainResult" },
    { "protocol": "ViewModelMapper", "method": "mapping(_:)", "input": "EntityResult" }
  ],
  "sources": [
    { "kind": "local.keychain", "call": "KeychainStore.read(key:)", "key": "key" },
    { "kind": "local.keychain", "call": "KeychainStore.save(_:key:)", "key": "key", "direction": "write" }
  ],
  "itemViews": [
    { "match": { "name": "*Cell" } },
    { "match": { "name": "*Row", "conformsTo": "View" } }
  ],
  "entryPoints": [
    { "call": "AppCoordinator.start()" }
  ]
}
```

- `extends`: preset theo thứ tự. Preset sau và phần của dự án ghi đè hoặc bổ sung preset trước. Rule có `id` thì ghi đè được theo `id`; `"disable": ["alamofire.response-legacy"]` tắt một rule của preset.
- Thiếu file: dùng preset mặc định suy từ `import` của dự án (có `import Alamofire` thì bật `alamofire`, ...).
- `swiftgraph rules check`: kiểm tra schema, báo rule không khớp gì trong dự án. `swiftgraph rules explain <symbol>`: rule nào áp lên symbol này, vì sao.

### 5.2. Cách khớp

Một rule khớp **lời gọi** hoặc **type**:

- `call`: `Type.selector`, ví dụ `JSONDecoder.decode(_:from:)`, `UserDefaults.string(forKey:)`, `Publisher.sink(receiveCompletion:receiveValue:)`. `Type` có thể là class, protocol hoặc `*`. Receiver phải resolve ra type đó hoặc một type kế thừa hoặc conform nó; nếu receiver chưa rõ type mà tên và selector khớp, kết quả có `confidence = AMBIGUOUS`.
- `match` (cho type và declaration): `name` (glob), `conformsTo`, `inherits`, `attribute` (`@Published`, `@AppStorage`), `module`, `path` (glob thư mục). Các điều kiện kết hợp theo AND; một danh sách giá trị nghĩa là OR.
- Argument chỉ định bằng label (`"key": "forKey"`) hoặc vị trí (`"key": 0`). Giá trị literal được ghi lại (key của UserDefaults, Keychain, tên file).

### 5.3. Loại rule

| Loại | Ý nghĩa | Ví dụ preset |
|------|---------|--------------|
| `layers` | gán type vào lớp kiến trúc; dùng để nhóm kết quả và kiểm tra hướng phụ thuộc | `mvvm-clean`: `*View`/`View` → View, `*ViewModel`/`ObservableObject` → ViewModel, `*UseCase*` → UseCase, `*Repository*` → Repository, `*Mapper` → Mapper, `Decodable` không có method → Entity |
| `sources` | nơi dữ liệu sinh ra, kèm `kind` (`coredata`: `@FetchRequest`, `NSManagedObjectContext.fetch`; `swiftdata`: `@Query`, `ModelContext.fetch`) | `alamofire`: `DataRequest.serializingDecodable(_:)`, `responseDecodable(of:)`, `publishDecodable(type:)` → `response`, type lấy từ argument; `JSONDecoder.decode(_:from:)`; `foundation-storage`: `UserDefaults.*(forKey:)`, `@AppStorage`, `Data(contentsOf:)`, `FileManager.contents(atPath:)`, `SecItemCopyMatching` → `local.*` |
| `sinks` | nơi dữ liệu được hiển thị | `swiftui`: `Text(_:)`, `TextField(_:text:)`, `Label`, `Image`, `Toggle(isOn:)`; `uikit`: gán `UILabel.text`, `UITextField.text`, `UIImageView.image`, `UIButton.setTitle(_:for:)` |
| `itemViews` | view là một item của danh sách | `uikit`: subclass `UITableViewCell`, `UICollectionViewCell`, type dùng trong `dequeueReusableCell`; `swiftui`: view tạo trong closure của `List`, `ForEach`, `LazyVStack` |
| `flowThrough` | API chuyển giá trị qua closure hoặc qua thời gian | `combine`: output của publisher → tham số closure `receiveValue` của `sink`, closure của `map`/`tryMap`/`flatMap`/`compactMap`, `assign(to:on:)`; `@Published` setter → mọi `sink` trên `$prop`; `concurrency`: `Task {}`, `await`, `MainActor.run`; `alamofire`: closure `response { }` |
| `injection` | nối protocol với implementation | `swinject`: `Container.register(P.self) { _ in Impl() }` → P ↦ Impl; hàm trả về protocol mà thân hàm chỉ `resolve(P.self)` → kiểu cụ thể theo binding |
| `mappers` | quy ước chuyển đổi của dự án | khai báo protocol, method chuyển đổi, associatedtype vào/ra (mục 5.1) |
| `entryPoints` | nơi một luồng bắt đầu | `swiftui`: `Button(action:)`, `.onAppear`, `.task`, `.onTapGesture`, `.refreshable`; `uikit`: `viewDidLoad`, `viewWillAppear`, `@IBAction`, `addTarget(_:action:for:)` |

Preset nằm trong `src/rules/presets/*.json`, cùng định dạng với `swiftgraph.json`. Thêm framework mới (Moya, RxSwift, Realm) là thêm một file JSON, không sửa code.

### 5.4. Edge và thuộc tính mới

| Edge / thuộc tính | Nghĩa |
|-------------------|-------|
| `FLOWS_TO` | giá trị đi từ A tới B (argument → parameter, phép gán, return, closure), có bằng chứng file:dòng |
| `DISPATCHES` | lời gọi qua protocol hoặc generic tới implementation |
| `INJECTS` | binding DI protocol → implementation |
| `DISPLAYS` | view (hoặc item view) hiển thị một giá trị, tại sink nào |
| `SOURCES` | giá trị lấy từ nguồn nào (`response`, `local.userDefaults`, `local.keychain`, `local.file`), kèm key nếu có |
| `nodes.layer`, `nodes.tags` | lớp kiến trúc, `item_view`, `entry_point` |

Mọi edge mới giữ quy ước `confidence` (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) và ghi lại rule đã sinh ra nó (`rule_id`).

## 6. Lớp 3: query

### 6.1. Command `define` (ưu tiên)

Đầu vào là **một màn hình** (view); đầu ra là các **item màn hình** (của view đó và của view con, cell, row) cùng **quan hệ datasource** của từng item. Luồng xử lý (bấm nút thì chạy gì) là **command riêng** `flows` (mục 6.2); `define` chỉ in id item để gọi tiếp `flows --entry`.

```
swiftgraph define <screen> [--root <repo> | --db <path>]
                           [--no-children] [--depth <n>]
                           [--source api,local,file,localization,literal,input]
                           [--item <id>] [--format text|json|markdown] [--budget <tokens>]
```

| Tham số | Ý nghĩa |
|---------|---------|
| `<screen>` | tên type (`LoginView`, `ProductCell`, `ProductListViewController`), tên đầy đủ (`App.LoginView`) hoặc đường dẫn file (mọi view khai báo trong file). Nhiều type khớp thì in danh sách để chọn, như các query khác |
| `--no-children` | chỉ item của chính view, không đi vào view con, cell, row (mặc định: có, đệ quy) |
| `--depth <n>` | số bước tối đa khi lần ngược về nguồn (mặc định 12) |
| `--source <kinds>` | chỉ in item có nguồn thuộc các loại này |
| `--item <id>` | chỉ một item, in đầy đủ đường đi (không rút gọn) |
| `--format` | `text` (mặc định, ít token), `compact` (ít token nhất), `pretty` (căn cột cho người đọc), `json` (cho tool khác, xem dưới), `markdown` (bảng) |
| `--detail` | in thêm `DATA` và `CONDITIONS` |

Tool MCP tương ứng: `get_screen_definition { screen, include_children, depth, sources, item }`.

View được nhận diện qua rule `sinks`/`itemViews` (mục 5.3): SwiftUI `View`, `UIViewController`, `UIView`, `UITableViewCell`, `UICollectionViewCell` dựng bằng code. Item là mỗi lời gọi tạo view thuộc `sinks` trong cây view (SwiftUI), hoặc mỗi property/biến kiểu `UIView` được gán giá trị hiển thị (`label.text = …`, `imageView.image = …`, `button.setTitle(…)`) và mỗi `addTarget`/`UIAction` (UIKit).

#### Mẫu output trên `../test/fixtures/custom-clean-app`

Kết quả mong đợi, lần bằng tay theo source; đây là đáp án kiểm chứng của F3.

```
$ swiftgraph define LoginView --root test/fixtures/custom-clean-app

LoginView  [SwiftUI View, layer View]  SampleArchitecture/LoginView.swift:7
  state:     vm: LoginViewModel = LoginViewModel()                       LoginView.swift:8
  children:  none

ITEMS (6)
 id            item                                   kind       dir      shown when
 LoginView#1   ZStack > VStack > HStack > TextField   TextField  input    vm.state == .login
 LoginView#2   ZStack > VStack > HStack > TextField   TextField  input    vm.state == .login
 LoginView#3   ZStack > VStack > TextField            TextField  input    vm.state == .login
 LoginView#4   ZStack > VStack > TextField            TextField  input    vm.state == .login
 LoginView#5   ZStack > VStack > Button               Button     action   vm.state == .login
 LoginView#6   ZStack > Text                          Text       display  !(vm.state == .login)

DATA
 #1 placeholder  localization  Localizable "First Name"  missing: en, ja         LoginView.swift:15
    text         input → LoginViewModel.firstName: String = ""                   LoginViewModel.swift:9
                 ⚠ not read anywhere else (not sent in any request)
 #2 placeholder  localization  Localizable "Last Name"  missing: en, ja          LoginView.swift:17
    text         input → LoginViewModel.lastName: String = ""                    LoginViewModel.swift:10
                 ⚠ not read anywhere else
 #3 placeholder  localization  Localizable "Phone Number"  missing: en, ja       LoginView.swift:20
    text         input → LoginViewModel.phoneNumber: String = ""                 LoginViewModel.swift:11
                 ⚠ not read anywhere else
 #4 placeholder  localization  Localizable "Customer Number"  missing: en, ja    LoginView.swift:22
    text         input → LoginViewModel.customerNumber: String = ""              LoginViewModel.swift:12
                 ⚠ not read anywhere else
 #5 label        localization  Localizable "Login"  missing: en, ja              LoginView.swift:25
    action       vm.anonymousSession()                                           LoginView.swift:24
                 flows: swiftgraph flows LoginView --entry LoginView#5
 #6 text         localization  Localizable "Hello, user"  missing: en, ja        LoginView.swift:33

CONDITIONS
 vm.state: LoginViewModel.State                         (items #1–#6)
   initial  enum .login                                                          LoginViewModel.swift:13
   written  enum .main  when !entity.isEmpty                                     AnonymousViewModelMapper.swift:37
     ← entity: String           RegisterViewModelMapper.mapping(_:)    [Mapper]      AnonymousViewModelMapper.swift:35
     ← domain as? String        LoginUseCaseImpl.register(_:) sink     [UseCase]     LoginUseCase.swift:56
     ← AnonymousSession         LoginRepository.register(_:)           [Repository]  LoginRepository.swift:29
                                (DI: LoginRepository → LoginRepositoryImpl          DIContainer.swift:13)
     ← api  JSONDecoder.decode → AnonymousSession.sessionId: String  JSON "session_id"   LoginRepository.swift:38
            value: literal "{ session_id=\"fjaksdjfkajsdjfa\" }" (no network call)   LoginRepository.swift:32
     ⚠ cast AnonymousSession → String always fails (LoginUseCase.swift:56): .main is never written, item #6 is never shown
     flows: swiftgraph flows LoginView (writes vm.state: LoginView/F2)

SUMMARY
 api           AnonymousSession.sessionId: String (JSON "session_id")  → condition of #1–#6
 local         none
 file          none
 localization  Localizable: 6 keys, all missing in en, ja
 input         firstName, lastName, phoneNumber, customerNumber: String (4, none sent)
 unresolved    none
```

Đọc output:

- Mặc định chỉ in `ITEMS` và `SUMMARY`; `DATA` và `CONDITIONS` khi có `--detail` hoặc `--item`. Định dạng `text` và `compact` (mặc định của tool MCP) giữ nội dung nhưng bỏ căn cột (`pretty` giữ căn cột), cột của bảng ngăn bằng `|`, id item của màn hình viết `#1`, dòng cùng file viết `:30`, và legend cho host API, view model, binding DI.
- `ITEMS`: `id`, `line` (file:dòng của item), loại, hướng (`display`, `input`, `action`, `list`), điều kiện hiển thị (`when`), và `datasource`: **một** nguồn của item. Ưu tiên dữ liệu lưu trữ hoặc từ xa theo thứ tự `api`, `userDefaults`, `file`, `coreData`, `swiftData`, `keychain` (rồi các loại nguồn khác do dự án khai báo); không có thì biến ViewModel mà view đọc; rồi chuỗi localization; cuối cùng literal. API ghi `<METHOD> <ENDPOINT> <đường dẫn JSON>`, ví dụ `GET https://api.example.com/v1/products items[].product_name` (key JSON lấy từ `CodingKeys` hoặc `.convertFromSnakeCase`; không biết endpoint thì `api <Type>`). Ô nhập (`TextField`, `SecureField`, `UITextField`) ghi thêm placeholder đã localize kèm bản dịch và ngôn ngữ thiếu: `LoginViewModel.firstName; placeholder localization "First Name" (missing en, ja)`; có `prompt:` thì tham số đầu là `label`, prompt là `placeholder`. Ví dụ khác: `userDefaults "lastUpdated"`, `LoginViewModel.firstName`, `localization "Login"`. Đường dẫn trong cây view (`VStack > PointsBadge > Label`) vẫn có trong JSON (trường `path`). Mọi nguồn khác vẫn có trong `DATA`.
- `DATA`: mỗi giá trị của item, kèm loại nguồn, **type** và **giá trị khi biết** (literal, case enum, key). Đường đi dài được rút gọn thành một dòng; `--item <id>` in đầy đủ.
- Nguồn `error`: giá trị lấy từ lỗi bắt được (`error.localizedDescription` trong `catch`), kèm lời gọi `try` ném ra nó và nguồn của lời gọi đó; trong `datasource` ghi `error GET https://…`, xếp sau dữ liệu lưu trữ/từ xa và trước biến ViewModel.
- `CONDITIONS`: dữ liệu quyết định item nào hiện, lần ngược về nguồn như giá trị hiển thị.
- `⚠`: kết luận suy ra từ code: input không được đọc ở đâu, ép kiểu giữa hai type cụ thể không liên quan, nhánh không bao giờ chạy.
- `flows: …`: lệnh `flows` để xem trình tự xử lý của hành động hoặc luồng ghi dữ liệu đó.
- Nguồn không lần được tới cuối được ghi `unresolved` kèm file:dòng nơi đường đi bị đứt và lý do (type không suy ra được, giá trị qua `Any`, ...).

#### Mẫu output cho màn hình danh sách (UIKit, cell)

Minh hoạ dạng output cho các loại nguồn mà sample chưa có (API qua Alamofire, UserDefaults, Keychain, file, cell). Tên type giả định; fixture `clean-app` (F4) sẽ có màn hình tương ứng.

```
$ swiftgraph define ProductListViewController

ProductListViewController  [UIViewController, layer View]  Features/ProductList/ProductListViewController.swift:9
  state:     viewModel: ProductListViewModel                                  :11
  children:  ProductCell (UITableViewCell, dequeueReusableCell, row = viewModel.rows[indexPath.row])   :58

ITEMS (6)
 id                          item                      kind          dir      shown when
 ProductListVC#1             titleLabel                UILabel       display
 ProductListVC#2             lastUpdatedLabel          UILabel       display  viewModel.lastUpdated != nil
 ProductListVC#3             refreshButton             UIButton      action
 ProductListVC#4             tableView                 UITableView   list     rows: viewModel.rows
 ProductCell#1  (in #4)      nameLabel                 UILabel       display
 ProductCell#2  (in #4)      priceLabel                UILabel       display

DATA
 ProductListVC#1  text   api  GET "/v1/products" → ProductListResponse.title: String  JSON "title"
                         → ProductListEntityMapper.mapping [Mapper] → ProductListViewModel.title [ViewModel]
 ProductListVC#2  text   local.userDefaults "lastUpdated": Date?   format "yyyy/MM/dd HH:mm"   ProductListViewModel.swift:41
 ProductListVC#3  title  localization  Localizable "refresh"  en "Refresh", ja "更新"
                  action viewModel.reload()     flows: swiftgraph flows ProductListViewController --entry ProductListVC#3
 ProductListVC#4  rows   api  ProductListResponse.items: [ProductDTO]  JSON "items"
                         → ProductRowMapper.mapping → [ProductRowViewData]
 ProductCell#1    text   api  ProductDTO.name: String  JSON "product_name"
 ProductCell#2    text   api  ProductDTO.price: Decimal  JSON "price"  + literal "¥"   NumberFormatter .currency

CONDITIONS
 viewModel.lastUpdated: Date?   (ProductListVC#2)
   written  local.userDefaults "lastUpdated"            ProductListViewModel.swift:41
   written  Date() after a successful load               ProductListViewModel.swift:52

SUMMARY
 api           GET "/v1/products": ProductListResponse.title, .items[].product_name, .items[].price
 local         userDefaults "lastUpdated": Date?; keychain "accessToken": String (request header, not displayed)
 file          none
 localization  Localizable: 1 key ("refresh")
 unresolved    none
```

Endpoint lấy từ argument của `AF.request` (literal, hoặc router enum có `path`/`method` literal); không suy ra được thì ghi `api <DTO type>` không có endpoint.

#### Định dạng `json`

```json
{
  "view": { "id": "swift:custom-clean-app/LoginView", "kind": "SwiftUI View", "layer": "View", "file": "custom-clean-app/LoginView.swift", "line": 7 },
  "items": [
    {
      "id": "LoginView#6", "path": ["ZStack", "Text"], "kind": "Text", "direction": "display",
      "shownWhen": ["!(vm.state == .login)"],
      "data": [
        { "role": "text", "source": { "kind": "localization", "table": "Localizable", "key": "Hello, user", "missing": ["en", "ja"] },
          "steps": [{ "file": "custom-clean-app/LoginView.swift", "line": 33 }] }
      ]
    }
  ],
  "conditions": [
    { "expression": "vm.state", "type": "LoginViewModel.State", "items": ["LoginView#1", "LoginView#6"],
      "writes": [
        { "value": { "kind": "enum", "case": "main" }, "when": "!entity.isEmpty",
          "source": { "kind": "api", "type": "AnonymousSession", "field": "sessionId", "fieldType": "String", "jsonKey": "session_id" },
          "steps": [{ "symbol": "RegisterViewModelMapper.mapping(_:)", "layer": "Mapper", "file": "custom-clean-app/AnonymousViewModelMapper.swift", "line": 37 }],
          "warnings": ["cast AnonymousSession → String always fails"] }
      ] }
  ],
  "summary": { "api": [], "local": [], "file": [], "localization": [], "input": [], "unresolved": [] }
}
```

Mỗi `source` có `kind` (`api`, `local.userDefaults`, `local.keychain`, `local.file`, `localization`, `literal`, `enum`, `input`, `unresolved`), `type`, và khi biết: `value`, `key`, `jsonKey`, `endpoint`, `path`. Mỗi bước trong `steps` có file, dòng, symbol, lớp kiến trúc và `confidence`.

### 6.2. Command `flows`

Đầu vào là **một màn hình** (cùng cách nhận diện như `define`); đầu ra là **mọi luồng xử lý** của màn hình đó: mỗi điểm vào (hành động của item, `onAppear`, `.task`, `viewDidLoad`, khởi tạo view model, `sink` trên `@Published`/publisher của view model) cùng các bước theo thứ tự thực thi.

```
swiftgraph flows <screen> [--root <repo> | --db <path>]
                          [--entry <id>] [--depth <n>] [--no-children]
                          [--format text|json|markdown|mermaid] [--budget <tokens>]
```

| Tham số | Ý nghĩa |
|---------|---------|
| `<screen>` | như `<screen>` của `define` |
| `--entry <id>` | chỉ một luồng: id item của `define` (`LoginView#5`), hoặc id luồng của `flows` (`LoginView/F2`) |
| `--depth <n>` | số lớp lời gọi tối đa (mặc định 12) |
| `--no-children` | bỏ luồng của view con, cell |
| `--format mermaid` | mỗi luồng một `sequenceDiagram`, participant là các lớp kiến trúc |

Tool MCP tương ứng: `get_screen_flows { screen, entry, depth, include_children }`.

Thứ tự các bước là thứ tự trong source, cộng ngữ nghĩa của rule `flowThrough`: closure của `sink`, `map`, `Task {}`, completion handler chạy sau bước tạo ra nó và được đánh dấu `async`. Nhánh `if`/`guard`/`switch` được in kèm điều kiện. Lời gọi qua protocol hoặc generic được thay bằng implementation (DI hoặc type cụ thể truyền vào), ghi rõ căn cứ.

#### Mẫu output trên `../test/fixtures/custom-clean-app`

Kết quả mong đợi, lần bằng tay theo source; đây là đáp án kiểm chứng.

```
$ swiftgraph flows LoginView --root test/fixtures/custom-clean-app

LoginView  [SwiftUI View, layer View]  SampleArchitecture/LoginView.swift:7
FLOWS (2)
 LoginView/F1  create   LoginView init → vm = LoginViewModel()                    LoginView.swift:8
 LoginView/F2  action   LoginView#5 Button "Login" tap                            LoginView.swift:24

LoginView/F1  create
  1 [View]        vm = LoginViewModel()                                           LoginView.swift:8
  2 [ViewModel]   LoginViewModel.init()                                           LoginViewModel.swift:25
  3                 useCase = DIContainer.shared.getLoginUseCase()                LoginViewModel.swift:16
                    (DI: LoginUseCase → LoginUseCaseImpl                          DIContainer.swift:17)
  4 [UseCase]       LoginUseCaseImpl: repository = DIContainer.shared.getLoginRepository()   LoginUseCase.swift:19
                    (DI: LoginRepository → LoginRepositoryImpl                    DIContainer.swift:13)
  5 [Mapper]        anonymousViewModelMapper = AnonymousViewModelMapper(viewModel: self)   LoginViewModel.swift:26
  6 [Mapper]        registerViewModelMapper = RegisterViewModelMapper(viewModel: self)     LoginViewModel.swift:27
  writes: LoginViewModel.state = .login, .firstName/.lastName/.phoneNumber/.customerNumber = ""

LoginView/F2  action  Button "Login"
  1 [View]        action closure → vm.anonymousSession()                          LoginView.swift:24
  2 [ViewModel]   LoginViewModel.anonymousSession()                               LoginViewModel+APIHandler.swift:6
                    guard let anonymousViewModelMapper else return                :7
  3 [UseCase]     LoginUseCaseImpl.anonymous(_:)  Mapper = AnonymousViewModelMapper   LoginUseCase.swift:22
  4 [Mapper]        AnonymousEntityMapper()                                       LoginUseCase.swift:25
  5 [Repository]    LoginRepositoryImpl.anonymousSession(_:)                      LoginRepository.swift:14
                    (DI: LoginRepository → LoginRepositoryImpl)
  6                   Just(()) → compactMap → tryMap → mapError → eraseToAnyPublisher   LoginRepository.swift:18
  7 [api]               JSONDecoder.decode(AnonymousSession)  .convertFromSnakeCase      LoginRepository.swift:23
                        input: literal "{ session_id=\"fjaksdjfkajsdjfa\" }"   ⚠ not valid JSON   :17
  8 [UseCase]       sink  async (after the publisher emits)                       LoginUseCase.swift:27
                    on failure: mapper.error(error) → AnonymousViewModelMapper.error(_:)  ⚠ empty   AnonymousViewModelMapper.swift:18
                    on value:   domain as? String  ⚠ AnonymousSession → String always fails   LoginUseCase.swift:34
                      else → mapper.error(DomainError.mapFailure)  ⚠ empty           :37
                      then → AnonymousViewModelMapper.mapping(_:)                    :35
  9 [Mapper]          if !entity.isEmpty → viewModel?.login()                    AnonymousViewModelMapper.swift:14
 10 [ViewModel]       LoginViewModel.login()                                      LoginViewModel.swift:30
                        guard let registerViewModelMapper else return             :31
 11 [UseCase]         LoginUseCaseImpl.register(_:)  Mapper = RegisterViewModelMapper   LoginUseCase.swift:43
                        guard mapper.getRequest() as? String → RegisterViewModelMapper.getRequest() = ""   :46
 12 [Mapper]            RegisterEntityMapper(request)                             LoginUseCase.swift:49
 13 [Repository]        LoginRepositoryImpl.register(_:) → JSONDecoder.decode(AnonymousSession)   LoginRepository.swift:29
 14 [UseCase]         sink  async                                                 LoginUseCase.swift:51
                        on failure: RegisterViewModelMapper.error(_:) → vm.error = error   AnonymousViewModelMapper.swift:42
                        on value:   domain as? String  ⚠ always fails → mapper.error(.mapFailure) → vm.error   :56
                          then → RegisterViewModelMapper.mapping(_:) → if !entity.isEmpty: vm.state = .main   AnonymousViewModelMapper.swift:37
  writes: LoginViewModel.state (.main), LoginViewModel.error
  shown:  vm.state → LoginView#1–#6 (define LoginView); vm.error → not read by any view ⚠
```

Mặc định `flows` in **góc nhìn dữ liệu**: mỗi bước là một lần get/set datasource (request API, đọc/ghi Keychain, UserDefaults, file, Core Data, SwiftData) hoặc gán biến ViewModel; các lớp ở giữa (UseCase, Repository, Service, Mapper) được bỏ qua; `success`/`failure` chỉ giữ thay đổi dữ liệu của ViewModel (handler không đổi dữ liệu bị bỏ):

```
F1 action #4 refreshButton tap → didTapRefresh() @ProductListViewController.swift:27
1 set vm.errorMessage ← nil (→ #3) @ProductListViewModel.swift:29
2 read keychain "accessToken" @ProductService.swift:15
3 GET /v1/products → ProductListResponse @:17
    success
      vm.title ← title → #1
      vm.rows ← items (map → [ProductRowViewData]) → #5, ProductCell#1, ProductCell#2
          .name ← items[].product_name
          .price ← items[].price (formatted)
      vm.lastUpdated ← Date() → #2
    failure
      catch let error as AFError → vm.errorMessage ← error GET /v1/products → #3
      catch → vm.rows ← [] → #5, ProductCell#1, ProductCell#2
      catch → vm.errorMessage ← error GET /v1/products → #3
4 write userDefaults "lastUpdated" ← Date() @SettingsStore.swift:11
```

Bước đọc ghi biến nhận giá trị: `1 vm.notificationsEnabled ← read userDefaults "notificationsEnabled"`.

Luồng không truy cập dữ liệu (chỉ cập nhật UI) được liệt kê ở `No data access: F2`. `--calls` in **bản đánh số theo lời gọi** qua các lớp (`--until`, `--layers` dùng bản này), `--steps` in mọi bước. Trong bản `--calls`:

- Bước đánh số: lời gọi tới code của dự án, đọc nguồn (`read "accessToken"`, `GET …`), ghi nơi lưu trữ (`write "lastUpdated"`), subscription (`viewModel.$title.sink`). Nhánh lỗi không đánh số.
- `success` / `failure` gắn với bước có thể thất bại gần nhất: dữ liệu ghi vào ViewModel (hoặc property của view UIKit) khi thành công, nguồn của nó (đường dẫn JSON, key) và item hiển thị nó; với type của dự án (phần tử của mảng sau `map`), mỗi field ghi field JSON nguồn, `(formatted)` khi giá trị được ghép/định dạng. `failure` gồm nhánh `catch`, closure failure, `.failure`, optional binding hoặc ép kiểu thất bại (`cast fails (domain)`), việc handler làm (`↳`), handler rỗng, `try?` bỏ qua lỗi; request không có xử lý lỗi nào ghi `failure  ⚠ not handled`.
- `writes`: ghi của bước không thể thất bại (reset trạng thái, cập nhật label trong subscription).
- `⚠ stops`: luồng dừng ở ép kiểu luôn thất bại; ghi phía sau đánh dấu `⚠ never runs`.
- `--until Repository` (tool MCP: `until`): giữ **mọi** bước từ view xuống tới Repository: ViewModel, UseCase, Mapper, toán tử biến đổi dữ liệu (`Just(()) → compactMap { jsonData.data(using: .utf8) } → tryMap { … }`), subscription (`sink`), điều kiện của bước (`if let domain = domain as? Mapper.EntityResult → …`), các phép ghi ở lớp giữa. Phần chạy bên dưới Repository (Service, API client) gộp thành ghi chú của bước Repository (`→ GET /v1/products`, `→ read "accessToken"`). Request được xử lý trong một subscription thì bước đó ghi `success/failure → step 5` và `success`/`failure` nằm ở subscription.
- `--layers ViewModel,Repository` (tool MCP: `layers`): chỉ giữ bước của các lớp đó. Nguồn dữ liệu của bước bị ẩn thành ghi chú của bước còn giữ phía trên (`ProductRepositoryImpl.products() (→ read "accessToken"; → GET /v1/products → ProductListResponse)`), `success`/`failure`/`writes` chuyển theo; luồng không có bước nào thuộc các lớp đó bị bỏ.

JSON có cả `steps` và `summary`.

- `FLOWS`: danh sách luồng, mỗi luồng có id (`LoginView/F2`) để gọi lại bằng `--entry`.
- Mỗi bước: số thứ tự, lớp kiến trúc, lời gọi, file:dòng. Thụt lề là độ sâu lời gọi.
- `on failure` / `on value` / `then`: các nhánh của closure và điều kiện.
- `errors`: luồng xử lý lỗi thế nào: bước trong `catch` (`catch let error as AFError → …`), closure `on completion`/`on failure` và nhánh `.failure`, lời gọi `try?` bỏ qua lỗi (⚠), `try!`; luồng gọi API mà không xử lý lỗi nào được đánh dấu `⚠ no error handling`. Bước trong `catch` được in `catch → …`.
- `writes`: dữ liệu luồng ghi vào view model; `shown`: item nào của `define` hiển thị dữ liệu đó.
- `⚠`: closure xử lý lỗi rỗng, ép kiểu luôn thất bại, JSON literal không hợp lệ, dữ liệu ghi mà không view nào đọc.

### 6.3. Các query khác

| Lệnh / tool MCP | Trả lời |
|-----------------|---------|
| `data_usage <Type.field>` | field tới những view, item view nào |
| `layer_check` | phụ thuộc trái hướng kiến trúc (View gọi Repository trực tiếp, ...) theo `layers` |

Output của mọi command giữ nhãn tiếng Anh như các lệnh khác. Giới hạn token giống các query hiện có. Mỗi bước có file:dòng để agent mở đúng chỗ.

## 7. Mô hình facts của lớp 1

Extractor ghi thêm, theo từng file:

```ts
/** Giá trị như được viết, rút gọn tới mức data flow cần. */
type ValueExpr =
  | { kind: 'path'; root: PathRoot; members: string[]; binding?: true } // vm.items[], $vm.firstName
  | { kind: 'literal'; type: 'String' | 'Int' | 'Double' | 'Bool' | 'nil'; value: string }
  | { kind: 'case'; name: string }                                      // .main
  | { kind: 'call'; call: number }                                      // kết quả của một lời gọi
  | { kind: 'compound'; text: string; operands: ValueExpr[] };          // "\(a) \(b)", a ?? b, a + b, ...

interface CallSite {        // mỗi lời gọi (cùng thứ tự với reference 'call')
  reference: number;
  parent: number | null;    // lời gọi chứa nó: cây view, chuỗi toán tử Combine
  receiver?: ValueExpr;
  arguments: { label: string; value?: ValueExpr; closure?: number }[];
  branch: string[];         // điều kiện if/guard/switch bao quanh trong thân hàm
  await?: true;
}
interface ClosureFact { id: number; parameters: string[]; returns: ValueExpr[] }
interface Assignment { from: number | null; target: ValueExpr; value: ValueExpr; branch: string[]; line: number }
interface LocalBinding { from: number | null; scope: number; name: string; value: ValueExpr; line: number }
interface ReturnFact { from: number | null; value: ValueExpr; line: number }
```

Resolver nối các facts này thành edge `FLOWS_TO` giữa property, parameter và kết quả hàm, rồi rule (mục 5) gắn nguồn và sink. Optional chain (`a?.b`, `a!.b`) được bỏ qua khi dựng đường dẫn, và cũng được dùng cho receiver của lời gọi và phép gán (sửa lỗi ở mục 2).

## 8. Giới hạn

- Không có type checker: type của biểu thức phức tạp (chuỗi gọi dài, closure lồng, overload) có thể không suy ra được. Edge khi đó là `AMBIGUOUS` hoặc luồng bị đứt và được đánh dấu. Chế độ `--precise` (index store) sau này thay một phần bằng kết quả của compiler.
- Thứ tự trong `flows` là thứ tự trong source cộng với ngữ nghĩa của `flowThrough` (closure của `sink` chạy sau khi publisher phát). Không mô phỏng scheduler, thread hay timing.
- Giá trị qua `Any`, reflection, key-value coding, Objective-C runtime hoặc storyboard không được theo.
- Dữ liệu local chỉ nhận ra qua API được khai báo trong rule. Wrapper riêng của dự án (ví dụ `KeychainStore`) cần một dòng trong `swiftgraph.json`; `rules check` gợi ý type nào đang gọi `SecItem*` hoặc `UserDefaults` để khai báo.

## 9. Cài đặt so với thiết kế

- **Phân tích lúc query, không lưu edge mới.** `define`/`flows` dựng chỉ mục type từ declaration đã lưu, đọc facts của từng file khi cần, và dùng edge `CALLS`/`WRITES`/`READS`/`IMPLEMENTS`/`INSTANTIATES` có sẵn để tìm nơi gọi và nơi ghi. Edge `FLOWS_TO`, `DISPATCHES`, `INJECTS`, `DISPLAYS`, `SOURCES`, `nodes.layer`, `nodes.tags` chưa được ghi vào database. Ưu điểm: lời gọi qua generic được giải theo ngữ cảnh (cùng `anonymous(_:)` có `Mapper = AnonymousViewModelMapper` hay `RegisterViewModelMapper` tuỳ nơi gọi), sửa rule không cần build lại. Mỗi lần gọi tốn thêm thời gian dựng chỉ mục (vài trăm ms trên repo vài nghìn file).
- **Resolver** (`src/resolve/resolve.ts`): `genericConstraints` (từ `<M: P>` và `where M: P`) và `initializerChain` trong declaration; `IMPLEMENTS` qua protocol kế thừa.
- **Engine** (`src/flow/engine.ts`): type của biểu thức (generic đã bind, associatedtype qua typealias, type lồng hoặc suy từ chữ ký của implementation), đích lời gọi (requirement → implementation theo DI, type cụ thể hoặc duy nhất), lần ngược giá trị: binding, tham số → argument ở nơi gọi, return, property → mọi nơi ghi (kể cả memberwise init), closure theo rule `flowThrough`, nguồn theo rule `sources`. Khi đi ngược qua requirement của receiver generic, nơi gọi chỉ được giữ nếu có nơi truyền type tương thích.
- **Rule**: thêm `derivedFrom` cho `flowThrough` (cả mảng do `map` sinh ra đến từ mảng nguồn); `sources.input` làm nguồn đổi loại theo dữ liệu đầu vào (`JSONDecoder.decode` từ file là `local.file`). Gọi SDK không có rule thì kết quả là `computed` kèm các giá trị đầu vào (`DateFormatter.localizedString(from: date)` ← UserDefaults).
- **Màn hình chia nhiều file**: item lấy từ mọi member của type, kể cả extension ở file khác (`ProfileView+Header.swift`, `ProfileViewController+Binding.swift`); view con khai báo ở file riêng được đi vào đệ quy. Đường dẫn item ghi member dựng view khi không phải `body` và view con chứa nó: `header > HStack > AvatarView > AsyncImage`, `VStack > PointsBadge > Label`. Chưa biết `header` nằm ở đâu trong `body` (đường dẫn bắt đầu từ `header`).
- **Kiểm chứng**: `test/data-flow.test.ts`; output thật nằm trong `test/expected/clean-app.*.txt` và `test/expected/custom-clean-app.*.txt` (thay cho mẫu viết tay ở mục 6.1, 6.2; khác biệt chủ yếu ở cách trình bày, ví dụ field `AnonymousSession.sessionId` không xuất hiện vì giá trị ép kiểu là cả `AnonymousSession`).
- **Chưa làm**: `data_usage`, `layer_check`, `rules check`/`rules explain`, JSON Schema của `swiftgraph.json`, hash rule trong `meta`; `Future`/`PassthroughSubject.send` và completion handler qua nhiều tầng mới theo được một phần.
