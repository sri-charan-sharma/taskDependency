// layout.js
// ---------------------------------------------------------------------------
// Pure, deterministic layered layout for the task DAG. No DOM, no state
// changes: it only reads the engine and returns positions.
//   column  = longest chain of prerequisites above a task
//   order   = barycenter sweeps to reduce edge crossings
//   centers = each column is vertically centered against the tallest one
// ---------------------------------------------------------------------------

const NODE_W = 220;
const NODE_H = 96;
const GAP_X = 88;
const GAP_Y = 24;
const PAD = 40;

function computeLayout(engine) {
  if (!engine.tasks.size) return { pos: {}, width: 0, height: 0, layers: 0 };

  // 1. Longest-path layering over a topological order.
  const order = engine.getTopologicalSort();
  const col = new Map();
  for (const id of order) {
    let c = 0;
    for (const p of engine.revAdj.get(id)) c = Math.max(c, col.get(p) + 1);
    col.set(id, c);
  }
  const layers = [];
  const maxCol = Math.max(...col.values());
  for (let c = 0; c <= maxCol; c++) layers.push([]);
  for (const id of order) layers[col.get(id)].push(id);

  // 2. Crossing reduction: sort each column by average position of its
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

  // 3. Coordinates.
  const colH = (n) => n * NODE_H + (n - 1) * GAP_Y;
  const maxLen = Math.max(...layers.map((L) => L.length));
  const totalH = colH(maxLen);
  const pos = {};
  layers.forEach((L, c) => {
    const top = PAD + (totalH - colH(L.length)) / 2;
    L.forEach((id, r) => {
      pos[id] = { x: PAD + c * (NODE_W + GAP_X), y: top + r * (NODE_H + GAP_Y) };
    });
  });

  return {
    pos,
    width: PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X,
    height: PAD * 2 + totalH,
    layers: layers.length,
  };
}

/** Cubic curve from the right edge of `a` to the left edge of `b`. */
function edgePath(a, b) {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
  const x2 = b.x, y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
