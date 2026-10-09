// app.js
// ---------------------------------------------------------------------------
// UI controller. The ONLY file that touches the DOM. It never changes a
// task's status or edges itself: every change is a call into GraphEngine,
// which either accepts it (we re-render) or throws (we show the banner).
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dep-planner-v1';
const HISTORY_LIMIT = 100;

let engine = loadFromStorage() || new GraphEngine();

// Undo/redo keep serialized snapshots of the engine, taken before each
// successful mutation.
const undoStack = [];
const redoStack = [];

let showConnections = false;
let editingId = null;

const els = {
  presetSelect: document.getElementById('preset-select'),
  form: document.getElementById('add-task-form'),
  title: document.getElementById('task-title'),
  duration: document.getElementById('task-duration'),
  prereqs: document.getElementById('task-prereqs'),
  bannerPanel: document.getElementById('banner-panel'),
  banner: document.getElementById('banner'),
  diagDuration: document.getElementById('diag-duration'),
  diagPath: document.getElementById('diag-path'),
  diagRemaining: document.getElementById('diag-remaining'),
  diagCompletion: document.getElementById('diag-completion'),
  overridesPanel: document.getElementById('overrides-panel'),
  overridesList: document.getElementById('overrides-list'),
  resetBtn: document.getElementById('reset-btn'),
  undoBtn: document.getElementById('undo-btn'),
  redoBtn: document.getElementById('redo-btn'),
  toggleConnections: document.getElementById('toggle-connections'),
  board: document.getElementById('board'),
  overlay: document.getElementById('connections-overlay'),
  overrideDialog: document.getElementById('override-dialog'),
  overrideMessage: document.getElementById('override-message'),
  editDialog: document.getElementById('edit-dialog'),
  editForm: document.getElementById('edit-form'),
  editTitle: document.getElementById('edit-title'),
  editDuration: document.getElementById('edit-duration'),
  editPrereqs: document.getElementById('edit-prereqs'),
  editError: document.getElementById('edit-error'),
  inspectDialog: document.getElementById('inspect-dialog'),
  inspectTitle: document.getElementById('inspect-title'),
  inspectCpm: document.getElementById('inspect-cpm'),
  inspectLists: document.getElementById('inspect-lists'),
  contextMenu: document.getElementById('context-menu'),
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
    if (!raw) return null;
    return GraphEngine.fromJSON(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not restore saved board:', e);
    return null;
  }
}

// ---- undo / redo -----------------------------------------------------

function snapshot() {
  return JSON.stringify(engine.toJSON());
}

function restore(json) {
  engine = GraphEngine.fromJSON(JSON.parse(json));
}

/**
 * Runs `fn` as one undoable step. If `fn` throws, the engine is rolled
 * back to the pre-call snapshot and nothing is recorded, so a rejected
 * action never leaves a half-applied change or an empty undo entry.
 */
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

// ---- banner -----------------------------------------------------

function showBanner(message, kind /* 'ok' | 'error' */) {
  els.bannerPanel.hidden = false;
  els.banner.textContent = message;
  els.banner.className = kind;
}

// ---- rendering -----------------------------------------------------

function render() {
  renderPrereqOptions();
  renderDiagnostics();
  renderOverrides();
  renderBoard();
  renderConnections();
  els.undoBtn.disabled = !undoStack.length;
  els.redoBtn.disabled = !redoStack.length;
  els.toggleConnections.textContent = showConnections ? 'Hide dependency lines' : 'Show dependency lines';
  saveToStorage();
}

