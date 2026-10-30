# swiftgraph

swiftgraph gives coding agents (Claude Code, Cursor, Codex and others) a map of a Swift codebase. It parses the project with tree-sitter and stores declarations, calls, conformances, screens and localized strings in one SQLite file inside the repo. Agents then query the graph over MCP or the CLI. They do not need to grep and read whole files.

The goal is a small token budget. An agent reads from coarse to fine: an overview first, then a symbol, then an outline, and the source of a function only when it needs the body.

- **Local only.** It does not use the network or an LLM. It does not run the Swift compiler. The database can be encrypted.
- **Fast.** A full build of 3,500 Swift files takes about 10 s. A rebuild after edits takes under 1 s. Queries take under 50 ms.
- **Compact output.** Every answer fits a token budget. Repeated module names and file paths are left out.

> Status: early (0.0.x), not published to npm. In a token benchmark without an LLM (`bench/proxy.ts`, 15 questions on swift-nio, TCA and swift-argument-parser), graph answers used 42× fewer tokens than grep and file reads. They found the expected answer in 13 of 15 questions. A benchmark with a real agent (`bench/agent.ts`) has not been run yet.

## What an agent sees

The outline of a type: signatures and line ranges without bodies, including extensions in other files.

```
$ swiftgraph outline Store
Sources/Core/Store.swift
9-36 public final class Store<State>  /// Holds the items and applies actions to them.
  10 @Published public private(set) var items: [Item]
  11 private let logger: Logging
  13-15 public init(logger: Logging = ConsoleLogger())
  17-20 public func send(_ action: Action)
  22-29 private func reduce(_ action: Action)
  31-35 public static func preview() -> Store<State>
Sources/Core/Store+Observation.swift
3-5 extension Store: ObservableObject
  4 public var count: Int
```

Callers as a tree. Calls through a protocol continue to the implementations.

```
$ swiftgraph callers 'Logging.log(_:)'
Core.Logging.log(_:)  [function, Sources/Core/Logger.swift:2]
  callers (depth ≤ 3):
  1. Core.Store.send(_:)  Sources/Core/Store.swift:17
    2. Core.Store.preview()  :31
      3. AppTests.previewHasOneItem()  Tests/AppTests/StoreTests.swift:13
    2. App.AppView.body  Sources/App/AppView.swift:8
    2. AppTests.StoreTests.testSendAddsItem()  Tests/AppTests/StoreTests.swift:6
```

The items of a screen and where the data of each item comes from:

```
$ swiftgraph define LoginView
LoginView [SwiftUI View] @SampleArchitecture/LoginView.swift:7
# vm = LoginViewModel
  children: DetailView (navigation push); DetailView (navigation modal)

ITEMS (7)
 id | line | kind | dir | when | datasource
 #1 | :14 | TextField | input | | vm.firstName; placeholder localized "名"
 #5 | :24 | Button | action | | localized "ログイン"
 ...
```

## Features

- **Code graph:** declarations, calls, inheritance, conformances, overrides, extensions and SwiftUI view composition. Each edge has a confidence: `EXTRACTED`, `INFERRED` or `AMBIGUOUS`.
- **Overview:** modules, functional areas (Louvain communities), screens, the most depended-on symbols (PageRank) and entry points.
- **Navigation:** search, symbol details, outline, callers and callees, the shortest path between two symbols, the impact of a change (including tests) and source by symbol.
- **Screens:** `define` lists the items of a SwiftUI or UIKit screen and the data source of each one: API, local storage, file or localization. `flows` follows each action through the layers (view, view model, use case, repository). Project-specific architectures are described with rules in `swiftgraph.json`.
- **Localization:** `.strings`, `.stringsdict` and `.xcstrings`. It finds keys, translations and missing languages, and the strings a view uses.
- **Agent setup:** `install` writes instructions to `CLAUDE.md` and `AGENTS.md`, a Cursor rule, the MCP server entry, a Claude Code skill and hook, and git hooks that keep the graph up to date.
- **Graph view:** a self-contained HTML page of the graph that does not load anything from the network.

## Install

Requirements:

