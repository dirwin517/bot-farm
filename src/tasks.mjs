// Tasks are the primitive. A pipeline is a recipe that emits them.
//
// That is the whole architectural bet here. If stages were their own thing,
// the QA bot finding an unrelated defect would have nowhere to put it, and a
// "pipeline" would only ever be a straight line. Because every stage is just
// a task with dependencies, the board can hold pipeline work and ad-hoc work
// side by side, work can fan out in parallel, and a late defect is simply a
// new task that blocks an existing one.

export const COLUMNS = ["backlog", "blocked", "waiting", "queued", "active", "review", "done", "cancelled"]

let seq = 0
const newId = () => "tsk_" + Date.now().toString(36) + (++seq).toString(36)

export class Tasks {
  constructor(db, { onChange = () => {} } = {}) {
    this.db = db
    this.onChange = onChange
  }

  /**
   * Ownership has three shapes, and they are not the same thing:
   *
   *   session  a named session does this
   *   role     whichever bot plays this part picks it up — so a dev task does
   *            not die because one particular dev session was closed
   *   human    you do this, or you answer this; it is never dispatched
   */
  create({
    title,
    brief = "",
    projectId = null,
    runId = null,
    stage = null,
    persona = null,
    assignee = null,
    role = null,
    owner = null,
    kind = "work",
    options = [],
    askedBy = null,
    dependsOn = [],
    createdBy = "operator",
    acceptance = [],
    order = Date.now(),
  }) {
    if (!title?.trim()) throw new TaskError("bad_request", "A task needs a title.")
    if (owner === "human" || kind === "question") owner = "human"
    else if (assignee) owner = "session"
    else if (role) owner = "role"
    else owner = owner ?? "unassigned"
    const task = {
      id: newId(),
      title: title.trim(),
      brief,
      projectId,
      runId,
      stage,
      persona,
      assignee, // session id, when one session in particular owns it
      role, // or a part, played by whoever is playing it
      owner, // session | role | human | unassigned
      kind, // work | question
      options, // for a question: the answers offered
      askedBy, // session that asked
      answer: null,
      dependsOn,
      acceptance,
      createdBy,
      status: dependsOn.length ? "blocked" : owner === "human" ? "waiting" : assignee || role ? "queued" : "backlog",
      queuedAt: dependsOn.length ? null : Date.now(),
      handoff: null,
      notes: [],
      files: [],
      created: Date.now(),
      updated: Date.now(),
      order,
    }
    this.db.put("tasks", task)
    this.onChange()
    return task
  }

  get(id) {
    return this.db.get("tasks", id)
  }

  all({ projectId, runId, assignee, status, owner, role } = {}) {
    return this.db
      .all("tasks")
      .filter((t) => (!projectId || t.projectId === projectId) && (!runId || t.runId === runId))
      .filter((t) => (!assignee || t.assignee === assignee) && (!status || t.status === status))
      .filter((t) => (!owner || t.owner === owner) && (!role || t.role === role))
      .sort((a, b) => a.order - b.order)
  }

  /** Everything waiting on the operator: questions first, they block someone. */
  forHuman() {
    return this.all({ owner: "human" })
      .filter((t) => !["done", "cancelled"].includes(t.status))
      .sort((a, b) => (a.kind === "question" ? -1 : 1) - (b.kind === "question" ? -1 : 1) || a.created - b.created)
  }

  save(task) {
    task.updated = Date.now()
    this.db.put("tasks", task)
    this.onChange()
    return task
  }

  update(id, patch) {
    const task = this.get(id)
    if (!task) throw new TaskError("unknown_task", `No task ${id}.`)
    if (patch.status && !COLUMNS.includes(patch.status)) {
      throw new TaskError("bad_status", `status must be one of: ${COLUMNS.join(", ")}`)
    }
    Object.assign(task, patch)
    return this.save(task)
  }

  note(id, text, by = "operator") {
    const task = this.get(id)
    if (!task) return null
    task.notes.push({ at: Date.now(), by, text: String(text).slice(0, 2000) })
    if (task.notes.length > 50) task.notes.shift()
    return this.save(task)
  }

  /** A task is ready when every dependency has landed in `done`. */
  ready(task) {
    return task.dependsOn.every((id) => this.get(id)?.status === "done")
  }

  /**
   * Move anything whose dependencies just cleared into `queued`. Queued is
   * deliberately not `active`: the assignee is told about it when it next goes
   * idle, so a running agent is never interrupted mid-thought.
   */
  unblock() {
    const freed = []
    for (const task of this.all()) {
      if (task.status !== "blocked") continue
      if (!this.ready(task)) continue
      task.status = task.owner === "human" ? "waiting" : task.assignee || task.role ? "queued" : "backlog"
      task.queuedAt = Date.now()
      this.save(task)
      freed.push(task)
    }
    return freed
  }

  /**
   * The next thing this session should pick up: work addressed to it by name,
   * or work addressed to the part it plays that nobody has taken yet.
   */
  nextFor(sessionId, { role = null, projectId = null, alive = null, now = Date.now() } = {}) {
    const mine = this.all({ assignee: sessionId })
    // Work addressed to a part stays in its workstream: another workstream's
    // dev bot must not pick up this one's cards. A card sent back for rework
    // prefers the bot that did it first: others take it only once that bot is
    // gone or has had its chance (preferUntil).
    const mayTake = (t) => !t.prefer || t.prefer === sessionId || now > (t.preferUntil ?? 0) || (alive && !alive(t.prefer))
    const byRole = role
      ? this.all({ role }).filter((t) => !t.assignee && t.owner === "role" && (!projectId || !t.projectId || t.projectId === projectId) && mayTake(t))
      : []
    return [...mine, ...byRole]
      .filter((t) => t.status === "queued" && this.ready(t))
      .sort((a, b) => a.order - b.order)[0]
  }

  /** Kanban projection: columns with their cards, newest activity first. */
  board({ projectId, runId } = {}) {
    const tasks = this.all({ projectId, runId })
    return COLUMNS.map((status) => ({
      status,
      tasks: tasks.filter((t) => t.status === status),
    }))
  }

  remove(id) {
    this.db.delete("tasks", id)
    this.onChange()
  }
}

export class TaskError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
