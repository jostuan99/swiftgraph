// Graph analysis: communities, PageRank, entry points and bridges.
// See docs/01-design.md, section 6.

import GraphModule from 'graphology';
import louvainModule from 'graphology-communities-louvain';
import pagerankModule from 'graphology-metrics/centrality/pagerank.js';
import type { Db } from '../store/db.ts';

// These are CommonJS packages: the default import is `module.exports`, while
// their typings describe an ES module with a `default` export.
const Graph = GraphModule as unknown as typeof import('graphology').default;
const louvain = louvainModule as unknown as typeof import('graphology-communities-louvain').default;
const pagerank = pagerankModule as unknown as typeof import('graphology-metrics/centrality/pagerank.js').default;

/** Weight of each edge kind in the undirected graph used for communities. */
const COMMUNITY_WEIGHTS: Readonly<Record<string, number>> = {
  CONTAINS: 3,
  EXTENDS: 3,
  CONFORMS_TO: 2,
  INHERITS: 2,
  IMPLEMENTS: 1,
  OVERRIDES: 1,
  CALLS: 1,
  INSTANTIATES: 1,
  RENDERS: 1,
  READS: 0.5,
  WRITES: 0.5,
  REFERENCES: 0.5,
};

/** Edge kinds that make a node important for PageRank (who depends on it). */
const RANK_KINDS = new Set(['CALLS', 'INSTANTIATES', 'REFERENCES', 'RENDERS', 'CONFORMS_TO', 'INHERITS', 'READS', 'WRITES']);

/** Node kinds that take part in the analysis (declarations of the repository). */
const ANALYZED_KINDS = new Set([
  'class',
  'struct',
  'enum',
  'actor',
  'protocol',
  'extension',
  'function',
  'initializer',
  'deinitializer',
  'subscript',
  'property',
  'enum_case',
  'typealias',
  'associatedtype',
  'macro',
]);

const TYPE_KINDS = new Set(['class', 'struct', 'enum', 'actor', 'protocol']);

export interface AnalysisResult {
  communities: number;
  nodes: number;
  durationMs: number;
}

interface NodeRow {
  id: number;
  kind: string;
  name: string;
  qualified_name: string;
  path: string | null;
}

export function analyze(db: Db): AnalysisResult {
  const started = performance.now();
  const nodes = db
    .prepare('SELECT n.id, n.kind, n.name, n.qualified_name, f.path FROM nodes n LEFT JOIN files f ON f.id = n.file_id')
    .all() as NodeRow[];
  const analyzed = new Map(nodes.filter((node) => ANALYZED_KINDS.has(node.kind)).map((node) => [node.id, node]));
  // Weights summed per node pair first (edges are streamed, not loaded as
  // rows), then each pair becomes one graph edge. Node ids are below 2^26, so
  // a pair fits in one exact double key.
  const pairKey = (a: number, b: number) => a * 2 ** 26 + b;
  const communityWeights = new Map<number, number>();
  const rankWeights = new Map<number, number>();
  const edges = db.prepare(`SELECT source_id, target_id, kind, weight FROM edges WHERE confidence != 'AMBIGUOUS'`).raw();
  for (const [sourceId, targetId, kind, weight] of edges.iterate() as IterableIterator<[number, number, string, number]>) {
    if (sourceId === targetId || !analyzed.has(sourceId) || !analyzed.has(targetId)) continue;
    const communityWeight = (COMMUNITY_WEIGHTS[kind] ?? 0) * weight;
    if (communityWeight > 0) {
      // Undirected: one key per unordered pair.
      const key = sourceId < targetId ? pairKey(sourceId, targetId) : pairKey(targetId, sourceId);
      communityWeights.set(key, (communityWeights.get(key) ?? 0) + communityWeight);
    }
    if (RANK_KINDS.has(kind)) {
      const key = pairKey(sourceId, targetId);
      rankWeights.set(key, (rankWeights.get(key) ?? 0) + weight);
    }
  }

  const undirected = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  const directed = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
  for (const id of analyzed.keys()) {
    undirected.addNode(String(id));
    directed.addNode(String(id));
  }
  for (const [key, weight] of communityWeights) {
    undirected.addEdge(String(Math.floor(key / 2 ** 26)), String(key % 2 ** 26), { weight });
  }
  communityWeights.clear();
  for (const [key, weight] of rankWeights) {
    directed.addEdge(String(Math.floor(key / 2 ** 26)), String(key % 2 ** 26), { weight });
  }
  rankWeights.clear();

  // Deterministic Louvain: a seeded random generator.
  let seed = 0x5eed;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const membership: Record<string, number> = undirected.size > 0 ? louvain(undirected, { getEdgeWeight: 'weight', rng: random }) : {};
  const ranks: Record<string, number> = directed.order > 0 ? pagerank(directed, { getEdgeWeight: 'weight' }) : {};

  // Renumber communities by size; isolated nodes get no community.
  const members = new Map<number, number[]>();
  for (const [node, community] of Object.entries(membership)) {
    if (undirected.degree(node) === 0) continue;
    const list = members.get(community);
    if (list) list.push(Number(node));
    else members.set(community, [Number(node)]);
  }
  const ordered = [...members.entries()].sort((a, b) => b[1].length - a[1].length);
  const rank = (id: number) => ranks[String(id)] ?? 0;

  const updateNode = db.prepare('UPDATE nodes SET community = ?, pagerank = ? WHERE id = ?');
  const insertCommunity = db.prepare('INSERT INTO communities (id, label, size) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('UPDATE nodes SET community = NULL, pagerank = NULL').run();
    db.prepare('DELETE FROM communities').run();
    for (const id of analyzed.keys()) updateNode.run(null, rank(id), id);
    ordered.forEach(([, ids], index) => {
      const communityId = index + 1;
      for (const id of ids) updateNode.run(communityId, rank(id), id);
      insertCommunity.run(
        communityId,
        communityLabel(
          ids.map((id) => analyzed.get(id)!),
          rank,
        ),
        ids.length,
      );
    });
  })();
  return { communities: ordered.length, nodes: analyzed.size, durationMs: Math.round(performance.now() - started) };
}

/** Most central type of the community, with the deepest directory its files share. */
function communityLabel(nodes: NodeRow[], rank: (id: number) => number): string {
  const types = nodes.filter((node) => TYPE_KINDS.has(node.kind));
  const candidates = types.length > 0 ? types : nodes;
  const top = candidates.reduce((best, node) => (rank(node.id) > rank(best.id) ? node : best), candidates[0]!);
  const directories = nodes.map((node) => node.path?.split('/').slice(0, -1) ?? []).filter((parts) => parts.length > 0);
  let common = directories[0] ?? [];
  for (const parts of directories) {
    let length = 0;
    while (length < common.length && length < parts.length && common[length] === parts[length]) length++;
    common = common.slice(0, length);
  }
  return common.length > 0 ? `${top.qualified_name} (${common.join('/')})` : top.qualified_name;
}
