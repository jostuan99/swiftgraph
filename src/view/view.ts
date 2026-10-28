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
  /** source, target (node indexes), edge kind index, 1 when EXTRACTED. */
  edges: [number, number, number, number][];
  edgeKinds: string[];
  /** Areas of the shown nodes; size is the number of shown nodes. */
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
  const edges: ViewData['edges'] = [];
  const edgeKinds: string[] = [];
  const seen = new Set<string>();
  // One edge per direction, EXTRACTED first.
  const edgeRows = db
    .prepare(
      `SELECT source_id AS source, target_id AS target, kind, confidence FROM edges
       WHERE confidence != 'AMBIGUOUS' AND kind NOT IN ('TESTS', 'IMPORTS') ORDER BY confidence`,
    )
    .iterate() as Iterable<{ source: number; target: number; kind: string; confidence: string }>;
  for (const edge of edgeRows) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    if (seen.has(`${source}>${target}`)) continue;
    seen.add(`${source}>${target}`);
    if (!edgeKinds.includes(edge.kind)) edgeKinds.push(edge.kind);
    edges.push([source, target, edgeKinds.indexOf(edge.kind), edge.confidence === 'EXTRACTED' ? 1 : 0]);
    const a = String(edge.source);
    const b = String(edge.target);
    if (!graph.hasEdge(a, b)) graph.addEdge(a, b);
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
  const labels = new Map(
    (db.prepare('SELECT id, label FROM communities').all() as { id: number; label: string }[]).map((row) => [row.id, row.label]),
  );
  const shown = new Map<number, number>();
  for (const row of rows) shown.set(row.community, (shown.get(row.community) ?? 0) + 1);
  const areas = [...shown]
    .map(([id, size]) => ({ id, label: labels.get(id) ?? (id === 0 ? 'other' : `area ${id}`), size }))
    .sort((a, b) => b.size - a.size || a.id - b.id);
  return { nodes, kinds, edges, edgeKinds, areas, title };
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
  :root { --bg: #fbfbfa; --fg: #1d1d1f; --muted: #6e6e73; --panel: #ffffff; --line: #d2d2d7; --edge: #8e8e93; --hover: #0000000d; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111114; --fg: #f2f2f7; --muted: #a1a1a6; --panel: #1c1c1f; --line: #333336; --edge: #8e8e93; --hover: #ffffff12; }
  }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px -apple-system, system-ui, sans-serif; overflow: hidden; }
  body { display: flex; }
  canvas { display: block; flex: 1; min-width: 0; height: 100%; cursor: grab; touch-action: none; }
  aside { width: 300px; flex: none; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--line); }
  aside > section { padding: 12px 14px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 15px; margin: 0 0 10px; overflow-wrap: anywhere; }
  h2 { font-size: 11px; margin: 0 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  h3 { font-size: 14px; margin: 0 0 8px; overflow-wrap: anywhere; }
  .search { position: relative; }
  input { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
  #results { position: absolute; left: 0; right: 0; top: 100%; z-index: 2; margin-top: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; max-height: 50vh; overflow: auto; }
  #results:empty { display: none; }
  button { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border: 0; border-radius: 4px; background: none; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
  button:hover { background: var(--hover); }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted, .count { color: var(--muted); }
  .count { font-variant-numeric: tabular-nums; }
  #info dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0 0 10px; }
  #info dt { color: var(--muted); }
  #info dd { margin: 0; overflow-wrap: anywhere; }
  #info .neighbors { max-height: 30vh; overflow: auto; }
  #areas-section { flex: 1; min-height: 0; overflow: auto; }
  .area.off { opacity: 0.35; }
  #stats { padding: 10px 14px; color: var(--muted); font-size: 12px; }
  #tooltip { position: fixed; z-index: 3; pointer-events: none; padding: 4px 7px; border-radius: 5px; background: var(--panel); border: 1px solid var(--line); max-width: 360px; overflow-wrap: anywhere; }
  #tooltip[hidden] { display: none; }
  @media (max-width: 700px) {
    body { flex-direction: column; }
    canvas { height: auto; flex: 1; }
    aside { width: auto; height: 45vh; border-left: 0; border-top: 1px solid var(--line); overflow: auto; }
    #areas-section { flex: none; overflow: visible; }
  }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<aside>
  <section>
    <h1 id="title"></h1>
    <div class="search">
      <input id="search" placeholder="Search symbols…" autocomplete="off" spellcheck="false">
      <div id="results"></div>
    </div>
  </section>
  <section id="info"></section>
  <section id="areas-section"><h2>Areas</h2><div id="areas"></div></section>
  <div id="stats"></div>
</aside>
<div id="tooltip" hidden></div>
<script id="data" type="application/json">${escapeScript(JSON.stringify(data))}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const nodes = data.nodes, edges = data.edges;
  const $ = (id) => document.getElementById(id);
  const element = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  document.title = 'swiftgraph – ' + data.title;
  $('title').textContent = data.title;
  $('stats').textContent = nodes.length + ' symbols · ' + edges.length + ' edges · ' + data.areas.length + ' areas';

  const canvas = $('canvas');
  const context = canvas.getContext('2d');
  const outgoing = nodes.map(() => []), incoming = nodes.map(() => []);
  edges.forEach((edge, e) => { outgoing[edge[0]].push(e); incoming[edge[1]].push(e); });
  const areaLabel = new Map(data.areas.map((area) => [area.id, area.label]));
  const color = (community) => 'hsl(' + ((community * 137.508) % 360) + ' 65% 52%)';
  const hidden = new Set();
  const visible = (i) => !hidden.has(nodes[i][3]);
  // Drawing every edge is too slow on very large graphs: then only the selected node's edges.
  const drawAllEdges = edges.length <= 60000;
  // Nodes come sorted by PageRank: the most central ones are always labelled.
  const labelled = Math.min(30, Math.ceil(nodes.length * 0.08));
  let scale = 1, offsetX = 0, offsetY = 0, selected = -1, hovered = -1, drag = null;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const px = (node) => node[5] * scale + offsetX, py = (node) => node[6] * scale + offsetY;
  const radius = (node) => Math.max(1.5, node[4] * Math.min(1.5, Math.sqrt(scale)));

  function fit() {
    const xs = nodes.map((n) => n[5]), ys = nodes.map((n) => n[6]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    scale = Math.min(width / (maxX - minX || 1), height / (maxY - minY || 1)) * 0.9;
    offsetX = width / 2 - ((minX + maxX) / 2) * scale; offsetY = height / 2 - ((minY + maxY) / 2) * scale;
  }

  function arrow(from, to) {
    const x1 = px(from), y1 = py(from), x2 = px(to), y2 = py(to);
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / length, uy = (y2 - y1) / length;
    const tipX = x2 - ux * (radius(to) + 1), tipY = y2 - uy * (radius(to) + 1);
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(tipX, tipY); context.stroke();
    context.beginPath(); context.moveTo(tipX, tipY);
    context.lineTo(tipX - ux * 7 - uy * 3.5, tipY - uy * 7 + ux * 3.5);
    context.lineTo(tipX - ux * 7 + uy * 3.5, tipY - uy * 7 - ux * 3.5);
    context.closePath(); context.fill();
  }

  function draw() {
    const ratio = devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const fg = css('--fg');
    const focus = selected >= 0 ? new Set([selected, ...outgoing[selected].map((e) => edges[e][1]), ...incoming[selected].map((e) => edges[e][0])]) : null;
    // Solid: EXTRACTED; dashed: INFERRED. Hidden while dragging to keep panning smooth.
    if (drawAllEdges && !(drag && drag.moved)) {
      context.strokeStyle = css('--edge'); context.lineWidth = 0.6;
      for (const extracted of [1, 0]) {
        context.setLineDash(extracted ? [] : [3, 3]);
        context.globalAlpha = focus ? 0.05 : extracted ? 0.3 : 0.18;
        context.beginPath();
        for (const edge of edges) {
          if (edge[3] !== extracted || !visible(edge[0]) || !visible(edge[1])) continue;
          context.moveTo(px(nodes[edge[0]]), py(nodes[edge[0]])); context.lineTo(px(nodes[edge[1]]), py(nodes[edge[1]]));
        }
        context.stroke();
      }
    }
    if (focus) {
      context.strokeStyle = fg; context.fillStyle = fg; context.lineWidth = 1.2; context.globalAlpha = 0.75;
      for (const e of [...outgoing[selected], ...incoming[selected]]) {
        const edge = edges[e];
        if (!visible(edge[0]) || !visible(edge[1])) continue;
        context.setLineDash(edge[3] ? [] : [4, 3]);
        arrow(nodes[edge[0]], nodes[edge[1]]);
      }
    }
    context.setLineDash([]);
    context.font = '12px -apple-system, system-ui, sans-serif';
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!visible(i)) continue;
      const node = nodes[i], x = px(node), y = py(node), r = radius(node);
      if (x < -40 || y < -40 || x > width + 40 || y > height + 40) continue;
      context.globalAlpha = !focus || focus.has(i) ? 1 : 0.12;
      context.fillStyle = color(node[3]);
      context.beginPath(); context.arc(x, y, r, 0, 6.2832); context.fill();
      if (i === selected || i === hovered) {
        context.strokeStyle = fg; context.lineWidth = 2; context.globalAlpha = 1;
        context.beginPath(); context.arc(x, y, r + 2.5, 0, 6.2832); context.stroke();
      }
      if ((focus && focus.has(i)) || i === hovered || (!focus && (i < labelled || node[4] * scale > 14))) {
        context.globalAlpha = 1; context.fillStyle = fg; context.fillText(node[1], x + r + 3, y + 4);
      }
    }
    context.globalAlpha = 1;
  }

  function pick(clientX, clientY, maxDistance) {
    const bounds = canvas.getBoundingClientRect(), x = clientX - bounds.left, y = clientY - bounds.top;
    let best = -1, distance = maxDistance * maxDistance;
    nodes.forEach((node, i) => {
      if (!visible(i)) return;
      const d = (px(node) - x) ** 2 + (py(node) - y) ** 2 - radius(node) ** 2;
      if (d < distance) { distance = d; best = i; }
    });
    return best;
  }

  // Members of the selected symbol are shown without its name: .rows instead of App.ViewModel.rows.
  const short = (label) => (selected >= 0 && label.startsWith(nodes[selected][1] + '.') ? label.slice(nodes[selected][1].length) : label);

  function neighborButton(direction, e) {
    const edge = edges[e], other = direction === '→' ? edge[1] : edge[0];
    const button = element('button');
    const dot = element('span', 'dot'); dot.style.background = color(nodes[other][3]);
    button.append(dot, element('span', 'muted', direction + ' ' + data.edgeKinds[edge[2]] + (edge[3] ? '' : '?')), element('span', 'name', short(nodes[other][1])));
    button.title = nodes[other][1] + (edge[3] ? '' : ' (inferred)');
    button.addEventListener('click', () => focusNode(other));
    return button;
  }

  function showInfo() {
    const info = $('info');
    info.replaceChildren(element('h2', '', 'Symbol'));
    if (selected < 0) { info.append(element('div', 'muted', 'Click a symbol to inspect it. Drag to pan, scroll to zoom.')); return; }
    const node = nodes[selected];
    info.append(element('h3', '', node[1]));
    const fields = element('dl');
    const field = (name, value) => fields.append(element('dt', '', name), element('dd', '', value));
    field('Kind', data.kinds[node[2]]);
    field('Area', areaLabel.get(node[3]));
    if (node[7]) field('Source', node[7]);
    field('Degree', (outgoing[selected].length + incoming[selected].length) + ' (' + outgoing[selected].length + ' out, ' + incoming[selected].length + ' in)');
    info.append(fields);
    const links = [...outgoing[selected].map((e) => ['→', e]), ...incoming[selected].map((e) => ['←', e])];
    info.append(element('h2', '', 'Neighbors (' + links.length + ')'));
    const list = element('div', 'neighbors');
    for (const [direction, e] of links.slice(0, 300)) list.append(neighborButton(direction, e));
    if (links.length > 300) list.append(element('div', 'muted', '… ' + (links.length - 300) + ' more'));
    info.append(list);
  }

  function select(index) { selected = index; showInfo(); draw(); }

  function focusNode(index) {
    if (hidden.delete(nodes[index][3])) showAreas();
    scale = Math.max(scale, 3);
    offsetX = canvas.clientWidth / 2 - nodes[index][5] * scale; offsetY = canvas.clientHeight / 2 - nodes[index][6] * scale;
    select(index);
  }

  function showAreas() {
    const list = $('areas'); list.replaceChildren();
    for (const area of data.areas) {
      const button = element('button', hidden.has(area.id) ? 'area off' : 'area');
      const dot = element('span', 'dot'); dot.style.background = color(area.id);
      button.append(dot, element('span', 'name', area.label), element('span', 'count', String(area.size)));
      button.title = (hidden.has(area.id) ? 'Show ' : 'Hide ') + area.label;
      button.addEventListener('click', () => {
        if (!hidden.delete(area.id)) hidden.add(area.id);
        if (selected >= 0 && !visible(selected)) selected = -1;
        showAreas(); showInfo(); draw();
      });
      list.append(button);
    }
  }

  const tooltip = $('tooltip');
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, moved: false };
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
      if (!drag.moved) return;
      offsetX += dx; offsetY += dy; drag.x = event.clientX; drag.y = event.clientY;
      tooltip.hidden = true; draw();
      return;
    }
    const index = pick(event.clientX, event.clientY, 10);
    if (index !== hovered) { hovered = index; draw(); }
    tooltip.hidden = index < 0;
    if (index >= 0) {
      tooltip.textContent = nodes[index][1] + ' · ' + data.kinds[nodes[index][2]];
      tooltip.style.left = Math.min(event.clientX + 14, innerWidth - tooltip.offsetWidth - 8) + 'px';
      tooltip.style.top = (event.clientY + 14) + 'px';
    }
    canvas.style.cursor = index >= 0 ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerup', (event) => {
    const moved = drag && drag.moved;
    drag = null; canvas.style.cursor = 'grab';
    if (!moved) select(pick(event.clientX, event.clientY, 12));
    else draw();
  });
  canvas.addEventListener('pointerleave', () => { tooltip.hidden = true; if (hovered >= 0) { hovered = -1; draw(); } });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    offsetX = x - (x - offsetX) * factor; offsetY = y - (y - offsetY) * factor;
    scale *= factor; draw();
  }, { passive: false });
  addEventListener('keydown', (event) => { if (event.key === 'Escape' && selected >= 0) select(-1); });

  const search = $('search'), results = $('results');
  search.addEventListener('input', () => {
    const query = search.value.toLowerCase();
    results.replaceChildren();
    if (query.length < 2) return;
    const matches = [];
    for (let i = 0; i < nodes.length && matches.length < 20; i++) if (nodes[i][1].toLowerCase().includes(query)) matches.push(i);
    for (const i of matches) {
      const button = element('button');
      const dot = element('span', 'dot'); dot.style.background = color(nodes[i][3]);
      button.append(dot, element('span', 'name', nodes[i][1]), element('span', 'count', data.kinds[nodes[i][2]]));
      button.addEventListener('click', () => { search.value = ''; results.replaceChildren(); focusNode(i); });
      results.append(button);
    }
    if (matches.length === 0) results.append(element('div', 'muted', 'No symbol matches.'));
  });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.search')) results.replaceChildren(); });

  addEventListener('resize', draw);
  showInfo(); showAreas(); fit(); draw();
})();
</script>
</body>
</html>
`;
}
