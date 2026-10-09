// engine.js
// ---------------------------------------------------------------------------
// GraphEngine: pure JavaScript. No DOM access anywhere in this file.
// The UI (app.js) only ever calls methods on an instance of this class and
// reads its state back out — it never mutates tasks/edges directly.
// ---------------------------------------------------------------------------

class CycleError extends Error {}
class SelfDependencyError extends Error {}
class InvalidTransitionError extends Error {}
class ValidationError extends Error {}

const STATUS = {
  BLOCKED: 'BLOCKED',
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
};

// Input-validation rules for addTask()/updateTask(). These live on the
// engine (not just in the UI) so that *any* caller — the form, the edit
// dialog, a future import script, a test — gets the same guarantees.
const TITLE_PATTERN = /^[A-Za-z0-9 ]+$/; // letters, numbers, and spaces only
const MIN_DURATION = 0.5; // smallest allowed task size (half a day); rejects 0 and blank
const MAX_DURATION = 3650; // ~10 years — a generous ceiling to catch fat-finger numbers

class GraphEngine {
  constructor() {
    /** @type {Map<string, Task>} */
    this.tasks = new Map();
    /** @type {Map<string, Set<string>>} u -> set of v, meaning "u must finish before v" */
    this.adj = new Map();
    /** @type {Map<string, Set<string>>} v -> set of u (reverse of adj) */
    this.revAdj = new Map();
    /** Log of every forced ("override") completion, newest first. */
    this.overrides = [];
    this._counter = 0;
    this.criticalPath = [];
    this.totalDuration = 0; // CPM "planned" project duration (uses full durations)
    this.remainingDuration = 0; // CPM duration if DONE tasks count as 0 — "how much is left"
  }

  // ---- shared validation helpers -----------------------------------------------------

  _validateTitle(title) {
    const clean = typeof title === 'string' ? title.trim() : '';
    if (!clean) throw new ValidationError('Task title cannot be empty.');
    if (!TITLE_PATTERN.test(clean)) {
      throw new ValidationError('Task title may only contain letters, numbers, and spaces.');
    }
    return clean;
  }

  _validateDuration(duration) {
    if (duration === '' || duration === null || duration === undefined) {
      throw new ValidationError('Duration is required.');
    }
    const clean = Number(duration);
    if (Number.isNaN(clean)) throw new ValidationError('Duration must be a number.');
    if (clean <= 0) throw new ValidationError('Duration must be greater than zero.');
    if (clean > MAX_DURATION) {
      throw new ValidationError(`Duration is unreasonably large (max ${MAX_DURATION} days).`);
    }
    return clean;
  }

  // ---- task lifecycle -----------------------------------------------------

  /**
   * addTask: validates both raw inputs before anything touches the graph.
   * A duplicate title (same text, different task) is NOT rejected — two
   * tasks are only "the same task" if they share an id, and ids are
   * generated here and never reused. The caller gets `duplicate: true`
   * back so the UI can surface a non-blocking notice.
   */
  addTask(title, duration) {
    const cleanTitle = this._validateTitle(title);
    const cleanDuration = this._validateDuration(duration);

    const duplicate = [...this.tasks.values()].some(
      (t) => t.title.toLowerCase() === cleanTitle.toLowerCase()
    );

    const id = 't' + ++this._counter;
    this.tasks.set(id, {
      id,
      title: cleanTitle,
      duration: cleanDuration,
      status: STATUS.BLOCKED, // recalculated immediately below
      isCritical: false,
      overridden: false,
      manuallyPaused: false,
      cpm: { es: 0, ef: 0, ls: 0, lf: 0, slack: 0 },
    });
    this.adj.set(id, new Set());
    this.revAdj.set(id, new Set());
    this.recalculateStatuses();
    return { id, duplicate };
  }

  /** Edits a task's title and/or duration in place. Same validation as addTask. */
  updateTask(id, { title, duration } = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task id: ' + id);
    if (title !== undefined) task.title = this._validateTitle(title);
    if (duration !== undefined) task.duration = this._validateDuration(duration);
    this.recalculateStatuses(); // duration changes ripple through CPM immediately
  }

