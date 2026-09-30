// Paths people actually type, and a parent repo with services cloned into a
// gitignored folder — the layout that broke "start a pipeline".
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, mkdir, readdir } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import * as git from "../src/git.mjs"

const run = promisify(execFile)
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))

const commit = async (dir, msg = "init") => {
  await run("git", ["add", "-A"], { cwd: dir })
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { cwd: dir })
}
const init = async (dir) => {
  await mkdir(dir, { recursive: true })
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir })
}

console.log("paths as typed")
ok(git.expandPath("~") === homedir(), "a bare tilde expands to $HOME")
ok(git.expandPath("~/workspace/x") === join(homedir(), "workspace/x"), "and so does ~/workspace/x")
ok(git.expandPath("  ~/a/b/  ") === join(homedir(), "a/b"), "surrounding whitespace is ignored")
ok(git.expandPath("$HOME/x") === join(homedir(), "x"), "environment variables expand")
ok(git.expandPath("/tmp/abs") === "/tmp/abs", "absolute paths are left alone")

console.log("\nsaying what is actually wrong")
let info = await git.inspect("~/definitely-not-here-" + Math.random().toString(36).slice(2))
ok(!info.exists && /no such directory/.test(info.reason), `a missing path says so ("${info.reason}")`)
const plain = await mkdtemp(join(tmpdir(), "plain-"))
info = await git.inspect(plain)
ok(info.exists && !info.isRepo && /not a git repository/.test(info.reason), "a real directory that is not a repo says that instead")

console.log("\na parent repo with services in a gitignored folder")
const parent = await mkdtemp(join(tmpdir(), "java-parent-services-"))
await init(parent)
await writeFile(join(parent, "pom.xml"), "<project/>\n")
await writeFile(join(parent, ".gitignore"), "src/\n")
await commit(parent)
const services = ["billing", "identity", "notifications"]
for (const name of services) {
  const dir = join(parent, "src", name)
  await init(dir)
  await writeFile(join(dir, "README.md"), `# ${name}\n`)
  await commit(dir)
}

info = await git.inspect(parent)
ok(info.isRepo, "the parent is recognised as a repository")
ok(info.nested.length === 3, `its ${info.nested.length} nested repos are found even though git ignores them`)
ok(info.nested.every((n) => n.rel.startsWith("src/")), "reported by path relative to the parent")
ok(info.nested[0].branch === "main", "with the branch each one is on")

console.log("\none worktree per repo, same layout")
const set = await git.addWorktreeSet(parent, "feat/sso", {
  path: join(tmpdir(), "wt-" + Date.now()),
  include: ["src/billing", "src/identity"],
})
ok(set.branch === "feat/sso", "the parent gets the branch")
ok(set.children.length === 2 && set.children.every((c) => !c.error), "so do the selected services")
const listed = await readdir(join(set.path, "src"))
ok(listed.includes("billing") && listed.includes("identity"), "laid out where the agent expects them")
ok(!listed.includes("notifications"), "and services you did not select are left out")
const billingBranch = (await git.status(join(set.path, "src", "billing")))?.branch
ok(billingBranch === "feat/sso", "each service worktree is on its own copy of the branch")
const origin = await git.status(join(parent, "src", "billing"))
ok(origin.branch === "main", "while the original checkout stays where it was")

console.log("\nchanges across all of them")
await writeFile(join(set.path, "pom.xml"), "<project><module/></project>\n")
await writeFile(join(set.path, "src", "billing", "Invoice.java"), "class Invoice {}\n")
await writeFile(join(set.path, "src", "identity", "README.md"), "# identity\nchanged\n")
const changed = await git.changedFiles(set.path)
ok(changed.some((f) => f.path === "pom.xml"), "the parent's own change is listed")
ok(changed.some((f) => f.path === "src/billing/Invoice.java" && f.repo === "src/billing"), "a new file in a service is listed, tagged with its repo")
ok(changed.some((f) => f.path === "src/identity/README.md" && f.removed >= 0), "as is an edit inside another service")

console.log("\ndiffing a file that belongs to a nested repo")
const diff = await git.diffFile(set.path, "src/identity/README.md")
ok(/changed/.test(diff), "the diff is fetched from the repo that owns the file")

console.log("\ncleaning up removes every worktree it made")
const removed = await git.removeWorktreeSet(set.path, { force: true })
ok(removed.length === 2, `both service worktrees were removed (${removed.join(", ")})`)
const left = await git.nestedRepos(parent)
ok(left.length === 3, "and the original checkouts are untouched")

console.log("\na repo from somewhere else, mounted in the worktree")
{
  const ws = await mkdtemp(join(tmpdir(), "jps-"))
  await init(ws); await writeFile(join(ws, "pom.xml"), "<project/>\n"); await commit(ws)
  const spt = join(await mkdtemp(join(tmpdir(), "elsewhere-")), "spt")
  await init(spt); await writeFile(join(spt, "App.java"), "class App {}\n"); await commit(spt)
  const srcs = git.serviceSources(ws, [spt, { path: spt, as: "spt-two" }, "src/x"])
  ok(srcs[0].external && srcs[0].rel === "spt" && srcs[1].rel === "spt-two" && !srcs[2].external && srcs[2].source === join(ws, "src/x"), "an absolute path mounts under its folder name (or `as`); a relative one is nested")
  let threw = await git.checkService(ws, join(tmpdir(), "nope-" + Date.now())).then(() => null, (e) => e.message)
  ok(/not a git repository/.test(threw ?? ""), "a folder that is not a repo is refused")
  threw = await git.checkService(ws, spt, { taken: ["spt"] }).then(() => null, (e) => e.message)
  ok(/already has something at spt/.test(threw ?? ""), "so is a mount name already taken")
  const wtPath = join(await mkdtemp(join(tmpdir(), "wt-")), "b")
  const set2 = await git.addWorktreeSet(ws, "botfarm/ext", { path: wtPath, include: [spt] })
  const child = set2.children[0]
  ok(!child.error && child.path === join(wtPath, "spt") && child.branch === "botfarm/ext", "it gets a worktree inside the workstream's, on the same branch")
  const st = await git.status(wtPath)
  ok(st.untracked === 0, "and the parent's git status does not list it")
  await writeFile(join(child.path, "New.java"), "class New {}\n")
  ok((await git.changedFiles(wtPath)).some((f) => f.path === "spt/New.java" && f.repo === "spt"), "changes in it show up with the workstream's")
  const snap = await git.snapshot(wtPath)
  ok(Object.keys(snap.repos).includes("spt"), "and in card snapshots")
  const removed2 = await git.removeWorktreeSet(wtPath, { force: true })
  ok(removed2.includes("spt") && (await git.listWorktrees(spt)).length === 1, "removing the workstream removes its worktree of the other repo too")
}

console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
