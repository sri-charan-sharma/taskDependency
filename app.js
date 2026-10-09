// app.js
// ---------------------------------------------------------------------------
// UI controller. This file is the ONLY place that touches the DOM.
// It never flips a task's status itself — every change goes through
// engine.addTask / engine.addDependency / engine.transitionTask, and the
// engine either accepts it (we re-render) or throws (we show the banner
// and, for drags, shake the card).
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dep-planner-v1';

let engine = loadFromStorage() || new GraphEngine();

const els = {
  form: document.getElementById('add-task-form'),
  title: document.getElementById('task-title'),
  duration: document.getElementById('task-duration'),
  prereqs: document.getElementById('task-prereqs'),
  bannerPanel: document.getElementById('banner-panel'),
  banner: document.getElementById('banner'),
  diagDuration: document.getElementById('diag-duration'),
  diagPath: document.getElementById('diag-path'),
  overridesPanel: document.getElementById('overrides-panel'),
  overridesList: document.getElementById('overrides-list'),
  resetBtn: document.getElementById('reset-btn'),
  board: document.getElementById('board'),
  overrideDialog: document.getElementById('override-dialog'),
  overrideMessage: document.getElementById('override-message'),
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
  saveToStorage();
}

function renderPrereqOptions() {
  const selected = new Set([...els.prereqs.selectedOptions].map((o) => o.value));
  els.prereqs.innerHTML = '';
  for (const task of engine.tasks.values()) {
    const opt = document.createElement('option');
    opt.value = task.id;
    opt.textContent = `${task.title} (${task.duration}d)`;
    opt.selected = selected.has(task.id);
    els.prereqs.appendChild(opt);
  }
}

function renderDiagnostics() {
  els.diagDuration.textContent = engine.tasks.size ? `${engine.totalDuration} days` : '—';
  const titles = engine.getCriticalPathTitles();
  els.diagPath.textContent = titles.length ? titles.join(' → ') : '—';
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

  const prereqTitles = [...engine.revAdj.get(task.id)].map((id) => engine.tasks.get(id).title);

  card.innerHTML = `
    <div class="card-title">
      <span>${escapeHtml(task.title)}</span>
      <span class="card-duration">${task.duration}d</span>
    </div>
    <div class="card-tags">
      ${prereqTitles.map((t) => `<span class="tag">after: ${escapeHtml(t)}</span>`).join('')}
      ${task.isCritical ? '<span class="tag critical-tag">critical path</span>' : ''}
      ${task.overridden ? '<span class="tag override-tag">completed out of order</span>' : ''}
    </div>
    <div class="card-actions">
      <button type="button" data-action="delete">Delete</button>
    </div>
  `;

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', task.id);
  });

  card.querySelector('[data-action="delete"]').addEventListener('click', () => {
    engine.deleteTask(task.id);
    showBanner(`Deleted "${task.title}".`, 'ok');
    render();
  });

  return card;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---- add-task form -----------------------------------------------------

els.form.addEventListener('submit', (e) => {
  // Always prevent default first: this is also what fires when the user
  // presses Enter inside the form. If required/pattern fields are still
  // invalid at that point, reportValidity() surfaces the browser's own
  // inline message (pointing at the first bad field) and we stop — no
  // task is created from an incomplete form, whether submitted by click
  // or by Enter.
  e.preventDefault();
  if (!els.form.reportValidity()) return;

  const rawTitle = els.title.value; // engine trims + validates this itself
  const rawDuration = els.duration.value; // may be '' if cleared after typing
  // selectedOptions preserves the order the <option> elements were
  // rendered in, not click order — fine here since a dependency edge
  // doesn't care what order it was selected in, only that it's a valid
  // edge. Multiple prerequisites are simply added one at a time below.
  const prereqIds = [...els.prereqs.selectedOptions].map((o) => o.value);

  let created;
  try {
    created = engine.addTask(rawTitle, rawDuration);
  } catch (err) {
    // Covers: empty title, non letters/numbers/spaces title, blank
    // duration, non-numeric duration, zero/negative duration, and
    // duration over the sanity cap.
    showBanner(err.message, 'error');
    return; // form is left exactly as the user had it, for correcting
  }

  const { id, duplicate } = created;

  // Wire up every selected prerequisite; each edge is independently
  // validated so one bad edge doesn't silently drop the rest.
  const rejected = [];
  for (const pid of prereqIds) {
    try {
      engine.addDependency(pid, id);
    } catch (err) {
      rejected.push(err.message);
    }
  }

  const title = engine.tasks.get(id).title;
  els.form.reset();
  els.duration.value = 1;

  const notes = [];
  if (duplicate) {
    notes.push(`Note: another task is already named "${title}" — tracked separately, since tasks are identified by id, not by title.`);
  }
  if (rejected.length) {
    notes.push(...rejected);
  }

  if (notes.length) {
    showBanner(`Added "${title}". ${notes.join(' ')}`, rejected.length ? 'error' : 'ok');
  } else {
    showBanner(`Added "${title}".`, 'ok');
  }
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
    const taskId = e.dataTransfer.getData('text/plain');
    const targetStatus = zone.dataset.dropzone;
    attemptTransition(taskId, targetStatus);
  });
}

function attemptTransition(taskId, targetStatus, override = false) {
  const task = engine.tasks.get(taskId);
  try {
    engine.transitionTask(taskId, targetStatus, { override });
    showBanner(`"${task.title}" moved to ${targetStatus.replace('_', ' ').toLowerCase()}.`, 'ok');
    render();
  } catch (err) {
    if (err instanceof InvalidTransitionError && targetStatus === 'DONE' && !override) {
      // This is the one case where we don't just refuse outright: offer
      // the deliberate override path instead, per the spec's edge case.
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
      attemptTransition(task.id, 'DONE', true);
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

// ---- reset -----------------------------------------------------

els.resetBtn.addEventListener('click', () => {
  if (!confirm('Clear the whole board? This cannot be undone.')) return;
  engine = new GraphEngine();
  localStorage.removeItem(STORAGE_KEY);
  els.bannerPanel.hidden = true;
  render();
});

// ---- boot -----------------------------------------------------

render();
