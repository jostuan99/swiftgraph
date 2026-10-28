// MCP server over stdio. See docs/01-design.md, section 8.2.
//
// Every tool is read-only and works on one read-only (`query_only`)
// connection. Inputs are bounded (lengths, depths, budgets); the server opens
// no network port.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { defineText, flowsText } from './flow/commands.ts';
import { graphReport } from './report/report.ts';
import type { Db } from './store/db.ts';
import { openDatabase } from './store/db.ts';
import {
  DEFAULT_BUDGET,
  formatCommunity,
  formatImpact,
  formatIssues,
  formatNeighbors,
  formatPath,
  formatSearch,
  formatSource,
  formatString,
  formatStringSearch,
  formatStringsOfSymbol,
  formatSymbol,
  formatTraversal,
} from './query/text.ts';

const text = (max = 300) => z.string().min(1).max(max);
const budget = z.number().int().min(100).max(8000).optional().describe('approximate output size in tokens');
const depth = (fallback: number) => z.number().int().min(0).max(6).optional().describe(`traversal depth (default ${fallback})`);
const edgeKinds = z
  .array(
    z.enum([
      'CALLS',
      'INSTANTIATES',
      'READS',
      'WRITES',
      'REFERENCES',
      'CONFORMS_TO',
      'INHERITS',
      'EXTENDS',
      'IMPLEMENTS',
      'OVERRIDES',
      'RENDERS',
      'TESTS',
      'WRAPS',
      'EXPANDS',
      'USES_STRING',
      'CONTAINS',
    ]),
  )
  .max(16)
  .optional();
