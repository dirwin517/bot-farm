// Plan → Code → Verify → Fail → Code → Verify → Pass: sending work back.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import { checkPipelineDoc } from "../src/pipelines.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))
const repo = await mkdtemp(join(tmpdir(), "loop-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "a"), "x")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "looph-"))
process.env.BOT_FARM_WORKTREE_ROOT = join(home, "wt")
await sleep(600)
const PORT = 4847
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: `http://127.0.0.1:${PORT}` })
await sup.start()
startServer({ supervisor: sup, port: PORT })
const api = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const prompts = async (id) => (await (await fetch("http://127.0.0.1:4096/__prompts")).json()).filter((p) => p.id === id)
const lastText = async (id) => (await prompts(id)).at(-1)?.parts?.[0]?.text ?? ""
const T = (id) => sup.tasks.get(id)
const idleAll = () => { for (const s of sup.store.list()) s.setStatus("idle") }
const token = (s) => sup.mcpUrlFor(s).split("/").pop()
const rpc = async (s, name, args) => { sup.mcpCalls.set(s.id, Date.now()); return (await (await fetch(`http://127.0.0.1:${PORT}/mcp/${token(s)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result }

const ws = await sup.workspaces.add({ path: repo, name: "loop" })
const lib = await sup.pipelines.lib(ws.id)
lib.definitions.set("tdd", { id: "tdd", title: "TDD loop", stages: [
  { id: "plan", persona: "product", receives: [], prompt: "{{story}}" },
  { id: "code", persona: "dev", receives: ["plan"], prompt: "Build it." },
  { id: "verify", persona: "qa", receives: ["plan", "code"], max_rounds: 2, prompt: "Verify it." },
] })
lib.definitions.set("fan", { id: "fan", title: "Fan", stages: [
  { id: "plan", persona: "product", receives: [], prompt: "{{story}}" },
  { id: "build", persona: "dev", receives: ["plan"], split: "tasks", parallel: 2, prompt: "Build your piece." },
  { id: "verify", persona: "qa", receives: ["build"], prompt: "Verify it." },
] })
for (const [k, v] of sup.pipelines.personas) if (!lib.personas.has(k)) lib.personas.set(k, v)

console.log("the pipeline file")
const bad = checkPipelineDoc({ id: "x", stages: [{ id: "a", persona: "dev" }, { id: "b", persona: "qa", send_back: ["zzz"], max_rounds: 99 }] }, lib.personas)
ok(bad.some((p) => p.includes('"zzz"')) && bad.some((p) => p.includes("max_rounds")), "send_back and max_rounds are checked")

console.log("\nCode → Verify → Fail → Code → Verify")
const r = await sup.pipelines.start({ pipeline: "tdd", workspace: ws.id, story: "DE238: DELETE should 409 when a FRID exists", title: "Loop" })
await sleep(300); idleAll()
await sup.pipelines.complete(T(r.taskIds.plan), { summary: "Criteria set.", acceptance_criteria: ["409 when a FRID is active"] })
await sleep(300); idleAll()
const code = () => T(r.taskIds.code), verify = () => T(r.taskIds.verify)
const dev = sup.store.get(code().assignee)
await sup.pipelines.complete(code(), { summary: "Added the FRID check in CardService.", artifacts: ["CardService.java"] })
await sleep(300); idleAll()
const qa = sup.store.get(verify().assignee)
ok(verify().status === "active" && (await lastText(qa.id)).includes("botfarm_send_back") && (await lastText(qa.id)).includes("code (@"), "the checker is told it can send work back, and to whom")
let out = await rpc(qa, "send_back", { task_id: verify().id, to: "code", reason: "DELETE still returns 500", failures: ["FridDeleteIT.deleteWithActiveFrid: expected 409 but was 500 (CardController.java:88)"] })
await sleep(300)
ok(!out.isError && out.structuredContent.fix === "1 of 2", "QA sends the code back (fix 1 of 2)")
ok(code().round === 2 && code().history?.[0]?.summary.includes("FRID check") && code().status === "active" && code().assignee === dev.id, "the code card goes back to the dev who wrote it, with the last round kept")
ok(verify().status === "blocked" && verify().recheck?.to === "code" && verify().dependsOn.includes(code().id), "QA's card waits for the fix")
let t = await lastText(dev.id)
ok(t.includes("Round 2") && t.includes("expected 409 but was 500") && t.includes("Added the FRID check"), "the dev's prompt says what failed and what it handed off last time")
const room = sup.rooms.rooms.get(r.roomId)
ok(room.messages.some((m) => m.meta?.kind === "sendback" && m.text.includes("fix 1 of 2")), "the chat shows it was sent back")
idleAll()
await sup.pipelines.complete(code(), { summary: "Mapped FridActiveException to 409 in the controller advice." })
await sleep(300); idleAll()
ok(code().xp?.gained === 3 && code().rework === null, "a fix round earns a little XP, not a full card")
t = await lastText(qa.id)
ok(verify().status === "active" && verify().assignee === qa.id && t.includes("Fix 1") && t.includes("controller advice") && t.includes("Verify it again"), "the same QA bot gets its card back with the fix to verify")

console.log("\nstopping the loop")
out = await rpc(qa, "send_back", { task_id: verify().id, to: "code", reason: "DELETE still returns 500", failures: ["FridDeleteIT.deleteWithActiveFrid: expected 409 but was 500 (CardController.java:88)"] })
ok(out.structuredContent.paused && verify().status === "review" && verify().budget?.kind === "rounds" && /same failure/.test(verify().budget.why), "the same failure twice stops and asks the operator")
ok(code().status === "done", "and nothing was sent")
idleAll()
let res = await api(`/api/tasks/${verify().id}/budget`, { method: "POST", body: { action: "continue" } })
await sleep(300)
ok(res.status === 200 && code().round === 3 && code().status === "active", "One more round sends it after all")
idleAll()
await sup.pipelines.complete(code(), { summary: "Fixed the transaction boundary too." })
await sleep(300); idleAll(); await sup.pipelines.dispatch()
out = await rpc(qa, "send_back", { task_id: verify().id, to: "code", reason: "Now the 409 body is empty", failures: ["FridDeleteIT.errorBody: expected JSON body"] })
ok(out.structuredContent.paused && /sent back 2 times \(max 2\)/.test(verify().budget.why), "past max_rounds it stops too")
res = await api(`/api/tasks/${verify().id}/budget`, { method: "POST", body: { action: "accept" } })
await sleep(200)
ok(verify().status === "active" && (await lastText(qa.id)).includes("no more rounds"), "Accept as is tells the checker to finish and list what still fails")
out = await rpc(qa, "send_back", { task_id: verify().id, to: "plan", reason: "x".repeat(30) })
ok(!out.isError && out.structuredContent.fix, "any earlier stage can be the target by default")
idleAll()
await sup.pipelines.complete(T(r.taskIds.plan), { summary: "Clarified the body." })
await sleep(300); idleAll()
out = await rpc(qa, "send_back", { task_id: verify().id, to: "verify", reason: "x".repeat(30) })
ok(out.isError, "a card cannot send itself back")
await sup.pipelines.complete(verify(), { summary: "Passes except the empty body.", open_questions: [] })
await sleep(300)
ok(sup.pipelines.run(r.id).status === "done" && verify().xp?.reasons.some((x) => x.includes("sent back")), "then it completes, and the checker gets a little for catching things")

console.log("\nfrom the board")
{
  const r2 = await sup.pipelines.start({ pipeline: "tdd", workspace: ws.id, story: "US9: board", title: "Board loop" })
  await sleep(300); idleAll()
  await sup.pipelines.complete(T(r2.taskIds.plan), { summary: "ok" })
  await sleep(200); idleAll()
  await sup.pipelines.complete(T(r2.taskIds.code), { summary: "done" })
  await sleep(200)
  ok(T(r2.taskIds.verify).status === "active", "QA is verifying")
  res = await api(`/api/tasks/${r2.taskIds.code}/send-back`, { method: "POST", body: { reason: "Use the existing ErrorBody class, not a new one" } })
  await sleep(300)
  ok(res.status === 200 && T(r2.taskIds.code).round === 2 && T(r2.taskIds.code).rework.by === "operator", "the operator sends a done card back")
  ok(T(r2.taskIds.verify).status === "blocked" && T(r2.taskIds.verify).recheck, "and the card that was checking it waits for the fix")
  await sup.pipelines.restart(r2.projectId, { stage: "code", fresh: false })
  await sleep(200)
  ok(!T(r2.taskIds.code).round && !T(r2.taskIds.verify).recheck && T(r2.taskIds.verify).dependsOn.length === 1, "restarting forgets the rounds")
}

console.log("\nsplit stages: the piece that failed, preferring its bot")
{
  const r3 = await sup.pipelines.start({ pipeline: "fan", workspace: ws.id, story: "US10: two pieces", title: "Fan loop" })
  await sleep(300); idleAll()
  await sup.pipelines.complete(T(r3.taskIds.plan), { summary: "two", tasks: [{ title: "API docs" }, { title: "Service check" }] })
  await sleep(500); idleAll()
  const [p1, p2] = T(r3.taskIds.build).children.map(T)
  const devA = p1.assignee, devB = p2.assignee
  ok(devA && devB && devA !== devB, "two dev bots build the two pieces")
  await sup.pipelines.complete(p1, { summary: "docs", artifacts: ["docs/api.md"] })
  await sup.pipelines.complete(T(p2.id), { summary: "service", artifacts: ["src/main/java/CardService.java"] })
  await sleep(300); idleAll()
  const qa3 = sup.store.get(T(r3.taskIds.verify).assignee)
  sup.store.get(devB).setStatus("busy")
  out = await rpc(qa3, "send_back", { task_id: r3.taskIds.verify, to: "build", reason: "409 missing", files: ["CardService.java"] })
  await sleep(300)
  ok(!out.isError && T(p2.id).status === "queued" && T(p2.id).prefer === devB && T(p1.id).status === "done", "only the piece that touched the file goes back, for the bot that built it")
  ok(T(r3.taskIds.build).status === "active", "the split card is open again until it lands")
  await sup.pipelines.dispatch()
  ok(T(p2.id).status === "queued", "the other dev, though free, leaves it while its own bot has its chance")
  sup.store.get(devA).setStatus("idle")
  const waiting = T(p2.id)
  waiting.preferUntil = Date.now() - 1
  sup.tasks.save(waiting)
  await sup.pipelines.dispatch()
  ok(T(p2.id).status === "active" && T(p2.id).assignee === devA, "after that, a free bot of the same kind takes it")
  idleAll()
  await sup.pipelines.complete(T(p2.id), { summary: "fixed" })
  await sleep(300); idleAll()
  ok(T(r3.taskIds.build).status === "done" && T(r3.taskIds.verify).status === "active", "the split card lands again and QA verifies")
  out = await rpc(qa3, "send_back", { task_id: r3.taskIds.verify, to: "build", reason: "The audit log line is missing for deletes" })
  await sleep(300)
  const fix = T(r3.taskIds.build).children.map(T).at(-1)
  ok(!out.isError && fix.title.startsWith("Fix:") && fix.item.index === 3 && fix.owner === "role", "a failure no piece owns becomes a new fix piece for any dev")
}

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
