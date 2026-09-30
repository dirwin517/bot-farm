// Cheap and on track: model routing by difficulty, trimmed handoffs, team
// notes, loop detection; and the fun part: XP, levels, perks, harvests, PR
// packets and portable replays.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import { difficulty, trimText, stuckReason, routeFor } from "../src/craft.mjs"
import { ModelLedger } from "../src/quota.mjs"
import { levelOf } from "../src/farmhands.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))
const repo = await mkdtemp(join(tmpdir(), "craft-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "a"), "x")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "crafth-"))
process.env.BOT_FARM_WORKTREE_ROOT = join(home, "wt")
await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: "http://127.0.0.1:4843" })
await sup.start()
startServer({ supervisor: sup, port: 4843 })
const api = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:4843${path}`, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const prompts = async (id) => (await (await fetch("http://127.0.0.1:4096/__prompts")).json()).filter((p) => p.id === id)
const T = (id) => sup.tasks.get(id)
const idleAll = () => { for (const s of sup.store.list()) s.setStatus("idle") }

console.log("difficulty, without a model")
ok(difficulty({ title: "Fix typo in README" }).level === "easy", "a typo in the docs is easy")
ok(difficulty({ title: "Refactor the auth flow", detail: "migrate sessions to the new security model" }).level === "hard", "a security refactor is hard")
ok(difficulty({ title: "Return 409 when a FRID exists on DELETE /cards/{id}", detail: "The service should check the FRID repository before deleting and map the conflict in the controller advice, returning a JSON error body." }).level === "normal", "an ordinary change is normal")
ok(difficulty({ explicit: "hard", title: "typo" }).level === "hard", "a difficulty set on the piece wins")

console.log("\ntrimming handoffs, without a model")
const long = "Did the thing. ".repeat(40) + "\n```java\n" + "int x = 1;\n".repeat(30) + "```\n" + "Decided to keep FridDao.existsActive. ".repeat(80)
const brief = trimText(long, 800)
ok(brief.length < 1000 && brief.includes("[code block, 31 lines") && brief.includes("botfarm_handoff"), `a long handoff becomes a brief (${long.length} → ${brief.length} chars), code blocks become pointers`)

console.log("\nloops, from the tool log")
const call = (name, summary, status = "completed") => ({ name, summary, status, at: Date.now() })
ok(stuckReason([call("grep", "FridDao"), call("read", "a.java"), call("grep", "FridDao"), call("grep", "FridDao")])?.why.includes("repeated grep"), "the same grep three times is a loop")
ok(stuckReason([1, 2, 3, 4, 5].map((i) => call("bash", "mvn test " + i, "error")))?.why.includes("last 5"), "five failures in a row is a loop")
ok(stuckReason(Array.from({ length: 20 }, (_, i) => call("read", "f" + i)), { tokens: 300_000 })?.why.includes("without changing a file"), "300k tokens and no edits is a loop")
ok(!stuckReason([call("read", "a"), call("edit", "a"), call("read", "b")], { tokens: 10_000 }), "normal work is not")
{
  const { inputSig, summarizeToolInput } = await import("../src/store.mjs")
  const mcp = (input) => ({ name: "local-dev_repo_grep", summary: summarizeToolInput(input), sig: inputSig(input), status: "completed", at: Date.now() })
  ok(!stuckReason([mcp({ regex: "FridDao", glob: "*.java" }), mcp({ regex: "FridDao", glob: "*.xml" }), mcp({ regex: "CardService" })]), "the same tool three times with different arguments is not a loop")
  ok(stuckReason([mcp({ regex: "FridDao", glob: "*.java" }), mcp({ glob: "*.java", regex: "FridDao" }), mcp({ regex: "FridDao", glob: "*.java" })])?.why.includes("repeated local-dev_repo_grep"), "with exactly the same arguments (in any order) it is")
  const mvn = { name: "bash", summary: "mvn -q test", sig: inputSig({ command: "mvn -q test" }), status: "error", at: 1 }
  ok(!stuckReason([mvn, call("edit", "A.java"), mvn, call("edit", "A.java"), mvn]), "running the same build after each edit is not a loop")
}

console.log("\nwhat a card changed, however it changed it")
{
  const g = await import("../src/git.mjs")
  const d = await mkdtemp(join(tmpdir(), "snap-"))
  await run("git", ["init", "-q", "-b", "main"], { cwd: d })
  await writeFile(join(d, "Svc.java"), "class Svc {\n  int a = 1;\n}\n")
  await writeFile(join(d, "Keep.java"), "class Keep {}\n")
  await run("git", ["add", "."], { cwd: d })
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: d })
  // Someone else's uncommitted work, before the card starts.
  await writeFile(join(d, "Svc.java"), "class Svc {\n  int a = 1;\n  int b = 2;\n}\n")
  const snap = await g.snapshot(d)
  // The card: an edit on top of that, a brand-new file written by "some MCP tool", nothing else.
  await writeFile(join(d, "Svc.java"), "class Svc {\n  int a = 1;\n  int b = 2;\n  int c = 3;\n}\n")
  await writeFile(join(d, "Generated.java"), "class Generated {}\n")
  const ch = await g.changesSince(d, snap)
  const svc = ch.find((c) => c.file === "Svc.java")
  ok(svc && svc.added === 1 && svc.diff.includes("+  int c = 3;") && !svc.diff.includes("+  int b = 2;"), "a file edited during the card shows only this card's change, not earlier uncommitted work")
  ok(ch.some((c) => c.file === "Generated.java" && c.created && c.diff.includes("+class Generated")), "a file written any other way (an MCP tool, a script) shows up too")
  ok(!ch.some((c) => c.file === "Keep.java"), "untouched files do not")
  ok(await g.changedSince(d, snap) && !(await g.changedSince(d, await g.snapshot(d))), "and 'did anything change' is answered from disk")
}

console.log("\nrouting a card by how hard it looks")
const ws = await sup.workspaces.add({ path: repo, name: "craft" })
ok((await readFile(join(repo, "botfarm", "routing.botfarm.yml"), "utf8")).includes("enabled: false"), "a routing file is written, switched off")
await writeFile(join(repo, "botfarm", "routing.botfarm.yml"), "enabled: true\ntiers:\n  easy:\n    model: amazon-bedrock/anthropic.claude-haiku-4-5\n    variant: low\n  normal: {}\n  hard:\n    model: amazon-bedrock/anthropic.claude-opus-5\n    variant: high\n")
sup.pipelines.definitions.set("fan", {
  id: "fan", title: "Fan",
  stages: [
    { id: "plan", persona: "product", receives: [], prompt: "{{story}}" },
    { id: "build", persona: "dev", receives: ["plan"], split: "tasks", parallel: 2, limits: { minutes: 30 }, prompt: "Build it." },
    { id: "check", persona: "reviewer", receives: ["build"], prompt: "{{#handoffs.build}}{{summary}}{{/handoffs.build}}" },
  ],
})
const lib = await sup.pipelines.lib(ws.id)
for (const [k, v] of sup.pipelines.definitions) lib.definitions.set(k, v)
for (const [k, v] of sup.pipelines.personas) if (!lib.personas.has(k)) lib.personas.set(k, v)
const r = await sup.pipelines.start({ pipeline: "fan", workspace: ws.id, story: "US7: two small things", title: "Craft", limits: { usd: 50 } })
await sleep(300)
idleAll()
await sup.pipelines.complete(T(r.taskIds.plan), { summary: long, acceptance_criteria: ["docs fixed", "service secured"], tasks: [{ title: "Fix a typo in the API docs", detail: "One word in docs/api.md" }, { title: "Redesign the auth token refresh", detail: "Migrate token refresh to the new security model; watch for race conditions", difficulty: "hard" }] })
await sleep(400)
const [easy, hard] = T(r.taskIds.build).children.map(T)
ok(easy.difficulty?.level === "easy" && hard.difficulty?.level === "hard", "each piece is sized: easy and hard")
const easyP = (await prompts(easy.assignee)).at(-1)
const hardP = (await prompts(hard.assignee)).at(-1)
ok(easyP.model?.modelID === "anthropic.claude-haiku-4-5" && easyP.variant === "low", "the easy piece runs on haiku, low")
ok(hardP.model?.modelID === "anthropic.claude-opus-5" && hardP.variant === "high", "the hard one on opus, high")
const seen = sup.pipelines.contextFor(easy).handoffs.plan
ok(seen.summary.includes("[code block, 31 lines") && seen.summary.length < 2200 && T(r.taskIds.plan).handoff.summary.length > 3000, `and reads the product bot's handoff trimmed (${T(r.taskIds.plan).handoff.summary.length} → ${seen.summary.length} chars; the card keeps it all)`)
await sup.setBotSettings(easy.assignee, { model: "amazon-bedrock/anthropic.claude-sonnet-5" })
await sup.send(easy.assignee, "go on")
ok((await prompts(easy.assignee)).at(-1).model?.modelID === "anthropic.claude-sonnet-5", "a bot's own Model… choice still wins")
await sup.setBotSettings(easy.assignee, { model: null, variant: null })

