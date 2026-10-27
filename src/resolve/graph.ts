// Graph produced by the resolver. See docs/01-design.md, section 3.

import type { IssueRecord, LocalizationPayload } from '../localization/resolve.ts';
import type { DeclarationKind, Range } from '../schema/types.ts';

export type NodeKind = 'module' | 'file' | DeclarationKind | 'external_symbol' | 'localization_table' | 'localized_string';

export type EdgeKind =
  | 'CONTAINS'
  | 'EXTENDS'
  | 'INHERITS'
  | 'CONFORMS_TO'
  | 'IMPLEMENTS'
  | 'OVERRIDES'
  | 'CALLS'
  | 'INSTANTIATES'
  | 'REFERENCES'
  | 'READS'
  | 'WRITES'
  | 'IMPORTS'
  | 'WRAPS'
  | 'EXPANDS'
  | 'RENDERS'
  | 'TESTS'
  | 'USES_STRING';

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 };

export interface GraphNode {
  symbolId: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  signature: string | null;
  access: string | null;
  /** Modifiers followed by attributes (`@MainActor`). */
  modifiers: string[];
  file: string | null;
  range: Range | null;
  doc: string | null;
  conditions: string[];
}

export interface Evidence {
  file: string;
  line: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  confidence: Confidence;
  weight: number;
  count: number;
  evidence: Evidence[];
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  localization: LocalizationPayload;
  /** missing_key and dynamic_key_usage issues, attached to the declaration that uses the key. */
  referenceIssues: IssueRecord[];
  /** Short numbers for symbol ids, which keep the keys of `edges` small. */
  symbolNumbers: Map<string, number>;
  /** Files that declare a symbol together with another file (`#if` variants in two files). */
  sharedSymbolFiles: Set<string>;
}

/** Keeps at most this many evidence locations per edge. */
const EVIDENCE_LIMIT = 20;

export function createGraph(): Graph {
  return {
    nodes: new Map(),
    edges: new Map(),
    localization: { tables: new Map(), issues: [] },
    referenceIssues: [],
    symbolNumbers: new Map(),
    sharedSymbolFiles: new Set(),
  };
}

const EDGE_KIND_NUMBERS = new Map<EdgeKind, number>();

function symbolNumber(graph: Graph, symbolId: string): number {
  let number = graph.symbolNumbers.get(symbolId);
  if (number === undefined) {
    number = graph.symbolNumbers.size;
    graph.symbolNumbers.set(symbolId, number);
  }
  return number;
}

/** `<source>,<kind>,<target>` in numbers: a fifth of the length of the symbol ids. */
function edgeKey(graph: Graph, source: string, kind: EdgeKind, target: string): string {
  let kindNumber = EDGE_KIND_NUMBERS.get(kind);
  if (kindNumber === undefined) EDGE_KIND_NUMBERS.set(kind, (kindNumber = EDGE_KIND_NUMBERS.size));
  return `${symbolNumber(graph, source)},${kindNumber},${symbolNumber(graph, target)}`;
}

export function addEdge(
  graph: Graph,
  source: string,
  kind: EdgeKind,
  target: string,
  confidence: Confidence,
  evidence: Evidence | null,
  weight = 1,
): void {
  if (source === target && kind !== 'CALLS') return;
  const key = edgeKey(graph, source, kind, target);
  const existing = graph.edges.get(key);
  if (existing) {
    existing.count++;
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = confidence;
      existing.weight = weight;
    }
    if (evidence && existing.evidence.length < EVIDENCE_LIMIT) {
      const duplicate = existing.evidence.some((item) => item.file === evidence.file && item.line === evidence.line);
      if (!duplicate) existing.evidence.push(evidence);
    }
    return;
  }
  graph.edges.set(key, { source, target, kind, confidence, weight, count: 1, evidence: evidence ? [evidence] : [] });
}