const SYMBOL_HELP = 'symbol id (swift:Module/Type.member(label:)) or a qualified name / suffix such as Store.send(_:)';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function run(action: () => string): ToolResult {
  try {
    return { content: [{ type: 'text', text: action() }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

// Sent to the client on initialize: how to read the output of the screen tools.
export const INSTRUCTIONS = `swiftgraph answers questions about a Swift codebase from a prebuilt graph (read-only, offline). Call graph_overview first.

Screens: get_screen_definition tells what a screen shows and where each value comes from; get_screen_flows tells what runs from each entry point. Both return compact text by default. How to read it:

Common
- First line: Screen [kind] @file:line. "@file:line" is a source location; "@:N" is line N of the last file named above.
- "#" lines are a legend: "# api = <host>" (paths below are relative to it), "# vm = <type>" ("vm." means that view model), "# di: Protocol → Impl file:line" (DI bindings used).
- "#N" is an item of the screen; "Cell#N (in #M)" is an item of a child view, cell or row shown inside item #M; "#1–#6" is a range. Pass ids as item (get_screen_definition) or entry (get_screen_flows).
- "⚠" marks a likely bug found statically. Confirm it with get_source before reporting it.
- "More: ..." names options that add detail.

get_screen_definition
- "state:" properties that hold screen data; "children:" child views, cells, rows and the item they belong to.
- ITEMS columns: id | line | kind (UI type) | dir (display, input, action, list) | when (condition for the item to show; empty = always) | datasource.
- datasource: "GET /path field" (API response field; items[].x = field of each element, JSON key as written in the response); userDefaults/keychain/file "key"; localization "key" ("missing en" = no translation); "error GET /path" (message of a caught error of that request); "vm.x" (variable bound to an input) with its placeholder.
- SUMMARY, one line per source: api (endpoint, response type, fields used), local, file, error, localization (key count, missing languages), input ("not read elsewhere" = value never used), unresolved (values not traced: the answer may be incomplete).
- detail=true adds DATA: for each item its sources and the path "→ A [Layer] → B [Layer]" from the source up to the view; "from:" inputs of a computed value; "value:" where a stored value comes from. It also adds CONDITIONS.

get_screen_flows (default: data view)
- "F<n> <kind> <trigger> @file:line" starts a flow. kind: create (init), action (tap; #N is the item), appear, task, lifecycle (viewDidLoad...), refresh, change, receive.
- Numbered steps are the gets and sets of data in execution order: "read <store> \\"key\\"", "write <store> \\"key\\" ← value", "GET /path → Type" (request), "set vm.x ← value" (view-model write); "(→ #3)" = items that show the value.
- Under a request, "success" and "failure" list what changes: "vm.x ← field → #1" (response field stored in the view model, shown by item #1); indented ".name ← items[].product_name" = field mapping after map; "(formatted)" = value transformed; "catch ... →" = the catch branch that runs.
- "errors:" how failures are handled; "try? → x ⚠ error ignored" and "⚠ no error handling on this flow" = failures are lost.
- "⚠ stops: <reason>" the flow cannot go past this step; "⚠ never runs: <reason>" an unreachable write; "⚠ empty" a handler with an empty body.
- "No data access: F2" = flows that read and write no data.
- calls=true: the numbered calls through the layers; "[Layer]" is written only when the layer changes; "(Mapper = X)" generic bindings; "a → map {…} → sink" Combine chains; "success/failure → N" = step N handles the result; "writes" = view-model properties set. until="Repository": every step down to that layer, deeper calls folded into it as "(→ api …)". layers=[...]: only those layers. steps=true: every step.

Start narrow (item, entry, sources, include_children=false) and add detail, calls or steps only when needed.`;

export function createServer(db: Db, root: string): McpServer {
  const server = new McpServer({ name: 'swiftgraph', version: '0.0.1' }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'graph_overview',
    {
      description: 'Overview of the Swift codebase: modules, areas, most depended-on symbols, entry points, localization. Call this first.',
      inputSchema: {},
      annotations: readOnly,
    },
    () => run(() => graphReport(db, root)),
  );
  server.registerTool(
    'get_screen_flows',
    {
      description:
        'Processing flows of a screen: entry points (creation, button actions, onAppear/task, viewDidLoad, addTarget) and the steps of each in execution order through View, ViewModel, UseCase, Repository, API, with DI and generic bindings, async closures, branches and the view-model data each flow writes.',
      inputSchema: {
        screen: text().describe('view type name, qualified name or file path'),
        entry: text(200).optional().describe('only one flow: flow id (LoginView/F2) or item id from get_screen_definition (LoginView#5)'),
        depth: z.number().int().min(1).max(30).optional().describe('maximum call depth (default 12)'),
        include_children: z.boolean().optional().describe('include flows of child views, cells and rows (default true)'),
        until: text(40)
          .optional()
          .describe(
            'every step from the view down to this layer (e.g. "Repository"), including mapping in between; what runs below it is folded into it',
          ),
        calls: z
          .boolean()
          .optional()
          .describe(
            'the numbered calls through the layers instead of the data view (one step per get/set of a datasource or view-model variable)',
          ),
        layers: z
          .array(text(40))
          .max(12)
          .optional()
          .describe(
            'only steps of these architecture layers, e.g. ["ViewModel", "Repository"]; sources and outcomes of hidden steps go to the kept step above',
          ),
        steps: z
          .boolean()
          .optional()
          .describe('every step in execution order instead of the summary (path, success with field mapping, failure, stores)'),
        format: z
          .enum(['compact', 'text', 'json', 'markdown', 'mermaid'])
          .optional()
          .describe('compact (default, fewest tokens), text, json, markdown, mermaid'),
        budget,
      },
      annotations: readOnly,
    },
    ({ screen, entry, depth, include_children, until, layers, steps, calls, format, budget }) =>
      run(() =>
        flowsText(db, root, {
          screen,
          children: include_children !== false,
          steps: steps === true,
          calls: calls === true,
          ...(layers ? { layers } : {}),
          ...(until ? { until } : {}),
          ...(entry ? { entry } : {}),
          ...(depth !== undefined ? { depth } : {}),
          format: format ?? 'compact',
          budget: budget ?? 4000,
        }),
      ),
  );
  server.registerTool(
    'get_screen_definition',
    {
      description:
        'Items of a screen (SwiftUI view, view controller, cell) and where the data of each item comes from: API response field with type and JSON key, UserDefaults/Keychain/file, localization key, user input; conditions that decide which items show. Rules come from swiftgraph.json and presets.',
      inputSchema: {
        screen: text().describe('view type name, qualified name or file path'),
        include_children: z.boolean().optional().describe('include child views, cells and rows (default true)'),
        depth: z.number().int().min(1).max(30).optional().describe('maximum steps when tracing a value to its source (default 12)'),
        sources: z
          .array(z.enum(['api', 'local', 'file', 'localization', 'literal', 'input']))
          .max(6)
          .optional()
          .describe('only items with data from these sources'),
        item: text(200).optional().describe('only this item id (LoginView#5), with full paths'),
        detail: z.boolean().optional().describe('also DATA (path of each value back to its source) and CONDITIONS'),
        format: z
          .enum(['compact', 'text', 'json', 'markdown'])
          .optional()
          .describe('compact (default, fewest tokens), text, json, markdown'),
        budget,
      },
      annotations: readOnly,
    },
    ({ screen, include_children, depth, sources, item, detail, format, budget }) =>
      run(() =>
        defineText(db, root, {
          screen,
          children: include_children !== false,
          ...(depth !== undefined ? { depth } : {}),
          ...(sources ? { sources } : {}),
          ...(item ? { item } : {}),
          detail: detail === true,
          format: format ?? 'compact',
          budget: budget ?? 4000,
        }),
      ),
  );
  server.registerTool(
    'search_symbols',
    {
      description: 'Find declarations by name, qualified name or doc comment (prefix match).',
      inputSchema: {
        query: text(200),
        kinds: z.array(text(30)).max(20).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        budget,
      },
      annotations: readOnly,
    },
    ({ query, kinds, limit, budget: size }) => run(() => formatSearch(db, query, kinds, limit ?? 20, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_symbol',
    {
      description: `Signature, doc, area and relations of a symbol (${SYMBOL_HELP}).`,
      inputSchema: { symbol: text(), budget },
      annotations: readOnly,
    },
    ({ symbol, budget: size }) => run(() => formatSymbol(db, symbol, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_neighbors',
    {
      description:
        'Direct relations of a symbol, optionally filtered by direction and edge kind. AMBIGUOUS edges are hidden unless include_ambiguous.',
      inputSchema: {
        symbol: text(),
        direction: z.enum(['in', 'out', 'both']).optional(),
        edge_kinds: edgeKinds,
        include_ambiguous: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        budget,
      },
      annotations: readOnly,
    },
    ({ symbol, direction, edge_kinds, include_ambiguous, limit, budget: size }) =>
      run(() =>
        formatNeighbors(
          db,
          symbol,
          {
            ...(direction ? { direction } : {}),
            ...(edge_kinds ? { kinds: edge_kinds } : {}),
            ...(include_ambiguous !== undefined ? { includeAmbiguous: include_ambiguous } : {}),
            ...(limit ? { limit } : {}),
          },
          size ?? DEFAULT_BUDGET,
        ),
      ),
  );
  for (const [name, direction, description] of [
    ['get_callers', 'in', 'Who calls or instantiates a symbol, transitively, closest first.'],
    ['get_callees', 'out', 'What a symbol calls or instantiates, transitively, closest first.'],
  ] as const) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          symbol: text(),
          depth: depth(3),
          include_ambiguous: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          budget,
        },
        annotations: readOnly,
      },
      ({ symbol, depth: levels, include_ambiguous, limit, budget: size }) =>
        run(() =>
          formatTraversal(
            db,
            symbol,
            direction,
            { depth: levels ?? 3, limit: limit ?? 50, ...(include_ambiguous !== undefined ? { includeAmbiguous: include_ambiguous } : {}) },
            size ?? DEFAULT_BUDGET,
          ),
        ),
    );
  }
  server.registerTool(
    'find_path',
    {
      description: 'Shortest chain of relations between two symbols (any direction), e.g. how a view reaches a service.',
      inputSchema: { from: text(), to: text(), max_depth: depth(6), budget },
      annotations: readOnly,
    },
    ({ from, to, max_depth, budget: size }) => run(() => formatPath(db, from, to, max_depth ?? 6, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_impact',
    {
      description: 'Declarations, files and tests that may be affected by changing the given files or symbols.',
      inputSchema: {
        files: z.array(text(500)).max(50).optional().describe('paths relative to the repository root'),
        symbols: z.array(text()).max(50).optional(),
        depth: depth(3),
        budget,
      },
      annotations: readOnly,
    },
    ({ files, symbols, depth: levels, budget: size }) =>
      run(() => formatImpact(db, { ...(files ? { files } : {}), ...(symbols ? { symbols } : {}) }, levels ?? 3, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_community',
    {
      description: 'An area of the codebase (community): key members and linked areas. Pass an area number or a symbol.',
      inputSchema: { area: text(), budget },
      annotations: readOnly,
    },
    ({ area, budget: size }) => run(() => formatCommunity(db, area, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_source',
    {
      description: 'Source code of a declaration, read from the repository.',
      inputSchema: { symbol: text(), context_lines: z.number().int().min(0).max(50).optional(), budget },
      annotations: readOnly,
    },
    ({ symbol, context_lines, budget: size }) => run(() => formatSource(db, root, symbol, context_lines ?? 0, size ?? 4000)),
  );
  server.registerTool(
    'search_strings',
    {
      description: 'Find localization keys by key, developer comment or translated text.',
      inputSchema: { query: text(200), language: text(20).optional(), limit: z.number().int().min(1).max(100).optional(), budget },
      annotations: readOnly,
    },
    ({ query, language, limit, budget: size }) => run(() => formatStringSearch(db, query, language, limit ?? 20, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_string',
    {
      description: 'Translations (per language and variation), missing languages and code usages of a localization key.',
      inputSchema: { key: text(500), table: text(100).optional(), budget },
      annotations: readOnly,
    },
    ({ key, table, budget: size }) => run(() => formatString(db, key, table, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_strings_for_symbol',
    {
      description: 'Localization keys a declaration uses; with depth, also through what it calls or renders.',
      inputSchema: { symbol: text(), depth: depth(0), budget },
      annotations: readOnly,
    },
    ({ symbol, depth: levels, budget: size }) => run(() => formatStringsOfSymbol(db, symbol, levels ?? 0, size ?? DEFAULT_BUDGET)),
  );
  server.registerTool(
    'get_localization_issues',
    {
      description:
        'Localization issues: missing_key, unused_key, missing_translation, needs_review, stale, format_mismatch, duplicate_key, parse_error, dynamic_key_usage.',
      inputSchema: { kind: text(40).optional(), language: text(20).optional(), limit: z.number().int().min(1).max(500).optional(), budget },
      annotations: readOnly,
    },
    ({ kind, language, limit, budget: size }) =>
      run(() =>
        formatIssues(db, { ...(kind ? { kind } : {}), ...(language ? { language } : {}), limit: limit ?? 100 }, size ?? DEFAULT_BUDGET),
      ),
  );
  return server;
}

export async function serveStdio(root: string, databasePath: string, key: string | null): Promise<void> {
  const db = openDatabase(databasePath, { readonly: true, key, warn: (message) => console.error(`warning: ${message}`) });
  const server = createServer(db, root);
  await server.connect(new StdioServerTransport());
}
