// Benchmark questions (docs/02-plan.md, G6). Each question has the MCP
// tool calls that answer it with the graph, the strings a correct answer must
// contain, and the searches an agent without the graph would typically run:
// grep for the symbol, then read the files with the most matches.

export interface ToolCall {
  tool: 'get_symbol' | 'get_neighbors' | 'get_callers' | 'get_callees' | 'find_path' | 'get_impact' | 'get_community' | 'search_symbols';
  args: Record<string, unknown>;
}

export interface Question {
  id: string;
  repo: 'swift-nio' | 'swift-composable-architecture' | 'swift-argument-parser';
  question: string;
  graph: ToolCall[];
  /** Substrings that the graph output must contain. */
  expect: string[];
  /** Substrings that make the answer wrong or useless. */
  reject?: string[];
  baseline: { greps: string[]; readFiles: number };
}

export const QUESTIONS: Question[] = [
  {
    id: 'nio-definition',
    repo: 'swift-nio',
    question: 'Where is EventLoopPromise.succeed defined and what does it call?',
    graph: [{ tool: 'get_symbol', args: { symbol: 'EventLoopPromise.succeed(_:)' } }],
    expect: ['EventLoopFuture.swift:186', 'EventLoopPromise._resolve(value:)'],
    baseline: { greps: ['func succeed\\('], readFiles: 2 },
  },
  {
    id: 'nio-conformers',
    repo: 'swift-nio',
    question: 'Which types in NIOHTTP1 implement ChannelInboundHandler?',
    graph: [
      {
        tool: 'get_neighbors',
        args: { symbol: 'NIOCore.ChannelInboundHandler', direction: 'in', edge_kinds: ['CONFORMS_TO'], limit: 200 },
      },
    ],
    expect: ['NIOHTTP1.HTTPServerUpgradeHandler', 'NIOHTTP1.NIOHTTPServerRequestAggregator'],
    baseline: { greps: ['ChannelInboundHandler'], readFiles: 5 },
  },
  {
    id: 'nio-callers',
    repo: 'swift-nio',
    question: 'Who calls ByteBuffer.writeString(_:)?',
    graph: [{ tool: 'get_callers', args: { symbol: 'ByteBuffer.writeString(_:)', depth: 1 } }],
    expect: ['NIOHTTP1.ByteBuffer.write(headers:)', 'NIOCore.ByteBuffer.writeLengthPrefixedString(_:strategy:)'],
    baseline: { greps: ['\\.writeString\\('], readFiles: 5 },
  },
  {
    id: 'nio-impact',
    repo: 'swift-nio',
    question: 'What may break, and which tests to run, if Sources/NIOCore/CircularBuffer.swift changes?',
    graph: [{ tool: 'get_impact', args: { files: ['Sources/NIOCore/CircularBuffer.swift'] } }],
    expect: ['tests:', 'CircularBufferTests'],
    baseline: { greps: ['CircularBuffer'], readFiles: 5 },
  },
  {
    id: 'nio-path',
    repo: 'swift-nio',
    question: 'How does ServerBootstrap.bind0 reach ChannelPipeline.addHandler?',
    graph: [{ tool: 'find_path', args: { from: 'ServerBootstrap.bind0(_:)', to: 'ChannelPipeline.addHandler(_:name:position:)' } }],
    expect: ['ServerBootstrap.bind0(_:)', 'ChannelPipeline.addHandler(_:name:position:)'],
    // Only an execution path answers "how": a chain of unrelated references does not.
    reject: ['no path along calls'],
    baseline: { greps: ['func bind0\\(', 'func addHandler\\('], readFiles: 5 },
  },
  {
    id: 'tca-definition',
    repo: 'swift-composable-architecture',
    question: 'What does Store.send do and who calls it?',
    graph: [{ tool: 'get_symbol', args: { symbol: 'ComposableArchitecture.Store.send(_:)' } }],
    expect: ['Store.send(_:originatingFrom:)', '← CALLS'],
    baseline: { greps: ['func send\\('], readFiles: 3 },
  },
  {
    id: 'tca-conformers',
    repo: 'swift-composable-architecture',
    question: 'Which types of the library conform to Reducer?',
    graph: [
      {
        tool: 'get_neighbors',
        args: { symbol: 'swift:ComposableArchitecture/Reducer', direction: 'in', edge_kinds: ['CONFORMS_TO'], limit: 200 },
      },
    ],
    expect: ['ComposableArchitecture.Scope'],
    baseline: { greps: [':\\s*Reducer\\b'], readFiles: 5 },
  },
  {
    id: 'tca-callers',
    repo: 'swift-composable-architecture',
    question: 'Which tests call TestStore.receive with a key path?',
    graph: [
      {
        tool: 'get_callers',
        args: { symbol: 'swift:ComposableArchitecture/TestStore.receive(_:timeout:assert:fileID:file:line:column:)', depth: 1 },
      },
    ],
    // Five overloads differ only by parameter types: without a type checker
    // the calls stay ambiguous and are hidden (a known limitation).
    expect: ['ComposableArchitectureTests'],
    baseline: { greps: ['\\.receive\\('], readFiles: 5 },
  },
  {
    id: 'tca-impact',
    repo: 'swift-composable-architecture',
    question: 'What depends on Sources/ComposableArchitecture/Effect.swift?',
    graph: [{ tool: 'get_impact', args: { files: ['Sources/ComposableArchitecture/Effect.swift'], depth: 2 } }],
    expect: ['affected:', 'ComposableArchitecture.Effect.run(priority:operation:catch:fileID:filePath:line:column:)'],
    baseline: { greps: ['Effect<'], readFiles: 5 },
  },
  {
    id: 'tca-area',
    repo: 'swift-composable-architecture',
    question: 'What belongs to the area around Store, and which areas does it talk to?',
    graph: [{ tool: 'get_community', args: { area: 'swift:ComposableArchitecture/Store' } }],
    expect: ['ComposableArchitecture.Store', 'linked areas'],
    baseline: { greps: ['class Store\\b'], readFiles: 3 },
  },
  {
    id: 'ap-callees',
    repo: 'swift-argument-parser',
    question: 'What does ParsableCommand.parseAsRoot call?',
    graph: [{ tool: 'get_callees', args: { symbol: 'ParsableCommand.parseAsRoot(_:)', depth: 1 } }],
    expect: ['ArgumentParser.CommandParser.parse(arguments:)'],
    baseline: { greps: ['func parseAsRoot'], readFiles: 2 },
  },
  {
    id: 'ap-conformers',
    repo: 'swift-argument-parser',
    question: 'Which standard types conform to ExpressibleByArgument in the library?',
    graph: [
      {
        tool: 'get_neighbors',
        args: { symbol: 'ArgumentParser.ExpressibleByArgument', direction: 'in', edge_kinds: ['CONFORMS_TO'], limit: 200 },
      },
    ],
    expect: ['ArgumentParser.Int+ext', 'ArgumentParser.String+ext'],
    baseline: { greps: ['ExpressibleByArgument'], readFiles: 5 },
  },
  {
    id: 'ap-instantiations',
    repo: 'swift-argument-parser',
    question: 'Where is SplitArguments created?',
    graph: [{ tool: 'get_callers', args: { symbol: 'swift:ArgumentParser/SplitArguments', depth: 1 } }],
    expect: ['ArgumentParser.CommandParser.parse(arguments:)'],
    baseline: { greps: ['SplitArguments\\('], readFiles: 5 },
  },
  {
    id: 'ap-path',
    repo: 'swift-argument-parser',
    question: 'How does ParsableCommand.main() reach parseAsRoot?',
    graph: [{ tool: 'find_path', args: { from: 'swift:ArgumentParser/ParsableCommand.main()', to: 'ParsableCommand.parseAsRoot(_:)' } }],
    expect: ['ParsableCommand.main()', 'ParsableCommand.parseAsRoot(_:)'],
    reject: ['no path along calls'],
    baseline: { greps: ['func main\\(', 'parseAsRoot\\('], readFiles: 3 },
  },
  {
    id: 'ap-impact',
    repo: 'swift-argument-parser',
    question: 'What may be affected by changing Sources/ArgumentParser/Parsing/SplitArguments.swift?',
    graph: [{ tool: 'get_impact', args: { files: ['Sources/ArgumentParser/Parsing/SplitArguments.swift'], depth: 2 } }],
    expect: ['affected:', 'SplitArgumentTests'],
    baseline: { greps: ['SplitArguments'], readFiles: 5 },
  },
];