  deleteTask(id) {
    if (!this.tasks.has(id)) return;
    for (const child of this.adj.get(id)) this.revAdj.get(child).delete(id);
    for (const parent of this.revAdj.get(id)) this.adj.get(parent).delete(id);
    this.adj.delete(id);
    this.revAdj.delete(id);
    this.tasks.delete(id);
    this.recalculateStatuses();
  }

  // ---- dependency edges -----------------------------------------------------

  /** DFS reachability: can you walk forward from `from` and reach `to`? */
  hasPath(from, to) {
    if (!this.adj.has(from) || !this.tasks.has(to)) return false;
    if (from === to) return true;
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const node = stack.pop();
      for (const next of this.adj.get(node)) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  /**
   * addDependency(u, v): "u must finish before v" (edge u -> v).
   * Self-dependency is rejected before any graph walk. A duplicate edge is
   * a harmless no-op. An edge that would close a cycle (hasPath(v, u) is
   * already true) is rejected — note a *transitive* edge like A->C, when
   * A->B->C already exists, is NOT a cycle and is accepted.
   */
  addDependency(u, v) {
    if (!this.tasks.has(u) || !this.tasks.has(v)) {
      throw new Error('Both tasks must exist before adding a dependency.');
    }
    if (u === v) throw new SelfDependencyError('A task cannot depend on itself.');
    if (this.adj.get(u).has(v)) return;

    if (this.hasPath(v, u)) {
      throw new CycleError(
        `Cannot add "${this.tasks.get(u).title}" -> "${this.tasks.get(v).title}": ` +
        `a path already exists from "${this.tasks.get(v).title}" back to "${this.tasks.get(u).title}", ` +
        `so this edge would create a cycle.`
      );
    }
    this.adj.get(u).add(v);
    this.revAdj.get(v).add(u);
    this.recalculateStatuses();
  }

  removeDependency(u, v) {
    if (!this.adj.has(u)) return;
    this.adj.get(u).delete(v);
    this.revAdj.get(v)?.delete(u);
    this.recalculateStatuses();
  }

  /**
   * Replaces task `id`'s full set of direct prerequisites with
   * `desiredParentIds` in one go (used by the card-edit dialog). Diffs
   * against the current parents: removals are applied unconditionally,
   * additions are validated one at a time so one bad edge (self-dep,
   * cycle) doesn't block the rest. Returns the list of rejection messages,
   * if any — removals and the valid additions still take effect.
   */
  setPrerequisites(id, desiredParentIds) {
    if (!this.tasks.has(id)) throw new Error('Unknown task id: ' + id);
    const current = new Set(this.revAdj.get(id));
    const desired = new Set(desiredParentIds);

    for (const p of current) {
      if (!desired.has(p)) this.removeDependency(p, id);
    }
    const rejected = [];
    for (const p of desired) {
      if (!current.has(p)) {
        try {
          this.addDependency(p, id);
        } catch (err) {
          rejected.push(err.message);
        }
      }
    }
    return rejected;
  }

  // ---- manual pause (right-click "Mark as Blocked" / "Unblock") -----------------------------------------------------

  /**
   * Manually forces a task back to BLOCKED even if its dependencies are
   * satisfied — e.g. "we're ready to start but waiting on a teammate".
   * This is tracked separately from the automatic BLOCKED/READY rule via
   * `manuallyPaused`, so it survives recalculateStatuses() until resumed.
   * Not allowed once a task is already IN_PROGRESS or DONE.
   */
  pauseTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task id: ' + id);
    if (task.status === STATUS.IN_PROGRESS || task.status === STATUS.DONE) {
      throw new InvalidTransitionError(`Cannot manually block "${task.title}" — it's already ${task.status.toLowerCase().replace('_', ' ')}.`);
    }
    task.manuallyPaused = true;
    this.recalculateStatuses();
  }

  resumeTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task id: ' + id);
    task.manuallyPaused = false;
    this.recalculateStatuses();
  }

  // ---- status engine -----------------------------------------------------

  /** In-degree counts only *unfinished* direct prerequisites. */
  getInDegree(id) {
    const parents = this.revAdj.get(id);
    if (!parents) return 0;
    let n = 0;
    for (const p of parents) {
      if (this.tasks.get(p).status !== STATUS.DONE) n++;
    }
    return n;
  }

  /**
   * Re-derives BLOCKED/READY for every task that isn't already IN_PROGRESS
   * or DONE (those are states a human explicitly put the task into). A
   * manually-paused task is pinned to BLOCKED regardless of in-degree,
   * until resumeTask() clears the flag. A brand-new task with no
   * prerequisites lands in READY "for free" here.
   */
  recalculateStatuses() {
    for (const task of this.tasks.values()) {
      if (task.status === STATUS.DONE || task.status === STATUS.IN_PROGRESS) continue;
      if (task.manuallyPaused) {
        task.status = STATUS.BLOCKED;
        continue;
      }
      task.status = this.getInDegree(task.id) === 0 ? STATUS.READY : STATUS.BLOCKED;
    }
    this._computeCPM();
  }

  /**
   * transitionTask: the single gatekeeper for every status change coming
   * from the UI (drag-and-drop or buttons).
   *   - READY / IN_PROGRESS are refused while in-degree > 0.
   *   - DONE is refused while in-degree > 0 UNLESS { override: true } is
   *     passed, in which case it's allowed but logged as an inconsistency.
   * Moving a task back to BLOCKED by hand goes through pauseTask(),
   * not here, so that the manual-pause flag stays consistent.
   */
  transitionTask(id, targetStatus, { override = false } = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task id: ' + id);
    const blocked = this.getInDegree(id) > 0;

    if ((targetStatus === STATUS.READY || targetStatus === STATUS.IN_PROGRESS) && blocked) {
      throw new InvalidTransitionError(
        `Cannot start "${task.title}": blocked by unfinished dependencies.`
      );
    }

    if (targetStatus === STATUS.DONE && blocked) {
      if (!override) {
        throw new InvalidTransitionError(
          `"${task.title}" still has unfinished prerequisites. Completing it now would be inconsistent — pass override to force it.`
        );
      }
      const incompleteParents = [...this.revAdj.get(id)]
        .filter((p) => this.tasks.get(p).status !== STATUS.DONE)
        .map((p) => this.tasks.get(p).title);
      task.overridden = true;
      this.overrides.unshift({ taskId: id, title: task.title, timestamp: Date.now(), incompleteParents });
    }

    if (targetStatus !== STATUS.BLOCKED) task.manuallyPaused = false; // leaving BLOCKED clears any manual pause
    task.status = targetStatus;
    this.recalculateStatuses();
  }

  // ---- topological order -----------------------------------------------------

  /** Kahn's algorithm. Returns ids in a valid topological order. */
  getTopologicalSort() {
    const inDeg = new Map();
    for (const id of this.tasks.keys()) inDeg.set(id, this.revAdj.get(id).size);
    const queue = [...this.tasks.keys()].filter((id) => inDeg.get(id) === 0);
    const order = [];
    while (queue.length) {
      const n = queue.shift();
      order.push(n);
      for (const m of this.adj.get(n)) {
        inDeg.set(m, inDeg.get(m) - 1);
        if (inDeg.get(m) === 0) queue.push(m);
      }
    }
    return order; // length === tasks.size, since addDependency never lets a cycle in
  }

  // ---- Critical Path Method (CPM) -----------------------------------------------------

  /**
   * Full forward/backward CPM pass:
   *   ES[v] = max(EF[u]) over direct parents u, or 0 if v has none
   *   EF[v] = ES[v] + duration[v]
   *   LF[v] = min(LS[w]) over direct children w, or project duration if none
   *   LS[v] = LF[v] - duration[v]
   *   slack[v] = LS[v] - ES[v]  (equivalently LF[v] - EF[v])
   * Any task with slack 0 is on a/the critical path — note a diamond-
   * shaped graph can have two equal-length parallel critical paths, and
   * both get marked, not just one arbitrarily chosen branch.
   *
   * Runs twice: once with every task's full duration (the traditional,
   * status-independent "planned" CPM — this drives `isCritical` styling
   * and the on-card ES/EF/LS/LF/slack numbers), and once treating DONE
   * tasks as taking 0 time (the "remaining" CPM — just a single number,
   * `remainingDuration`, used for the live completion-date estimate).
   */
  _computeCPM() {
    const order = this.getTopologicalSort();

    // --- planned pass (full durations; drives per-task CPM + isCritical) ---
    const ES = new Map(), EF = new Map(), prevOnPath = new Map();
    for (const id of order) {
      const task = this.tasks.get(id);
      let es = 0, bestPrev = null;
      for (const p of this.revAdj.get(id)) {
        const efP = EF.get(p);
        if (efP > es) { es = efP; bestPrev = p; }
      }
      ES.set(id, es);
      EF.set(id, es + task.duration);
      prevOnPath.set(id, bestPrev);
    }
    const plannedDuration = order.length ? Math.max(...order.map((id) => EF.get(id))) : 0;

    const LS = new Map(), LF = new Map();
    for (const id of [...order].reverse()) {
      const task = this.tasks.get(id);
      const children = this.adj.get(id);
      const lf = children.size ? Math.min(...[...children].map((c) => LS.get(c))) : plannedDuration;
      LF.set(id, lf);
      LS.set(id, lf - task.duration);
    }

    let endId = null, maxEF = -Infinity;
    for (const id of order) {
      const task = this.tasks.get(id);
      const slack = LS.get(id) - ES.get(id);
      task.cpm = { es: ES.get(id), ef: EF.get(id), ls: LS.get(id), lf: LF.get(id), slack };
      task.isCritical = Math.abs(slack) < 1e-9;
      if (EF.get(id) > maxEF) { maxEF = EF.get(id); endId = id; }
    }

    const path = [];
    let cur = endId;
    while (cur !== null && cur !== undefined) {
      path.push(cur);
      cur = prevOnPath.get(cur);
    }
    path.reverse();
    this.criticalPath = path;
    this.totalDuration = order.length ? plannedDuration : 0;

    // --- remaining pass (DONE tasks cost 0 — "how much is left from here") ---
    const remEF = new Map();
    for (const id of order) {
      const task = this.tasks.get(id);
      const effectiveDuration = task.status === STATUS.DONE ? 0 : task.duration;
      let es = 0;
      for (const p of this.revAdj.get(id)) es = Math.max(es, remEF.get(p));
      remEF.set(id, es + effectiveDuration);
    }
    this.remainingDuration = order.length ? Math.max(...order.map((id) => remEF.get(id))) : 0;
  }

  getCriticalPathTitles() {
    return this.criticalPath.map((id) => this.tasks.get(id).title);
  }

  // ---- persistence -----------------------------------------------------

  toJSON() {
    return {
      counter: this._counter,
      tasks: [...this.tasks.values()],
      edges: [...this.adj.entries()].flatMap(([u, vs]) => [...vs].map((v) => [u, v])),
      overrides: this.overrides,
    };
  }

  static fromJSON(data) {
    const engine = new GraphEngine();
    if (!data) return engine;
    engine._counter = data.counter || 0;
    for (const t of data.tasks || []) {
      engine.tasks.set(t.id, { ...t });
      engine.adj.set(t.id, new Set());
      engine.revAdj.set(t.id, new Set());
    }
    for (const [u, v] of data.edges || []) {
      engine.adj.get(u)?.add(v);
      engine.revAdj.get(v)?.add(u);
    }
    engine.overrides = data.overrides || [];
    engine.recalculateStatuses();
    return engine;
  }
}
