// Fan-out and join: a stage split into one card per item of an earlier
// handoff, worked by several bots of one kind at once; "after:" for stages
// that run side by side (TDD); time/token/$ limits that stop and ask.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))
const repo = await mkdtemp(join(tmpdir(), "par-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "a"), "x")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "parh-"))
await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: "http://127.0.0.1:4839" })
await sup.start()
startServer({ supervisor: sup, port: 4839 })
const texts = async (id) => (await sup.client.messages(id, { limit: 200 })).filter((m) => (m.info ?? m).role !== "assistant").flatMap((m) => (m.parts ?? []).map((p) => p.text ?? ""))
const idleAll = () => { for (const s of sup.store.list()) s.setStatus("idle") }
const T = (id) => sup.tasks.get(id)

sup.pipelines.definitions.set("fan", {
  id: "fan",
  title: "Plan, build in parallel, test alongside",
  stages: [
    { id: "plan", persona: "product", title: "Plan the pieces", receives: [], prompt: "{{story}}" },
    { id: "build", persona: "dev", title: "Build", receives: ["plan"], split: "tasks", parallel: 3, limits: { minutes: 30 }, prompt: "Build it." },
    { id: "tests", persona: "qa", title: "Write the tests first", receives: ["plan"], after: ["plan"], prompt: "Write failing tests for the criteria." },
    { id: "check", persona: "reviewer", title: "Check", receives: ["build", "tests"], after: ["build", "tests"], prompt: "{{#handoffs.build}}{{summary}}{{/handoffs.build}}" },
  ],
})

console.log("a stage that waits on an earlier one, not the one before it")
const r = await sup.pipelines.start({ pipeline: "fan", repo, branch: "feat/fan", story: "US9: ten little changes", title: "Fan", limits: { minutes: 600 } })
await sleep(300)
ok(T(r.taskIds.plan).status === "active" && T(r.taskIds.build).status === "blocked" && T(r.taskIds.tests).status === "blocked", "only the first stage starts")
const plan = (await texts(r.sessions.product)).find((t) => t.includes("[botfarm] task"))
ok(plan?.includes("tasks") && plan.includes("REQUIRED") && plan.includes("dev bot"), "the stage feeding a split is asked for a task list")
idleAll()
await sup.pipelines.complete(T(r.taskIds.plan), { summary: "Four pieces.", acceptance_criteria: ["all four"], tasks: ["Add the DAO method", { title: "Add the endpoint", detail: "DELETE /things/{id} returns 409 when a FRID exists" }, "Wire the service", "Update the docs"] })
await sleep(400)
const build = T(r.taskIds.build)
ok(T(r.taskIds.tests).status === "active", "QA starts on the tests at the same time as the devs (after: [plan])")
ok(build.children?.length === 4 && build.status === "active", "the build card fans out into one card per item")
const kids = build.children.map(T)
ok(kids[1].title === "Add the endpoint" && kids[1].item.detail.includes("409") && kids[1].item.total === 4, "each with its own title and detail")
const devs = sup.projects.sessions(r.projectId).filter((s) => s.persona === "dev")
ok(devs.length === 3, `up to three dev bots work it (${devs.length})`)
ok(kids.filter((k) => k.status === "active").length === 3 && kids.filter((k) => k.status === "queued").length === 1, "three pieces at once, the fourth waits its turn")
ok(new Set(kids.filter((k) => k.assignee).map((k) => k.assignee)).size === 3, "each on a different bot")
const kidPrompt = (await texts(kids[0].assignee)).find((t) => t.includes(kids[0].id))
ok(kidPrompt?.includes("Your part — 1 of 4: Add the DAO method") && kidPrompt.includes("Do only your piece"), "a piece knows which part it is and that others share the worktree")
ok(kidPrompt?.includes("You are @"), "a new dev bot gets the dev brief with its first piece")
ok(sup.pipelines.run(r.id).sessions["dev-2"] && sup.rooms.rooms.get(r.roomId ?? sup.pipelines.run(r.id).roomId).members.size >= 6, "the extra bots join the team and the chat")

