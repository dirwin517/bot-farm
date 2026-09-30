// Open questions travel with a handoff instead of stopping the line, unless
// the stage says to wait; the operator can let a held stage go on with answers.
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
const repo = await mkdtemp(join(tmpdir(), "ho-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "a"), "x")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "hoh-"))
await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: "http://127.0.0.1:4837" })
await sup.start()
startServer({ supervisor: sup, port: 4837 })
const texts = async (id) => (await sup.client.messages(id, { limit: 200 })).filter((m) => (m.info ?? m).role !== "assistant").flatMap((m) => (m.parts ?? []).map((p) => p.text ?? ""))
const idle = async (id) => { await sup.client.interrupt(id); sup.store.get(id).setStatus("idle") }

console.log("open questions do not stop the line")
const r = await sup.pipelines.start({ pipeline: "story", repo, branch: "feat/a", story: "DE238: DELETE should 409 when a FRID exists", title: "A" })
await sleep(300)
await idle(r.sessions.dev)
await sup.pipelines.complete(sup.tasks.get(r.taskIds.analyse), { summary: "Criteria written.", acceptance_criteria: ["409 on FRID"], open_questions: ["Which FRID statuses count?", "Is soft-delete in scope?"] })
await sleep(300)
ok(sup.tasks.get(r.taskIds.analyse).status === "done", "the stage is done")
ok(sup.tasks.get(r.taskIds.build).status === "active", "and the next bot picks up its card straight away")
const dev = (await texts(r.sessions.dev)).find((t) => t.includes("[botfarm] task"))
ok(dev?.includes("Which FRID statuses count?") && dev.includes("Settle them"), "carrying the open questions with it")
ok(dev?.includes("Finished analyse: Criteria written."), "the handoff notice rides along with the card")
ok(!(await texts(r.sessions.dev)).some((t) => t.startsWith("[botfarm]") && t.includes("Finished analyse") && !t.includes("[botfarm] task")), "instead of waking the bot on its own")
ok(!(await texts(r.sessions.qa)).some((t) => t.includes("Finished analyse")), "and later stages are not woken by it")

