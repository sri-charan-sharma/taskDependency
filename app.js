// app.js
// ---------------------------------------------------------------------------
// UI controller. The only file that touches the DOM. Task state changes
// go through GraphEngine; the flowchart and inspector are views of it.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dep-planner-v1';
const HISTORY_LIMIT = 100;
const FIT_MIN_K = 0.35;  // smallest scale fit-to-view uses; text counter-scales to stay readable
const COMPACT_K = 0.7;    // below this, cards drop secondary lines
const EDGE_ZONE = 56;     // px from a canvas edge where edge-pan starts
const EDGE_SPEED = 16;   // px per frame at the very edge

// Label + icon for every visible state. Colour is never the only signal.
const STATE_UI = {
  BLOCKED: { label: 'Blocked', icon: '⊘' },
  HELD: { label: 'Held', icon: '⏸' },
  READY: { label: 'Ready', icon: '◆' },
  IN_PROGRESS: { label: 'In progress', icon: '▶' },
  DONE: { label: 'Done', icon: '✓' },
};

const ARROW_DEFS = `<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="#4a5160"/></marker>
  <marker id="arrow-crit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="#e8b04a"/></marker>
  <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="#9aa3b2"/></marker>
</defs>`;

let engine = loadFromStorage() || new GraphEngine();
let layout = computeLayout(engine);

const undoStack = [];
const redoStack = [];
let selectedId = null;
let editingId = null;
let hasFit = false;
const view = { x: 0, y: 0, k: 1 };
let edgePan = true;
let pointer = null;
let edgeRaf = 0;

const $ = (id) => document.getElementById(id);
const els = {
  presetSelect: $('preset-select'),
  form: $('add-task-form'),
  title: $('task-title'),
  duration: $('task-duration'),
  prereqs: $('task-prereqs'),
  bannerPanel: $('banner-panel'),
  banner: $('banner'),
  diagDuration: $('diag-duration'),
  diagPath: $('diag-path'),
  diagRemaining: $('diag-remaining'),
  diagCompletion: $('diag-completion'),
  overridesPanel: $('overrides-panel'),
  overridesList: $('overrides-list'),
  resetBtn: $('reset-btn'),
  undoBtn: $('undo-btn'),
  redoBtn: $('redo-btn'),
  viewport: $('viewport'),
  world: $('world'),
  edges: $('edges'),
  nodes: $('nodes'),
  emptyHint: $('empty-hint'),
  edgePanBtn: $('edge-pan'),
  zoomFit: $('zoom-fit'),
  inspector: $('inspector'),
  overrideDialog: $('override-dialog'),
  overrideMessage: $('override-message'),
  editDialog: $('edit-dialog'),
  editForm: $('edit-form'),
  editTitle: $('edit-title'),
  editDuration: $('edit-duration'),
  editPrereqs: $('edit-prereqs'),
  editError: $('edit-error'),
};

// ---- persistence -----------------------------------------------------

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(engine.toJSON()));
  } catch (e) {
    console.warn('Could not persist to localStorage:', e);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? GraphEngine.fromJSON(JSON.parse(raw)) : null;
  } catch (e) {
    console.warn('Could not restore saved board:', e);
    return null;
  }
}

// ---- undo / redo -----------------------------------------------------

const snapshot = () => JSON.stringify(engine.toJSON());
const restore = (json) => { engine = GraphEngine.fromJSON(JSON.parse(json)); };

/** Runs fn as one undoable step. If fn throws, state is rolled back and nothing is recorded. */
function mutate(fn) {
  const before = snapshot();
  try {
    fn();
  } catch (err) {
    restore(before);
    throw err;
  }
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  showBanner('Undid last change.', 'ok');
  render();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  showBanner('Redid change.', 'ok');
  render();
}

// ---- helpers -----------------------------------------------------

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** Display state: a manual hold is shown as HELD even though engine status is BLOCKED. */
function stateOf(task) {
  if (task.status === STATUS.BLOCKED && task.manuallyPaused) return 'HELD';
  return task.status;
}

function showBanner(message, kind) {
  els.bannerPanel.hidden = false;
  els.banner.textContent = message;
  els.banner.className = kind;
}

// ---- render -----------------------------------------------------

