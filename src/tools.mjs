// A workspace's own tools: every .js / .mjs file in <workspace>/botfarm/mcps/
// is loaded into BotFarm's MCP server and offered to the bots working in that
// workspace (as botfarm_<name>), next to the built-in ones.
//
// A tool file exports:
//   name         letters, digits, _ and - (defaults to the file name)
//   description  what the model reads to decide when to call it
//   inputSchema  JSON Schema for the arguments (default: no arguments)
//   execute      async (args, ctx) => result   (also accepted: handler, default)
//   timeoutMs    optional, default 120000
//
// ctx: { repoRoot, workspace, bot, signal, log(...), exec(cmd, args, opts) }
//
// Files are re-imported when they change (fs.watch, plus a rescan as a safety
// net), so saving a file is enough; bots get the new list on their next turn.

import { readdir, readFile, writeFile, stat, mkdir, unlink } from "node:fs/promises"
import { watch } from "node:fs"
import { join, basename, extname } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile } from "node:child_process"

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.m?js$/

export class WorkspaceTools {
  constructor({ supervisor, dirFor, reserved = [] }) {
    this.sup = supervisor
    this.dirFor = dirFor // (ws) => absolute tools folder
    this.reserved = new Set(reserved) // built-in tool names a file may not take
    this.sets = new Map() // workspace id -> { dir, tools: Map<name, tool>, files: Map<file, {mtime, name?, error?}>, watcher, version }
    this.listeners = new Set()
  }

  onChange(fn) { this.listeners.add(fn) }

  /** Load (or re-check) one workspace's tools. Returns true when the list changed. */
  async load(ws) {
    const dir = this.dirFor(ws)
    let set = this.sets.get(ws.id)
    if (!set || set.dir !== dir) {
      set?.watcher?.close?.()
      set = { dir, tools: new Map(), files: new Map(), watcher: null, version: 0, ws: ws.id }
      this.sets.set(ws.id, set)
    }
    let names = []
    try { names = (await readdir(dir)).filter((n) => FILE_RE.test(n)) } catch { names = [] }
    let changed = false
    const seen = new Set()
    for (const file of names) {
      seen.add(file)
      const path = join(dir, file)
      const mtime = await stat(path).then((s) => s.mtimeMs, () => 0)
      const prev = set.files.get(file)
      if (prev && prev.mtime === mtime) continue
      changed = true
      if (prev?.name) set.tools.delete(prev.name)
      try {
        const mod = await import(`${pathToFileURL(path).href}?v=${mtime}`)
        const name = String(mod.name ?? mod.title ?? basename(file, extname(file)))
        const exec = mod.execute ?? mod.handler ?? (typeof mod.default === "function" ? mod.default : null)
        if (!NAME_RE.test(name)) throw new Error(`name "${name}" must be letters, digits, _ and - (starting with a letter)`)
        if (this.reserved.has(name)) throw new Error(`"${name}" is a built-in BotFarm tool; pick another name`)
        if (typeof exec !== "function") throw new Error("no execute(args, ctx) function exported")
        const clash = [...set.tools.values()].find((t) => t.name === name && t.file !== file)
        if (clash) throw new Error(`${clash.file} already defines "${name}"`)
        const tool = {
          name,
          description: String(mod.description ?? "").trim() || `(no description in ${file})`,
          inputSchema: mod.inputSchema && typeof mod.inputSchema === "object" ? mod.inputSchema : { type: "object", properties: {} },
          timeoutMs: Number(mod.timeoutMs) > 0 ? Number(mod.timeoutMs) : 120_000,
          execute: exec,
          file,
        }
        set.tools.set(name, tool)
        set.files.set(file, { mtime, name })
      } catch (e) {
        set.files.set(file, { mtime, error: e.message })
      }
    }
    for (const [file, info] of [...set.files]) {
      if (seen.has(file)) continue
      set.files.delete(file)
      if (info.name) set.tools.delete(info.name)
      changed = true
    }
    if (!set.watcher) {
      try {
        let t = null
        set.watcher = watch(dir, () => { clearTimeout(t); t = setTimeout(() => this.refresh(ws), 250) })
        set.watcher.on("error", () => { set.watcher = null })
      } catch { set.watcher = null } // no folder yet: the rescan picks it up
    }
    if (changed) set.version++
    return changed
  }

  async refresh(ws) {
    const changed = await this.load(ws).catch(() => false)
    if (changed) for (const fn of this.listeners) fn(ws.id)
    return changed
  }

  /** Rescan every workspace (the safety net for missed fs events). */
  async rescan(workspaces) {
    for (const ws of workspaces) await this.refresh(ws)
  }