function renderPrereqOptions() {
  const selected = new Set([...els.prereqs.selectedOptions].map((o) => o.value));
  els.prereqs.innerHTML = '';
  for (const task of engine.tasks.values()) {
    const opt = document.createElement('option');
    opt.value = task.id;
    opt.textContent = `${task.title} (${fmt(task.duration)}d)`;
    opt.selected = selected.has(task.id);
    els.prereqs.appendChild(opt);
  }
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function renderDiagnostics() {
  const hasTasks = engine.tasks.size > 0;
  els.diagDuration.textContent = hasTasks ? `${fmt(engine.totalDuration)} days` : '—';
  els.diagRemaining.textContent = hasTasks ? `${fmt(engine.remainingDuration)} days` : '—';

  const titles = engine.getCriticalPathTitles();
  els.diagPath.textContent = titles.length ? titles.join(' → ') : '—';

  // Completion estimate = today + remaining project days. We don't invent a
  // project start date; this is simply "if work started now".
  if (!hasTasks) {
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
  if (!engine.overrides.length) {
    els.overridesPanel.hidden = true;
    return;
  }
  els.overridesPanel.hidden = false;
  els.overridesList.innerHTML = '';
  for (const o of engine.overrides) {
    const li = document.createElement('li');
    const when = new Date(o.timestamp).toLocaleTimeString();
    const parents = o.incompleteParents.length ? o.incompleteParents.join(', ') : 'none listed';
    li.textContent = `${when} — "${o.title}" force-completed while still waiting on: ${parents}`;
    els.overridesList.appendChild(li);
  }
}

function renderBoard() {
  const zones = {
    BLOCKED: els.board.querySelector('[data-dropzone="BLOCKED"]'),
    READY: els.board.querySelector('[data-dropzone="READY"]'),
    IN_PROGRESS: els.board.querySelector('[data-dropzone="IN_PROGRESS"]'),
    DONE: els.board.querySelector('[data-dropzone="DONE"]'),
  };
  for (const zone of Object.values(zones)) zone.innerHTML = '';
  for (const task of engine.tasks.values()) {
    zones[task.status].appendChild(renderCard(task));
  }
}

function renderCard(task) {
  const card = document.createElement('div');
  card.className = 'card' + (task.isCritical ? ' critical' : '');
  card.draggable = true;
  card.dataset.id = task.id;
  card.dataset.status = task.status;
  card.dataset.paused = String(!!task.manuallyPaused);

  const parentIds = [...engine.revAdj.get(task.id)];
  const childIds = [...engine.adj.get(task.id)];
  const waitingOn = parentIds.filter((p) => engine.tasks.get(p).status !== STATUS.DONE);

  card.innerHTML = `
    <div class="card-title">
      <span>${escapeHtml(task.title)}</span>
      <span class="card-duration">${fmt(task.duration)}d</span>
    </div>
    <div class="card-tags">
      ${parentIds.map((p) => `<span class="tag">after: ${escapeHtml(engine.tasks.get(p).title)}</span>`).join('')}
      ${task.isCritical ? '<span class="tag critical-tag">critical path</span>' : ''}
      ${task.overridden ? '<span class="tag override-tag">completed out of order</span>' : ''}
      ${task.manuallyPaused ? '<span class="tag paused-tag">manually blocked</span>' : ''}
    </div>
    <div class="badge-row">
      <button type="button" class="badge waiting${waitingOn.length ? '' : ' inactive'}" ${waitingOn.length ? '' : 'disabled'}>
        waiting on ${waitingOn.length}
      </button>
      <button type="button" class="badge unblocks${childIds.length ? '' : ' inactive'}" ${childIds.length ? '' : 'disabled'}>
        unblocks ${childIds.length}
      </button>
    </div>
    <div class="card-actions">
      <button type="button" data-action="inspect">Inspect</button>
      <button type="button" data-action="edit">Edit</button>
      <button type="button" data-action="delete">Delete</button>
    </div>
  `;

  // Drag: the card only carries its id. The engine decides legality on drop.
  card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', task.id));

  // Hover: highlight direct blockers (orange) or dependents (teal).
  card.addEventListener('mouseenter', () => setRelationHighlight(task.id));
  card.addEventListener('mouseleave', clearRelationHighlight);

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(task.id, e.clientX, e.clientY);
  });

  card.querySelector('[data-action="inspect"]').addEventListener('click', () => openInspect(task.id));
  card.querySelector('[data-action="edit"]').addEventListener('click', () => openEdit(task.id));
  card.querySelector('[data-action="delete"]').addEventListener('click', () => {
    const title = task.title;
    mutate(() => engine.deleteTask(task.id));
    showBanner(`Deleted "${title}".`, 'ok');
    render();
  });

  return card;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---- hover relationship highlighting -----------------------------------

function setRelationHighlight(id) {
  clearRelationHighlight();
  for (const p of engine.revAdj.get(id) || []) {
    els.board.querySelector(`.card[data-id="${p}"]`)?.classList.add('highlight-blocker');
  }
  for (const c of engine.adj.get(id) || []) {
    els.board.querySelector(`.card[data-id="${c}"]`)?.classList.add('highlight-downstream');
  }
}

function clearRelationHighlight() {
  for (const el of els.board.querySelectorAll('.highlight-blocker, .highlight-downstream')) {
    el.classList.remove('highlight-blocker', 'highlight-downstream');
  }
}

// ---- dependency lines (SVG overlay) -----------------------------------------

function renderConnections() {
  els.overlay.classList.toggle('visible', showConnections);
  els.overlay.innerHTML = '';
  if (!showConnections) return;

  const boardRect = els.board.getBoundingClientRect();
  els.overlay.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`);

  for (const [u, children] of engine.adj) {
    const from = els.board.querySelector(`.card[data-id="${u}"]`);
    if (!from) continue;
    for (const v of children) {
      const to = els.board.querySelector(`.card[data-id="${v}"]`);
      if (!to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const x1 = a.right - boardRect.left;
      const y1 = a.top + a.height / 2 - boardRect.top;
      const x2 = b.left - boardRect.left;
      const y2 = b.top + b.height / 2 - boardRect.top;
      const mid = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
      const onCritical = engine.tasks.get(u).isCritical && engine.tasks.get(v).isCritical;
      path.setAttribute('class', onCritical ? 'critical-edge' : 'normal-edge');
      els.overlay.appendChild(path);
    }
  }
}

window.addEventListener('resize', () => { if (showConnections) renderConnections(); });

els.toggleConnections.addEventListener('click', () => {
  showConnections = !showConnections;
  render();
});

// ---- context menu (right-click) -----------------------------------------

function openContextMenu(id, x, y) {
  const task = engine.tasks.get(id);
  const done = task.status === STATUS.DONE;
  const inProgress = task.status === STATUS.IN_PROGRESS;
  const hasOpenParents = engine.getInDegree(id) > 0;

  const items = [
    { label: 'Mark as Ready', action: 'ready', enabled: !done && !inProgress && !hasOpenParents && !task.manuallyPaused },
    { label: 'Mark as In progress', action: 'in-progress', enabled: !done && !inProgress && !hasOpenParents },
    { label: 'Mark as Done', action: 'done', enabled: !done },
    task.manuallyPaused
      ? { label: 'Unblock', action: 'resume', enabled: true }
      : { label: 'Mark as Blocked', action: 'pause', enabled: !done && !inProgress },
    { label: 'Edit…', action: 'edit', enabled: true },
    { label: 'Inspect…', action: 'inspect', enabled: true },
  ];

  els.contextMenu.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.disabled = !item.enabled;
    btn.addEventListener('click', () => {
      closeContextMenu();
      runContextAction(item.action, id);
    });
    li.appendChild(btn);
    els.contextMenu.appendChild(li);
  }

  els.contextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  els.contextMenu.style.top = Math.min(y, window.innerHeight - 260) + 'px';
  els.contextMenu.hidden = false;
}

function closeContextMenu() {
  els.contextMenu.hidden = true;
}

function runContextAction(action, id) {
  const task = engine.tasks.get(id);
  if (!task) return;
  if (action === 'edit') return openEdit(id);
  if (action === 'inspect') return openInspect(id);

  if (action === 'done') return attemptTransition(id, STATUS.DONE);
  if (action === 'ready') return attemptTransition(id, STATUS.READY);
  if (action === 'in-progress') return attemptTransition(id, STATUS.IN_PROGRESS);

  try {
    if (action === 'pause') {
      mutate(() => engine.pauseTask(id));
      showBanner(`"${task.title}" manually blocked.`, 'ok');
    } else if (action === 'resume') {
      mutate(() => engine.resumeTask(id));
      showBanner(`"${task.title}" unblocked.`, 'ok');
    }
    render();
  } catch (err) {
    showBanner(err.message, 'error');
    shakeCard(id);
  }
}

document.addEventListener('click', (e) => {
  if (!els.contextMenu.hidden && !els.contextMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

// ---- inspect dialog (CPM numbers + direct blockers/unblocks) -----------------

function openInspect(id) {
  const task = engine.tasks.get(id);
  if (!task) return;
  const c = task.cpm;
  const statusLabel = task.status.toLowerCase().replace('_', ' ');

  els.inspectTitle.textContent = task.title;
  els.inspectCpm.innerHTML = `
    <dt>Duration</dt><dd>${fmt(task.duration)} days</dd>
    <dt>Early start</dt><dd>${fmt(c.es)}</dd>
    <dt>Early finish</dt><dd>${fmt(c.ef)}</dd>
    <dt>Late start</dt><dd>${fmt(c.ls)}</dd>
    <dt>Late finish</dt><dd>${fmt(c.lf)}</dd>
    <dt>Slack</dt><dd>${fmt(c.slack)} days${task.isCritical ? ' (critical)' : ''}</dd>
    <dt>Status</dt><dd>${statusLabel}${task.manuallyPaused ? ' (manually blocked)' : ''}</dd>
  `;

  const list = (ids) => {
    if (!ids.length) return '<p class="hint">None</p>';
    return '<ul>' + ids.map((tid) => {
      const t = engine.tasks.get(tid);
      return `<li>${escapeHtml(t.title)} <span class="hint">(${t.status.toLowerCase().replace('_', ' ')})</span></li>`;
    }).join('') + '</ul>';
  };

  els.inspectLists.innerHTML = `
    <h3>Direct prerequisites</h3>${list([...engine.revAdj.get(id)])}
    <h3>Direct dependents</h3>${list([...engine.adj.get(id)])}
  `;
  els.inspectDialog.showModal();
}

// ---- edit dialog (title, duration, prerequisites) ------------------------------

function openEdit(id) {
  const task = engine.tasks.get(id);
  if (!task) return;
  editingId = id;
  els.editError.hidden = true;
  els.editTitle.value = task.title;
  els.editDuration.value = task.duration;

  const currentParents = new Set(engine.revAdj.get(id));
  els.editPrereqs.innerHTML = '';
  for (const t of engine.tasks.values()) {
    if (t.id === id) continue; // a task can never be its own prerequisite
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.title} (${fmt(t.duration)}d)`;
    opt.selected = currentParents.has(t.id);
    els.editPrereqs.appendChild(opt);
  }
  els.editDialog.showModal();
}