function render() {
  if (selectedId && !engine.tasks.has(selectedId)) selectedId = null;
  layout = computeLayout(engine);

  renderPrereqOptions();
  renderDiagnostics();
  renderOverrides();
  renderCanvas();
  renderInspector();

  els.undoBtn.disabled = !undoStack.length;
  els.redoBtn.disabled = !redoStack.length;
  els.emptyHint.hidden = engine.tasks.size > 0;

  saveToStorage();
  if (!hasFit && engine.tasks.size) fitView();
}

function renderPrereqOptions() {
  const selected = new Set([...els.prereqs.selectedOptions].map((o) => o.value));
  els.prereqs.innerHTML = '';
  for (const t of engine.tasks.values()) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.title} (${fmt(t.duration)}d)`;
    opt.selected = selected.has(t.id);
    els.prereqs.appendChild(opt);
  }
}

function renderDiagnostics() {
  const has = engine.tasks.size > 0;
  els.diagDuration.textContent = has ? `${fmt(engine.totalDuration)} days` : '—';
  els.diagRemaining.textContent = has ? `${fmt(engine.remainingDuration)} days` : '—';
  const titles = engine.getCriticalPathTitles();
  els.diagPath.textContent = titles.length ? titles.join(' → ') : '—';

  if (!has) {
    els.diagCompletion.textContent = '—';
  } else if (engine.remainingDuration === 0) {
    els.diagCompletion.textContent = 'All tasks done';
  } else {
    const d = new Date();
    d.setDate(d.getDate() + Math.ceil(engine.remainingDuration));
    els.diagCompletion.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}

function renderOverrides() {
  els.overridesPanel.hidden = !engine.overrides.length;
  els.overridesList.innerHTML = '';
  for (const o of engine.overrides) {
    const li = document.createElement('li');
    const parents = o.incompleteParents.length ? o.incompleteParents.join(', ') : 'none listed';
    li.textContent = `${new Date(o.timestamp).toLocaleTimeString()} — "${o.title}" completed while waiting on: ${parents}`;
    els.overridesList.appendChild(li);
  }
}

/** Draws every node and every edge from the current layout. Read-only. */
function renderCanvas() {
  const { pos, width, height } = layout;
  els.world.style.width = width + 'px';
  els.world.style.height = height + 'px';
  els.edges.setAttribute('width', width);
  els.edges.setAttribute('height', height);
  els.edges.setAttribute('viewBox', `0 0 ${width} ${height}`);
  applyView();

  // Edges
  let svg = ARROW_DEFS;
  for (const [u, kids] of engine.adj) {
    for (const v of kids) {
      const a = pos[u], b = pos[v];
      if (!a || !b) continue;
      const crit = engine.tasks.get(u).isCritical && engine.tasks.get(v).isCritical;
      const hl = selectedId !== null && (u === selectedId || v === selectedId);
      const cls = 'edge' + (crit ? ' edge-crit' : '') + (hl ? ' edge-hl' : '');
      const marker = hl ? 'arrow-hl' : crit ? 'arrow-crit' : 'arrow';
      svg += `<path class="${cls}" marker-end="url(#${marker})" d="${edgePath(a, b)}"/>`;
    }
  }
  els.edges.innerHTML = svg;

  // Nodes
  els.nodes.innerHTML = '';
  for (const t of engine.tasks.values()) {
    const p = pos[t.id];
    const state = stateOf(t);
    const ui = STATE_UI[state];
    const nParents = engine.revAdj.get(t.id).size;
    const nKids = engine.adj.get(t.id).size;

    const node = document.createElement('div');
    node.className = 'node'
      + (t.isCritical ? ' critical' : '')
      + (t.id === selectedId ? ' selected' : '')
      + (state === 'HELD' ? ' held' : '');
    node.dataset.id = t.id;
    node.dataset.status = t.status;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `${t.title}, ${ui.label}, ${fmt(t.duration)} days`);
    node.setAttribute('aria-selected', String(t.id === selectedId));
    node.style.left = p.x + 'px';
    node.style.top = p.y + 'px';
    node.innerHTML = `
      <div class="node-head">
        <span class="state-chip" data-state="${state}"><span class="chip-icon" aria-hidden="true">${ui.icon}</span><span class="chip-label">${ui.label}</span></span>
        <span class="node-dur">${fmt(t.duration)}d</span>
      </div>
      <div class="node-title" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="node-meta">
        <span>${nParents ? `after ${nParents}` : 'no prerequisites'}</span>
        ${nKids ? `<span>unlocks ${nKids}</span>` : ''}
        ${t.isCritical ? '<span class="crit">★ critical</span>' : ''}
        ${t.overridden ? '<span class="warn">out of order</span>' : ''}
      </div>`;
    els.nodes.appendChild(node);
  }
}

function linkList(ids) {
  if (!ids.length) return '<p class="hint">None</p>';
  return `<ul class="links">${ids.map((id) => {
    const t = engine.tasks.get(id);
    return `<li><button class="link" data-select="${id}">${esc(t.title)}
      <span class="hint"> · ${STATE_UI[stateOf(t)].label}</span></button></li>`;
  }).join('')}</ul>`;
}

/** Which action buttons make sense for this task right now. Engine still enforces the rules. */
function actionsFor(t) {
  const acts = [];
  const done = t.status === STATUS.DONE;
  const inProg = t.status === STATUS.IN_PROGRESS;
  const paused = t.manuallyPaused;

  if (t.status === STATUS.READY) acts.push({ act: 'start', label: 'Start', cls: 'primary' });
  if (inProg) acts.push({ act: 'ready', label: 'Stop (back to ready)' });
  if (!done) acts.push({ act: 'done', label: 'Complete' });
  if (done) acts.push({ act: 'reopen', label: 'Reopen' });
  if (paused) acts.push({ act: 'release', label: 'Release hold' });
  else if (!done && !inProg) acts.push({ act: 'hold', label: 'Hold' });
  return acts;
}

function renderInspector() {
  const t = selectedId ? engine.tasks.get(selectedId) : null;
  if (!t) {
    els.inspector.innerHTML = '<p class="hint">Select a task to see its details, prerequisites, unlocks, and actions.</p>';
    return;
  }

  const c = t.cpm;
  const state = stateOf(t);
  const ui = STATE_UI[state];
  const parents = [...engine.revAdj.get(t.id)];
  const kids = [...engine.adj.get(t.id)];
  const actions = actionsFor(t).map((a) =>
    `<button data-act="${a.act}" class="${a.cls || ''}">${a.label}</button>`).join('');

  els.inspector.innerHTML = `
    <span class="state-chip" data-state="${state}"><span class="chip-icon" aria-hidden="true">${ui.icon}</span><span class="chip-label">${ui.label}</span></span>
    <h2 class="insp-title">${esc(t.title)}</h2>
    <dl class="diagnostics">
      <dt>Duration</dt><dd>${fmt(t.duration)} days</dd>
      <dt>Early</dt><dd>${fmt(c.es)} → ${fmt(c.ef)}</dd>
      <dt>Late</dt><dd>${fmt(c.ls)} → ${fmt(c.lf)}</dd>
      <dt>Slack</dt><dd>${fmt(c.slack)} days${t.isCritical ? ' · critical' : ''}</dd>
    </dl>
    ${t.overridden ? '<p class="insp-note">Completed before its prerequisites.</p>' : ''}
    <h3>Prerequisites</h3>${linkList(parents)}
    <h3>Unlocks</h3>${linkList(kids)}
    <div class="insp-actions">${actions}</div>
    <div class="insp-actions">
      <button data-act="edit">Edit</button>
      <button data-act="delete" class="danger">Delete</button>
    </div>`;
}

function renderSelectionOnly() {
  renderCanvas();
  renderInspector();
}

// ---- pan / zoom -----------------------------------------------------

function applyView() {
  els.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  els.world.style.setProperty('--k', String(view.k));
  els.world.classList.toggle('compact', view.k < COMPACT_K);
}

/** Keeps at least a sliver of the graph on screen so panning can't lose it. */
function clampView() {
  const r = els.viewport.getBoundingClientRect();
  if (!layout.width) return;
  const m = 60;
  view.x = clamp(view.x, m - layout.width * view.k, r.width - m);
  view.y = clamp(view.y, m - layout.height * view.k, r.height - m);
}

function fitView() {
  const r = els.viewport.getBoundingClientRect();
  if (!engine.tasks.size || !r.width || !layout.width) {
    view.x = 0; view.y = 0; view.k = 1;
    applyView();
    return;
  }
  const k = clamp(Math.min(r.width / layout.width, r.height / layout.height, 1), FIT_MIN_K, 1);
  view.k = k;
  view.x = (r.width - layout.width * k) / 2;
  view.y = (r.height - layout.height * k) / 2;
  applyView();
  hasFit = true;
}

let panning = null;
els.viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node, button')) return;
  panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  els.viewport.setPointerCapture(e.pointerId);
  els.viewport.classList.add('panning');
});
els.viewport.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (!panning) {
    startEdgePan();
    return;
  }
  const dx = e.clientX - panning.x;
  const dy = e.clientY - panning.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) panning.moved = true;
  view.x = panning.vx + dx;
  view.y = panning.vy + dy;
  clampView();
  applyView();
});
els.viewport.addEventListener('pointerleave', () => { pointer = null; });

/** Content velocity for one axis: pointer near the start edge pulls content in, near the far edge pushes it out. */
function edgeVelocity(p, size) {
  if (p < EDGE_ZONE) return EDGE_SPEED * (1 - p / EDGE_ZONE);
  if (p > size - EDGE_ZONE) return -EDGE_SPEED * (1 - (size - p) / EDGE_ZONE);
  return 0;
}

/** Scrolls the view while the pointer sits near any canvas edge. Stops when it leaves. */
function edgeStep() {
  edgeRaf = 0;
  if (!edgePan || !pointer || panning) return;
  const r = els.viewport.getBoundingClientRect();
  const vx = edgeVelocity(pointer.x - r.left, r.width);
  const vy = edgeVelocity(pointer.y - r.top, r.height);
  if (!vx && !vy) return;
  view.x += vx;
  view.y += vy;
  clampView();
  applyView();
  edgeRaf = requestAnimationFrame(edgeStep);
}

function startEdgePan() {
  if (edgePan && !edgeRaf) edgeRaf = requestAnimationFrame(edgeStep);
}

els.edgePanBtn.addEventListener('click', () => {
  edgePan = !edgePan;
  els.edgePanBtn.textContent = `Edge pan: ${edgePan ? 'on' : 'off'}`;
  if (edgePan) startEdgePan();
});
els.viewport.addEventListener('pointerup', () => {
  if (panning && !panning.moved) {
    selectedId = null;
    renderSelectionOnly();
  }
  panning = null;
  els.viewport.classList.remove('panning');
});

els.zoomFit.addEventListener('click', fitView);

// ---- selection -----------------------------------------------------

els.nodes.addEventListener('click', (e) => {
  const node = e.target.closest('.node');
  if (!node) return;
  selectedId = node.dataset.id;
  renderSelectionOnly();
});

/** Nearest node by vertical distance among candidates, for keyboard movement. */
function nearestByY(candidates, fromId) {
  const fy = layout.pos[fromId].y;
  return candidates.sort((a, b) =>
    Math.abs(layout.pos[a].y - fy) - Math.abs(layout.pos[b].y - fy) || layout.pos[a].y - layout.pos[b].y)[0];
}

/** Keyboard movement: arrows follow dependency edges and columns; Enter selects. */
els.nodes.addEventListener('keydown', (e) => {
  const node = e.target.closest('.node');
  if (!node) return;
  const id = node.dataset.id;
  let next = null;

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectedId = id;
    renderSelectionOnly();
    els.nodes.querySelector(`.node[data-id="${id}"]`)?.focus();
  } else if (e.key === 'ArrowRight') {
    const kids = [...engine.adj.get(id)];
    next = kids.length ? nearestByY(kids, id) : null;
  } else if (e.key === 'ArrowLeft') {
    const parents = [...engine.revAdj.get(id)];
    next = parents.length ? nearestByY(parents, id) : null;
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const x = layout.pos[id].x;
    const column = [...engine.tasks.keys()].filter((t) => t !== id && layout.pos[t].x === x);
    const below = column.filter((t) => (e.key === 'ArrowDown' ? layout.pos[t].y > layout.pos[id].y : layout.pos[t].y < layout.pos[id].y));
    next = below.length ? nearestByY(below, id) : null;
  } else {
    return;
  }
  e.preventDefault();
  if (next) {
    selectedId = next;
    renderSelectionOnly();
    els.nodes.querySelector(`.node[data-id="${next}"]`)?.focus();
  }
});

els.inspector.addEventListener('click', (e) => {
  const sel = e.target.closest('[data-select]');
  if (sel) {
    selectedId = sel.dataset.select;
    renderSelectionOnly();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act && selectedId) runAction(act.dataset.act, selectedId);
});

// ---- actions (all state changes go through the engine) ----------------------

function runAction(act, id) {
  const t = engine.tasks.get(id);
  if (!t) return;

  if (act === 'edit') return openEdit(id);

  if (act === 'delete') {
    const title = t.title;
    mutate(() => engine.deleteTask(id));
    selectedId = null;
    showBanner(`Deleted "${title}".`, 'ok');
    return render();
  }

  if (act === 'hold' || act === 'release') {
    try {
      mutate(() => (act === 'hold' ? engine.pauseTask(id) : engine.resumeTask(id)));
      showBanner(`"${t.title}" ${act === 'hold' ? 'held' : 'released'}.`, 'ok');
      render();
    } catch (err) {
      showBanner(err.message, 'error');
      shakeNode(id);
    }
    return;
  }

  const target = {
    start: STATUS.IN_PROGRESS,
    ready: STATUS.READY,
    done: STATUS.DONE,
    reopen: STATUS.BLOCKED, // engine recalculates to READY if nothing is open
  }[act];
  if (target) attemptTransition(id, target);
}

function attemptTransition(taskId, target, override = false) {
  const task = engine.tasks.get(taskId);
  if (!task) return;
  try {
    mutate(() => engine.transitionTask(taskId, target, { override }));
    showBanner(`"${task.title}" → ${STATE_UI[target].label.toLowerCase()}.`, 'ok');
    render();
  } catch (err) {
    if (err instanceof InvalidTransitionError && target === STATUS.DONE && !override) {
      promptOverride(task, err.message);
      return;
    }
    showBanner(err.message, 'error');
    shakeNode(taskId);
  }
}

function promptOverride(task, message) {
  els.overrideMessage.textContent = message;
  els.overrideDialog.showModal();
  els.overrideDialog.onclose = () => {
    if (els.overrideDialog.returnValue === 'confirm') {
      attemptTransition(task.id, STATUS.DONE, true);
    } else {
      showBanner(`Kept "${task.title}" as-is.`, 'error');
      shakeNode(task.id);
    }
  };
}

function shakeNode(id) {
  const node = els.nodes.querySelector(`.node[data-id="${id}"]`);
  if (!node) return;
  node.classList.add('shake');
  setTimeout(() => node.classList.remove('shake'), 320);
}

// ---- edit dialog -----------------------------------------------------

function openEdit(id) {
  const t = engine.tasks.get(id);
  if (!t) return;
  editingId = id;
  els.editError.hidden = true;
  els.editTitle.value = t.title;
  els.editDuration.value = t.duration;

  const parents = new Set(engine.revAdj.get(id));
  els.editPrereqs.innerHTML = '';
  for (const other of engine.tasks.values()) {
    if (other.id === id) continue;
    const opt = document.createElement('option');
    opt.value = other.id;
    opt.textContent = `${other.title} (${fmt(other.duration)}d)`;
    opt.selected = parents.has(other.id);
    els.editPrereqs.appendChild(opt);
  }
  els.editDialog.showModal();
}

els.editForm.addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!els.editForm.reportValidity()) return;

  const desired = [...els.editPrereqs.selectedOptions].map((o) => o.value);
  let rejected = [];
  try {
    mutate(() => {
      engine.updateTask(editingId, { title: els.editTitle.value, duration: els.editDuration.value });
      rejected = engine.setPrerequisites(editingId, desired);
    });
  } catch (err) {
    els.editError.textContent = err.message;
    els.editError.hidden = false;
    return;
  }

  const title = engine.tasks.get(editingId).title;
  els.editDialog.close();
  showBanner(
    rejected.length ? `Saved "${title}", but: ${rejected.join(' ')}` : `Saved "${title}".`,
    rejected.length ? 'error' : 'ok'
  );
  render();
});

// ---- add-task form -----------------------------------------------------

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!els.form.reportValidity()) return;

  const prereqIds = [...els.prereqs.selectedOptions].map((o) => o.value);
  let created;
  const rejected = [];
  try {
    mutate(() => {
      created = engine.addTask(els.title.value, els.duration.value);
      for (const pid of prereqIds) {
        try {
          engine.addDependency(pid, created.id);
        } catch (err) {
          rejected.push(err.message);
        }
      }
    });
  } catch (err) {
    showBanner(err.message, 'error');
    return;
  }

  const title = engine.tasks.get(created.id).title;
  els.form.reset();
  els.duration.value = 1;

  const notes = [];
  if (created.duplicate) {
    notes.push(`Note: another task is already named "${title}". They are tracked separately.`);
  }
  notes.push(...rejected);
  showBanner(
    notes.length ? `Added "${title}". ${notes.join(' ')}` : `Added "${title}".`,
    rejected.length ? 'error' : 'ok'
  );
  render();
});

// ---- presets -----------------------------------------------------

const PRESETS = {
  webapp: {
    name: 'Web App Release',
    tasks: [
      { key: 'design', title: 'Design schema', duration: 3, after: [] },
      { key: 'api', title: 'Build API', duration: 5, after: ['design'] },
      { key: 'ui', title: 'Build UI', duration: 4, after: ['design'] },
      { key: 'tests', title: 'Write tests', duration: 2, after: ['api'] },
      { key: 'docs', title: 'Write docs', duration: 1, after: [] },
      { key: 'release', title: 'Release', duration: 1, after: ['ui', 'tests', 'docs'] },
    ],
  },
  cicd: {
    name: 'CI/CD Pipeline',
    tasks: [
      { key: 'lint', title: 'Lint code', duration: 1, after: [] },
      { key: 'unit', title: 'Unit tests', duration: 3, after: ['lint'] },
      { key: 'integ', title: 'Integration tests', duration: 6, after: ['unit'] },
      { key: 'build', title: 'Build image', duration: 2, after: ['lint'] },
      { key: 'scan', title: 'Security scan', duration: 2, after: ['build'] },
      { key: 'deploy', title: 'Deploy staging', duration: 1, after: ['integ', 'scan'] },
    ],
  },
  microservices: {
    name: 'Microservice Migration',
    tasks: [
      { key: 'audit', title: 'Audit monolith', duration: 4, after: [] },
      { key: 'extract-auth', title: 'Extract auth', duration: 6, after: ['audit'] },
      { key: 'extract-billing', title: 'Extract billing', duration: 8, after: ['audit'] },
      { key: 'gateway', title: 'API gateway', duration: 3, after: [] },
      { key: 'cutover', title: 'Cutover traffic', duration: 2, after: ['extract-auth', 'extract-billing', 'gateway'] },
    ],
  },
};

els.presetSelect.addEventListener('change', () => {
  const preset = PRESETS[els.presetSelect.value];
  els.presetSelect.value = '';
  if (!preset) return;
  if (!confirm(`Replace the current board with "${preset.name}"?`)) return;

  mutate(() => {
    const next = new GraphEngine();
    const idByKey = {};
    for (const t of preset.tasks) idByKey[t.key] = next.addTask(t.title, t.duration).id;
    for (const t of preset.tasks) {
      for (const pk of t.after) next.addDependency(idByKey[pk], idByKey[t.key]);
    }
    engine = next;
  });
  selectedId = null;
  hasFit = false;
  showBanner(`Loaded "${preset.name}".`, 'ok');
  render();
});

// ---- toolbar -----------------------------------------------------

els.undoBtn.addEventListener('click', undo);
els.redoBtn.addEventListener('click', redo);

els.resetBtn.addEventListener('click', () => {
  if (!confirm('Clear the whole board? You can still undo this.')) return;
  mutate(() => { engine = new GraphEngine(); });
  selectedId = null;
  hasFit = false;
  els.bannerPanel.hidden = true;
  render();
});

document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'Escape') {
    selectedId = null;
    renderSelectionOnly();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

window.addEventListener('resize', () => { /* layout is independent of viewport size */ });

// ---- boot -----------------------------------------------------

render();
