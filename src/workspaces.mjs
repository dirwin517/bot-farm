// A workspace is a folder and its opencode config: the thing you open.
//
// It owns the definitions for the bots that work in it, one file per
// definition in a botfarm/ folder at its root, so they travel with the
// repository, can be reviewed like code and edited without scrolling past
// everything else:
//
//   botfarm/<id>.agent.botfarm.yml      one agent (persona): prompt, model, tools
//   botfarm/<id>.pipeline.botfarm.yml   one pipeline: stages naming those agents
//   botfarm/mcps/*.js                   extra tools served to every bot (see tools.mjs)
//
// The file name is the id. Everything else — the workstreams started from
// those pipelines, with their own worktree, team, channel and board — hangs
// off a workspace.

import { readFile, writeFile, stat, readdir, mkdir, rename, unlink } from "node:fs/promises"
import { join, basename, dirname } from "node:path"
import { homedir } from "node:os"
import * as YAML from "./yaml.mjs"
import * as git from "./git.mjs"
import { DEFAULTS, checkPersona, checkPipelineDoc } from "./pipelines.mjs"
import { LEGACY } from "./legacy-defaults.mjs"

export const BOTFARM_DIR = "botfarm"
export const TOOLS_DIR = join(BOTFARM_DIR, "mcps")
/** The single files of earlier versions, split into botfarm/ once and kept as .bak. */
export const AGENTS_FILE = "botfarm-agents.yml"
export const PIPELINES_FILE = "botfarm-pipeline.yml"
const KINDS = { agents: "agent", pipelines: "pipeline" }
const SUFFIX = ".botfarm.yml"
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "workspace"

const HEADERS = {
  agents: (id) => `# BotFarm agent "${id}" — a bot template: who it is, what it is told, and
# optionally which model, reasoning level and tools it gets. The file name is the id.
# Edit here or in the BotFarm app; both write this file.
`,
  pipelines: (id) => `# BotFarm pipeline "${id}" — ordered stages, each naming an agent and which earlier
# stages' handoffs it receives. Starting it creates a workstream: its own branch,
# team, chat and board. The file name is the id.
`,
}

/** botfarm/<id>.<kind>.botfarm.yml → { kind, id } */
export function parseEntryFile(name) {
  const m = /^(.+)\.(agent|pipeline)\.botfarm\.ya?ml$/.exec(name)
  if (!m) return null
  return { id: m[1], kind: m[2] === "agent" ? "agents" : "pipelines" }
}
const entryFile = (kind, id) => `${id}.${KINDS[kind]}${SUFFIX}`

/** The built-in definitions, as the documents the files hold. */
export function defaultLibrary() {
  const agents = Object.values(DEFAULTS.personas).map((y) => YAML.parse(y))
  const pipelines = Object.values(DEFAULTS.pipelines).map((y) => YAML.parse(y))
  return { agents, pipelines }
}

/** Tool names changed from botfarm_* to botfarm_*: carry prompts along. */
const renameTools = (v) => (typeof v === "string" ? v.replace(/\bbotfarm_(?=[a-z])/g, "botfarm_") : Array.isArray(v) ? v.map(renameTools) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameTools(x)])) : v)

export class Workspaces {
  constructor({ db, supervisor }) {
    this.db = db
    this.sup = supervisor
    this.cache = new Map() // id -> { sig, library }
  }

  list() {
    return this.db.all("workspaces").sort((a, b) => a.created - b.created)
  }

  get(id) {
    return id ? this.db.get("workspaces", id) : null
  }

