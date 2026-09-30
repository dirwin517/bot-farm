// A very small document store: tables of JSON rows keyed by id.
//
// Runtime state (pipeline runs, tasks, handoffs) lives here. Definitions
// (personas, pipelines) stay in YAML files, because config that people edit
// and share in git should not live inside a binary. Two sources of truth is a
// bug factory, so the split is by *kind*: YAML in, YAML out, database only in
// the middle.
//
// node:sqlite is used when the runtime has it (Node 22.5+) and a JSON file
// otherwise — the interface is identical, so nothing above here cares.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname } from "node:path"

export async function openDb(path) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    mkdirSync(dirname(path), { recursive: true })
    return new SqliteStore(new DatabaseSync(path))
  } catch {
    return new JsonStore(path.replace(/\.db$/, ".json"))
  }
}

class SqliteStore {
  constructor(db) {
    this.db = db
    this.kind = "sqlite"
    this.tables = new Set()
  }
  table(name) {
    if (!this.tables.has(name)) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${safe(name)} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
      this.tables.add(name)
    }
    return safe(name)
  }
  put(name, row) {
    const t = this.table(name)
    this.db.prepare(`INSERT INTO ${t} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(row.id, JSON.stringify(row))
    return row
  }
  get(name, id) {
    const r = this.db.prepare(`SELECT data FROM ${this.table(name)} WHERE id = ?`).get(id)
    return r ? JSON.parse(r.data) : null
  }
  all(name) {
    return this.db.prepare(`SELECT data FROM ${this.table(name)}`).all().map((r) => JSON.parse(r.data))
  }
  delete(name, id) {
    this.db.prepare(`DELETE FROM ${this.table(name)} WHERE id = ?`).run(id)
  }
  close() {
    try { this.db.close() } catch {}
  }
}

class JsonStore {
  constructor(path) {
    this.path = path
    this.kind = "json"
    this.data = {}
    if (existsSync(path)) {
      try { this.data = JSON.parse(readFileSync(path, "utf8")) } catch {}
    }
  }
  flush() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.data))
  }
  put(name, row) {
    ;(this.data[name] ??= {})[row.id] = row
    this.flush()
    return row
  }
  get(name, id) {
    return this.data[name]?.[id] ?? null
  }
  all(name) {
    return Object.values(this.data[name] ?? {})
  }
  delete(name, id) {
    delete this.data[name]?.[id]
    this.flush()
  }
  close() {}
}

function safe(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad table name: ${name}`)
  return name
}