console.log("\nrouting from the app")
let rr = await api(`/api/workspaces/${ws.id}/routing`)
ok(rr.body.enabled === true && rr.body.tiers.hard.model.endsWith("opus-5"), "the routing page reads the file")
rr = await api(`/api/workspaces/${ws.id}/routing`, { method: "PUT", body: { enabled: true, tiers: { easy: { model: "amazon-bedrock/anthropic.claude-sonnet-5", variant: "low" }, normal: { variant: "default" }, hard: { model: "amazon-bedrock/anthropic.claude-opus-5", variant: "max" } } } })
const rtext = await readFile(join(repo, "botfarm", "routing.botfarm.yml"), "utf8")
ok(rr.status === 200 && rtext.startsWith("# BotFarm model routing") && rtext.includes("variant: max") && !rtext.includes("default"), "and saves it, keeping the explanation at the top")
ok((await api(`/api/workspaces/${ws.id}/models`)).body.models.some((m) => m.id.endsWith("opus-5")), "with the models opencode offers to pick from")
let pr2 = await api(`/api/workspaces/${ws.id}/pipelines/pinned`, { method: "PUT", body: { doc: { id: "pinned", stages: [{ id: "review", persona: "reviewer", receives: [], difficulty: "normal", prompt: "{{story}}" }] } } })
ok(pr2.body.pipelines.find((p) => p.id === "pinned").stages[0].difficulty === "normal" && !pr2.body.problems.some((p) => p.id === "pinned"), "a stage can pin its difficulty")
pr2 = await api(`/api/workspaces/${ws.id}/pipelines/pinned`, { method: "PUT", body: { doc: { id: "pinned", stages: [{ id: "review", persona: "reviewer", receives: [], difficulty: "huge", prompt: "x" }] } } })
ok(pr2.body.problems.some((p) => p.id === "pinned" && p.problems.some((x) => /difficulty/.test(x))), "and a wrong one is reported")
await api(`/api/workspaces/${ws.id}/pipelines/pinned`, { method: "DELETE" })
const agentSave = await api(`/api/workspaces/${ws.id}/agents/reviewer`, { method: "PUT", body: { doc: { ...(await sup.workspaces.summary(ws.id)).agents.find((a) => a.id === "reviewer"), tiers: { easy: { variant: "medium" }, normal: {}, hard: {} } } } })
ok(agentSave.body.agents.find((a) => a.id === "reviewer").tiers.easy.variant === "medium", "an agent can route its own way")