  /** The workspace a path belongs to, if any. */
  forPath(path) {
    if (!path) return null
    return this.list()
      .filter((w) => path === w.path || path.startsWith(w.path + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  }

  async add({ path, name }) {
    const where = await git.inspect(path)
    if (!where.exists) throw new Error(`${where.path}: ${where.reason}`)
    const root = where.root ?? where.path
    const existing = this.list().find((w) => w.path === root)
    if (existing) return existing
    let id = slug(name ?? basename(root))
    for (let n = 2; this.get(id); n++) id = `${slug(name ?? basename(root))}-${n}`
    const ws = { id, name: name ?? basename(root), path: root, isRepo: where.isRepo, services: [], created: Date.now() }
    this.db.put("workspaces", ws)
    await this.ensureFiles(ws)
    await this.upgradeDefaults(ws)
    await this.sup.wsTools?.load(ws).catch(() => {})
    this.sup.store.note(`workspace ${ws.name} added (${root})`)
    this.sup.onChange()
    return ws
  }

  update(id, patch) {
    const ws = this.get(id)
    if (!ws) throw new Error("unknown workspace")
    Object.assign(ws, patch, { id })
    this.db.put("workspaces", ws)
    this.sup.onChange()
    return ws
  }

  /**
   * A repository from anywhere (~/workspace/spt) that this workspace's
   * workstreams can take along: each gets a worktree of it on the workstream's
   * branch, mounted in the workstream's worktree under `as` (its folder name).
   */
  async addLinked(id, { path, as = null } = {}) {
    const ws = this.get(id)
    if (!ws) throw new Error("unknown workspace")
    const where = await git.inspect(ws.path).catch(() => ({ nested: [] }))
    const linked = ws.linked ?? []
    const taken = [...(where.nested ?? []).map((n) => n.rel), ...git.serviceSources(ws.path, linked).map((l) => l.rel)]
    const raw = String(path ?? "").trim()
    const pre = git.serviceSources(ws.path, [raw])[0]
    if (pre && git.serviceSources(ws.path, linked).some((l) => l.source === pre.source)) throw new Error(`${pre.source} is already linked`)
    const svc = await git.checkService(ws.path, as ? { path: raw, as } : raw, { taken })
    if (!svc.external) throw new Error(`${svc.source} is inside this workspace already — tick it under Repos instead`)
    if (git.serviceSources(ws.path, linked).some((l) => l.source === svc.source)) throw new Error(`${svc.source} is already linked`)
    ws.linked = [...linked, { path: svc.source, as: svc.rel }]
    ws.services = [...new Set([...(ws.services ?? []).filter((x) => typeof x === "string"), svc.source])]
    this.db.put("workspaces", ws)
    this.sup.store.note(`workspace ${ws.name}: linked ${svc.source} (mounted as ${svc.rel}/)`)
    this.sup.onChange()
    return ws
  }

  removeLinked(id, path) {
    const ws = this.get(id)
    if (!ws) throw new Error("unknown workspace")
    ws.linked = (ws.linked ?? []).filter((l) => l.path !== path)
    ws.services = (ws.services ?? []).filter((x) => x !== path)
    this.db.put("workspaces", ws)
    this.sup.onChange()
    return ws
  }

  /** A workspace's services as start() wants them: linked repos carry their mount name. */
  serviceEntries(ws, picked = ws?.services ?? []) {
    const linked = new Map((ws?.linked ?? []).map((l) => [l.path, l]))
    return picked.map((p) => (typeof p === "string" && linked.has(p) ? { path: p, as: linked.get(p).as } : p))
  }

  remove(id) {
    this.db.delete("workspaces", id)
    this.cache.delete(id)
    this.sup.onChange()
  }

  files(ws) {
    const dir = join(ws.path, BOTFARM_DIR)
    return { dir, agents: dir, pipelines: dir, tools: join(ws.path, TOOLS_DIR) }
  }

  entryPath(ws, kind, id) {
    return join(ws.path, BOTFARM_DIR, entryFile(kind, id))
  }

  async entryFiles(ws) {
    const dir = join(ws.path, BOTFARM_DIR)
    let names = []
    try { names = await readdir(dir) } catch { return [] }
    return names.map((n) => ({ name: n, path: join(dir, n), ...parseEntryFile(n) })).filter((f) => f.kind)
  }

  async writeEntry(ws, kind, doc) {
    const id = doc.id
    const clean = { id, ...doc }
    delete clean.file
    await mkdir(join(ws.path, BOTFARM_DIR), { recursive: true })
    await writeFile(this.entryPath(ws, kind, id), HEADERS[kind](id) + "\n" + YAML.stringify(clean) + "\n")
  }

  /**
   * Make sure botfarm/ has definitions: the old single files split into one
   * file per entry (and renamed to .bak), or the built-ins on a new
   * workspace. Also the tools folder, with one example tool.
   */
  async ensureFiles(ws) {
    const have = await this.entryFiles(ws)
    const note = (m) => this.sup.store.note(m, null, "info")
    if (!have.length) {
      const legacy = {}
      for (const [kind, file] of [["agents", AGENTS_FILE], ["pipelines", PIPELINES_FILE]]) {
        try { legacy[kind] = YAML.parse(await readFile(join(ws.path, file), "utf8"))?.[kind] ?? null } catch { legacy[kind] = null }
      }
      const lib = defaultLibrary()
      const moved = []
      for (const kind of ["agents", "pipelines"]) {
        const list = (legacy[kind] ?? lib[kind]).filter((x) => x?.id && ID_RE.test(x.id))
        for (const doc of list) {
          await this.writeEntry(ws, kind, renameTools(doc)).catch((e) => this.sup.store.note(`could not write ${entryFile(kind, doc.id)}: ${e.message}`, null, "warn"))
        }
        if (legacy[kind]) {
          const from = join(ws.path, kind === "agents" ? AGENTS_FILE : PIPELINES_FILE)
          let to = from + ".bak"
          if (await stat(to).then(() => true, () => false)) to = `${from}.${Date.now()}.bak`
          await rename(from, to).then(() => moved.push(`${basename(from)} → ${basename(to)}`), () => {})
        }
      }
      if (moved.length) note(`${ws.name}: split ${moved.map((m) => m.split(" ")[0]).join(" and ")} into one file per definition in ${BOTFARM_DIR}/ (old files kept: ${moved.map((m) => m.split(" → ")[1]).join(", ")})`)
    }
    const routing = join(ws.path, BOTFARM_DIR, ROUTING_FILE)
    if (!(await stat(routing).then(() => true, () => false))) await writeFile(routing, ROUTING_EXAMPLE).catch(() => {})
    const tools = join(ws.path, TOOLS_DIR)
    if (!(await stat(tools).then(() => true, () => false))) {
      await mkdir(tools, { recursive: true }).catch(() => {})
      await writeFile(join(tools, "worktree_status.js"), EXAMPLE_TOOL).catch(() => {})
    }
    await git.excludeLocally(ws.path, `${BOTFARM_DIR}/*.bak`).catch(() => {})
  }

  /**
   * Move built-in definitions that are still exactly as they shipped to the
   * current built-ins. Only untouched entries change; an edit, however
   * small, means the definition is yours and it is left alone.
   */
  async upgradeDefaults(ws) {
    const same = (a, b) => String(a ?? "").replace(/\s+/g, " ").trim() === String(b ?? "").replace(/\s+/g, " ").trim()
    const now = defaultLibrary()
    const changed = []
    for (const f of await this.entryFiles(ws)) {
      let doc
      try { doc = YAML.parse(await readFile(f.path, "utf8")) } catch { continue }
      if (!doc) continue
      if (f.kind === "agents") {
        const olds = (LEGACY.agents[f.id] ?? []).map((y) => renameTools(YAML.parse(y)))
        const current = now.agents.find((x) => x.id === f.id)
        if (current && olds.some((o) => same(o.prompt, doc.prompt) && !doc.tools && !doc.model)) {
          await this.writeEntry(ws, "agents", current)
          changed.push(`agent ${f.id}`)
        }
      } else {
        let hit = false
        for (const [i, st] of (doc.stages ?? []).entries()) {
          const olds = (LEGACY.stages[`${f.id}/${st.id}`] ?? []).map((y) => renameTools(YAML.parse(y).stages[0]))
          const current = now.pipelines.find((x) => x.id === f.id)?.stages?.find((x) => x.id === st.id)
          if (current && olds.some((o) => same(o.prompt, st.prompt))) {
            doc.stages[i] = { ...st, title: current.title, prompt: current.prompt }
            changed.push(`stage ${f.id}/${st.id}`)
            hit = true
          }
        }
        if (hit) await this.writeEntry(ws, "pipelines", { ...doc, id: f.id })
      }
    }
    if (changed.length) { this.cache.delete(ws.id); this.sup.store.note(`updated unedited built-ins in ${ws.name}: ${changed.join(", ")}`) }
    return changed
  }

  /**
   * The agents and pipelines defined in this workspace, re-read whenever a
   * file in botfarm/ changes, appears or goes — so a hand edit shows up
   * without a reload.
   */
  async library(id) {
    const ws = this.get(id)
    if (!ws) throw new Error("unknown workspace")
    const f = this.files(ws)
    const entries = await this.entryFiles(ws)
    const stats = await Promise.all(entries.map((e) => stat(e.path).then((s) => `${e.name}:${s.mtimeMs}`).catch(() => e.name)))
    const sig = stats.sort().join("|")
    const hit = this.cache.get(id)
    if (hit && hit.sig === sig) return hit.library
    const library = { workspace: id, personas: new Map(), definitions: new Map(), problems: [], files: f, missing: [] }
    if (!entries.length) library.missing.push("agents", "pipelines")
    const docs = { agents: [], pipelines: [] }
    for (const e of entries) {
      try {
        const doc = YAML.parse(await readFile(e.path, "utf8")) ?? {}
        if (doc.id && doc.id !== e.id) library.problems.push({ file: `${BOTFARM_DIR}/${e.name}`, id: e.id, problems: [`says id: ${doc.id}, but the file name makes it "${e.id}" — the file name wins`] })
        docs[e.kind].push({ ...doc, id: e.id, file: e.path })
      } catch (err) {
        library.problems.push({ file: `${BOTFARM_DIR}/${e.name}`, id: e.id, problems: [err.message] })
      }
    }
    for (const a of docs.agents.sort((x, y) => x.id.localeCompare(y.id))) {
      const problems = checkPersona(a)
      if (problems.length) library.problems.push({ file: `${BOTFARM_DIR}/${basename(a.file)}`, id: a.id, problems })
      library.personas.set(a.id, a)
    }
    for (const p of docs.pipelines.sort((x, y) => x.id.localeCompare(y.id))) {
      const problems = checkPipelineDoc(p, library.personas)
      if (problems.length) library.problems.push({ file: `${BOTFARM_DIR}/${basename(p.file)}`, id: p.id, problems })
      library.definitions.set(p.id, p)
    }
    this.cache.set(id, { sig, library })
    return library
  }

  async summary(id) {
    const lib = await this.library(id)
    const ws = this.get(id)
    const setup = await opencodeSetup(ws.path)
    const rel = (p) => (p ? p.slice(ws.path.length + 1) : null)
    return {
      opencode: {
        found: setup.found,
        model: setup.model ?? null,
        defaultAgent: setup.default_agent ?? null,
        agents: Object.entries(setup.agent).map(([name, a]) => ({ name, model: a.model ?? null, variant: a.variant ?? null, mode: a.mode ?? null, description: a.description ?? null })),
        mcp: Object.entries(setup.mcp).map(([name, m]) => ({ name, type: m.type, enabled: m.enabled !== false })),
      },
      files: lib.files,
      missing: lib.missing,
      problems: lib.problems,
      agents: [...lib.personas.values()].map(({ file, ...a }) => ({ ...a, file: rel(file) })),
      pipelines: [...lib.definitions.values()].map(({ file, ...p }) => ({
        ...p,
        file: rel(file),
        stages: (p.stages ?? []).map((s) => ({ ...s, receives: s.receives ?? [] })),
      })),
    }
  }

  /** Replace, add, rename or delete one entry: its own file. */
  async saveEntry(id, kind, entryId, doc) {
    const ws = this.get(id)
    if (!ws) throw new Error("unknown workspace")
    kind = kind === "agents" ? "agents" : "pipelines"
    if (doc === null) {
      await unlink(this.entryPath(ws, kind, entryId)).catch((e) => { if (e.code !== "ENOENT") throw e })
    } else {
      const next = String(doc.id ?? entryId).trim()
      if (!ID_RE.test(next)) throw new Error(`"${next}" cannot be an id: letters, digits, dots, dashes and underscores only (it becomes the file name)`)
      await this.writeEntry(ws, kind, { ...doc, id: next })
      if (next !== entryId && entryId && entryId !== "+new") await unlink(this.entryPath(ws, kind, entryId)).catch(() => {})
    }
    this.cache.delete(id)
    this.sup.onChange()
    return this.summary(id)
  }

  /**
   * botfarm/routing.botfarm.yml: which model and reasoning level a card gets by
   * how hard it looks. { enabled, tiers: { easy, normal, hard } }, or null.
   */
  async routing(id) {
    const ws = this.get(id)
    if (!ws) return null
    const path = join(ws.path, BOTFARM_DIR, ROUTING_FILE)
    const mtime = await stat(path).then((s) => s.mtimeMs, () => 0)
    this.routingCache ??= new Map()
    const hit = this.routingCache.get(id)
    if (hit && hit.mtime === mtime) return hit.doc
    let doc = null
    try { doc = YAML.parse(await readFile(path, "utf8")) ?? null } catch { doc = null }
    this.routingCache.set(id, { mtime, doc })
    return doc
  }

  /** Save routing from the app: { enabled, tiers: { easy, normal, hard } }, keeping the header comment. */
  async saveRouting(id, doc) {
    const ws = this.get(id)
    if (!ws) throw new Error("unknown workspace")
    const clean = { enabled: !!doc?.enabled, ...(doc?.switch === "next-turn" ? { switch: "next-turn" } : {}), tiers: {} }
    for (const level of ["easy", "normal", "hard"]) clean.tiers[level] = cleanTier(doc?.tiers?.[level])
    const header = ROUTING_EXAMPLE.split("\n").filter((l) => l.startsWith("#")).join("\n")
    await mkdir(join(ws.path, BOTFARM_DIR), { recursive: true })
    await writeFile(join(ws.path, BOTFARM_DIR, ROUTING_FILE), header + "\n\n" + YAML.stringify(clean) + "\n")
    this.routingCache?.delete(id)
    this.sup.onChange()
    return clean
  }

  /** One entry's file as text, for the YAML tab. */
  async readRaw(id, kind, entryId) {
    const ws = this.get(id)
    kind = kind === "agents" ? "agents" : "pipelines"
    const path = this.entryPath(ws, kind, entryId)
    return { path, text: await readFile(path, "utf8").catch(() => "") }
  }

  async writeRaw(id, kind, text, entryId) {
    const doc = YAML.parse(text) // refuse to write something we cannot read back
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the file must be one definition (a map), not a list")
    const ws = this.get(id)
    kind = kind === "agents" ? "agents" : "pipelines"
    if (!ID_RE.test(entryId ?? "")) throw new Error("which definition? (no id)")
    await mkdir(join(ws.path, BOTFARM_DIR), { recursive: true })
    await writeFile(this.entryPath(ws, kind, entryId), text.endsWith("\n") ? text : text + "\n")
    this.cache.delete(id)
    this.sup.onChange()
    return this.summary(id)
  }
}

/** One routing tier as it is saved: model, variant, and optionally a quota on that model with a fallback. */
export function cleanTier(t = {}) {
  const out = {}
  if (t?.model && String(t.model).trim()) out.model = String(t.model).trim()
  if (t?.variant && String(t.variant).trim() && t.variant !== "default") out.variant = String(t.variant).trim()
  if (out.model && t?.quota) {
    const q = {}
    for (const k of ["usd", "tokens", "minutes"]) if (Number(t.quota[k]) > 0) q[k] = Number(t.quota[k])
    if (Object.keys(q).length) {
      q.per = ["day", "week", "month", "workstream"].includes(t.quota.per) ? t.quota.per : "day"
      out.quota = q
      const fb = {}
      if (t.fallback?.model && String(t.fallback.model).trim()) fb.model = String(t.fallback.model).trim()
      if (t.fallback?.variant && t.fallback.variant !== "default") fb.variant = String(t.fallback.variant)
      out.fallback = fb
    }
  }
  return out
}

export const ROUTING_FILE = "routing.botfarm.yml"
const ROUTING_EXAMPLE = `# BotFarm model routing: each card gets a model and reasoning level by how hard it
# looks — from its words (refactor, migration, security… vs typo, docs, rename…),
# its length and its number of criteria, or a "difficulty:" set on a stage or on a
# split piece. No model is used to decide. A bot's own Model… choice always wins,
# and an agent can have its own "tiers:" with the same shape.
#
# A tier can cap its model: quota: { usd, tokens, minutes, per: day|week|month|workstream }
# and name a fallback: { model, variant } to use once the quota is spent, e.g.
#   hard: { model: …opus…, variant: high, quota: { usd: 5, per: day }, fallback: { model: …sonnet…, variant: high } }
# switch: next-turn   moves running bots to the fallback on their next turn instead of at once.
#
# Off until you set enabled: true. Leave a key out to keep the agent's own setting.

enabled: false
tiers:
  easy:
    variant: low
    # model: amazon-bedrock/anthropic.claude-haiku-4-5
  normal: {}
  hard:
    variant: high
    # model: amazon-bedrock/anthropic.claude-opus-5
`

const EXAMPLE_TOOL = `// A BotFarm tool. Every .js file in botfarm/mcps/ is loaded into BotFarm's own MCP
// server and offered to every bot in this workspace as botfarm_<name>. Save the
// file and it is live — no restart. Try it from Tools in the BotFarm sidebar.
//
//   name         the tool's name (letters, digits, _ and -)
//   description  what it does and when to use it: this is what the model reads
//   inputSchema  JSON Schema for the arguments
//   execute      async (args, ctx) => anything JSON-serialisable (or a string)
//
// ctx.repoRoot is the calling bot's worktree (or the workspace, from the test
// bench); ctx.bot is { handle, persona, id } or null; ctx.exec(cmd, args, opts)
// runs a program in ctx.repoRoot and returns { code, stdout, stderr };
// ctx.signal aborts when the call is cancelled.

export const name = "worktree_status"
export const description = "Show what has changed in your worktree: branch, changed files and a short diff summary."
export const inputSchema = {
  type: "object",
  properties: {
    diff: { type: "boolean", description: "Include the diff stat per file (default true)." },
  },
}

export async function execute({ diff = true } = {}, ctx) {
  const branch = (await ctx.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  const status = (await ctx.exec("git", ["status", "--short"])).stdout.trim()
  const stat = diff ? (await ctx.exec("git", ["diff", "--stat", "HEAD"])).stdout.trim() : undefined
  return { worktree: ctx.repoRoot, branch, changed: status ? status.split("\\n") : [], diff: stat }
}
`

// ---------------------------------------------------------------------------
// The workspace's own opencode setup: model, agents, MCP servers.
//
// A bot runs in a worktree, and opencode does not reliably read the
// checkout's config for it (a newer server boots a location without loading
// project config at all — the bot then falls back to opencode's free tier).
// So botfarm reads the workspace's opencode.json itself and passes the model,
// agent and MCP servers explicitly.

function parseJsonc(text) {
  const noComments = String(text)
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(noComments)
}

export async function readJsonc(path) {
  try { return parseJsonc(await readFile(path, "utf8")) } catch { return null }
}

export async function opencodeSetup(dir) {
  const layers = []
  for (const f of ["opencode.json", "opencode.jsonc", join(".opencode", "opencode.json"), join(".opencode", "opencode.jsonc")]) {
    const doc = await readJsonc(join(dir, f))
    if (doc) layers.push(doc)
  }
  const merged = { agent: {}, mcp: {} }
  for (const d of layers) {
    for (const k of ["model", "small_model", "default_agent"]) if (d[k]) merged[k] = d[k]
    for (const [name, a] of Object.entries(d.agent ?? {})) merged.agent[name] = { ...(merged.agent[name] ?? {}), ...a }
    for (const [name, m] of Object.entries(d.mcp ?? {})) if (name !== "botfarm" && name !== "botfarm") merged.mcp[name] = { ...(merged.mcp[name] ?? {}), ...m }
  }
  merged.found = layers.length > 0
  return merged
}

/**
 * Which opencode agent, model and reasoning level a BotFarm agent runs on:
 * its own setting first, then the opencode agent's, then the workspace
 * default. The opencode agent defaults to "build" rather than the
 * workspace's default_agent, which may be one that switches most tools off
 * (the botfarm tools included, and a bot that cannot hand off is stuck).
 */
export function resolveBot(setup, persona = {}) {
  const agent = persona.agent ?? (setup?.agent?.build ? "build" : null)
  const a = (agent && setup?.agent?.[agent]) || {}
  return {
    agent,
    model: persona.model ?? a.model ?? setup?.model ?? null,
    variant: persona.variant ?? a.variant ?? null,
  }
}

// ---------------------------------------------------------------------------
// Workstream manifests: <workspace>/.botfarm/workstreams/<id>.yml
//
// One small file per workstream naming the opencode sessions behind its bots
// (and the ones they replaced), so the team can be found again after botfarm's
// own state is lost, moved to another machine, or a session falls off
// opencode's listing. Machine-specific, so it is excluded from git locally.

export const MANIFEST_DIR = join(".botfarm", "workstreams")

const MANIFEST_HEADER = `# BotFarm workstream: the opencode sessions behind this workstream's bots.
# Written by BotFarm whenever the team changes; used to bring the bots back.
`

export function manifestPath(ws, projectId) {
  return join(ws.path, MANIFEST_DIR, `${projectId}.yml`)
}

export async function readManifest(ws, projectId) {
  try {
    return YAML.parse(await readFile(manifestPath(ws, projectId), "utf8"))
  } catch {
    return null
  }
}

export async function readManifests(ws) {
  const dir = join(ws.path, MANIFEST_DIR)
  let files = []
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".yml")) } catch { return [] }
  const out = []
  for (const f of files) {
    try {
      const doc = YAML.parse(await readFile(join(dir, f), "utf8"))
      if (doc?.id) out.push(doc)
    } catch {}
  }
  return out
}

