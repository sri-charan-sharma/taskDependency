// smoke.js — runs the real app.js against a minimal fake DOM.
// Exercises boot, add, select, inspector actions, hold, edit, undo/redo,
// preset load, reset. Catches runtime errors and checks engine state.
// Does NOT check layout, CSS, pixels, or real pointer/keyboard events.
const fs = require('fs'), vm = require('vm');

const handlers = {};
const elements = {};
let errors = 0;
const log = [];

function makeEl(id = '') {
  let html = '';
  const el = {
    id, value: '', textContent: '', hidden: false, className: '', open: false,
    style: {}, dataset: {}, disabled: false, selectedOptions: [], options: [],
    attributes: {}, children: [], tagName: 'DIV', returnValue: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; this.children = []; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    addEventListener(ev, fn) { (handlers[(id || this._k || 'anon') + ':' + ev] ||= []).push(fn); },
    setPointerCapture() {},
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    reportValidity() { return true; },
    reset() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  return el;
}

const $el = (id) => (elements[id] ||= makeEl(id));
const document = {
  getElementById: $el,
  createElement(tag) { const e = makeEl(); e.tagName = tag.toUpperCase(); return e; },
  createElementNS() { return makeEl(); },
  addEventListener(ev, fn) { (handlers['document:' + ev] ||= []).push(fn); },
  querySelector() { return makeEl(); },
  querySelectorAll() { return []; },
  activeElement: { tagName: 'BODY' },
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const window = {
  addEventListener(ev, fn) { (handlers['window:' + ev] ||= []).push(fn); },
  innerWidth: 1200, innerHeight: 800,
};
const ctx = {
  document, window, localStorage,
  console: {
    log: (...a) => log.push(a.join(' ')),
    warn: (...a) => log.push('WARN ' + a.join(' ')),
    error: (...a) => { errors++; log.push('ERROR ' + a.join(' ')); },
  },
  confirm: () => true, setTimeout: (fn) => fn(),
  Date, JSON, Math, Map, Set, Number, String, Array, Object, Promise,
};
vm.createContext(ctx);

function load(file) {
  try { vm.runInContext(fs.readFileSync(__dirname + '/' + file, 'utf8'), ctx, { filename: file }); }
  catch (e) { errors++; log.push(`LOAD ERROR in ${file}: ${e.message}`); }
}
load('engine.js');
load('layout.js');
load('app.js');

// Fire an event on a registered element id. `target` simulates event.target.closest(...).
function fire(id, ev, extra = {}) {
  const event = { preventDefault() {}, ...extra };
  for (const fn of handlers[id + ':' + ev] || []) {
    try { fn(event); }
    catch (e) { errors++; log.push(`HANDLER ERROR ${id}:${ev}: ${e.message}`); }
  }
}
// Fake event target: closest(selector) matches only the selector it was built for.
const target = (selector, data) => ({ closest: (s) => (s === selector ? data : null) });
const nodeT = (id) => target('.node', { dataset: { id } });
const actT = (act) => target('[data-act]', { dataset: { act } });
const selT = (id) => target('[data-select]', { dataset: { select: id } });
const keyOn = (id, key) => fire('nodes', 'keydown', { key, target: nodeT(id) });
const check = (cond, label) => { log.push((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) errors++; };
const eng = (expr) => vm.runInContext(expr, ctx);

// ---- add two tasks, with a prerequisite -----------------------------
$el('task-title').value = 'Design schema'; $el('task-duration').value = '3';
fire('add-task-form', 'submit');
$el('task-title').value = 'Build API'; $el('task-duration').value = '5';
$el('task-prereqs').selectedOptions = [{ value: 't1' }];
fire('add-task-form', 'submit');
check(eng('engine.tasks.size') === 2, 'add: two tasks created');
check(eng('engine.tasks.get("t2").status') === 'BLOCKED', 'add: dependent starts BLOCKED');
check(eng('undoStack.length') === 2, 'add: each add is one undo step');
check(eng('els.nodes.children.length') === 2, 'render: one node per task');

// ---- select a node, use inspector to start root --------------------
fire('nodes', 'click', { target: nodeT('t1') });
check(eng('selectedId') === 't1', 'select: clicking node selects it');
fire('inspector', 'click', { target: actT('start') });
check(eng('engine.tasks.get("t1").status') === 'IN_PROGRESS', 'inspector: Start moves root to IN_PROGRESS');

// ---- blocked start must be refused and shake, not crash --------------
fire('nodes', 'click', { target: nodeT('t2') });
fire('inspector', 'click', { target: actT('start') });
check(eng('engine.tasks.get("t2").status') === 'BLOCKED', 'inspector: blocked Start refused');

// ---- complete root, dependent unlocks ------------------------------
fire('nodes', 'click', { target: nodeT('t1') });
fire('inspector', 'click', { target: actT('done') });
check(eng('engine.tasks.get("t2").status') === 'READY', 'inspector: completing root unlocks dependent');

// ---- hold and release -----------------------------------------------
fire('nodes', 'click', { target: nodeT('t2') });
fire('inspector', 'click', { target: actT('hold') });
check(eng('engine.tasks.get("t2").manuallyPaused') === true, 'inspector: Hold sets pause');
fire('inspector', 'click', { target: actT('release') });
check(eng('engine.tasks.get("t2").status') === 'READY', 'inspector: Release returns to READY');

// ---- follow a prerequisite link in the inspector --------------------
fire('inspector', 'click', { target: selT('t1') });
check(eng('selectedId') === 't1', 'inspector: prerequisite link selects that task');

// ---- undo / redo round trip -----------------------------------------
// Last mutation was Release on t2. Undo should re-apply its hold; redo should clear it.
check(eng('engine.tasks.get("t2").manuallyPaused') === false, 'pre-undo: t2 released');
fire('undo-btn', 'click');
check(eng('engine.tasks.get("t2").manuallyPaused') === true, 'undo: reverts last change (release -> held)');
check(eng('engine.tasks.get("t1").status') === 'DONE', 'undo: earlier completion of root untouched');
fire('redo-btn', 'click');
check(eng('engine.tasks.get("t2").manuallyPaused') === false, 'redo: reapplies release');
// Undo back past hold, then root completion: three undos from current state.
fire('undo-btn', 'click'); fire('undo-btn', 'click'); fire('undo-btn', 'click');
check(eng('engine.tasks.get("t1").status') !== 'DONE', 'undo x3: root completion reverted');

// ---- edit dialog: rename and drop prerequisite ----------------------
fire('nodes', 'click', { target: nodeT('t2') });
fire('inspector', 'click', { target: actT('edit') });
check($el('edit-dialog').open === true, 'edit: dialog opens');
$el('edit-title').value = 'Build API v2'; $el('edit-duration').value = '6';
$el('edit-prereqs').selectedOptions = [];
fire('edit-form', 'submit', { submitter: { value: 'save' } });
check(eng('engine.tasks.get("t2").title') === 'Build API v2', 'edit: title saved');
check(eng('engine.tasks.get("t2").duration') === 6, 'edit: duration saved');
check(eng('engine.revAdj.get("t2").size') === 0, 'edit: prerequisite removed');

// ---- preset replaces board ------------------------------------------
$el('preset-select').value = 'cicd';
fire('preset-select', 'change');
check(eng('engine.tasks.size') === 6, 'preset: CI/CD loads 6 tasks');
check(eng('engine.tasks.get([...engine.tasks.keys()][0]).status') === 'READY', 'preset: root is READY');

// ---- keyboard and zoom controls -------------------------------------
fire('zoom-in', 'click'); fire('zoom-out', 'click'); fire('zoom-fit', 'click');
fire('document', 'keydown', { key: 'Escape' });
check(eng('selectedId') === null, 'escape: clears selection');

// ---- keyboard navigation on the loaded CI/CD graph -------------------
// Root = a task with no prerequisites; ArrowRight must land on one of its children,
// ArrowLeft must return to the root.
const root = eng('[...engine.tasks.keys()].find((id) => engine.revAdj.get(id).size === 0)');
keyOn(root, 'Enter');
check(eng('selectedId') === root, 'keyboard: Enter selects focused node');
keyOn(root, 'ArrowRight');
const child = eng('selectedId');
check(eng(`engine.adj.get(${JSON.stringify(root)}).has(${JSON.stringify(child)})`) === true,
  'keyboard: ArrowRight moves to a child of the focused node');
keyOn(child, 'ArrowLeft');
check(eng('selectedId') === root, 'keyboard: ArrowLeft returns to the parent');
keyOn(root, 'ArrowUp');
check(eng('selectedId') === root, 'keyboard: ArrowUp with nothing above stays put');

// ---- reset ----------------------------------------------------------
fire('reset-btn', 'click');
check(eng('engine.tasks.size') === 0, 'reset: board cleared');

console.log(log.join('\n'));
console.log(errors ? `\n${errors} problem(s)` : '\nall smoke checks passed');
process.exitCode = errors ? 1 : 0;
