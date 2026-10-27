// Interactive view of the graph: one self-contained HTML page (canvas
// renderer, data embedded, no external resources). A Content-Security-Policy
// blocks every network request from the page.
//
// Layout: ForceAtlas2 computed here, starting from positions grouped by area.

import GraphModule from 'graphology';
import forceAtlas2Module from 'graphology-layout-forceatlas2';
import type { Db } from '../store/db.ts';

const Graph = GraphModule as unknown as typeof import('graphology').default;
const forceAtlas2 = forceAtlas2Module as unknown as typeof import('graphology-layout-forceatlas2').default;

const DECLARATION_KINDS =
  "('class', 'struct', 'enum', 'actor', 'protocol', 'function', 'initializer', 'subscript', 'property', 'enum_case', 'typealias', 'macro')";

export interface ViewData {
  /** id, label, kind index, community, size, x, y, location */
  nodes: [number, string, number, number, number, number, number, string][];
  kinds: string[];
  /** Pairs of node indexes. */
  edges: [number, number][];
  areas: { id: number; label: string; size: number }[];
  title: string;
}

export function viewData(db: Db, title: string, maxNodes = 20000): ViewData {
  const rows = db
    .prepare(
      `SELECT n.id, n.qualified_name AS label, n.kind, COALESCE(n.community, 0) AS community,
         COALESCE(n.pagerank, 0) AS rank, COALESCE(f.path || ':' || n.start_line, '') AS location
       FROM nodes n LEFT JOIN files f ON f.id = n.file_id
       WHERE n.kind IN ${DECLARATION_KINDS}
       ORDER BY COALESCE(n.pagerank, 0) DESC LIMIT ?`,
    )
    .all(maxNodes) as { id: number; label: string; kind: string; community: number; rank: number; location: string }[];
  const index = new Map(rows.map((row, position) => [row.id, position]));
  const kinds = [...new Set(rows.map((row) => row.kind))];

  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  // Start from a circle of areas so the layout converges quickly.
  const communities = [...new Set(rows.map((row) => row.community))];
  const angle = new Map(communities.map((community, position) => [community, (2 * Math.PI * position) / Math.max(1, communities.length)]));
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const row of rows) {
    const theta = angle.get(row.community) ?? 0;
    graph.addNode(String(row.id), { x: Math.cos(theta) * 100 + random() * 20, y: Math.sin(theta) * 100 + random() * 20 });
  }
  const edges: [number, number][] = [];
  const edgeRows = db
    .prepare(
      `SELECT source_id AS source, target_id AS target FROM edges
       WHERE confidence != 'AMBIGUOUS' AND kind NOT IN ('TESTS', 'IMPORTS')`,
    )
    .iterate() as Iterable<{ source: number; target: number }>;
  for (const edge of edgeRows) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    const a = String(edge.source);
    const b = String(edge.target);
    if (graph.hasEdge(a, b)) continue;
    graph.addEdge(a, b);
    edges.push([source, target]);
  }
  if (graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations: graph.order > 10000 ? 60 : 150,
      settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: graph.order > 2000 },
    });
  }
  const maxRank = Math.max(...rows.map((row) => row.rank), 1e-9);
  const nodes: ViewData['nodes'] = rows.map((row) => {
    const attributes = graph.getNodeAttributes(String(row.id)) as { x: number; y: number };
    return [
      row.id,
      row.label,
      kinds.indexOf(row.kind),
      row.community,
      Math.round(2 + 10 * Math.sqrt(row.rank / maxRank)),
      Math.round(attributes.x * 10) / 10,
      Math.round(attributes.y * 10) / 10,
      row.location,
    ];
  });
  const areas = db.prepare('SELECT id, label, size FROM communities ORDER BY size DESC LIMIT 40').all() as ViewData['areas'];
  return { nodes, kinds, edges, areas, title };
}

