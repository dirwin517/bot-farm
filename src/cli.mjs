#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Supervisor } from "./supervisor.mjs"
import { startServer } from "./server.mjs"
import { OpencodeClient } from "./api.mjs"
import * as git from "./git.mjs"

const HOME = join(homedir(), ".botfarm")
const CONFIG = join(HOME, "config.json")
const STATE = join(HOME, "metrics.json")

const args = process.argv.slice(2)
const cmd = args[0] ?? "up"
const flags = parseFlags(args.slice(1))
const positional = flags._

const config = await loadConfig()
const serverUrl = flags.server ?? config.server ?? "http://127.0.0.1:4096"

switch (cmd) {
  case "up":
  case "dash":
    await up()
    break
  case "ls":
  case "list":
    await ls()
    break
  case "new":
  case "start":
    await start()
    break
  case "send":
    await send()
    break
  case "stop":
  case "abort":
    await stop()
    break
  case "rm":
  case "delete":
    await remove()
    break
  case "attach":
    await attach()
    break
  default:
    usage()
}

// ---------------------------------------------------------------------------

async function up() {
  await ensureServer(serverUrl, flags.serve !== false)
  const port = Number(flags.port ?? config.port ?? 4777)
  const repos = (flags.repo ? [].concat(flags.repo) : config.repos ?? []).map((p) => git.expandPath(p))

  const supervisor = new Supervisor({
    url: serverUrl,
    statePath: STATE,
    mcpBase: `http://127.0.0.1:${port}`,
    pricing: config.pricing ?? {},
    // The folder you open first. Change it with "defaultWorkspace" in
    // ~/.botfarm/config.json, or add more folders from the app.
    defaultWorkspace: git.expandPath(flags.workspace ?? config.defaultWorkspace ?? process.cwd()),
  })
  const dialect = await supervisor.start()
  const { url } = startServer({ supervisor, port, repos })

  console.log(`botfarm  dashboard  ${url}`)
  console.log(`      opencode   ${serverUrl} (api ${dialect})`)
  console.log(`      watching   ${supervisor.store.sessions.size} session(s), ${repos.length} repo(s)`)
  if (flags.open !== false) openBrowser(url)

  const bye = async () => { await supervisor.stop(); process.exit(0) }
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
}

async function ls() {
  const client = await connect()
  const sessions = await client.listSessions({ limit: 100 })
  const active = (await client.activeSessionIds()) ?? new Set()
  const rows = sessions.map((s) => ({
    id: s.id,
    status: active.has(s.id) ? "busy" : "idle",
    title: (s.title ?? "").slice(0, 34),
    dir: (s.directory ?? s.location?.directory ?? "").replace(homedir(), "~"),
  }))
  if (rows.length === 0) return console.log("no sessions")
  const w = (k, min) => Math.max(min, ...rows.map((r) => String(r[k]).length))
  const cols = { id: w("id", 2), status: 6, title: w("title", 5) }
  console.log(pad("id", cols.id), pad("status", cols.status), pad("title", cols.title), "directory")
  for (const r of rows) console.log(pad(r.id, cols.id), pad(r.status, cols.status), pad(r.title, cols.title), r.dir)
}

async function start() {
  const repo = git.expandPath(positional[0] ?? process.cwd())
  const branch = flags.branch ?? flags.b ?? null
  const supervisor = new Supervisor({ url: serverUrl, statePath: STATE })
  await supervisor.client.connect()
  const root = (await git.repoRoot(repo)) ?? repo
  let directory = root
  if (branch) {
    const wt = await git.addWorktree(root, branch, { path: flags.path })
    directory = wt.path
    console.log(`${wt.reused ? "reusing" : "created"} worktree ${wt.path} (${wt.branch})`)
  }
  const info = await supervisor.client.createSession({
    title: flags.name ?? branch ?? "botfarm session",
    directory,
    agent: flags.agent,
    model: flags.model,
  })
  const task = flags.task ?? positional[1]
  if (task) await supervisor.client.prompt(info.id, task)
  console.log(`${info.id}  ${directory}${task ? `  <- "${task.slice(0, 50)}"` : ""}`)
}

async function send() {
  const client = await connect()
  const id = positional[0]
  const text = positional.slice(1).join(" ") || flags.text
  if (!id || !text) return usage()
  await client.prompt(id, text)
  console.log(`queued -> ${id}`)
}

async function stop() {
  const client = await connect()
  const ids = positional.length ? positional : [...(await client.activeSessionIds() ?? [])]
  for (const id of ids) {
    await client.interrupt(id)
    console.log(`aborted ${id}`)
  }
}

async function remove() {
  const client = await connect()
  const id = positional[0]
  if (!id) return usage()
  const info = await client.getSession(id).catch(() => null)
  await client.deleteSession(id)
  if (flags.worktree && info?.directory) {
    const root = await git.commonDir(info.directory)
    if (root && root !== info.directory) await git.removeWorktree(root, info.directory, { force: !!flags.force })
    console.log(`removed worktree ${info.directory}`)
  }
  console.log(`removed ${id}`)
}

async function attach() {
  const client = await connect()
  const id = positional[0]
  if (!id) return usage()
  const info = await client.getSession(id)
  const dir = info.directory ?? info.location?.directory ?? process.cwd()
  console.log(`attaching to ${id} in ${dir}`)
  spawn("opencode", ["--session", id], { cwd: dir, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0))
}

// ---------------------------------------------------------------------------

async function connect() {
  const client = new OpencodeClient(serverUrl)
  await client.connect()
  return client
}

async function ensureServer(url, allowSpawn) {
  const probe = new OpencodeClient(url)
  try {
    await probe.connect()
    return
  } catch {}
  if (!allowSpawn) throw new Error(`no opencode server at ${url}`)
  const { port, hostname } = new URL(url)
  console.log(`starting opencode serve on ${hostname}:${port}`)
  const child = spawn("opencode", ["serve", "--port", port, "--hostname", hostname], {
    stdio: "ignore",
    detached: true,
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      await new OpencodeClient(url).connect()
      return
    } catch {}
  }
  throw new Error("opencode serve did not come up in 20s")
}

async function loadConfig() {
  await mkdir(HOME, { recursive: true })
  try {
    return JSON.parse(await readFile(CONFIG, "utf8"))
  } catch {
    return {}
  }
}

function parseFlags(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--no-")) out[a.slice(5)] = false
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=")
      const value = v ?? (argv[i + 1]?.startsWith("--") ? true : argv[++i] ?? true)
      if (out[k] === undefined) out[k] = value
      else out[k] = [].concat(out[k], value)
    } else if (a.startsWith("-") && a.length === 2) out[a[1]] = argv[++i]
    else out._.push(a)
  }
  return out
}

const pad = (s, n) => String(s).padEnd(n)

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
}

function usage() {
  console.log(`botfarm — process manager for opencode sessions

  botfarm up [--port 4777] [--server URL] [--repo PATH]...   dashboard (default)
  botfarm ls                                                 list sessions
  botfarm new <repo> [task] --branch NAME [--agent A]        new session in a worktree
  botfarm send <id> <text...>                                queue a prompt
  botfarm stop [id...]                                       interrupt (all busy if omitted)
  botfarm rm <id> [--worktree] [--force]                     delete session, optionally its worktree
  botfarm attach <id>                                        open the session in the opencode TUI

config: ~/.botfarm/config.json  { "server": "http://127.0.0.1:4096", "port": 4777, "repos": ["~/code/app"] }`)
}
