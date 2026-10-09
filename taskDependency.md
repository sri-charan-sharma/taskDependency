# Dependency-Aware Project Planner: Architecture & Implementation Spec

## 1. Project Overview & System Philosophy
A client-side project execution board written in vanilla HTML, CSS, and JavaScript. 
The application acts as a strict execution engine over an in-memory Directed Acyclic Graph (DAG), treating project tasks as vertices and dependencies as directed edges ($u \to v$ means $u$ must finish before $v$ can start).

Strict architectural rule: **Decouple the graph engine from the DOM/UI layer entirely.** The UI never modifies task state directly; it issues commands to the `GraphEngine`, which enforces graph invariants and emits updated state to the UI.

---

## 2. Core Invariants & Rules
1. **Cycle Prevention:** Adding edge $u \to v$ is strictly prohibited if a directed path already exists from $v \to u$.
2. **Execution Gatekeeper:** 
   - A task with active/uncompleted prerequisites cannot enter `READY` or `IN_PROGRESS`.
   - In-degree of an uncompleted node = number of prerequisites not in `DONE` status.
   - A task transitions to `READY` if and only if its active in-degree reaches `0`.
3. **Critical Path Guarantee:** Evaluated via Dynamic Programming over a Topological Ordering ($O(V + E)$). The critical path determines the lower-bound project duration.

---

## 3. Implementation Workflow

### Phase 1: In-Memory `GraphEngine` (Pure JS, Zero DOM)
Build a standalone ES6 class `GraphEngine` encapsulating all graph mathematics and state.

#### Data Structures:
- `tasks`: `Map<string, Task>` where each task has `{ id, title, duration, status }`.
- `adj`: `Map<string, Set<string>>` (Adjacency list for outgoing edges: $u \to v$).
- `revAdj`: `Map<string, Set<string>>` (Reverse adjacency list for incoming edges: $v \to u$).
- `status`: Enum (`'BLOCKED' | 'READY' | 'IN_PROGRESS' | 'DONE'`).

#### Core Methods:
1. `addTask(id, title, duration)`
2. `hasPath(from, to)`: DFS reachability check to prevent cycles before edge insertion.
3. `addDependency(u, v)`: Checks `hasPath(v, u)`. If true, throws `CycleError`. Otherwise, adds edge $u \to v$.
4. `getInDegree(nodeId)`: Returns count of parents not in `'DONE'` status.
5. `recalculateStatuses()`:
   - For all tasks not `'DONE'`: if `getInDegree(id) === 0` $\to$ status is `'READY'`, else status is `'BLOCKED'`.
6. `transitionTask(id, targetStatus)`:
   - Rejects transition to `'READY'` or `'IN_PROGRESS'` if `getInDegree(id) > 0`.
   - When set to `'DONE'`, triggers `recalculateStatuses()` to unlock downstream nodes.
7. `getTopologicalSort()`: Kahn’s Algorithm or DFS post-order reversal.
8. `getCriticalPath()`:
   - Let `dist[node] = node.duration`.
   - Process in topological order: for each edge $u \to v$, `dist[v] = max(dist[v], dist[u] + v.duration)`.
   - Max value in `dist` is total project duration; backtrack to construct critical path nodes.

---

### Phase 2: HTML Shell & Minimal CSS Layout
Set up a lean single-page UI without framework bloat.

- **Controls:** Input fields for task name, duration, multi-select / dropdown for prerequisites, and an "Add Task" button.
- **Diagnostics Panel:** Live readouts for:
  - Total Estimated Project Duration (days)
  - Critical Path sequence ($A \to B \to C$)
  - Error/Warning banner (e.g., cycle rejection, illegal move attempt).
- **Kanban Grid:** 4 columns with data attributes:
  - `col-BLOCKED` (`data-status="BLOCKED"`)
  - `col-READY` (`data-status="READY"`)
  - `col-IN_PROGRESS` (`data-status="IN_PROGRESS"`)
  - `col-DONE` (`data-status="DONE"`)
- **CSS Essentials:**
  - CSS Grid for the 4-column layout.
  - Status indicator badges and distinct left-border accents.
  - Dashed red border or glowing badge for tasks flagged `isCritical = true`.

---

### Phase 3: DOM Rendering & State Sync
Create the UI controller bridging `GraphEngine` to the DOM.

- Function `render()`:
  - Clears column task lists.
  - Pulls tasks and critical path from `GraphEngine`.
  - Generates task cards with: title, duration, dependency tags (badges showing prerequisite titles).
  - Populates each card into its matching status column.
  - Updates the top diagnostics banner with latest Critical Path metrics.
  - Refreshes the prerequisite `<select>` dropdown so new tasks can reference existing ones.

---

### Phase 4: HTML5 Drag-and-Drop & Move Interceptor
Implement Kanban interaction while enforcing graph invariants at drop time.

1. Cards marked `draggable="true"`.
2. `dragstart` attaches the task `id` to `event.dataTransfer`.
3. Columns handle `dragover` (`e.preventDefault()`).
4. Column `drop` handler:
   - Reads target status from `column.dataset.status`.
   - Calls `engine.transitionTask(taskId, targetStatus)`.
   - **If Engine rejects:** Trigger visual error shake animation on the card and show banner: *"Cannot start: Blocked by unfinished dependencies."*
   - **If Engine accepts:** Call `render()` to sync state and update dependent downstream cards.

---

### Phase 5: Persistence & Edge Cases
1. `localStorage` Sync: Serialize graph adjacency lists and task states to JSON on every mutation; rehydrate on page load.
2. Self-Dependency Guard: Reject adding task as its own prerequisite.
3. Node Deletion: Cleanly remove task from `adj`, `revAdj`, and cascade status recalculation.