els.editForm.addEventListener('submit', (e) => {
  // Cancel uses method="dialog" and submits with value "cancel"; let it close.
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!els.editForm.reportValidity()) return;

  const desiredParents = [...els.editPrereqs.selectedOptions].map((o) => o.value);
  let rejected = [];
  try {
    mutate(() => {
      engine.updateTask(editingId, {
        title: els.editTitle.value,
        duration: els.editDuration.value,
      });
      rejected = engine.setPrerequisites(editingId, desiredParents);
    });
  } catch (err) {
    els.editError.textContent = err.message;
    els.editError.hidden = false;
    return; // keep dialog open so the user can fix the input
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
  // Also fires on Enter. reportValidity() stops incomplete input here.
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
    return; // keep the user's input so they can correct it
  }

  const title = engine.tasks.get(created.id).title;
  els.form.reset();
  els.duration.value = 1;

  const notes = [];
  if (created.duplicate) {
    notes.push(`Note: another task is already named "${title}" — tracked separately, since tasks are identified by id, not by title.`);
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
  const key = els.presetSelect.value;
  els.presetSelect.value = '';
  const preset = PRESETS[key];
  if (!preset) return;
  if (!confirm(`Replace the current board with "${preset.name}"?`)) return;

  mutate(() => {
    const next = new GraphEngine();
    const idByKey = {};
    for (const t of preset.tasks) idByKey[t.key] = next.addTask(t.title, t.duration).id;
    for (const t of preset.tasks) {
      for (const parentKey of t.after) next.addDependency(idByKey[parentKey], idByKey[t.key]);
    }
    engine = next;
  });
  showBanner(`Loaded "${preset.name}".`, 'ok');
  render();
});

