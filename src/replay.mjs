// Replays: everything that happened in a workstream, as a timeline you can
// scrub through later — or save as one file and open on another computer.
//
// While a workstream runs, small events are appended to
// <workspace>/.botfarm/workstreams/<id>.replay.jsonl (buffered, a line each):
//
//   { t, k: "task", task: { id, title, stage, status, assignee, parentId, item, kind, owner } }
//   { t, k: "bot",  bot: { id, handle, persona, personaTitle, status, tool } }
//   { t, k: "msg",  msg: { id, from, fromId, text } }
//   { t, k: "note", text, level }
//   { t, k: "harvest", harvest }
//
// An export bundles that with the workstream's header into a single JSON
// document ("botfarm-replay", version 1). Avatars are drawn from id + handle,
// so a replay needs nothing from the machine that recorded it.

import { appendFile, readFile, mkdir, writeFile, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"

export const REPLAY_FORMAT = "botfarm-replay"

const pickTask = (t) => ({ id: t.id, title: t.title, stage: t.stage ?? null, status: t.status, assignee: t.assignee ?? null, parentId: t.parentId ?? null, item: t.item ?? null, kind: t.kind ?? "work", owner: t.owner ?? null, order: t.order ?? 0, children: t.children ?? null, dependsOn: t.dependsOn ?? [] })
const pickBot = (s) => ({ id: s.id, handle: s.handle, persona: s.persona ?? null, personaTitle: s.personaTitle ?? null, status: s.status, tool: s.currentTool?.name ?? null })

export class Recorder {
  constructor({ pathFor }) {
    this.pathFor = pathFor // (projectId) => file path, or null when it has no workspace
    this.buf = new Map() // path -> lines
    this.last = new Map() // `${projectId}:${kind}:${id}` -> signature, to record changes only
    this.timer = setInterval(() => this.flush().catch(() => {}), 2000)
    this.timer.unref?.()
  }

  push(projectId, ev) {
    if (!projectId || projectId === "default") return
    const path = this.pathFor(projectId)
    if (!path) return
    const line = JSON.stringify({ t: Date.now(), ...ev })
    this.buf.set(path, [...(this.buf.get(path) ?? []), line])
  }

  /** Record a task only when something visible about it changed. */
  task(t) {
    if (!t?.projectId) return
    const snap = pickTask(t)
    const sig = JSON.stringify([snap.status, snap.assignee, snap.title, snap.children?.length])
    const key = `${t.projectId}:task:${t.id}`
    if (this.last.get(key) === sig) return
    this.last.set(key, sig)
    this.push(t.projectId, { k: "task", task: snap })
  }

  bot(s) {
    if (!s?.project) return
    const snap = pickBot(s)
    const sig = JSON.stringify([snap.status, snap.tool, snap.handle])
    const key = `${s.project}:bot:${s.id}`
    if (this.last.get(key) === sig) return
    this.last.set(key, sig)
    this.push(s.project, { k: "bot", bot: snap })
  }

  msg(projectId, m) {
    this.push(projectId, { k: "msg", msg: { id: m.id, from: m.from, fromId: m.fromId ?? null, text: String(m.text).slice(0, 4000) } })
  }

  note(projectId, text, level = "info") {
    this.push(projectId, { k: "note", text: String(text).slice(0, 400), level })
  }

  harvest(projectId, h) {
    this.push(projectId, { k: "harvest", harvest: h })
  }

  async flush() {
    for (const [path, lines] of [...this.buf]) {
      this.buf.delete(path)
      if (!lines.length) continue
      await mkdir(dirname(path), { recursive: true }).catch(() => {})
      await appendFile(path, lines.join("\n") + "\n").catch(() => {})
    }
  }

  async events(projectId) {
    await this.flush()
    const path = this.pathFor(projectId)
    if (!path) return []
    const text = await readFile(path, "utf8").catch(() => "")
    return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }

  stop() {
    clearInterval(this.timer)
    return this.flush()
  }
}

/** One portable document for a workstream. */
export function bundle({ project, run, team, tasks, messages, events, harvest = null }) {
  const start = Math.min(...[run?.created, project?.created, events[0]?.t].filter(Boolean)) || Date.now()
  // Seed the timeline with the state at the start, so a replay recorded
  // mid-way (or before recording existed) still has a board to show.
  const seeded = [
    ...team.map((s) => ({ t: start, k: "bot", bot: pickBot({ ...s, status: "idle", currentTool: null }) })),
    ...tasks.filter((t) => !events.some((e) => e.k === "task" && e.task.id === t.id)).map((t) => ({ t: t.created ?? start, k: "task", task: pickTask(t) })),
    ...messages.filter((m) => !events.some((e) => e.k === "msg" && e.msg.id === m.id)).map((m) => ({ t: m.at, k: "msg", msg: { id: m.id, from: m.from, fromId: m.fromId ?? null, text: m.text } })),
  ]
  const all = [...seeded, ...events].sort((a, b) => a.t - b.t)
  return {
    format: REPLAY_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, branch: project.branch ?? null, story: project.story ?? null, pipeline: project.pipelineTitle ?? project.pipeline ?? null },
    team: team.map((s) => ({ id: s.id, handle: s.handle, persona: s.persona ?? null, personaTitle: s.personaTitle ?? null, model: s.model ?? s.configuredModel ?? null })),
    start,
    end: all.at(-1)?.t ?? start,
    harvest,
    events: all,
  }
}

export function validBundle(doc) {
  return doc && doc.format === REPLAY_FORMAT && Array.isArray(doc.events) && doc.project?.name
}

/** Imported replays live in ~/.botfarm/replays, one file each. */
export class ReplayShelf {
  constructor(dir) { this.dir = dir }
  async list() {
    const names = await readdir(this.dir).catch(() => [])
    const out = []
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      try {
        const d = JSON.parse(await readFile(join(this.dir, n), "utf8"))
        out.push({ id: n.replace(/\.json$/, ""), name: d.project?.name, start: d.start, end: d.end, events: d.events?.length ?? 0, importedFrom: d.importedFrom ?? null })
      } catch {}
    }
    return out.sort((a, b) => (b.end ?? 0) - (a.end ?? 0))
  }
  async get(id) {
    if (!/^[\w.-]+$/.test(id)) throw new Error("bad replay id")
    return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8"))
  }
  async put(doc) {
    if (!validBundle(doc)) throw new Error("that is not a BotFarm replay file")
    const id = `${String(doc.project.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}`
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(doc))
    return id
  }
}