  list(wsId) {
    const set = this.sets.get(wsId)
    if (!set) return { dir: null, tools: [], errors: [], version: 0 }
    return {
      dir: set.dir,
      version: set.version,
      tools: [...set.tools.values()].map(({ execute, ...t }) => t).sort((a, b) => a.name.localeCompare(b.name)),
      errors: [...set.files].filter(([, f]) => f.error).map(([file, f]) => ({ file, error: f.error })),
    }
  }

  get(wsId, name) {
    return this.sets.get(wsId)?.tools.get(name) ?? null
  }

  /** MCP tool definitions for a workspace. */
  mcpList(wsId) {
    const set = this.sets.get(wsId)
    if (!set) return []
    return [...set.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }

  /**
   * Run a tool. Never throws: the outcome is { ok, result?, error?, ms, logs }.
   * `repoRoot` is the checkout the tool works in (the bot's worktree).
   */
  async run(wsId, name, args = {}, { repoRoot, workspace = null, bot = null, signal = null } = {}) {
    const tool = this.get(wsId, name)
    const started = Date.now()
    const logs = []
    if (!tool) return { ok: false, error: `no tool "${name}" in this workspace`, ms: 0, logs }
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    signal?.addEventListener?.("abort", onAbort)
    let timer
    const ctx = {
      repoRoot,
      workspace,
      bot,
      signal: ctl.signal,
      log: (...a) => { if (logs.length < 200) logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 2000)) },
      exec: (cmd, argv = [], opts = {}) => new Promise((resolve) => {
        execFile(cmd, argv, { cwd: opts.cwd ?? repoRoot, timeout: opts.timeoutMs ?? tool.timeoutMs, maxBuffer: 16 * 1024 * 1024, signal: ctl.signal, env: { ...process.env, ...(opts.env ?? {}) } }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && !stderr ? err.message : "") })
        })
      }),
    }
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.execute(args ?? {}, ctx)),
        new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error(`timed out after ${Math.round(tool.timeoutMs / 1000)}s`)) }, tool.timeoutMs) }),
      ])
      return { ok: true, result: result === undefined ? null : result, ms: Date.now() - started, logs }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e), stack: String(e?.stack ?? "").split("\n").slice(1, 6).join("\n"), ms: Date.now() - started, logs }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
    }
  }

  // --- files, for the test bench ---------------------------------------------

  checkFile(file) {
    if (!FILE_RE.test(file ?? "")) throw new Error("a tool file is a name ending in .js or .mjs (letters, digits, _ - .)")
  }

  async source(ws, file) {
    this.checkFile(file)
    const path = join(this.dirFor(ws), file)
    return { file, path, text: await readFile(path, "utf8").catch(() => "") }
  }

  async save(ws, file, text) {
    this.checkFile(file)
    const dir = this.dirFor(ws)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), String(text ?? ""))
    await this.refresh(ws)
    return this.list(ws.id)
  }

  async create(ws, name) {
    if (!NAME_RE.test(name ?? "")) throw new Error("a tool name is letters, digits, _ and - (starting with a letter)")
    const file = `${name}.js`
    const path = join(this.dirFor(ws), file)
    if (await stat(path).then(() => true, () => false)) throw new Error(`${file} already exists`)
    return { ...(await this.save(ws, file, template(name))), file }
  }

  async remove(ws, file) {
    this.checkFile(file)
    await unlink(join(this.dirFor(ws), file))
    await this.refresh(ws)
    return this.list(ws.id)
  }

  close() {
    for (const s of this.sets.values()) s.watcher?.close?.()
  }
}

/** Plain JSON for MCP: strings as text, everything else pretty-printed (and structured when it is an object). */
export function toolResult(out) {
  if (!out.ok) return { content: [{ type: "text", text: `Tool error: ${out.error}${out.logs.length ? `\n\nlog:\n${out.logs.join("\n")}` : ""}` }], isError: true }
  const r = out.result
  if (typeof r === "string") return { content: [{ type: "text", text: r }] }
  const text = JSON.stringify(r, null, 2) ?? "null"
  return r && typeof r === "object" && !Array.isArray(r)
    ? { content: [{ type: "text", text }], structuredContent: r }
    : { content: [{ type: "text", text }] }
}

const template = (name) => `// BotFarm tool: offered to every bot in this workspace as botfarm_${name}.
// Saving this file reloads it. Try it from Tools in the BotFarm sidebar.

export const name = "${name}"
export const description = "Say what this does and when a bot should use it — this is what the model reads."
export const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "A path relative to the worktree." },
  },
  required: ["path"],
}

// ctx.repoRoot: the calling bot's worktree. ctx.exec(cmd, args): run a program there.
// ctx.log(...): lines shown in the test bench and returned with errors.
export async function execute({ path }, ctx) {
  const { stdout } = await ctx.exec("ls", ["-la", path])
  return { path, listing: stdout.split("\\n").filter(Boolean) }
}
`
