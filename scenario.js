// scenario.js — state-change flow the UI drives, checked against engine + layout.
const fs = require('fs'), vm = require('vm');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/engine.js', 'utf8') + '\n' +
  fs.readFileSync(__dirname + '/layout.js', 'utf8') +
  '\n;globalThis.__api={GraphEngine,computeLayout,STATUS,InvalidTransitionError};', ctx);
const { GraphEngine, computeLayout, STATUS, InvalidTransitionError } = ctx.__api;

let fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS ' : 'FAIL ') + l); if (!c) fail++; };
const col = (L, id) => L.pos[id].x;

const e = new GraphEngine();
const design = e.addTask('Design schema', 3).id;
const api = e.addTask('Build API', 5).id;
const ui = e.addTask('Build UI', 4).id;
const release = e.addTask('Release', 1).id;
e.addDependency(design, api);
e.addDependency(design, ui);
e.addDependency(api, release);
e.addDependency(ui, release);

ok(e.tasks.get(design).status === STATUS.READY, 'root starts READY');
ok(e.tasks.get(api).status === STATUS.BLOCKED && e.tasks.get(release).status === STATUS.BLOCKED, 'downstream BLOCKED');
let L = computeLayout(e);
ok(col(L, release) > col(L, api) && col(L, release) > col(L, ui), 'release converges after both branches');

// Start while blocked must be rejected by the engine.
try { e.transitionTask(api, STATUS.IN_PROGRESS); ok(false, 'blocked start rejected'); }
catch (err) { ok(err instanceof InvalidTransitionError, 'blocked start rejected by engine'); }

// Complete root: children unlock.
e.transitionTask(design, STATUS.DONE);
ok(e.tasks.get(api).status === STATUS.READY && e.tasks.get(ui).status === STATUS.READY, 'completing root unlocks both branches');
ok(e.tasks.get(release).status === STATUS.BLOCKED, 'join stays BLOCKED until both branches done');

// Complete one branch only: join still blocked.
e.transitionTask(api, STATUS.DONE);
ok(e.tasks.get(release).status === STATUS.BLOCKED, 'join blocked with one open prereq');
e.transitionTask(ui, STATUS.DONE);
ok(e.tasks.get(release).status === STATUS.READY, 'join READY once all prereqs done');

// Overriding completion of a blocked task is logged.
const f = new GraphEngine();
const a = f.addTask('Alpha', 1).id, b = f.addTask('Beta', 1).id;
f.addDependency(a, b);
try { f.transitionTask(b, STATUS.DONE); ok(false, 'blocked completion needs override'); }
catch (err) { ok(err instanceof InvalidTransitionError, 'blocked completion refused without override'); }
f.transitionTask(b, STATUS.DONE, { override: true });
ok(f.overrides.length === 1 && f.tasks.get(b).overridden, 'override recorded');

// Hold/release: held task is BLOCKED with the pause flag, then READY again.
const g = new GraphEngine();
const x = g.addTask('Solo', 2).id;
g.pauseTask(x);
ok(g.tasks.get(x).status === STATUS.BLOCKED && g.tasks.get(x).manuallyPaused, 'hold: BLOCKED + paused flag');
g.resumeTask(x);
ok(g.tasks.get(x).status === STATUS.READY, 'release: back to READY');

// Changing prerequisites updates the graph columns and critical path.
const h = new GraphEngine();
const p = h.addTask('Prep', 2).id, q = h.addTask('Work', 6).id, r = h.addTask('Ship', 1).id;
h.addDependency(p, r);
const before = computeLayout(h);
ok(col(before, r) > col(before, p), 'Ship after Prep');
h.setPrerequisites(r, [q]);
const after = computeLayout(h);
ok(col(after, r) > col(after, q) && h.tasks.get(r).status === STATUS.BLOCKED, 'changing prereqs re-flows graph and blocks');
ok(h.totalDuration === 7, 'critical duration reflects new prereq (Work 6 + Ship 1 = 7)');
ok(h.tasks.get(q).isCritical && h.tasks.get(r).isCritical && !h.tasks.get(p).isCritical, 'critical flags follow the new path');

// Delete a middle node: edges removed, graph still valid.
const d = new GraphEngine();
const m1 = d.addTask('One', 1).id, m2 = d.addTask('Two', 1).id, m3 = d.addTask('Three', 1).id;
d.addDependency(m1, m2); d.addDependency(m2, m3);
d.deleteTask(m2);
ok(d.tasks.get(m3).status === STATUS.READY && d.revAdj.get(m3).size === 0, 'delete middle: child becomes READY, no dangling edge');

console.log(fail ? `\n${fail} FAILED` : '\nall scenario checks passed');
process.exitCode = fail ? 1 : 0;
