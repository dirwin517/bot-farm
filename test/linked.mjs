// Repos from anywhere in a workstream: linked to the workspace up front, or added after the fact.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import * as git from "../src/git.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))
const mkrepo = async (dir, file) => {
  await mkdir(dir, { recursive: true })
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir })
  await writeFile(join(dir, file), "x\n")
  await run("git", ["add", "."], { cwd: dir })
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: dir })
  return dir
}
const exists = (p) => stat(p).then(() => true, () => false)
const base = await mkdtemp(join(tmpdir(), "linked-"))
const repo = await mkrepo(join(base, "java-parent-services"), "pom.xml")
const spt = await mkrepo(join(base, "elsewhere", "spt"), "App.java")
const ui = await mkrepo(join(base, "elsewhere", "web-ui"), "package.json")
const home = await mkdtemp(join(tmpdir(), "linkedh-"))
process.env.BOT_FARM_WORKTREE_ROOT = join(home, "wt")
await sleep(600)
const PORT = 4849
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: `http://127.0.0.1:${PORT}` })
await sup.start()
startServer({ supervisor: sup, port: PORT })
const api = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const prompts = async (id) => (await (await fetch("http://127.0.0.1:4096/__prompts")).json()).filter((p) => p.id === id)
const ws = await sup.workspaces.add({ path: repo, name: "jps" })

console.log("linking a repo from elsewhere to the workspace")
let res = await api(`/api/workspaces/${ws.id}/repos`, { method: "POST", body: { path: spt } })
ok(res.status === 200 && res.body.linked[0].path === spt && res.body.linked[0].as === "spt" && res.body.services.includes(spt), "a repo outside the workspace is linked, mounted as spt/, and ticked for new workstreams")
res = await api(`/api/workspaces/${ws.id}/repos`, { method: "POST", body: { path: spt } })
ok(res.status === 400 && /already linked/.test(res.body.error), "twice is refused")
res = await api(`/api/workspaces/${ws.id}/repos`, { method: "POST", body: { path: join(base, "elsewhere") } })
ok(res.status === 400 && /not a git repository/.test(res.body.error), "a folder that is not a repo is refused")
const lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.linked?.length === 1, "the library lists it for the new-workstream dialog")

console.log("\na workstream takes it along")
const r = await sup.pipelines.start({ pipeline: "story", workspace: ws.id, story: "US1: something across repos", title: "Across" })
await sleep(400)
const project = sup.projects.get(r.projectId)
ok(project.worktree && await exists(join(project.worktree, "spt", "App.java")), "the workstream's worktree has spt/ in it")
ok((await git.status(join(project.worktree, "spt"))).branch === project.branch, "on the workstream's branch")
const first = sup.store.get(Object.values(r.sessions)[0])
const text = (await prompts(first.id)).at(-1)?.parts?.[0]?.text ?? ""
ok(text.includes("Repos in this worktree") && text.includes("./spt/"), "and the bots are told which repos are where")

console.log("\nadding one after the fact")
res = await api(`/api/projects/${r.projectId}/repos`, { method: "POST", body: { path: ui, as: "ui" } })
ok(res.status === 200 && res.body.rel === "ui" && await exists(join(project.worktree, "ui", "package.json")), "a running workstream gets a worktree of another repo, mounted as ui/")
ok((await git.status(project.worktree)).untracked === 0, "the parent repo does not see it as untracked")
const room = sup.projects.room(r.projectId, { create: false })
ok(room?.messages.some((m) => m.text.includes("ui/ is now in this worktree")), "the chat says so")
ok(sup.pipelines.run(r.id).notes?.some((n) => n.topic === "Repos in this worktree" && n.text.includes("./ui/")), "and so do the team notes")
res = await api(`/api/projects/${r.projectId}/repos`, { method: "POST", body: { path: ui } })
ok(res.status === 400 && /already in this workstream/.test(res.body.error), "the same repo twice is refused")
ok((await sup.workstreamRepos(sup.projects.get(r.projectId))).includes(ui), "it counts as one of the workstream's repos (for branches and delete)")

console.log("\ndeleting the workstream")
await sup.deleteWorkstream(r.projectId, { deleteBranch: true, force: true })
ok((await git.listWorktrees(spt)).length === 1 && (await git.listWorktrees(ui)).length === 1, "the worktrees in the other repos go too")
const branches = (await run("git", ["branch", "--list", "botfarm/*"], { cwd: ui })).stdout.trim()
ok(!branches, "and their botfarm/ branches")

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