- Node.js 22.18 or later. It runs the TypeScript sources directly, with no build step.
- A C compiler: Xcode Command Line Tools on macOS, or `build-essential` on Linux. `npm install` builds the [tree-sitter-swift](https://github.com/jostuan99/tree-sitter-swift) grammar, pinned in `package.json`.

```sh
git clone https://github.com/jostuan99/swiftgraph.git
cd swiftgraph
npm install
npm link        # optional: puts `swiftgraph` on your PATH
```

Without `npm link`, replace `swiftgraph` with `node /path/to/swiftgraph/src/cli.ts`.

## Quick start

```sh
swiftgraph build /path/to/MyApp          # writes MyApp/.swiftgraph/graph.db
swiftgraph install /path/to/MyApp        # CLAUDE.md, .mcp.json, skill and hook for Claude Code
```

Add `.swiftgraph/` to the project's `.gitignore`. To set up other agents, run `install --targets claude,agents,cursor,git`. To add only the MCP server to Claude Code, run:

```sh
claude mcp add swiftgraph -- node /path/to/swiftgraph/src/cli.ts mcp /path/to/MyApp
```

After you edit code, run `swiftgraph sync /path/to/MyApp`. It parses only the changed files again. The `git` install target runs `sync` after each commit, checkout and merge.

## MCP tools

All 17 tools are read-only. Input is bounded: depth at most 6, budget at most 8,000 tokens.

| Tool | Answers |
|------|---------|
| `graph_overview` | Modules, areas, screens, key symbols and entry points |
| `search_symbols` | Declarations by name or doc comment |
| `get_symbol` | Signature, doc, area and relations of a symbol |
| `get_outline` | Declarations of a file, or of a type with its extensions, without bodies |
| `get_source` | Source of one declaration |
| `get_neighbors` | Direct relations |
| `get_callers`, `get_callees` | Call trees, through protocol dispatch |
| `find_path` | Shortest chain of relations between two symbols |
| `get_impact` | What changing files or symbols may affect, including tests |
| `get_community` | One functional area of the codebase |
| `get_screen_definition` | Items of a screen and their data sources |
| `get_screen_flows` | Processing flows of a screen, step by step |
| `search_strings`, `get_string`, `get_strings_for_symbol`, `get_localization_issues` | Localized strings |

## CLI

Query commands accept `--root <repo>` or `--db <path>`, and `--budget <tokens>`.

```sh
swiftgraph report  /path/to/MyApp                   # overview (Markdown)
swiftgraph find    EventLoop --root /path/to/MyApp
swiftgraph explain 'Store.send(_:)' --root ...
swiftgraph outline Sources/Core/Store.swift --root ...
swiftgraph source  'Store.reduce(_:)' --root ...
swiftgraph callers 'Store.send(_:)' --depth 2 --root ...
swiftgraph path    MiniApp.body 'Logging.log(_:)' --root ...
swiftgraph impact  Sources/Core/Model.swift --root ...
swiftgraph define  LoginView --root ...
swiftgraph flows   LoginView --entry LoginView#5 --root ...
swiftgraph strings show welcome_title --root ...
swiftgraph view    /path/to/MyApp --open            # HTML view of the graph
```

Run `swiftgraph --help` or `swiftgraph <command> --help` for all commands and options.

## Data and security

- swiftgraph reads only the contents of `.swift`, `.strings`, `.stringsdict` and `.xcstrings` files. It skips build output, dependencies (`Pods`, `Carthage`, `.build`), symbolic links and very large files.
- All data stays in `<repo>/.swiftgraph/graph.db`. The directory has mode `0700` and the file has mode `0600`. Nothing is sent over the network.
- `--encrypt` creates a SQLCipher database. On macOS, the key is kept in the Keychain (`swiftgraph key create`). On other systems, the key comes from `SWIFTGRAPH_KEY`.
- `--no-string-values` keeps localization keys but not their translations.

## Limitations

swiftgraph reads syntax and does not run the Swift type checker. So:

- Calls to overloads that differ only in parameter types can be marked `AMBIGUOUS`.
- Code generated by macros is not read. Common macros (`@Observable`, `@Model`, `@Reducer`, `@ObservableState`, `@DependencyClient`) are understood.
- Closures stored in properties do not produce call edges.

## Documentation

The detailed documentation is in Vietnamese.

| Document | Contents |
|----------|----------|
| [docs/04-usage.md](docs/04-usage.md) | Usage guide: build options, modules, agent setup, queries, security, troubleshooting |
| [docs/05-data-flow.md](docs/05-data-flow.md) | `define`, `flows` and architecture rules (`swiftgraph.json`) |
| [docs/01-design.md](docs/01-design.md) | Design: data model, resolution, storage, MCP |
| [docs/03-localization.md](docs/03-localization.md) | Localization data |
| [docs/02-plan.md](docs/02-plan.md) | Milestones and measurements |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [CHANGELOG.md](CHANGELOG.md) | Changes |

## Development

```sh
npm test                    # node:test
npm run typecheck
npm run format:check        # Prettier
UPDATE_GOLDEN=1 npm test    # regenerate golden files, then review the diff
```

| Directory | Contents |
|-----------|----------|
| `src/discover/` | File listing and the module map (`Package.swift`, Xcode layout) |
| `src/extract/` | Syntax tree to facts (`swift.ts`), worker processes |
| `src/resolve/` | Symbol table, resolution rules, SDK table |
| `src/analyze/`, `src/report/` | Communities, PageRank, the overview report |
| `src/query/` | Read-only queries and the text format shared by the CLI and MCP |
| `src/flow/`, `src/rules/` | Data-flow engine (`define`, `flows`) and architecture rules |
| `src/localization/` | Localization parsers, key matching, issues |
| `src/store/` | SQLite access, migrations, graph writes |
| `src/mcp.ts`, `src/cli.ts`, `src/install.ts` | MCP server, CLI, agent setup |
| `bench/` | Benchmark questions, the proxy benchmark and the agent benchmark |
| `test/fixtures/` | Sample Swift projects used by the tests |

## License

MIT, as declared in `package.json`.