// ---- drag and drop -----------------------------------------------------

for (const zone of els.board.querySelectorAll('.column-list')) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    attemptTransition(e.dataTransfer.getData('text/plain'), zone.dataset.dropzone);
  });
}

function attemptTransition(taskId, targetStatus, override = false) {
  const task = engine.tasks.get(taskId);
  if (!task) return;
  try {
    mutate(() => engine.transitionTask(taskId, targetStatus, { override }));
    showBanner(`"${task.title}" moved to ${targetStatus.replace('_', ' ').toLowerCase()}.`, 'ok');
    render();
  } catch (err) {
    if (err instanceof InvalidTransitionError && targetStatus === STATUS.DONE && !override) {
      promptOverride(task, err.message);
      return;
    }
    showBanner(err.message, 'error');
    shakeCard(taskId);
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
      shakeCard(task.id);
    }
  };
}

function shakeCard(taskId) {
  const card = els.board.querySelector(`.card[data-id="${taskId}"]`);
  if (!card) return;
  card.classList.add('shake');
  setTimeout(() => card.classList.remove('shake'), 320);
}

// ---- undo / redo / reset -----------------------------------------------------

els.undoBtn.addEventListener('click', undo);
els.redoBtn.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

els.resetBtn.addEventListener('click', () => {
  if (!confirm('Clear the whole board? You can still undo this.')) return;
  mutate(() => { engine = new GraphEngine(); });
  localStorage.removeItem(STORAGE_KEY);
  els.bannerPanel.hidden = true;
  render();
});

// ---- boot -----------------------------------------------------

render();