export async function writeManifest(ws, doc) {
  const file = manifestPath(ws, doc.id)
  await mkdir(dirname(file), { recursive: true })
  await git.excludeLocally(ws.path, ".botfarm/").catch(() => {})
  await writeFile(file, MANIFEST_HEADER + "\n" + YAML.stringify(doc) + "\n")
  return file
}

/**
 * A folder browser for the dashboard. A web page cannot ask the OS for a
 * folder's path, so the server lists directories instead. Hidden folders and
 * the usual build output are left out.
 */
export async function listDirs(input) {
  const path = git.expandPath(input || "~")
  let entries = []
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (err) {
    return { path, parent: dirname(path), home: homedir(), error: err.code === "ENOENT" ? "no such folder" : err.message, dirs: [] }
  }
  const skip = /^(\.|node_modules$|target$|build$|dist$|out$)/
  const dirs = []
  for (const e of entries) {
    if (!e.isDirectory() || skip.test(e.name)) continue
    const full = join(path, e.name)
    const isRepo = await stat(join(full, ".git")).then(() => true).catch(() => false)
    dirs.push({ name: e.name, path: full, isRepo })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const isRepo = await stat(join(path, ".git")).then(() => true).catch(() => false)
  return { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), isRepo, dirs: dirs.slice(0, 400) }
}
