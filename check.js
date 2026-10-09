// check.js — run from the task-planner folder:  node check.js
const fs = require('fs');
const vm = require('vm');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(__dirname + '/engine.js', 'utf8') + '\n' +
  fs.readFileSync(__dirname + '/layout.js', 'utf8') + '\n' +
  ';globalThis.__api = { GraphEngine, computeLayout, edgePath, NODE_W, NODE_H };',
  ctx
);
const { GraphEngine, computeLayout, edgePath, NODE_W, NODE_H } = ctx.__api;

let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label);
  if (!cond) failures++;
};

function overlaps(pos) {
  const ids = Object.keys(pos);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos[ids[i]], b = pos[ids[j]];
      if (a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H) return true;
    }
  return false;
}

function build(tasks, edges) {
  const e = new GraphEngine();
  const ids = {};
  for (const [name, dur] of tasks) ids[name] = e.addTask(name, dur).id;
  for (const [a, b] of edges) e.addDependency(ids[a], ids[b]);
  return { e, ids };
}

function edgesFlowRight(e, L) {
  for (const [u, vs] of e.adj) for (const v of vs) if (!(L.pos[v].x > L.pos[u].x)) return false;
  return true;
}

// 1. Linear chain flows left to right.
{
  const { e, ids } = build([['A', 2], ['B', 3], ['C', 5]], [['A', 'B'], ['B', 'C']]);
  const L = computeLayout(e);
  ok(L.pos[ids.A].x < L.pos[ids.B].x && L.pos[ids.B].x < L.pos[ids.C].x, 'chain: columns increase left to right');
  ok(!overlaps(L.pos), 'chain: no overlapping nodes');
}

// 2. Diamond: two branches diverge then converge.
{
  const { e, ids } = build(
    [['Root', 1], ['Left', 2], ['Right', 2], ['Join', 1]],
    [['Root', 'Left'], ['Root', 'Right'], ['Left', 'Join'], ['Right', 'Join']]
  );
  const L = computeLayout(e);
  ok(L.pos[ids.Left].x === L.pos[ids.Right].x, 'diamond: branches share a column');
  ok(L.pos[ids.Left].y !== L.pos[ids.Right].y, 'diamond: branches on separate rows');
  ok(L.pos[ids.Join].x > L.pos[ids.Left].x, 'diamond: join placed after both branches');
  ok(edgesFlowRight(e, L) && !overlaps(L.pos), 'diamond: edges rightward, no overlap');
}

// 3. Disconnected components coexist without overlap.
{
  const { e, ids } = build([['A', 1], ['B', 1], ['X', 4]], [['A', 'B']]);
  const L = computeLayout(e);
  ok(L.pos[ids.X] !== undefined && !overlaps(L.pos), 'disconnected: isolated task placed, no overlap');
}

// 4. Long chain of 30.
{
  const names = Array.from({ length: 30 }, (_, i) => 'T' + i);
  const edges = names.slice(1).map((n, i) => [names[i], n]);
  const { e, ids } = build(names.map((n) => [n, 1]), edges);
  const L = computeLayout(e);
  let inc = true;
  for (let i = 1; i < names.length; i++) inc = inc && L.pos[ids[names[i]]].x > L.pos[ids[names[i - 1]]].x;
  ok(inc && !overlaps(L.pos), 'long chain (30): strictly increasing columns, no overlap');
}

// 5. Fan-out: one root unlocking ten children.
{
  const kids = Array.from({ length: 10 }, (_, i) => 'K' + i);
  const { e, ids } = build([['Root', 1], ...kids.map((k) => [k, 1])], kids.map((k) => ['Root', k]));
  const L = computeLayout(e);
  const xs = new Set(kids.map((k) => L.pos[ids[k]].x));
  ok(xs.size === 1 && !overlaps(L.pos), 'fan-out: children share one column, no overlap');
}

// 6. Deterministic: same graph, same positions.
{
  const { e } = build([['A', 1], ['B', 2], ['C', 3]], [['A', 'C'], ['B', 'C']]);
  const a = JSON.stringify(computeLayout(e).pos), b = JSON.stringify(computeLayout(e).pos);
  ok(a === b, 'determinism: repeated layout identical');
}

// 7. Empty board.
{
  const L = computeLayout(new GraphEngine());
  ok(L.width === 0 && Object.keys(L.pos).length === 0, 'empty board: zero-size layout');
}

// 8. Changing prerequisites moves a task to a new column.
{
  const { e, ids } = build([['A', 1], ['B', 1]], [['A', 'B']]);
  ok(computeLayout(e).pos[ids.B].x > computeLayout(e).pos[ids.A].x, 'prereq set: B after A');
  e.setPrerequisites(ids.B, []);
  const L = computeLayout(e);
  ok(L.pos[ids.B].x === L.pos[ids.A].x, 'prereq cleared: B returns to first column');
}

// 9. Layout is read-only with respect to engine state.
{
  const { e } = build([['A', 1], ['B', 1]], [['A', 'B']]);
  const before = JSON.stringify(e.toJSON());
  computeLayout(e);
  ok(before === JSON.stringify(e.toJSON()), 'layout does not mutate engine state');
}

// 10. Random forward-only DAG, 40 tasks: rightward edges, no overlap.
{
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const names = Array.from({ length: 40 }, (_, i) => 'T' + i);
  const edges = [];
  for (let i = 0; i < 40; i++) for (let j = i + 1; j < 40; j++) if (rnd() < 0.08) edges.push([names[i], names[j]]);
  const { e } = build(names.map((n) => [n, 1]), edges);
  const L = computeLayout(e);
  ok(edgesFlowRight(e, L) && !overlaps(L.pos), `random DAG (40 tasks, ${edges.length} edges): rightward, no overlap`);
}

// 12. Two disconnected chains: their row bands must not overlap vertically.
{
  const { e, ids } = build(
    [['A1', 1], ['A2', 1], ['A3', 1], ['B1', 1], ['B2', 1]],
    [['A1', 'A2'], ['A2', 'A3'], ['B1', 'B2']]
  );
  const L = computeLayout(e);
  const band = (names) => {
    const ys = names.map((n) => L.pos[ids[n]].y);
    return [Math.min(...ys), Math.max(...ys) + NODE_H];
  };
  const [a0, a1] = band(['A1', 'A2', 'A3']);
  const [b0, b1] = band(['B1', 'B2']);
  ok(a1 <= b0 || b1 <= a0, 'components: row bands do not interleave');
  ok(L.components === 2, 'components: counted as 2');
}

// 11. edgePath returns a valid cubic curve string.
{
  const d = edgePath({ x: 0, y: 0 }, { x: 300, y: 50 });
  ok(/^M[-\d.]+,[-\d.]+ C/.test(d), 'edgePath: valid SVG path');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exitCode = failures ? 1 : 0;
