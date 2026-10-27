# Đánh giá

Repo tham chiếu và tag cố định: `eval/repos.txt`. Script clone vào `eval/repos/`, graph ghi vào `eval/graphs/` (git bỏ qua cả hai).

## Benchmark token (SG5)

```sh
eval/run-bench.sh [--min-correct N] [--min-ratio X]
```

Dựng graph cho swift-nio, swift-composable-architecture, swift-argument-parser rồi chạy `bench/proxy.ts`: với 15 câu hỏi của `bench/questions.ts`, so số token của output tool graph với "grep rồi đọc các file nhiều kết quả nhất", và kiểm tra output có đáp án. Có ngưỡng thì trả mã lỗi khi không đạt. CI (`.github/workflows/eval.yml`, job `bench`) chạy với `--min-correct 13 --min-ratio 5` trên mỗi push và pull request.

## So với index store của compiler (SG4)

```sh
eval/run-indexstore.sh [<repo>] [--min-precision P]   # mặc định swift-argument-parser
```

Script làm các bước thủ công bên dưới. CI chạy job `indexstore` khi gọi tay và hằng tuần, với `--min-precision 95`; job tự bỏ qua nếu Xcode của runner không phải Swift 6.4.

### Các bước thủ công

So sánh edge `CALLS`/`INSTANTIATES`/`READS`/`WRITES` của swiftgraph với lời gọi mà compiler Swift ghi trong index store (ground truth). Kế hoạch: `docs/02-plan.md`, G2. Chỉ chạy được trên macOS có Xcode.

```sh
# 1. Tool đọc index store (indexstore-db, tag swift-6.4.0-RELEASE)
swift build -c release --package-path eval/indexstore-calls

# 2. Biên dịch dự án cần đánh giá với index store
cd <repo> && swift build --build-tests --enable-index-store
STORE=$(find .build -type d -name store -path '*index*' | head -1)

# 3. Xuất các lời gọi
eval/indexstore-calls/.build/release/indexstore-calls \
  <repo>/$STORE \
  /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/libIndexStore.dylib \
  <repo> > calls.tsv

# 4. Dựng graph và so sánh
node src/cli.ts build <repo> --db graph.db
node eval/compare-calls.ts graph.db calls.tsv
```

Lưu ý:

- Bước 2 chạy code build của dự án (build plugin, macro). Chỉ chạy trên dự án tin cậy, như các repo trong `eval/repos.txt`.
- `node eval/compare-calls.ts ... --min-precision P` trả mã lỗi khi precision của `CALLS` + `INSTANTIATES` dưới P%.
- Vị trí trong index được ánh xạ về node của graph theo file và dòng (declaration nhỏ nhất chứa dòng đó).
- Initializer tự sinh (memberwise) được so với `INSTANTIATES`; gọi `init` của type T được tính là T bị khởi tạo, kể cả `super.init()` (nên `super.init()` xuất hiện là "missed").
- Getter/setter trong index được so với `READS`/`WRITES`. Ghi qua method `mutating` (`items.append(x)`) là setter trong index nhưng là `READS` trong graph.