function escapeScript(json: string): string {
  // Embedded JSON must not close the script element.
  return json.replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function viewHtml(data: ViewData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swiftgraph</title>
<style>
  :root { --bg: #fbfbfa; --fg: #1d1d1f; --muted: #6e6e73; --panel: #ffffffee; --line: #d2d2d7; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #f2f2f7; --muted: #a1a1a6; --panel: #232326ee; --line: #3a3a3c; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px -apple-system, system-ui, sans-serif; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; cursor: grab; }
  #panel { position: fixed; top: 12px; left: 12px; width: min(360px, calc(100vw - 24px)); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  #panel input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); }
  #info { margin-top: 8px; color: var(--muted); white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; }
  #info b { color: var(--fg); }
  #results div { padding: 3px 0; cursor: pointer; } #results div:hover { text-decoration: underline; }
  h1 { font-size: 14px; margin: 0 0 8px; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="panel">
  <h1 id="title"></h1>
  <input id="search" placeholder="Search a symbol…" autocomplete="off">
  <div id="results"></div>
  <div id="info">Drag to pan, scroll to zoom, click a node.</div>
</div>
<script id="data" type="application/json">${escapeScript(JSON.stringify(data))}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  document.getElementById('title').textContent = data.title + ' — ' + data.nodes.length + ' symbols';
  const canvas = document.getElementById('canvas');
  const context = canvas.getContext('2d');
  const neighbors = data.nodes.map(() => []);
  for (const [a, b] of data.edges) { neighbors[a].push(b); neighbors[b].push(a); }
  const palette = (community) => 'hsl(' + ((community * 137.508) % 360) + ' 65% 50%)';
  let scale = 1, offsetX = 0, offsetY = 0, selected = -1;
  function fit() {
    const xs = data.nodes.map((n) => n[5]), ys = data.nodes.map((n) => n[6]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    scale = Math.min(innerWidth / (maxX - minX || 1), innerHeight / (maxY - minY || 1)) * 0.9;
    offsetX = innerWidth / 2 - ((minX + maxX) / 2) * scale; offsetY = innerHeight / 2 - ((minY + maxY) / 2) * scale;
  }
  function draw() {
    const ratio = devicePixelRatio || 1;
    canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, innerWidth, innerHeight);
    const highlighted = new Set(selected >= 0 ? [selected, ...neighbors[selected]] : []);
    if (selected >= 0) {
      context.strokeStyle = getComputedStyle(document.body).color; context.globalAlpha = 0.35; context.beginPath();
      for (const other of neighbors[selected]) {
        const a = data.nodes[selected], b = data.nodes[other];
        context.moveTo(a[5] * scale + offsetX, a[6] * scale + offsetY); context.lineTo(b[5] * scale + offsetX, b[6] * scale + offsetY);
      }
      context.stroke(); context.globalAlpha = 1;
    }
    for (let i = data.nodes.length - 1; i >= 0; i--) {
      const node = data.nodes[i];
      const x = node[5] * scale + offsetX, y = node[6] * scale + offsetY;
      if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
      context.globalAlpha = selected < 0 || highlighted.has(i) ? 1 : 0.15;
      context.fillStyle = palette(node[3]);
      const radius = Math.max(1.5, node[4] * Math.min(1.5, Math.sqrt(scale)));
      context.beginPath(); context.arc(x, y, radius, 0, 6.2832); context.fill();
      if (highlighted.has(i) || node[4] * scale > 14) {
        context.fillStyle = getComputedStyle(document.body).color; context.fillText(node[1], x + radius + 2, y + 4);
      }
    }
    context.globalAlpha = 1;
  }
  function select(index) {
    selected = index;
    const info = document.getElementById('info');
    if (index < 0) { info.textContent = 'Drag to pan, scroll to zoom, click a node.'; draw(); return; }
    const node = data.nodes[index];
    const area = data.areas.find((a) => a.id === node[3]);
    info.innerHTML = '';
    const name = document.createElement('b'); name.textContent = node[1]; info.append(name);
    info.append('\\n' + data.kinds[node[2]] + (node[7] ? ' — ' + node[7] : '') + (area ? '\\narea: ' + area.label : '') +
      '\\n' + neighbors[index].length + ' neighbors: ' + neighbors[index].slice(0, 12).map((i) => data.nodes[i][1]).join(', '));
    draw();
  }
  let dragging = null;
  canvas.addEventListener('mousedown', (event) => { dragging = { x: event.clientX, y: event.clientY, moved: false }; });
  addEventListener('mousemove', (event) => {
    if (!dragging) return;
    offsetX += event.clientX - dragging.x; offsetY += event.clientY - dragging.y;
    dragging.moved ||= Math.abs(event.clientX - dragging.x) + Math.abs(event.clientY - dragging.y) > 2;
    dragging.x = event.clientX; dragging.y = event.clientY; draw();
  });
  addEventListener('mouseup', (event) => {
    if (dragging && !dragging.moved) {
      let best = -1, distance = 100;
      data.nodes.forEach((node, i) => {
        const d = (node[5] * scale + offsetX - event.clientX) ** 2 + (node[6] * scale + offsetY - event.clientY) ** 2;
        if (d < distance) { distance = d; best = i; }
      });
      select(best);
    }
    dragging = null;
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    offsetX = event.clientX - (event.clientX - offsetX) * factor; offsetY = event.clientY - (event.clientY - offsetY) * factor;
    scale *= factor; draw();
  }, { passive: false });
  document.getElementById('search').addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase();
    const results = document.getElementById('results'); results.innerHTML = '';
    if (query.length < 2) return;
    data.nodes.map((node, i) => [node, i]).filter(([node]) => node[1].toLowerCase().includes(query)).slice(0, 8).forEach(([node, i]) => {
      const row = document.createElement('div'); row.textContent = node[1];
      row.addEventListener('click', () => { scale = Math.max(scale, 4); offsetX = innerWidth / 2 - node[5] * scale; offsetY = innerHeight / 2 - node[6] * scale; select(i); });
      results.append(row);
    });
  });
  addEventListener('resize', draw);
  fit(); draw();
})();
</script>
</body>
</html>
`;
}