console.log("\nthe stage after waits for every piece")
const first = kids.find((k) => k.status === "active")
idleAll()
await sup.pipelines.complete(T(first.id), { summary: "DAO method added.", artifacts: ["Dao.java"] })
await sleep(300)
ok(T(kids.find((k) => k.status === "queued").id).status === "active", "a finished bot picks up the waiting piece")
ok(T(r.taskIds.build).status === "active" && T(r.taskIds.check).status === "blocked", "the build card is still open")
for (const k of kids.map((k) => T(k.id)).filter((k) => k.status === "active")) {
  idleAll()
  await sup.pipelines.complete(k, { summary: `Did ${k.title}.`, artifacts: [`${k.item.index}.java`], open_questions: k.item.index === 4 ? ["Which doc site?"] : [] })
}
await sleep(300)
const joined = T(r.taskIds.build)
ok(joined.status === "done" && joined.handoff.parts.length === 4, "when the last piece lands, the card is done")
ok(joined.handoff.summary.includes("DAO method added.") && joined.handoff.summary.includes("[2/4] Add the endpoint") && joined.handoff.artifacts.length === 4, "with every piece's handoff joined")
ok(joined.handoff.open_questions.includes("Which doc site?"), "open questions from a piece travel on")
ok(T(r.taskIds.check).status === "blocked", "the reviewer still waits for QA")
idleAll()
await sup.pipelines.complete(T(r.taskIds.tests), { summary: "Tests written, failing as expected." })
await sleep(300)
ok(T(r.taskIds.check).status === "active", "and starts once both are in")
const check = (await texts(r.sessions.reviewer)).find((t) => t.includes("[botfarm] task"))
ok(check?.includes("DAO method added.") && check.includes("Did Update the docs."), "reading the joined handoff")

console.log("\na card over its limit stops and asks")
const r2 = await sup.pipelines.start({ pipeline: "fan", repo, branch: "feat/fan2", story: "US10: two", title: "Fan2" })
await sleep(300)
idleAll()
await sup.pipelines.complete(T(r2.taskIds.plan), { summary: "Two.", tasks: ["one", "two"] })
await sleep(300)
const piece = T(T(r2.taskIds.build).children[0])
ok(sup.projects.sessions(r2.projectId).filter((s) => s.persona === "dev").length === 2, "two pieces bring two dev bots, not three")
ok(!sup.tasks.all({ projectId: r.projectId }).some((t) => t.parentId === r2.taskIds.build), "(and this workstream's pieces stay here)")
await sup.pipelines.checkBudgets(Date.now() + 40 * 60_000) // past 30 min even with a Seasoned +10%
let p2 = T(piece.id)
ok(p2.status === "review" && p2.budget?.kind === "minutes", "past its 30 minutes it is stopped and waits for you")
ok(sup.store.events.some((e) => /reached its time/.test(e.text)), "with a note saying why")
let res = await fetch(`http://127.0.0.1:4839/api/tasks/${piece.id}/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "continue" }) })
p2 = T(piece.id)
ok(res.ok && p2.status === "active" && p2.limits.minutes > 31 && !p2.budget, "Continue gives it half as much again and wakes the bot")
ok((await texts(p2.assignee)).some((t) => t.includes("gave you more room")), "which is told to carry on")

console.log("\na workstream over its limit stops every bot")
await fetch(`http://127.0.0.1:4839/api/projects/${r2.projectId}/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limits: { tokens: 1 } }) })
sup.store.get(r2.sessions.dev).totals.output += 50
await sup.pipelines.checkBudgets()
const run2 = sup.pipelines.run(r2.id)
ok(run2.paused?.kind === "tokens", "past its token limit the workstream pauses")
const snap = JSON.parse(JSON.stringify(sup.snapshot?.() ?? {}))
res = await fetch(`http://127.0.0.1:4839/api/projects/${r2.projectId}/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "continue", limits: { tokens: 10 } }) })
ok(!res.ok && sup.pipelines.run(r2.id).paused, "it will not resume into a limit it is still over")
res = await fetch(`http://127.0.0.1:4839/api/projects/${r2.projectId}/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "continue", limits: { tokens: 1_000_000, usd: 20 } }) })
ok(res.ok && !sup.pipelines.run(r2.id).paused && sup.pipelines.run(r2.id).limits.usd === 20, "raising it resumes the workstream")
res = await fetch(`http://127.0.0.1:4839/api/tasks/${T(r2.taskIds.build).children[1]}/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limits: { usd: 2 } }) })
ok(res.ok && T(T(r2.taskIds.build).children[1]).limits.usd === 2, "a card's limits can be set by hand")

console.log("\nrestarting puts a split card back together")
await sup.pipelines.restart(r.projectId, { stage: "build", fresh: false })
await sleep(300)
const again = T(r.taskIds.build)
ok(again.children?.length === 4 && again.children.every((id) => !kids.some((k) => k.id === id)), "and fans it out again from the handoff")

console.log("\npipelines check the new fields")
const { checkPipelineDoc } = await import("../src/pipelines.mjs")
const probs = checkPipelineDoc({ stages: [{ id: "a", persona: "dev" }, { id: "b", persona: "dev", after: ["zz"], parallel: 40, limits: { usd: -1 } }] }, new Map([["dev", {}]]))
ok(probs.some((p) => p.includes('after "zz"')) && probs.some((p) => p.includes("parallel")) && probs.some((p) => p.includes("limits")), "bad after / parallel / limits are reported")

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