---

## 4. Acceptance Criteria & Test Scenarios

- [ ] **Linear Chain:** Add A (2d) $\to$ B (3d) $\to$ C (5d). Total duration = 10d. A is `READY`, B and C are `BLOCKED`.
- [ ] **Auto-Unlock:** Marking A as `DONE` flips B to `READY`. C remains `BLOCKED`.
- [ ] **Cycle Rejection:** Attempting to make A depend on C triggers a cycle error and is aborted.
- [ ] **Illegal Drag Attempt:** Dragging C directly to `IN_PROGRESS` fails and resets position.
- [ ] **Parallel Critical Path:** 
  - Path 1: A (2d) $\to$ B (10d) $\to$ D (2d)
  - Path 2: A (2d) $\to$ C (3d) $\to$ D (2d)
  - Critical path must highlight: `A → B → D` (14 days total).

---

## 5. Edge Cases & Clarifications

- [ ] **Self-dependency:** `addDependency(u, u)` is rejected immediately — a task is never checked for a path to itself for this; it's a hard `id === id` guard before any graph traversal happens.

- [ ] **Multi-hop cycle detection:** `hasPath(v, u)` is a general DFS, not a check limited to direct neighbors, so it also catches cycles that only appear after several hops — e.g. edges A→B, B→C, then adding C→A is rejected because `hasPath(A, C)` already holds through B.

  > **Clarification on the example given:** edges A→B, B→C, **and** A→C is *not* a cycle — it's a valid DAG with a redundant (transitive) edge. You can still order the tasks A, B, C and nothing points backward. A cycle needs an edge that closes a loop, e.g. C→A (not A→C). The engine will accept A→C (it's just an extra direct dependency that B→C already implied) and will only throw `CycleError` on the edge that actually closes a loop.

- [ ] **No prerequisites:** a freshly added task with zero incoming edges has in-degree 0 and is placed directly into `READY` the moment `recalculateStatuses()` runs — no explicit "is this a root node" branch is needed, it falls out of the in-degree rule for free.

- [ ] **Forced/override completion:** marking a task `DONE` while `getInDegree(id) > 0` is rejected by default. The engine supports an explicit `{ override: true }` flag on `transitionTask`. When used:
  - The transition is allowed.
  - An entry is appended to an `overrides` log: `{ taskId, title, timestamp, incompleteParents }`.
  - The UI shows a persistent warning badge on that task ("Completed out of order") and lists override events in the diagnostics panel, so the inconsistency is visible rather than silently accepted.

- [ ] **Same idea, same framework, same output?** Two developers independently building this exact spec in vanilla HTML/CSS/JS will **not** necessarily produce byte-identical apps, but they should converge on the same *observable workflow* if both correctly implement the invariants in §2, because:
  - The **graph math is deterministic** — in-degree, reachability, topological order (up to tie-breaking), and critical-path length are fully determined by the task durations and edges, not by implementation choices.
  - What *can* differ between two correct implementations: tie-breaking when multiple critical paths have equal length, the exact ordering of tasks within a Kanban column, variable/class naming, and visual styling.
  - What must **not** differ, if both implementations are correct: whether a given drag-and-drop move is accepted or rejected, which tasks are `READY` vs `BLOCKED` at any point, the total project duration, and whether a given edge is rejected as a cycle.
  - In short: same inputs + same invariants ⇒ same *decisions*, but not necessarily the same *code* or *pixel layout*.

- [ ] **Input validation (the "Add task" form):** `addTask(title, duration)` is the single entry point for new tasks, so every one of these is rejected *there* — not just hinted at via HTML `required`/`pattern` attributes — so the rule holds no matter what calls it:
  - **Empty title** (or whitespace-only, e.g. `"   "`) → rejected: `"Task title cannot be empty."`
  - **Title with anything other than letters, numbers, and spaces** (e.g. `"Design-Schema!"`) → rejected: `"Task title may only contain letters, numbers, and spaces."` Spaces are allowed alongside the "letters and numbers" rule so multi-word titles like `"Design schema"` still work.
  - **Same task name as an existing task ("same task names"):** allowed, not rejected — two tasks are only ever "the same task" if they share an `id`, and `id`s are engine-generated and never reused, so a same-named task is simply a second, independent task. The UI shows a non-blocking note instead of silently merging them. ("Same id" for two different tasks cannot happen by construction — see `addTask`'s id generation.)
  - **Duration left blank** → rejected: `"Duration is required."`
  - **Duration typed as characters** (e.g. `"abc"`) → rejected: `"Duration must be a number."`
  - **Duration is zero** → rejected: `"Duration must be greater than zero."` (a task that takes 0 days doesn't need to exist as a scheduling unit)
  - **Duration is negative** → rejected, same message as above.
  - **Duration is an extremely large number** (e.g. `999999`) → rejected: `"Duration is unreasonably large (max 3650 days)."` — a sanity ceiling (~10 years) catches fat-fingered extra zeros.
  - **Multiple prerequisites selected** → fully supported; each selected prerequisite is wired up as its own independent edge (via the multi-select), so a task can have any number of parents, and in-degree correctly counts however many of them are still unfinished.
  - **Enter pressed while the form is incomplete** → the browser's native constraint validation (via `required`/`pattern` on the inputs) blocks the `submit` event from firing at all in the common case; as a second layer, the handler also calls `reportValidity()` and exits before touching the engine if anything is still invalid — so no task is ever created from an incomplete submission, whether triggered by click or by Enter.