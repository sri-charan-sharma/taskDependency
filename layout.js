// layout.js
// ---------------------------------------------------------------------------
// Pure, deterministic layered layout for the task DAG. No DOM, no state
// changes: it only reads the engine and returns positions.
//   1. Split into weakly connected components (independent branches).
//   2. Lay out each component on its own: column = longest prerequisite
//      chain, order = barycenter sweeps to reduce crossings.
//   3. Stack components vertically so they never interleave rows.
// Within a component, crossing reduction is heuristic: fewer crossings,
// not guaranteed zero.
// ---------------------------------------------------------------------------

const NODE_W = 220;
const NODE_H = 96;
const GAP_X = 88;
const GAP_Y = 24;
const GAP_COMPONENT = 48;
const PAD = 40;

/** Weakly connected components, each in the engine's topological order. */
function findComponents(engine, order) {
  const parent = new Map(order.map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const [u, kids] of engine.adj) {
    for (const v of kids) parent.set(find(u), find(v));
  }
  const groups = new Map();
  for (const id of order) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()]; // groups keep topological order inside
}

/** Lays out one component starting at (0,0). Returns positions and size. */
function layoutComponent(engine, ids) {
  // 1. Longest-path layering.
  const col = new Map();
  for (const id of ids) {
    let c = 0;
    for (const p of engine.revAdj.get(id)) c = Math.max(c, col.get(p) + 1);
    col.set(id, c);
  }
  const layers = Array.from({ length: Math.max(...col.values()) + 1 }, () => []);
  for (const id of ids) layers[col.get(id)].push(id);

  // 2. Crossing reduction: order each column by the average position of its
  //    neighbours in the adjacent column. Stable sort keeps ties deterministic.
  const rank = new Map();
  const refreshRanks = () => layers.forEach((L) => L.forEach((id, i) => rank.set(id, i)));
  const sweep = (layer, neighbours) => {
    const key = new Map();
    layer.forEach((id, i) => {
      const ns = neighbours(id);
      key.set(id, ns.length ? ns.reduce((s, n) => s + rank.get(n), 0) / ns.length : i);
    });
    layer.sort((a, b) => key.get(a) - key.get(b) || rank.get(a) - rank.get(b));
  };
  refreshRanks();
  for (let pass = 0; pass < 4; pass++) {
    for (let c = 1; c < layers.length; c++) {
      sweep(layers[c], (id) => [...engine.revAdj.get(id)]);
      refreshRanks();
    }
    for (let c = layers.length - 2; c >= 0; c--) {
      sweep(layers[c], (id) => [...engine.adj.get(id)]);
      refreshRanks();
    }
  }

  // 3. Coordinates, each column centred against the tallest one.
  const colH = (n) => n * NODE_H + (n - 1) * GAP_Y;
  const totalH = colH(Math.max(...layers.map((L) => L.length)));
  const pos = {};
  layers.forEach((L, c) => {
    const top = (totalH - colH(L.length)) / 2;
    L.forEach((id, r) => {
      pos[id] = { x: c * (NODE_W + GAP_X), y: top + r * (NODE_H + GAP_Y) };
    });
  });
  return {
    pos,
    width: layers.length * NODE_W + (layers.length - 1) * GAP_X,
    height: totalH,
    layers: layers.length,
  };
}

function computeLayout(engine) {
  if (!engine.tasks.size) return { pos: {}, width: 0, height: 0, layers: 0 };

  const order = engine.getTopologicalSort();
  const comps = findComponents(engine, order);

  const pos = {};
  let y = 0;
  let maxW = 0;
  let maxLayers = 0;
  for (const ids of comps) {
    const c = layoutComponent(engine, ids);
    for (const id of ids) pos[id] = { x: c.pos[id].x, y: y + c.pos[id].y };
    y += c.height + GAP_COMPONENT;
    maxW = Math.max(maxW, c.width);
    maxLayers = Math.max(maxLayers, c.layers);
  }
  const contentH = y - GAP_COMPONENT;

  // Shift everything by PAD so the canvas has a margin.
  for (const p of Object.values(pos)) { p.x += PAD; p.y += PAD; }
  return {
    pos,
    width: maxW + PAD * 2,
    height: contentH + PAD * 2,
    layers: maxLayers,
    components: comps.length,
  };
}

/** Cubic curve from the right edge of `a` to the left edge of `b`. */
function edgePath(a, b) {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
  const x2 = b.x, y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
