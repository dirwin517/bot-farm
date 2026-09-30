// The work as patches, applied to the real checkouts.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))
const G = (cwd, ...args) => run("git", args, { cwd }).then((r) => r.stdout)
const commit = async (dir, msg = "i") => { await G(dir, "add", "-A"); await G(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg) }
const mkrepo = async (dir, files) => {
  await mkdir(dir, { recursive: true })
  await G(dir, "init", "-q", "-b", "main")
  for (const [f, t] of Object.entries(files)) { await mkdir(join(dir, f, ".."), { recursive: true }); await writeFile(join(dir, f), t) }
  await commit(dir)
  return dir
}
const base = await mkdtemp(join(tmpdir(), "patch-"))
const repo = await mkrepo(join(base, "java-parent-services"), { "pom.xml": "<project/>\n", ".gitignore": "src/\n", "Readme.md": "one\ntwo\nthree\n" })
const svc = await mkrepo(join(repo, "src", "card-service"), { "Card.java": "class Card {\n  int a = 1;\n}\n" })
const spt = await mkrepo(join(base, "elsewhere", "spt"), { "App.java": "class App {}\n" })
const home = await mkdtemp(join(tmpdir(), "patchh-"))
process.env.BOT_FARM_WORKTREE_ROOT = join(home, "wt")
await sleep(600)
const PORT = 4851
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: `http://127.0.0.1:${PORT}` })
await sup.start()
startServer({ supervisor: sup, port: PORT })
const api = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const ws = await sup.workspaces.add({ path: repo, name: "jps" })
await sup.workspaces.addLinked(ws.id, { path: spt })
const r = await sup.pipelines.start({ pipeline: "story", workspace: ws.id, story: "US1", title: "Patches", services: ["src/card-service", spt] })
await sleep(400)
const wt = sup.projects.get(r.projectId).worktree

// The "bots'" work: an edit, a new file, a commit on the branch, work in a service and a linked repo.
await writeFile(join(wt, "Readme.md"), "one\ntwo changed\nthree\n")
await writeFile(join(wt, "New.java"), "class New {}\n")
await writeFile(join(wt, "src", "card-service", "Card.java"), "class Card {\n  int a = 2;\n}\n")
await writeFile(join(wt, "spt", "Extra.java"), "class Extra {}\n")
await writeFile(join(wt, "spt", "App.java"), "class App { int x; }\n")
await commit(join(wt, "spt"), "bot committed this one")

console.log("what would go where")
let res = await api(`/api/projects/${r.projectId}/patches`)
const byRel = Object.fromEntries(res.body.repos.map((x) => [x.rel, x]))
ok(res.status === 200 && res.body.repos.length === 3, "one patch per repo: the parent, the service and the linked repo")
ok(byRel[""].files.map((f) => f.path).sort().join() === "New.java,Readme.md", "the parent's patch has the edit and the new file — none of BotFarm's own files")
ok(byRel["src/card-service"].files.length === 1 && byRel["spt"].files.length === 2 && byRel["spt"].commits === 1, "committed work on the branch counts too")
ok(res.body.repos.every((x) => x.check?.how === "clean"), "and every one would apply cleanly")
ok((await G(wt, "status", "--porcelain")).includes("?? New.java"), "the worktree's own index is left alone")
const dl = await fetch(`http://127.0.0.1:${PORT}/api/projects/${r.projectId}/patches/file?rel=src%2Fcard-service`)
ok(dl.status === 200 && (await dl.text()).includes("+  int a = 2;"), "each patch can be downloaded")

console.log("\napplying")
res = await api(`/api/projects/${r.projectId}/patches/apply`, { method: "POST", body: {} })
ok(res.status === 200 && res.body.results.filter((x) => x.how === "clean").length === 3, "all three go in cleanly")
ok((await readFile(join(repo, "Readme.md"), "utf8")).includes("two changed") && await stat(join(repo, "New.java")).then(() => true, () => false), "the real checkout has the edit and the new file")
ok((await readFile(join(svc, "Card.java"), "utf8")).includes("a = 2") && (await readFile(join(spt, "App.java"), "utf8")).includes("int x"), "and so do the service and the linked repo")
ok((await G(repo, "log", "--oneline")).trim().split("\n").length === 1 && (await G(spt, "log", "--oneline")).trim().split("\n").length === 1, "nothing is committed for you")
ok((await G(repo, "diff", "--cached", "--name-only")).trim() === "", "and nothing is staged: review and commit as you like")
ok(sup.projects.room(r.projectId, { create: false })?.messages.some((m) => m.text.includes("Applied the work")), "the chat says what happened")
ok((await api(`/api/projects/${r.projectId}/patches`)).body.repos.every((x) => x.check?.how === "present"), "afterwards the preview says it is already in your repos")

console.log("\nundo")
res = await api(`/api/projects/${r.projectId}/patches/undo`, { method: "POST", body: {} })
ok(res.status === 200 && res.body.every((x) => x.undone), "Undo takes the clean ones back out")
ok(!(await readFile(join(repo, "Readme.md"), "utf8")).includes("changed") && (await G(spt, "status", "--porcelain")).trim() === "", "and the real repos are as they were")

console.log("\nwhen the real repo moved on")
await writeFile(join(repo, "Readme.md"), "one\ntwo mine\nthree\n")
await commit(repo, "you changed the same line")
res = await api(`/api/projects/${r.projectId}/patches`)
ok(res.body.repos.find((x) => x.rel === "").check.how !== "clean", "the preview says the parent will not apply cleanly")
res = await api(`/api/projects/${r.projectId}/patches/apply`, { method: "POST", body: { repos: [""] } })
const parent = res.body.results[0]
ok(res.body.results.length === 1 && ["conflicts", "3way", "partial"].includes(parent.how), `it is applied as far as it goes (${parent.how})`)
ok(parent.how !== "conflicts" || (await readFile(join(repo, "Readme.md"), "utf8")).includes("<<<<<<<"), "with conflict markers to resolve, like a merge")
ok(await stat(join(repo, "New.java")).then(() => true, () => false), "the parts that fit are in")

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
