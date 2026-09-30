// A pipeline that does not stall: bots are briefed when their stage starts,
// every stage sees the whole story, busy bots are not interrupted by peers,
// a bot that forgets to hand off is reminded and then escalated, the MCP
// caller is resolved inside a shared worktree, and an open session streams.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor, livePart, summarizeMessage } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import { toolOf, modelLabel, ingestMessages } from "../src/store.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))

console.log("parsing opencode shapes")
ok(toolOf({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" } } })?.name === "bash", "v1 tool part")
ok(toolOf({ type: "tool-invocation", toolName: "read", status: "done" })?.status === "completed", "other spellings of a tool call and of done")
ok(toolOf({ type: "text", text: "hi" }) === null, "text is not a tool")
ok(modelLabel({ providerID: "anthropic", modelID: "claude-sonnet-4-5" }) === "anthropic/claude-sonnet-4-5", "model from a v1 assistant message")
ok(modelLabel({ model: { providerID: "amazon-bedrock", id: "claude-opus-5" } }) === "amazon-bedrock/claude-opus-5", "model nested with id")
const fake = { model: null, totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tools: 0, toolErrors: 0 }, msgTokens: new Map(), seenTools: new Map(), toolLog: [], contextTokens: 0, record() {}, lastText: "" }
ingestMessages(fake, [{ info: { id: "m1", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: { input: 10, output: 5 } }, parts: [{ id: "p1", type: "tool", tool: "botfarm_room_post", state: { status: "completed" } }] }])
ok(fake.totals.tools === 1, "an MCP tool call is counted")
ok(fake.model === "anthropic/claude-sonnet-4-5", "and the model is picked up from the message, so it can be priced")
ingestMessages(fake, [
  { info: { id: "m3", role: "user", model: { providerID: "anthropic", modelID: "claude-opus-4-5", variant: "high" } }, parts: [] },
  { info: { id: "m2", role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-5", mode: "build", tokens: { input: 1, output: 1 } }, parts: [] },
])
ok(fake.model === "anthropic/claude-opus-4-5" && fake.variant === "high" && fake.mode === "build", "the newest model, its reasoning level and the agent are picked up")
const lp = livePart({ type: "message.part.updated", properties: { part: { id: "p9", messageID: "m9", sessionID: "s", type: "text", text: "Reading the" }, delta: " the" } })
ok(lp?.part.kind === "text" && lp.messageId === "m9" && lp.delta === " the", "a part event becomes a live frame")
ok(livePart({ properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "x" } })?.delta === "x", "so does a bare delta")
ok(summarizeMessage({ info: { id: "m", role: "assistant" }, parts: [{ type: "reasoning", text: "hmm" }, { type: "tool", tool: "grep", state: { status: "running", input: { pattern: "FRID" } } }] }).parts.length === 2, "transcripts keep thinking and tool steps")

const repo = await mkdtemp(join(tmpdir(), "flow-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "README.md"), "# demo\n")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "flowhome-"))
await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: "http://127.0.0.1:4817" })
await sup.start()
startServer({ supervisor: sup, port: 4817 })

const story =
  "DE238: DELETE rest/v1/customers/<custid>/eligibilities should error if a FRID exists. Make sure this error bubbles up to the caller with a 409 and the FRID id in the body, and that nothing is deleted."
const r = await sup.pipelines.start({ pipeline: "story", repo, branch: "feat/de238", story })
await sleep(400)
// What a bot was sent (the mock also writes assistant chatter for busy sessions).
const texts = async (id) =>
  (await sup.client.messages(id, { limit: 200 })).filter((m) => (m.info ?? m).role !== "assistant").flatMap((m) => (m.parts ?? []).map((p) => p.text ?? ""))

console.log("\nbriefing happens when the stage starts")
const product = await texts(r.sessions.product)
ok(product.length === 1, "the first bot gets one message")
ok(product[0].includes("You are the product analyst") && product[0].includes("[botfarm] task"), "with its brief and its task together")
for (const p of ["dev", "qa", "reviewer"]) ok((await texts(r.sessions[p])).length === 0, `${p} is told nothing yet`)
const room = sup.rooms.rooms.get(r.roomId)
ok(room.topic.length <= 91 && room.topic.endsWith("…") && !room.topic.includes("bubbles u…"), `the topic is a label cut at a word ("${room.topic}")`)

console.log("\na busy bot is not interrupted by its peers")
const devS = sup.store.get(r.sessions.dev)
const prodS = sup.store.get(r.sessions.product)
prodS.setStatus("busy")
await sup.rooms.post(room, devS, `@${prodS.handle} can you post the full criteria?`)
ok((await texts(prodS.id)).length === 1, "a mention waits while the product bot works")
prodS.setStatus("idle")
await sup.rooms.flushAll(prodS)
ok((await texts(prodS.id)).some((t) => t.includes("full criteria")), "and arrives when it finishes")
await sup.rooms.post(room, null, "operator here")
ok((await texts(prodS.id)).some((t) => t.includes("operator here")), "the operator reaches a working bot at once")
ok(!(await texts(devS.id)).some((t) => t.includes("operator here")), "but does not wake a bot whose stage has not started")
await sup.rooms.post(room, null, `@${prodS.handle} only you`)
ok(!(await texts(sup.store.get(r.sessions.qa).id)).some((t) => t.includes("only you")), "an @mention from the operator reaches only that bot")

console.log("\nthe caller is found inside a shared worktree")
ok(new Set(Object.values(r.sessions).map((id) => sup.store.get(id).directory)).size === 1, "all four bots share one worktree")
const token = sup.mcpUrlFor(sup.store.get(r.sessions.reviewer)).split("/").pop()
sup.mcpCalls.clear()
for (const id of Object.values(r.sessions)) sup.store.get(id).setStatus("idle")
sup.mcpCalls.set(prodS.id, Date.now())
ok((await sup.callerForToken(token)).id === prodS.id, "the session with an botfarm_ tool in flight is the caller, whatever URL it used")
sup.mcpCalls.clear()
devS.setStatus("busy")
ok((await sup.callerForToken(token)).id === devS.id, "failing that, the only busy one")
devS.setStatus("idle")

console.log("\nhanding off starts the next stage with its brief")
const call = async (name, args) => {
  const res = await fetch(`http://127.0.0.1:4817/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })
  return (await res.json()).result
}
// The operator's message above woke the dev bot; let it finish first.
await sup.client.interrupt(devS.id)
devS.setStatus("idle")
// Deliberately ambiguous: nobody is marked as calling, so the URL owner
// (the reviewer) is the best guess. The task id should still win.
const out = await call("task_complete", { task_id: r.taskIds.analyse, summary: "Criteria written.", acceptance_criteria: ["DELETE with a FRID returns 409", "nothing is deleted"] })
ok(!out.isError, "the product bot's handoff is accepted even when attributed to a worktree-mate")
await sleep(300)
const dev = await texts(devS.id)
const task = dev.find((t) => t.includes("[botfarm] task"))
ok(task && task.includes("You are the engineer"), "the dev bot is briefed with its first task")
ok(task?.includes("DELETE with a FRID returns 409") && task.includes("bubbles up to the caller"), "and gets the criteria and the whole story")
ok(task?.includes("operator here") && task.includes("before your stage started"), "and what you said in the chat before it started")

console.log("\na forgotten handoff is noticed")
const build = sup.tasks.get(r.taskIds.build)
ok(build.status === "active", "the build is active")
const t0 = Date.now() + 60_000
const quiet = { ...devS.totals }
Object.assign(devS.totals, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
sup.tasks.save(Object.assign(sup.tasks.get(r.taskIds.build), { tokensAtStart: 0, noRun: false }))
await sup.pipelines.checkForgotten(devS, { now: t0 })
ok(!(await texts(devS.id)).some((t) => t.includes("still open")) && sup.store.events.some((e) => /never ran/.test(e.text)), "a bot that never spent a token is reported as not running, not nagged")
Object.assign(devS.totals, quiet, { output: (quiet.output ?? 0) + 500 })
await sup.pipelines.checkForgotten(devS, { now: t0 })
ok((await texts(devS.id)).some((t) => t.includes("still open")), "going idle with it open gets a reminder")
await sup.pipelines.checkForgotten(devS, { now: t0 + 5_000 })
ok(!sup.tasks.forHuman().some((t) => t.askedBy === devS.id), "not escalated straight away")
await sup.pipelines.checkForgotten(devS, { now: t0 + 60_000 })
const q = sup.tasks.forHuman().find((t) => t.askedBy === devS.id)
ok(q && q.title.includes("stopped without finishing"), "stopping again puts it in front of you")
ok(sup.tasks.get(r.taskIds.build).status === "review", "and the task waits in review")

console.log("\nopencode's own errors reach the bot")
const logFile = join(home, "opencode.log")
await writeFile(logFile, "timestamp=x level=INFO message=hello\n")
sup.opencodeLog = logFile
await sup.watchOpencodeLog() // starts at the end
const { appendFile } = await import("node:fs/promises")
await appendFile(logFile, `timestamp=y level=ERROR run=1 message="Failed to drain Session" cause="SessionRunnerModel.VariantUnavailableError: Variant unavailable for amazon-bedrock/anthropic.claude-sonnet-5: medium\\n    at z8 (/x.js:4:1)" sessionID=${devS.id}\n`)
await sup.watchOpencodeLog()
ok(devS.status === "error" && /Variant unavailable/.test(devS.lastError), `a turn that dies in opencode shows on the bot ("${devS.lastError}")`)

console.log("\nan open session streams over the socket")
const reviewer = sup.store.get(r.sessions.reviewer)
await sup.send(reviewer.id, "start working") // the mock streams parts for busy sessions
const frames = []
const ws = new WebSocket("ws://127.0.0.1:4817/api/socket")
await new Promise((res) => (ws.onopen = res))
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t) frames.push(m) }
ws.send(`watch:${reviewer.id}`)
await sleep(3000)
const tr = frames.filter((f) => f.t === "transcript" && f.sessionId === reviewer.id)
ok(tr.length >= 2, `transcript frames keep coming while it works (${tr.length} in 3s)`)
ok(tr.at(-1)?.transcript.some((m) => m.parts?.some((p) => p.kind === "tool")), "with its tool calls in them")
ok(!frames.some((f) => f.sessionId && f.sessionId !== reviewer.id), "and nothing about sessions nobody is watching")
ws.send(`unwatch:${reviewer.id}`)
await sleep(300)
const before = frames.length
await sleep(2000)
ok(frames.length === before, "closing it stops the stream")
ws.close()

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