console.log("\nquotas: so much on opus, then sonnet")
await api(`/api/workspaces/${ws.id}/routing`, { method: "PUT", body: { enabled: true, tiers: { easy: { model: "amazon-bedrock/anthropic.claude-haiku-4-5", variant: "low" }, normal: {}, hard: { model: "amazon-bedrock/anthropic.claude-opus-5", variant: "high", quota: { usd: 5, per: "day" }, fallback: { model: "amazon-bedrock/anthropic.claude-sonnet-5", variant: "high" } } } } })
ok((await readFile(join(repo, "botfarm", "routing.botfarm.yml"), "utf8")).includes("fallback:"), "a tier saves a quota and a fallback")
let view = (await api(`/api/workspaces/${ws.id}/routing`)).body
ok(view.usage.hard && view.usage.hard.spent.usd === 0 && !view.usage.hard.over, "the routing page shows how much of it is used")
const devRow = view.agents?.find((a) => a.id === "dev")
ok(devRow && devRow.levels.hard.source === "workspace" && devRow.levels.hard.quota?.scope === "everyone" && devRow.levels.easy.model.includes("haiku"), "and what each agent gets per size, with where it comes from")
const hardDev = sup.store.get(hard.assignee)
hardDev.route = { model: "amazon-bedrock/anthropic.claude-opus-5", variant: "high", quota: { usd: 5, per: "day" }, fallback: { model: "amazon-bedrock/anthropic.claude-sonnet-5", variant: "high" }, taskId: hard.id, level: "hard", wsId: ws.id, projectId: r.projectId, switchMode: "now" }
hardDev.setStatus("busy")
sup.ledger.add(ws.id, "amazon-bedrock/us.anthropic.claude-opus-5", r.projectId, { usd: 5.2, tokens: 300_000 })
view = (await api(`/api/workspaces/${ws.id}/routing`)).body
ok(view.usage.hard.over?.kind === "usd", "spend on opus counts against it (whatever the region prefix)")
const before = (await prompts(hardDev.id)).length
await sup.pipelines.checkQuotas()
ok(hardDev.route.model.endsWith("sonnet-5") && hardDev.route.fellBack?.why.includes("quota"), "a bot on opus moves to sonnet when the quota runs out")
const after = await prompts(hardDev.id)
ok(after.length === before + 1 && after.at(-1).model?.modelID === "anthropic.claude-sonnet-5" && after.at(-1).parts[0].text.includes("now running on"), "at once: its turn is picked up again on sonnet")
ok(T(hard.id).difficulty.route.fellBack, "the card says it fell back")
const tier = sup.pipelines.applyQuota({ model: "amazon-bedrock/anthropic.claude-opus-5", variant: "high", quota: { usd: 5, per: "day" }, fallback: { model: "amazon-bedrock/anthropic.claude-sonnet-5" } }, { wsId: ws.id, projectId: r.projectId })
ok(tier.model.endsWith("sonnet-5") && tier.fellBack, "new hard cards go straight to the fallback")
ok(!sup.pipelines.applyQuota({ model: "amazon-bedrock/anthropic.claude-opus-5", quota: { usd: 5, per: "workstream" } }, { wsId: ws.id, projectId: "another" }).fellBack, "a per-workstream quota starts fresh in another workstream")
hardDev.route = null
await sup.workspaces.saveRouting(ws.id, { enabled: true, tiers: { easy: { model: "amazon-bedrock/anthropic.claude-haiku-4-5", variant: "low" }, normal: {}, hard: { model: "amazon-bedrock/anthropic.claude-opus-5", variant: "high" } } })

