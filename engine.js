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

// Input-validation rules for addTask(). These live on the engine (not just
// in the UI) so that *any* caller — the form, a future CLI, an import
// script, a test — gets the same guarantees. The UI (app.js) duplicates
// the cheap checks so it can give instant feedback, but the engine is the
// final authority and never trusts its caller.
const TITLE_PATTERN = /^[A-Za-z0-9 ]+$/; // letters, numbers, and spaces only
const MIN_DURATION = 0.5; // smallest allowed task size (half a day); rejects 0 and blank
const MAX_DURATION = 3650; // ~10 years — a generous ceiling to catch fat-finger numbers

class GraphEngine {
  constructor() {
    /** @type {Map<string, {id:string, title:string, duration:number, status:string, isCritical:boolean, overridden:boolean}>} */
    this.tasks = new Map();
    /** @type {Map<string, Set<string>>} u -> set of v, meaning "u must finish before v" */
    this.adj = new Map();
    /** @type {Map<string, Set<string>>} v -> set of u (reverse of adj) */
    this.revAdj = new Map();
    /** Log of every forced ("override") completion, newest first. */
    this.overrides = [];
    this._counter = 0;
    this.criticalPath = [];
    this.totalDuration = 0;
  }

  // ---- task lifecycle -----------------------------------------------------

  /**
   * addTask: validates the two raw inputs before anything else touches the
   * graph. Every one of the following is rejected with a ValidationError
   * (never silently coerced to some default):
   *   - empty / whitespace-only title
   *   - title containing anything other than letters, numbers, and spaces
   *   - duration left blank
   *   - duration that isn't a number at all (e.g. typed/pasted letters)
   *   - duration <= 0 (covers both "zero" and "negative")
   *   - duration above MAX_DURATION (catches an extra zero or two fat-fingered in)
   * A duplicate title (same text, different task) is NOT rejected — two
   * tasks are only ever "the same task" if they share an id, and ids are
   * generated here and never reused. The caller gets `duplicate: true`
   * back so the UI can surface a non-blocking notice instead of silently
   * merging two distinct tasks that happen to share a name.
   */
  addTask(title, duration) {
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) {
      throw new ValidationError('Task title cannot be empty.');
    }
    if (!TITLE_PATTERN.test(cleanTitle)) {
      throw new ValidationError('Task title may only contain letters, numbers, and spaces.');
    }

    if (duration === '' || duration === null || duration === undefined) {
      throw new ValidationError('Duration is required.');
    }
    const cleanDuration = Number(duration);
    if (Number.isNaN(cleanDuration)) {
      throw new ValidationError('Duration must be a number.');
    }
    if (cleanDuration <= 0) {
      throw new ValidationError('Duration must be greater than zero.');
    }
    if (cleanDuration > MAX_DURATION) {
      throw new ValidationError(`Duration is unreasonably large (max ${MAX_DURATION} days).`);
    }

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
    });
    this.adj.set(id, new Set());
    this.revAdj.set(id, new Set());
    this.recalculateStatuses();
    return { id, duplicate };
  }

  deleteTask(id) {
    if (!this.tasks.has(id)) return;
    // Edge case: cascade-clean every edge that touches this node before
    // dropping the node itself, so no dangling references remain.
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
   * Edge cases handled:
   *  - self-dependency (u === v) is rejected before any graph walk.
   *  - a duplicate edge is a harmless no-op.
   *  - an edge that would close a cycle (a path v -> ... -> u already
   *    exists) is rejected. Note a *transitive* edge like A->C, when
   *    A->B->C already exists, is NOT a cycle — it's accepted.
   */
  addDependency(u, v) {
    if (!this.tasks.has(u) || !this.tasks.has(v)) {
      throw new Error('Both tasks must exist before adding a dependency.');
    }
    if (u === v) {
      throw new SelfDependencyError('A task cannot depend on itself.');
    }
    if (this.adj.get(u).has(v)) return; // already linked, nothing to do

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

  // ---- status engine -----------------------------------------------------

  /** In-degree counts only *unfinished* prerequisites. */
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
   * or DONE (those are states a human explicitly put the task into).
   * A task with zero unfinished prerequisites — including a brand-new task
   * with no prerequisites at all — lands in READY "for free" here.
   */
  recalculateStatuses() {
    for (const task of this.tasks.values()) {
      if (task.status === STATUS.DONE || task.status === STATUS.IN_PROGRESS) continue;
      task.status = this.getInDegree(task.id) === 0 ? STATUS.READY : STATUS.BLOCKED;
    }
    this._computeCriticalPath();
  }

  /**
   * transitionTask: the single gatekeeper for every status change coming
   * from the UI (drag-and-drop or buttons).
   *   - READY / IN_PROGRESS are refused while in-degree > 0.
   *   - DONE is refused while in-degree > 0 UNLESS { override: true } is
   *     passed, in which case it's allowed but logged as an inconsistency.
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
      this.overrides.unshift({
        taskId: id,
        title: task.title,
        timestamp: Date.now(),
        incompleteParents,
      });
    }

    task.status = targetStatus;
    this.recalculateStatuses();
  }

  // ---- topological order & critical path -----------------------------------------------------

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
    return order; // length === tasks.size, since addDependency never allows a cycle in
  }

  /**
   * Longest-path-by-duration over the DAG, computed with one DP pass over
   * the topological order: dist[v] = v.duration + max(dist[u] for u -> v).
   * The task with the largest dist[] is the end of the critical path.
   */
  _computeCriticalPath() {
    const order = this.getTopologicalSort();
    const dist = new Map();
    const prev = new Map();

    for (const id of order) {
      const task = this.tasks.get(id);
      let best = task.duration;
      let bestPrev = null;
      for (const p of this.revAdj.get(id)) {
        const candidate = dist.get(p) + task.duration;
        if (candidate > best) {
          best = candidate;
          bestPrev = p;
        }
      }
      dist.set(id, best);
      prev.set(id, bestPrev);
    }

    let endId = null;
    let maxDist = -Infinity;
    for (const [id, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        endId = id;
      }
    }

    const path = [];
    let cur = endId;
    while (cur !== null && cur !== undefined) {
      path.push(cur);
      cur = prev.get(cur);
    }
    path.reverse();

    const criticalSet = new Set(path);
    for (const task of this.tasks.values()) task.isCritical = criticalSet.has(task.id);

    this.criticalPath = path;
    this.totalDuration = this.tasks.size ? maxDist : 0;
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
