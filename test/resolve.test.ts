import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover } from '../src/discover/discover.ts';
import { extractSwiftFacts } from '../src/extract/swift.ts';
import { parseLocalizationFile } from '../src/localization/parse.ts';
import type { Graph } from '../src/resolve/graph.ts';
import { baseTypeName, resolve, selectorMatches } from '../src/resolve/resolve.ts';
import type { Declaration } from '../src/schema/types.ts';
import { FIXTURE_ROOT } from './helpers.ts';

function fixtureGraph(): Graph {
  const { files } = discover(FIXTURE_ROOT);
  return resolve(
    files
      .filter((file) => file.kind === 'swift')
      .map((file) => ({ path: file.path, module: file.module, facts: extractSwiftFacts(readFileSync(file.absolutePath, 'utf8')) })),
    {
      localization: files
        .filter((file) => file.kind !== 'swift')
        .map((file) => ({
          path: file.path,
          module: file.module,
          facts: parseLocalizationFile(file.path, readFileSync(file.absolutePath), file.language),
        })),
    },
  );
}

interface ExpectedEdge {
  source: string;
  kind: string;
  target: string;
  confidence: string;
  absent: boolean;
}

function expectedEdges(): ExpectedEdge[] {
  const text = readFileSync(join(FIXTURE_ROOT, '..', '..', 'expected', 'mini-app.edges.tsv'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .map((columns) =>
      columns[0] === 'absent'
        ? { source: columns[1]!, kind: columns[2]!, target: columns[3]!, confidence: '', absent: true }
        : { source: columns[0]!, kind: columns[1]!, target: columns[2]!, confidence: columns[3]!, absent: false },
    );
}

test('resolves the expected edges of the fixture', () => {
  const graph = fixtureGraph();
  const failures: string[] = [];
  for (const expected of expectedEdges()) {
    const matching = [...graph.edges.values()].filter(
      (edge) =>
        edge.source === expected.source && edge.kind === expected.kind && (expected.target === '*' || edge.target === expected.target),
    );
    const description = `${expected.source} ${expected.kind} ${expected.target}`;
    if (expected.absent) {
      if (matching.length > 0) failures.push(`unexpected: ${description}`);
    } else if (matching.length === 0) {
      failures.push(`missing: ${description}`);
    } else if (matching[0]!.confidence !== expected.confidence) {
      failures.push(`confidence of ${description}: ${matching[0]!.confidence}, expected ${expected.confidence}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every edge points at existing nodes and has evidence when it comes from code', () => {
  const graph = fixtureGraph();
  for (const edge of graph.edges.values()) {
    assert.ok(graph.nodes.has(edge.source), edge.source);
    assert.ok(graph.nodes.has(edge.target), edge.target);
    if (['CALLS', 'READS', 'WRITES', 'INSTANTIATES'].includes(edge.kind)) assert.ok(edge.evidence.length > 0);
  }
});

test('declarations in exclusive #if branches share one node', () => {
  const graph = fixtureGraph();
  const node = graph.nodes.get('swift:Core/formatTitle(_:)');
  assert.deepEqual(node?.conditions, ['os(iOS)', '!(os(iOS))']);
  assert.ok(![...graph.nodes.keys()].some((id) => id.startsWith('swift:Core/formatTitle(_:)#')));
});

test('ambiguous receivers produce weighted AMBIGUOUS edges', () => {
  const facts = (source: string) => extractSwiftFacts(source);
  const graph = resolve([
    { path: 'A.swift', module: 'M', facts: facts('struct A { func run(x: Int) {} }') },
    { path: 'B.swift', module: 'M', facts: facts('struct B { func run(x: Int) {} }') },
    { path: 'C.swift', module: 'M', facts: facts('func go(items: [Any]) { items.first!.run(x: 1) }') },
  ]);
  const calls = [...graph.edges.values()].filter((edge) => edge.kind === 'CALLS');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.confidence, 'AMBIGUOUS');
    assert.equal(call.weight, 0.5);
  }
});

test('selector matching', () => {
  const declaration = (selector: string, parameters: Declaration['parameters']): Declaration => ({
    localId: 0,
    parent: null,
    kind: 'function',
    name: selector.slice(0, selector.indexOf('(')),
    selector,
    signature: '',
    access: null,
    modifiers: [],
    attributes: [],
    range: [1, 1, 1, 1],
    doc: null,
    conditions: [],
    parameters,
  });
  const animate = declaration('animate(withDuration:animations:completion:)', [
    { label: 'withDuration', name: 'd', type: 'TimeInterval' },
    { label: 'animations', name: 'a', type: '() -> Void' },
    { label: 'completion', name: 'c', type: '((Bool) -> Void)?', hasDefault: true },
  ]);
  assert.ok(selectorMatches('animate(withDuration:_:)', animate));
  assert.ok(selectorMatches('animate(withDuration:_:completion:)', animate));
  assert.ok(!selectorMatches('animate(_:)', animate));
  const log = declaration('log(_:_:)', [{ label: '_', name: 'items', type: 'Any', variadic: true }]);
  assert.ok(selectorMatches('log(_:_:_:)', log));
  assert.ok(selectorMatches('log()', log));
});

test('base type names', () => {
  assert.equal(baseTypeName('Store<Void>?'), 'Store');
  assert.equal(baseTypeName('some View'), 'View');
  assert.equal(baseTypeName('Foo.Bar<Int, [String]>'), 'Foo.Bar');
});

test('well-known attached macros add the conformance of their expansion', () => {
  const graph = resolve([
    {
      path: 'A.swift',
      module: 'App',
      facts: extractSwiftFacts(
        'import Observation\nimport ComposableArchitecture\n@Observable final class Model {}\n@Reducer struct Feature { @ObservableState struct State {} }\n',
      ),
    },
  ]);
  const conformances = [...graph.edges.values()]
    .filter((edge) => edge.kind === 'CONFORMS_TO')
    .map((edge) => `${edge.source} ${edge.target} ${edge.confidence}`)
    .sort();
  assert.deepEqual(conformances, [
    'swift:App/Feature swift:ComposableArchitecture/Reducer INFERRED',
    'swift:App/Feature.State swift:ComposableArchitecture/ObservableState INFERRED',
    'swift:App/Model swift:Observation/Observable INFERRED',
  ]);
});