console.log("\nteam notes and files already read")
const devA = sup.store.get(easy.assignee), devB = sup.store.get(hard.assignee)
const token = (s) => sup.mcpUrlFor(s).split("/").pop()
const rpc = async (s, name, args) => { sup.mcpCalls.set(s.id, Date.now()); return (await (await fetch(`http://127.0.0.1:4843/mcp/${token(s)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result }
let out = await rpc(devA, "notes_write", { topic: "Auth token flow", text: "TokenService.refresh() → TokenRepo; locks in RefreshLock", files: ["src/auth/TokenService.java"] })
ok(!out.isError && out.structuredContent.saved === "Auth token flow", "a bot saves a note")
out = await rpc(devB, "notes_read", {})
ok(out.structuredContent.notes.some((n) => n.topic === "Auth token flow"), "another lists it")
out = await rpc(devB, "notes_read", { topic: "auth token" })
ok(out.structuredContent.text.includes("RefreshLock"), "and reads it by topic")
out = await rpc(devB, "handoff", { stage: "plan" })
ok(out.structuredContent.summary.length === long.trim().length, "the full handoff is one call away")
devA.toolLog.push({ name: "read", summary: "src/auth/TokenService.java", status: "completed", at: Date.now() })
const ctxText = sup.pipelines.sharedContext(hard)
ok(ctxText.includes('"Auth token flow"') && ctxText.includes("src/auth/TokenService.java (@" + devA.handle + ")"), "the next card lists the team's notes and the files they read")

console.log("\nstuck bots are stopped and asked about")
devB.setStatus("busy")
const t0 = Date.now()
devB.toolLog.push(...[1, 2, 3].map(() => ({ name: "grep", summary: "refreshToken", status: "completed", at: t0 + 10 })))
await sup.pipelines.checkBudgets(t0 + 1000)
let h = T(hard.id)
ok(h.status === "review" && h.budget?.kind === "loop" && h.budget.why.includes("repeated grep"), "a bot repeating itself is paused, with why")
let res = await api(`/api/tasks/${hard.id}/budget`, { method: "POST", body: { action: "continue" } })
h = T(hard.id)
ok(res.status === 200 && h.status === "active" && h.loopQuietUntil > Date.now() && !h.budget, "Continue lets it go on and keeps the check quiet for a while")
ok((await prompts(devB.id)).at(-1).parts[0].text.includes("looked stuck"), "and tells the bot what it looked like")

console.log("\nXP, levels and perks")
idleAll()
const wtDir = sup.store.get(easy.assignee).directory
const { mkdir: mkd2 } = await import("node:fs/promises")
await mkd2(join(wtDir, "docs"), { recursive: true })
await writeFile(join(wtDir, "docs", "api.md"), "# API\n\nDELETE /cards/{id} returns 409 when a FRID is active.\n")
await writeFile(join(wtDir, "a"), "x\nchanged by the dev bot\n")
// A 1x1 PNG among the artifacts: a screenshot the bot saved.
await writeFile(join(wtDir, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
await writeFile(join(wtDir, "Generated.java"), "class Generated {}\n") // as if an MCP tool wrote it
for (const k of [easy, hard]) await sup.pipelines.complete(T(k.id), { summary: `Did ${k.title}.`, artifacts: k === easy ? ["docs/api.md", "a", "shot.png"] : ["src/auth/TokenServiceTest.java"] })
await sleep(300)
let dev = sup.farmhands.get(ws.id, "dev")
ok(dev.xp > 0 && T(easy.id).xp?.gained >= 20, `a clean card earns XP (${T(easy.id).xp.reasons.join(", ")})`)
ok(T(hard.id).xp.gained < T(easy.id).xp.gained, "a card that got stuck earns less")
sup.farmhands.award(ws.id, "dev", 400, { reasons: [["test", 400]] })
dev = sup.farmhands.get(ws.id, "dev")
ok(dev.level >= 5 && dev.hat, `enough XP levels a bot type up (level ${dev.level}, ${dev.title} ${dev.hat})`)
const lim = sup.pipelines.effectiveLimits({ limits: { minutes: 30 }, runId: r.id, persona: "dev" })
ok(lim.minutes > 30, `and its perks raise card limits (${lim.minutes} min)`)

console.log("\ncard completion in the chat")
const er = T(easy.id).report
ok(er && er.handle === sup.store.get(easy.assignee).handle && er.minutes >= 0 && typeof er.tokens === "number" && typeof er.usd === "number", "a finished card has a report: who, how long, tokens, cost")
ok(er.diffs.some((d) => d.file === "a" && d.added >= 1 && d.diff.includes("+changed by the dev bot")) && er.diffs.some((d) => d.file === "docs/api.md" && d.diff.includes("409")), "with the diff of every file it handed over, as it was then")
ok(er.images.some((i) => i.path === "shot.png"), "and image files among its artifacts as screenshots")
ok(er.diffs.some((d) => d.file === "Generated.java" && d.unlisted && d.created), "files changed on disk but not in its handoff are included and marked")
const roomNow = sup.rooms.rooms.get(sup.pipelines.run(r.id).roomId)
const ev = roomNow.messages.find((m) => m.meta?.kind === "card" && m.meta.taskId === easy.id)
ok(ev && ev.meta.files.some((f) => f.file === "a" && f.added >= 1) && ev.meta.images === 1 && ev.meta.tokens === er.tokens && ev.quiet, "the chat gets a card event carrying it (and it wakes nobody)")
const joinedEv = roomNow.messages.find((m) => m.meta?.kind === "card" && m.meta.taskId === r.taskIds.build)
ok(joinedEv && joinedEv.meta.pieces === 2 && joinedEv.meta.bots.length === 2, "a split stage gets one for all its pieces")
res = await api(`/api/tasks/${easy.id}/report`)
ok(res.status === 200 && res.body.diffs.length >= 2 && res.body.summary.includes("Did"), "the diffs load when you open them")
const img = await fetch(`http://127.0.0.1:4843/api/tasks/${easy.id}/image/0`)
ok(img.ok && img.headers.get("content-type") === "image/png" && (await img.arrayBuffer()).byteLength > 20, "and the screenshot is served")
ok((await fetch(`http://127.0.0.1:4843/api/tasks/${easy.id}/image/5`)).status === 404, "(only the ones it has)")

console.log("\npause and resume a workstream")
const devC = sup.store.get(r.sessions.reviewer)
res = await api(`/api/projects/${r.projectId}/pause`, { method: "POST", body: {} })
ok(res.status === 200 && res.body.paused?.kind === "manual" && sup.pipelines.run(r.id).paused, "Pause stops the workstream")
ok(sup.projects.snapshot().find((p) => p.id === r.projectId) && sup.pipelines.budgetView(sup.projects.get(r.projectId)).paused.kind === "manual", "and the header knows it was you")
ok(sup.pipelines.run(r.id).paused.interrupted.includes(r.taskIds.check) && devC.status === "idle", "the bot working a card is stopped mid-card")
const nPrompts = (await prompts(devC.id)).length
res = await api(`/api/projects/${r.projectId}/resume`, { method: "POST", body: {} })
await sleep(200)
ok(res.status === 200 && !sup.pipelines.run(r.id).paused, "Resume lets it go on")
ok((await prompts(devC.id)).length === nPrompts + 1 && (await prompts(devC.id)).at(-1).parts[0].text.includes("paused by the operator and has been resumed"), "and the stopped bot picks its card up again")

console.log("\nharvest, PR packet, replay")
idleAll()
await sup.pipelines.complete(T(r.taskIds.check), { summary: "All good; the token refresh is covered by TokenServiceTest.", acceptance_criteria: ["docs fixed", "service secured"] })
await sleep(600)
const project = sup.projects.get(r.projectId)
ok(project.harvest && project.harvest.cards >= 4 && project.harvest.xp > 0, `the finished workstream is harvested (${project.harvest.cards} cards, +${project.harvest.xp} XP)`)
ok(project.harvest.budget === 50 && project.harvest.saved > 0, "with what it saved against its budget")
const totals = (await api(`/api/workspaces/${ws.id}/harvest`)).body
ok(totals.week.stories === 1 && totals.levels.some((l) => l.persona === "dev"), "the harvest log counts it this week, with levels")
const packetPath = join(repo, ".botfarm", "workstreams", `${r.projectId}.pr.md`)
ok(await stat(packetPath).then(() => true, () => false), "a PR packet is written when it finishes")
const packet = (await api(`/api/projects/${r.projectId}/pr`)).body
ok(packet.markdown.includes("## Acceptance criteria") && packet.markdown.includes("service secured") && packet.markdown.includes("TokenServiceTest.java") && packet.markdown.includes("## Cost"), "with criteria, the tests behind them and the cost")
const rep = await (await fetch(`http://127.0.0.1:4843/api/projects/${r.projectId}/replay?download=1`)).json()
ok(rep.format === "botfarm-replay" && rep.events.some((e) => e.k === "task") && rep.events.some((e) => e.k === "msg") && rep.events.some((e) => e.k === "bot") && rep.events.some((e) => e.k === "harvest"), `a replay exports as one file (${rep.events.length} events)`)
res = await api(`/api/replays`, { method: "POST", body: rep })
ok(res.status === 201, "it imports")
const list = (await api(`/api/replays`)).body
ok(list.some((x) => x.id === res.body.id && x.name === "Craft"), "and shows up with the others")
res = await api(`/api/replays`, { method: "POST", body: { hello: 1 } })
ok(res.status === 400, "anything else is refused")

console.log("\nper-agent routing")
{
  const ws = { enabled: true, tiers: { easy: { model: "a/haiku" }, normal: { model: "a/sonnet" }, hard: { model: "a/opus", quota: { usd: 5 }, fallback: { model: "a/sonnet" } } } }
  const own = { hard: { model: "a/opus", variant: "high", quota: { usd: 1 }, fallback: { model: "a/sonnet" } } }
  ok(routeFor("hard", { agentTiers: own, routing: ws }).source === "agent" && routeFor("hard", { agentTiers: own, routing: ws }).variant === "high", "an agent's own rule wins for its size")
  ok(routeFor("easy", { agentTiers: own, routing: ws })?.model === "a/haiku" && routeFor("easy", { agentTiers: own, routing: ws }).source === "workspace", "sizes it leaves out use the workspace's")
  ok(routeFor("easy", { agentTiers: own, routing: { ...ws, enabled: false } }) === null && routeFor("hard", { agentTiers: own, routing: { ...ws, enabled: false } })?.model === "a/opus", "with workspace routing off, only the agent's own rules apply")
  const rows = new Map()
  const led = new ModelLedger({ get: (_, id) => rows.get(id), put: (_, r) => rows.set(r.id, r), all: () => [...rows.values()] })
  led.add("w", "a/opus", null, { usd: 2 }, Date.now(), "dev")
  led.add("w", "a/opus", null, { usd: 3 }, Date.now(), "qa")
  const Y = await import("../src/yaml.mjs")
  const flow = Y.parse("quota: { usd: 3, per: day }\nfallback: { model: a/sonnet }\nnone: {}\nprompt: {{story}}")
  ok(flow.quota.usd === 3 && flow.fallback.model === "a/sonnet" && typeof flow.none === "object" && flow.prompt === "{{story}}", "one-line YAML maps work in hand-edited files (templates stay text)")
  ok(led.spent("w", "a/opus", "day").usd === 5 && led.spent("w", "a/opus@dev", "day").usd === 2, "spend counts for everyone and, separately, per agent")
}

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