console.log("\na stage can choose to wait")
const r2 = await sup.pipelines.start({ pipeline: "story", repo, branch: "feat/b", story: "US1: another", title: "B" })
const run2 = sup.pipelines.run(r2.id)
run2.def.stages[0].hold_on_questions = true
sup.db.put("runs", run2)
await sleep(300)
await idle(r2.sessions.dev)
await sup.pipelines.complete(sup.tasks.get(r2.taskIds.analyse), { summary: "Written.", acceptance_criteria: ["x"], open_questions: ["Which API version?"] })
await sleep(300)
ok(sup.tasks.get(r2.taskIds.analyse).status === "review", "a holding stage waits in review")
ok(sup.tasks.get(r2.taskIds.build).status === "blocked", "and the next stage has not started")
const res = await fetch(`http://127.0.0.1:4837/api/tasks/${r2.taskIds.analyse}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "Use v1 only." }) })
ok(res.ok, "you can let it continue")
await sleep(300)
ok(sup.tasks.get(r2.taskIds.build).status === "active", "which starts the next bot")
const dev2 = (await texts(r2.sessions.dev)).find((t) => t.includes("[botfarm] task"))
ok(dev2?.includes("The operator's answer: Use v1 only."), "with your answer in its card")
ok(sup.rooms.rooms.get(run2.roomId).messages.some((m) => m.from === "operator" && m.text.includes("Use v1 only.")), "and in the chat")

console.log("\nchatter does not wake bots whose stage has not started")
const room = sup.rooms.rooms.get(sup.pipelines.run(r.id).roomId)
for (let i = 0; i < 8; i++) await sup.rooms.post(room, i % 2 ? null : sup.store.get(r.sessions.dev), `message ${i}`)
await sup.rooms.flushAll(sup.store.get(r.sessions.reviewer))
ok((await texts(r.sessions.reviewer)).length === 0, "not even when the backlog grows")

console.log("\nquestions for you come with choices")
const tokenFor = (id) => sup.mcpUrlFor(sup.store.get(id)).split("/").pop()
const call = async (id, name, args) => {
  sup.mcpCalls.set(id, Date.now())
  const res = await fetch(`http://127.0.0.1:4837/mcp/${tokenFor(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })
  return (await res.json()).result
}
const asked = await call(r.sessions.dev, "ask_human", { questions: [
  { question: "Which FRID statuses block the delete?", options: [{ label: "Active only", description: "Expired FRIDs are ignored" }, "Active and pending"], header: "FRID" },
  { question: "Which environments?", options: ["dev", "qa", "prod"], multiple: true },
  { question: "Anything else I should know?" },
] })
ok(!asked.isError, "a bot can ask several questions at once")
const q = sup.tasks.get(asked.structuredContent.task_id)
ok(q.questions.length === 3 && q.questions[0].options[0].description === "Expired FRIDs are ignored" && q.questions[1].multiple, "each with its own choices, single or multiple")
ok(q.questions[2].options.length === 0, "or none, for an open question")
await fetch(`http://127.0.0.1:4837/api/tasks/${q.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [{ picked: ["Active only"], text: "" }, { picked: ["dev", "qa"], text: "prod later" }, { picked: [], text: "" }] }) })
await sleep(200)
const got = (await texts(r.sessions.dev)).find((t) => t.includes("your operator answered"))
ok(got?.includes("→ Active only") && got.includes("→ dev, qa — prod later"), "your picks and your words go back together")
ok(got?.includes("(no answer — use your judgement)"), "and a question you skipped says so")
const one = await call(r.sessions.dev, "ask_human", { question: "Ship behind a flag?", options: ["yes", "no"] })
ok(sup.tasks.get(one.structuredContent.task_id).questions[0].options.length === 2, "the one-question form still works")

console.log("\nan agent's tools are enforced per turn")
const prod = sup.store.get(r.sessions.product)
prod.allowedTools = ["read", "grep", "glob", "list"]
const sw = await sup.toolSwitches(prod)
ok(sw && sw.bash === false && sw.edit === false && !("read" in sw) && !("grep" in sw), "everything not on its list is switched off")
ok(await sup.toolSwitches(sup.store.get(r.sessions.qa)) === undefined, "an agent with no list keeps every tool")

console.log("\nyour sign-off stage is a question too")
for (const st of ["build", "verify", "check"]) await sup.pipelines.release(sup.tasks.get(r.taskIds[st]), "")
const signoff = sup.tasks.get(r.taskIds.signoff)
ok(signoff.status === "waiting" && signoff.kind === "question", "it reaches you once the chain before it is done")
await fetch(`http://127.0.0.1:4837/api/tasks/${signoff.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [{ picked: ["Looks good — ship it"], text: "" }] }) })
await sleep(200)
ok(sup.tasks.get(signoff.id).status === "done" && sup.pipelines.run(r.id).status === "done", "answering it finishes the run")

console.log("\nbots with no open cards stay quiet")
const [devS, qaS, revS] = [r.sessions.dev, r.sessions.qa, r.sessions.reviewer].map((id) => sup.store.get(id))
for (const b of [devS, qaS, revS]) b.setStatus("idle")
ok(sup.pipelines.resting(qaS) && !sup.pipelines.resting(sup.store.get(r2.sessions.dev)), "a bot is resting once all its cards are done")
const count = async (id) => (await texts(id)).length
let n = await count(qaS.id)
await sup.rooms.post(room, devS, `All done here, thanks @${qaS.handle} and @${revS.handle}!`)
await sup.rooms.post(room, revS, "Great work everyone.")
await sup.rooms.flushAll(qaS)
ok(await count(qaS.id) === n, "thanks and sign-offs do not wake it, even at idle")
await sup.rooms.post(room, devS, `@${qaS.handle} did the 409 test run against qa?`)
ok(await count(qaS.id) === n + 1, "a direct question does")
ok((await texts(qaS.id)).some((t) => t.includes("Great work everyone.") && t.includes("did the 409")), "with what it missed")
n = await count(revS.id)
await sup.rooms.post(room, null, "One more thing: add a changelog line.")
ok(await count(revS.id) === n + 1, "and so does the operator")
ok((await texts(revS.id)).some((t) => t.includes("add a changelog") && t.includes("Do not post to acknowledge")), "and the frame says not to post just to agree")

console.log("\na partly done workstream can be restarted")
const r3 = await sup.pipelines.start({ pipeline: "story", repo, branch: "feat/c", story: "DE9: restart me", title: "C" })
await sleep(300)
await idle(r3.sessions.dev)
await sup.pipelines.complete(sup.tasks.get(r3.taskIds.analyse), { summary: "Criteria v1.", acceptance_criteria: ["a"] })
await sleep(200)
ok(sup.tasks.get(r3.taskIds.build).status === "active", "(build is under way)")
const project3 = sup.pipelines.run(r3.id).projectId
const before = { ...sup.pipelines.run(r3.id).sessions }
// Same bots, from the current stage
let out = await sup.pipelines.restart(project3, { fresh: false })
ok(out.from === "build" && out.fresh === 0, "by default from the first unfinished stage")
ok(sup.tasks.get(r3.taskIds.analyse).status === "done" && sup.tasks.get(r3.taskIds.analyse).handoff.summary === "Criteria v1.", "earlier stages keep their handoff")
ok(sup.tasks.get(r3.taskIds.build).status === "active" && sup.tasks.get(r3.taskIds.verify).status === "blocked", "the stage is handed out again and the rest wait")
// Fresh bots, from the start
out = await sup.pipelines.restart(project3, { stage: "analyse", fresh: true })
await sleep(300)
const after = sup.pipelines.run(r3.id).sessions
ok(out.fresh === 4 && Object.keys(before).every((k) => after[k] && after[k] !== before[k]), "fresh bots replace every old one")
ok(Object.values(before).every((id) => !sup.store.get(id)), "the old sessions leave the board")
ok(Object.values(after).every((id) => sup.store.get(id)?.directory === sup.store.get(after.product).directory), "the new ones work in the same worktree")
ok(sup.tasks.get(r3.taskIds.analyse).status === "active" && sup.tasks.get(r3.taskIds.analyse).assignee === after.product, "the first stage goes to the new product bot")
ok(!sup.tasks.get(r3.taskIds.analyse).handoff && sup.tasks.get(r3.taskIds.build).status === "blocked", "with the old handoff cleared")
const room3 = sup.rooms.rooms.get(sup.pipelines.run(r3.id).roomId)
ok(Object.values(after).every((id) => room3.members.has(id)) && Object.values(before).every((id) => !room3.members.has(id)), "the chat has the new team")
ok((await texts(after.product)).some((t) => t.includes("You are the product analyst")), "and the new bot is briefed again")

console.log("\na long opencode history does not hide the team")
for (let i = 0; i < 210; i++) await fetch("http://127.0.0.1:4096/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "old " + i, location: { directory: "/tmp/old" } }) })
const r4 = await sup.pipelines.start({ pipeline: "story", repo, branch: "feat/d", story: "DE10: after a long history", title: "D" })
await sup.discover()
ok(Object.values(r4.sessions).every((id) => sup.store.get(id)), "bots beyond the first page of sessions stay on the board")
ok(Object.values(after).every((id) => sup.store.get(id)), "including a freshly restarted team")

console.log("\na workstream can be deleted when you are done")
const r5 = await sup.pipelines.start({ pipeline: "story", repo, branch: "botfarm/delete-me", story: "DE11: throwaway", title: "E" })
await sleep(300)
const p5 = sup.pipelines.run(r5.id).projectId
const wt5 = sup.projects.get(p5).worktree
const room5 = sup.projects.get(p5).roomId
await writeFile(join(wt5, "scratch.txt"), "unsaved")
let pv = await (await fetch(`http://127.0.0.1:4837/api/projects/${p5}/delete`)).json()
ok(pv.changed === 1 && pv.files.includes("scratch.txt") && pv.branchOwned && pv.bots === 4, "the dialog is told what would go, uncommitted files first")
let del = await fetch(`http://127.0.0.1:4837/api/projects/${p5}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
ok(del.status === 409 && sup.projects.get(p5), "uncommitted work stops it unless you say so")
del = await fetch(`http://127.0.0.1:4837/api/projects/${p5}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true, deleteBranch: true }) })
ok(del.ok, "and then it goes")
ok(!sup.projects.get(p5) && !sup.pipelines.run(r5.id) && !sup.rooms.rooms.get(room5), "the workstream, its run and its chat are gone")
ok(sup.tasks.all({ projectId: p5 }).length === 0 && Object.values(r5.sessions).every((id) => !sup.store.get(id) && !sup.registry.get(id)), "and so are its cards and bots")
ok(!(await run("git", ["worktree", "list"], { cwd: repo })).stdout.includes(wt5), "the worktree is removed")
ok(!(await run("git", ["branch", "--list", "botfarm/delete-me"], { cwd: repo })).stdout.trim(), "and the botfarm branch, because you asked")
const p4 = sup.pipelines.run(r4.id).projectId
pv = await (await fetch(`http://127.0.0.1:4837/api/projects/${p4}/delete`)).json()
ok(pv.branch === "feat/d" && !pv.branchOwned, "a branch you named yourself is never offered")
await fetch(`http://127.0.0.1:4837/api/projects/${p4}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deleteBranch: true }) })
ok(!sup.projects.get(p4) && (await run("git", ["branch", "--list", "feat/d"], { cwd: repo })).stdout.trim(), "so it survives the delete")

console.log("\nan MCP server that was down when opencode opened the worktree is retried")
const botM = sup.store.get(Object.values(sup.pipelines.run(r3.id).sessions)[0])
await fetch("http://127.0.0.1:4096/__mcp-down?down=1")
await sup.refreshMcp([botM], { force: true })
ok(botM.mcp.servers.find((m) => m.name === "local-dev")?.status === "failed" && botM.mcp.servers.find((m) => m.name === "local-dev").error, "while it is still down the bot shows it failed, with why")
ok((await (await fetch("http://127.0.0.1:4096/__mcp-connects")).json()).some((c) => c.name === "local-dev" && c.directory === botM.directory), "and BotFarm asked opencode to connect it again")
ok(!(await (await fetch("http://127.0.0.1:4096/__mcp-connects")).json()).some((c) => c.name === "rag" || c.name === "botfarm" || c.name === "botfarm"), "but leaves disabled servers alone")
await fetch("http://127.0.0.1:4096/__mcp-down?down=0")
const rc = await fetch(`http://127.0.0.1:4837/api/sessions/${botM.id}/mcp/reconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
ok(rc.ok && (await rc.json()).servers.find((m) => m.name === "local-dev").connected, "once it is up, Reconnect brings it back")

console.log("\nworkspace config changes reach running workstreams")
const repo6 = await mkdtemp(join(tmpdir(), "cfg-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo6 })
const { mkdir: mkd, readFile: rf } = await import("node:fs/promises")
await mkd(join(repo6, ".opencode"))
const wsCfg = (mcp) => writeFile(join(repo6, ".opencode", "opencode.json"), JSON.stringify({ agent: { plan: { permission: { edit: "deny", "local-broad*": "allow" } } }, mcp }))
await wsCfg({ "local-broad": { type: "remote", url: "http://localhost:3333/sse/broad", enabled: true }, rally: { type: "remote", url: "https://mcp.rallydev.com/mcp", enabled: true } })
await writeFile(join(repo6, "a"), "x")
await run("git", ["add", "."], { cwd: repo6 })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo6 })
const r6 = await sup.pipelines.start({ pipeline: "story", repo: repo6, branch: "feat/cfg", story: "US3: config", title: "F" })
await sleep(300)
const p6 = sup.pipelines.run(r6.id).projectId
const wt6 = sup.projects.get(p6).worktree
const cfg6 = async () => JSON.parse(await rf(join(wt6, ".opencode", "opencode.json"), "utf8"))
let c6 = await cfg6()
ok(c6.mcp["local-broad"]?.url.includes("root=") && c6.mcp.botfarm, "the worktree starts with the workspace's MCP servers, pinned to it")
const prodPerm = c6.agent["botfarm-product"].permission ?? {}
ok(prodPerm["local-broad_*"] === "deny" && prodPerm["rally_*"] === "deny" && !("local-broad*" in prodPerm), "a bot limited to a few tools is denied MCP servers it does not list, even ones its base agent allows")
await wsCfg({ rally: { type: "remote", url: "https://mcp.rallydev.com/mcp", enabled: true } })
const disposedBefore = (await (await fetch("http://127.0.0.1:4096/__disposed")).json().catch(() => [])).length
const rr = await fetch(`http://127.0.0.1:4837/api/projects/${p6}/refresh-config`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
const rrOut = await rr.json()
c6 = await cfg6()
ok(rr.ok && !c6.mcp["local-broad"] && c6.mcp.rally && c6.mcp.botfarm, "Refresh tools drops a server removed from the workspace and keeps botfarm")
ok(!("local-broad_*" in (c6.agent["botfarm-product"].permission ?? {})), "and the bots' agents are rebuilt from the new setup")
ok(rrOut.reloaded || rrOut.pending, "then opencode re-opens the worktree, now or once the bots are idle")

console.log("\nthe chat can colour a bot")
const snap = sup.store.get(r.sessions.dev).snapshot()
ok(/^#[0-9a-f]{6}$/.test(snap.color?.fg) && /^#[0-9a-f]{6}$/.test(snap.color?.bg), "every session carries its avatar colours")

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
