// botfarm only manages sessions you put on the board.
//
// `opencode` accumulates every session you have ever opened; listing them all
// turns the dashboard into an archive browser. The registry is the line
// between "a session that exists" and "a session I am running right now",
// and it is also where botfarm keeps the metadata opencode has no place for:
// group, label, notes, mesh policy, lineage.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export class Registry {
  constructor(path) {
    this.path = path
    this.entries = new Map() // sessionId -> { group, label, notes, adoptedAt, createdByBotfarm }
    this.groups = ["default"]
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"))
      this.entries = new Map(Object.entries(raw.sessions ?? {}))
      this.groups = raw.groups?.length ? raw.groups : ["default"]
    } catch {}
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(
      this.path,
      JSON.stringify({ sessions: Object.fromEntries(this.entries), groups: this.groups }, null, 2),
    )
  }

  has(id) {
    return this.entries.has(id)
  }

  get(id) {
    return this.entries.get(id) ?? null
  }

  adopt(id, meta = {}) {
    const existing = this.entries.get(id) ?? {}
    const entry = {
      group: "default",
      label: null,
      notes: "",
      createdByBotfarm: false,
      adoptedAt: Date.now(),
      ...existing,
      ...meta,
    }
    this.entries.set(id, entry)
    if (entry.group && !this.groups.includes(entry.group)) this.groups.push(entry.group)
    return entry
  }

  release(id) {
    this.entries.delete(id)
  }

  update(id, patch) {
    const entry = this.entries.get(id)
    if (!entry) return null
    Object.assign(entry, patch)
    if (patch.group && !this.groups.includes(patch.group)) this.groups.push(patch.group)
    return entry
  }

  addGroup(name) {
    const clean = String(name).trim().slice(0, 32)
    if (clean && !this.groups.includes(clean)) this.groups.push(clean)
    return clean
  }

  removeGroup(name) {
    if (name === "default") return
    this.groups = this.groups.filter((g) => g !== name)
    for (const e of this.entries.values()) if (e.group === name) e.group = "default"
  }

  counts() {
    const out = Object.fromEntries(this.groups.map((g) => [g, 0]))
    for (const e of this.entries.values()) out[e.group] = (out[e.group] ?? 0) + 1
    return out
  }
}
