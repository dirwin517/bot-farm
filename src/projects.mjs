// A project is the thing you actually work on: a checkout, the sessions
// working in it, the tasks they are working through, and the conversation they
// are having about it.
//
// Those used to be four separate ideas in botfarm — a group, a worktree, a board
// and a room — which meant four places to look and four things to create
// before anything could happen. They are one object now. Creating a project
// creates its chat; adding a session to a project adds it to that chat; the
// project's board is its tasks. The global board still exists, as a view
// across every project rather than as the primary one.

const slug = (name) =>
  String(name ?? "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "project"

export class Projects {
  constructor({ db, supervisor }) {
    this.db = db
    this.sup = supervisor
  }

  list() {
    const rows = this.db.all("projects")
    if (!rows.some((p) => p.id === "default")) {
      rows.unshift({ id: "default", name: "Default", repo: null, branch: null, created: 0, roomId: null })
    }
    return rows.sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : b.created - a.created))
  }

  get(id) {
    if (!id) return null
    return this.db.get("projects", id) ?? (id === "default" ? this.list()[0] : null)
  }

  find(ref) {
    return this.get(ref) ?? this.list().find((p) => p.name === ref || p.id === slug(ref)) ?? null
  }

  create({ name, repo = null, branch = null, worktree = null, services = [], unique = false, workspaceId = null }) {
    let id = slug(name)
    if (unique) for (let n = 2; this.db.get("projects", id) || id === "default"; n++) id = `${slug(name).slice(0, 36)}-${n}`
    if (this.db.get("projects", id)) throw new Error(`a project called "${id}" already exists`)
    const project = {
      id,
      name: name ?? id,
      repo,
      branch,
      worktree,
      services,
      workspaceId: workspaceId ?? this.sup.workspaces?.forPath(repo)?.id ?? null,
      status: "open",
      roomId: null,
      created: Date.now(),
    }
    this.db.put("projects", project)
    this.sup.store.note(`project ${project.name} created`)
    this.sup.onChange()
    return project
  }

  save(project) {
    this.db.put("projects", project)
    this.sup.onChange()
    return project
  }

  remove(id) {
    if (id === "default") throw new Error("the default project cannot be removed")
    for (const s of this.sessions(id)) this.sup.registry.update(s.id, { project: "default" })
    this.db.delete("projects", id)
    this.sup.onChange()
  }

  sessions(id) {
    return this.sup.store.list().filter((s) => (s.project ?? "default") === id)
  }

  tasks(id) {
    return this.sup.tasks.all({ projectId: id })
  }

  /**
   * A project's chat is created the first time it is needed, with whoever is
   * in the project — so "the conversation about this project" never has to be
   * set up as a separate act.
   */
  room(id, { create = true } = {}) {
    const project = this.get(id)
    if (!project) return null
    const existing = project.roomId ? this.sup.rooms.rooms.get(project.roomId) : null
    if (existing) return existing
    if (!create) return null
    const members = this.sessions(id)
    const room = this.sup.rooms.create({
      name: project.id,
      topic: project.branch ? `${project.name} · ${project.branch}` : project.name,
      members,
      createdBy: "operator",
    })
    room.projectId = id
    project.roomId = room.id
    this.save(project)
    return room
  }

  /** Moving a session into a project moves it into that project's chat too. */
  attach(sessionId, projectId) {
    const session = this.sup.store.get(sessionId)
    if (!session) return null
    // Naming a project that does not exist yet creates it: assigning work is
    // how projects come into being, not a separate ceremony beforehand.
    if (projectId !== "default" && !this.get(projectId)) {
      this.create({ name: projectId, repo: session.repo ?? session.directory, branch: session.branch })
    }
    const previous = session.project ?? "default"
    session.project = projectId
    this.sup.registry.update(sessionId, { project: projectId })
    if (previous !== projectId) {
      const old = this.get(previous)?.roomId ? this.sup.rooms.rooms.get(this.get(previous).roomId) : null
      if (old) this.sup.rooms.leave(old, session)
    }
    const room = this.room(projectId, { create: this.sessions(projectId).length > 1 })
    if (room && session.policy.rooms !== "off") this.sup.rooms.join(room, session)
    this.sup.onChange()
    return session
  }

  snapshot() {
    return this.list().map((p) => {
      const sessions = this.sessions(p.id)
      const tasks = this.tasks(p.id)
      const room = p.roomId ? this.sup.rooms.rooms.get(p.roomId) : null
      return {
        ...p,
        sessions: sessions.map((s) => ({ id: s.id, handle: s.handle, status: s.status, name: s.label ?? s.title })),
        busy: sessions.filter((s) => s.status === "busy").length,
        open: tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length,
        total: tasks.length,
        unread: room ? [...room.unread.values()].reduce((a, v) => a + v, 0) : 0,
        messages: room ? room.stats.posts : 0,
        roomId: room?.id ?? null,
      }
    })
  }
}
