// A workspace is a folder: its agents and pipelines live in two YAML files at
// its root, and every pipeline run is a new workstream with its own branch,
// team, chat and board.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import { listDirs } from "../src/workspaces.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))

const root = await mkdtemp(join(tmpdir(), "wsp-"))
const repo = join(root, "java-parent-services")
await mkdir(repo)
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "pom.xml"), "<x/>")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
process.env.BOT_FARM_WORKTREE_ROOT = join(root, "worktrees")
// The checkout's own opencode setup, deliberately untracked — and, like a
// real one, kept elsewhere and linked in.
const shared = join(root, "shared-opencode")
await mkdir(join(shared, ".opencode", "agent"), { recursive: true })
await writeFile(join(shared, "opencode.json"), `{
  // comments are allowed
  "model": "amazon-bedrock/anthropic.claude-sonnet-5",
  "default_agent": "locked-down",
  "agent": {
    "build": { "model": "amazon-bedrock/anthropic.claude-sonnet-5", "variant": "medium" },
    "locked-down": { "tools": { "*": false } },
  },
  "mcp": { "jira": { "type": "remote", "url": "https://jira.example/mcp" }, "off-one": { "type": "remote", "url": "x", "enabled": false }, "local-dev": { "type": "remote", "url": "http://localhost:3333/sse/dev" } },
}`)
await writeFile(join(shared, ".opencode", "agent", "java.md"), "You know our Java conventions.")
await writeFile(join(shared, ".opencode", "opencode.json"), JSON.stringify({ mcp: { sonar: { type: "local", command: ["sonar"] } } }))
const { symlink: ln } = await import("node:fs/promises")
await ln(join(shared, "opencode.json"), join(repo, "opencode.json"))
await ln(join(shared, ".opencode"), join(repo, ".opencode"))
const home = await mkdtemp(join(tmpdir(), "wsph-"))
await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: "http://127.0.0.1:4827", defaultWorkspace: repo })
await sup.start()
startServer({ supervisor: sup, port: 4827 })
const api = async (p, opts = {}) => {
  const res = await fetch("http://127.0.0.1:4827" + p, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await res.json() }
}

console.log("the default folder is the first workspace")
const [ws] = sup.workspaces.list()
ok(ws?.path === repo && ws.id === "java-parent-services", "java-parent-services is opened on first start")
const agentsText = await readFile(join(repo, "botfarm", "product.agent.botfarm.yml"), "utf8")
const pipesText = await readFile(join(repo, "botfarm", "story.pipeline.botfarm.yml"), "utf8")
ok(agentsText.includes("id: product") && agentsText.includes("prompt:"), "botfarm/ gets one file per built-in agent")
ok(pipesText.includes("id: story") && pipesText.includes("stages:"), "and per built-in pipeline")
let lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.agents.length === 4 && lib.pipelines[0].stages.length === 5 && !lib.problems.length, "and they read back cleanly")

console.log("\nediting definitions edits the files")
const story = lib.pipelines[0]
await api(`/api/workspaces/${ws.id}/pipelines/do-user-story`, { method: "PUT", body: { doc: { ...story, id: "do-user-story", title: "DoUserStory", stages: story.stages.slice(0, 2) } } })
lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.pipelines.some((p) => p.id === "do-user-story" && p.stages.length === 2), "a new pipeline can be saved next to the old one")
ok(!lib.problems.length, "and the file still parses after a rewrite")
const edited = { ...lib.pipelines.find((p) => p.id === "do-user-story") }
edited.stages[1].receives = ["analyse"]
edited.stages[1].prompt = "Build it.\n\n{{#handoffs.analyse}}{{summary}}{{/handoffs.analyse}}\n"
await api(`/api/workspaces/${ws.id}/pipelines/do-user-story`, { method: "PUT", body: { doc: edited } })
await api(`/api/workspaces/${ws.id}/agents/security`, { method: "PUT", body: { doc: { id: "security", title: "Security Bot", role: "security", prompt: "You review for injection.\n", tools: ["read", "grep"] } } })
lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.agents.some((a) => a.id === "security" && a.tools.join() === "read,grep"), "agents too")
ok(!lib.problems.length, "nothing broke after three rewrites")
const raw = (await api(`/api/workspaces/${ws.id}/file/pipelines?entry=do-user-story`)).body.text
ok(raw.includes("title: DoUserStory"), "the YAML is readable as a file")
ok((await api(`/api/workspaces/${ws.id}/file/pipelines?entry=do-user-story`, { method: "PUT", body: { text: "stages: [\n" } })).status >= 400, "a file that does not parse is refused")
await writeFile(join(repo, "botfarm", "do-user-story.pipeline.botfarm.yml"), raw.replace("title: DoUserStory", "title: DoUserStory v2"))
lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.pipelines.some((p) => p.title === "DoUserStory v2"), "a hand edit is picked up without a reload")

console.log("\nevery run is a new workstream")
const a = (await api(`/api/workspaces/${ws.id}/workstreams`, { method: "POST", body: { pipeline: "do-user-story", story: "DE238: DELETE eligibilities should 409 when a FRID exists", title: "DE238 FRID guard" } })).body
const b = (await api(`/api/workspaces/${ws.id}/workstreams`, { method: "POST", body: { pipeline: "do-user-story", story: "US1412: show eligibility end dates", title: "US1412 end dates" } })).body
ok(a.projectId && b.projectId && a.projectId !== b.projectId, "two runs of one pipeline are two workstreams")
const pa = sup.projects.get(a.projectId)
const pb = sup.projects.get(b.projectId)
ok(pa.branch === "botfarm/de238-frid-guard" && pb.branch === "botfarm/us1412-end-dates", `each on its own branch (${pa.branch}, ${pb.branch})`)
ok(pa.roomId && pb.roomId && pa.roomId !== pb.roomId, "with its own chat")
ok(sup.projects.sessions(pa.id).length === 2 && sup.projects.sessions(pb.id).length === 2, "and its own team")
ok(new Set([...sup.projects.sessions(pa.id), ...sup.projects.sessions(pb.id)].map((s) => s.directory)).size === 2, "working in two separate worktrees")
ok(sup.tasks.all({ projectId: pa.id }).length === 2 && sup.tasks.all({ projectId: pb.id }).length === 2, "and its own board")
ok(pa.workspaceId === ws.id && pa.pipeline === "do-user-story" && pa.story.includes("FRID"), "remembering its workspace, pipeline and story")
const clash = await api(`/api/workspaces/${ws.id}/workstreams`, { method: "POST", body: { pipeline: "do-user-story", story: "again", branch: pa.branch } })
ok(clash.status === 500 && /already on branch/.test(clash.body.error), "a second workstream on the same branch is refused")
const again = (await api(`/api/workspaces/${ws.id}/workstreams`, { method: "POST", body: { pipeline: "do-user-story", story: "DE238 again", title: "DE238 FRID guard", branch: "botfarm/de238-take-2" } })).body
ok(again.projectId && again.projectId !== a.projectId, "the same name twice still makes a new workstream")

console.log("\nbots get the checkout's opencode setup and the botfarm tools")
const wt = sup.projects.sessions(pa.id)[0].directory
const rootCfg = await readFile(join(wt, "opencode.json"), "utf8")
ok(rootCfg.includes("jira"), "the untracked opencode.json (with its MCP servers) reaches the worktree")
ok((await readFile(join(wt, ".opencode", "agent", "java.md"), "utf8")).includes("Java"), "so is .opencode/ (agents, commands)")
const dotCfg = JSON.parse(await readFile(join(wt, ".opencode", "opencode.json"), "utf8"))
ok(dotCfg.mcp?.sonar && dotCfg.mcp?.botfarm?.url?.includes("/mcp/"), "the botfarm tools are added next to the checkout's own MCP servers")
const { lstat: lst } = await import("node:fs/promises")
ok(!(await lst(join(wt, ".opencode"))).isSymbolicLink() && (await lst(join(wt, ".opencode", "agent"))).isSymbolicLink(), "a linked .opencode becomes a real folder whose contents link back")
ok(!(await readFile(join(shared, ".opencode", "opencode.json"), "utf8")).includes("botfarm\"\: {"), "so the shared config is never written to")
ok(dotCfg.mcp?.["local-dev"]?.headers?.["X-Repo-Root"] === wt && new URL(dotCfg.mcp["local-dev"].url).searchParams.get("root") === wt && dotCfg.mcp["local-dev"].url.startsWith("http://localhost:3333/sse/dev?"), "local MCP servers are told the worktree is their checkout")
ok(!dotCfg.mcp?.jira?.headers, "remote ones elsewhere are left alone")
const created = await (await fetch("http://127.0.0.1:4096/__created")).json()
const mine = created.filter((b) => b.location?.directory === wt)
ok(mine.length && mine.every((b) => b.engine === "v1" && b.model?.providerID === "amazon-bedrock" && b.model?.modelID === "anthropic.claude-sonnet-5" && !b.model?.variant && /^botfarm-/.test(b.agent)), "bots run on opencode's instance engine (the TUI's), on the workspace's model, each as its own botfarm-* agent")
const prompts = await (await fetch("http://127.0.0.1:4096/__prompts")).json()
const firstTurn = prompts.find((x) => mine.length && sup.projects.sessions(pa.id).some((s) => s.id === x.id))
ok(firstTurn && /^botfarm-/.test(firstTurn.agent) && firstTurn.model?.modelID === "anthropic.claude-sonnet-5", "and every turn is sent with its agent and model")
const wtCfg = JSON.parse(await readFile(join(wt, ".opencode", "opencode.json"), "utf8"))
ok(wtCfg.agent?.["botfarm-product"]?.model === "amazon-bedrock/anthropic.claude-sonnet-5" && wtCfg.agent["botfarm-product"].tools?.["*"] === false && wtCfg.agent["botfarm-product"].tools?.read === true && wtCfg.agent["botfarm-product"].tools?.["botfarm*"] === true, "the product agent is read-only but keeps the botfarm tools")
ok(wtCfg.agent?.["botfarm-dev"]?.model === "amazon-bedrock/anthropic.claude-sonnet-5" && !wtCfg.agent["botfarm-dev"].variant && !wtCfg.agent["botfarm-dev"].tools, "built on the workspace's build agent (not its locked-down default), without a reasoning level the model may not offer")
const reg = await (await fetch("http://127.0.0.1:4096/__registered")).json()
ok(sup.projects.sessions(pa.id).every((s) => /^botfarm-/.test(s.snapshot().agentName)), "and each bot remembers what it runs on")
const team = sup.projects.sessions(pa.id)
ok(team.every((s) => s.mcpToken && dotCfg.mcp.botfarm.url.endsWith(s.mcpToken)), "before the session starts, with the token the whole worktree shares")
ok(team.every((s) => s.personaTitle), "each bot knows its kind (" + team.map((s) => s.personaTitle).join(", ") + ")")
await sup.refreshMcp(team)
ok(team[0].snapshot().mcp?.total >= 1, "and its MCP servers are counted")
ok(team.some((s) => s.snapshot().invocations === 1), "the bot that was handed a card has one run")

console.log("\nwhat opencode waits on reaches you")
const asker = sup.projects.sessions(pa.id)[0]
const post = (u, b) => fetch("http://127.0.0.1:4096" + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json())
await post("/__ask", { sessionID: asker.id, kind: "permission", request: { permission: "bash", patterns: ["mvn test"], metadata: { command: "mvn -pl eligibility test" }, always: ["mvn *"] } })
await post("/__ask", { sessionID: asker.id, kind: "question", request: { questions: [{ question: "Which module?", header: "Module", options: [{ label: "eligibility", description: "" }, { label: "customer", description: "" }] }] } })
sup.dirty.add(asker.id)
await sup.flushDirty()
let snap = sup.store.snapshot().sessions.find((x) => x.id === asker.id)
ok(snap.status === "waiting" && snap.permissions[0]?.action === "bash" && snap.permissions[0].metadata.command.includes("mvn"), "a pending permission shows on the bot, with the command")
ok(snap.questions[0]?.questions[0]?.options.length === 2, "and so does a question from opencode's own question tool")
await api(`/api/sessions/${asker.id}/permission`, { method: "POST", body: { requestId: snap.permissions[0].id, decision: "once" } })
await api(`/api/sessions/${asker.id}/question`, { method: "POST", body: { requestId: snap.questions[0].id, answers: [["eligibility"]] } })
const replies = await (await fetch("http://127.0.0.1:4096/__replies")).json()
ok(replies.some((r) => r.kind === "permission" && r.reply === "once") && replies.some((r) => r.kind === "question" && r.answers?.[0]?.[0] === "eligibility"), "answering goes back to opencode")
sup.dirty.add(asker.id)
await sup.flushDirty()
snap = sup.store.snapshot().sessions.find((x) => x.id === asker.id)
ok(!snap.permissions.length && !snap.questions.length && snap.status !== "waiting", "and the bot carries on")

console.log("\nprices")
const s0 = team[0]
Object.assign(s0.totals, { input: 1_000_000, output: 100_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }); for (const t of sup.timers) clearInterval(t)
s0.model = "amazon-bedrock/us.anthropic.claude-opus-9-20300101-v1:0"
ok(sup.store.totals().unknownModels.includes("claude-opus-9"), "an unknown model is reported by name")
await api("/api/pricing", { method: "PUT", body: { model: s0.model, input: 10, output: 50 } })
ok(Math.abs(sup.store.snapshot().sessions.find((x) => x.id === s0.id).cost.usd - 15) < 1e-6, "setting its price prices that bot (1M in × $10 + 100k out × $50)")
ok(JSON.parse(await readFile(join(home, "config.json"), "utf8")).pricing["claude-opus-9"].output === 50, "and it is kept in config.json")

console.log("\nthe run keeps the definition it started with")
const runA = sup.pipelines.run(a.id)
await api(`/api/workspaces/${ws.id}/pipelines/do-user-story`, { method: "DELETE" })
ok(sup.pipelines.promptFor(sup.tasks.get(runA.taskIds.build)).includes("Build it."), "deleting the pipeline does not break a workstream using it")

console.log("\nbots and cards can be added by hand")
const bot = (await api(`/api/projects/${pa.id}/bots`, { method: "POST", body: { agent: "security" } })).body
ok(bot.id && sup.store.get(bot.id).project === pa.id, "a bot joins the workstream")
ok(sup.rooms.rooms.get(pa.roomId).members.has(bot.id), "and its chat")
ok(sup.store.get(bot.id).directory === sup.projects.sessions(pa.id)[0].directory, "in the same worktree")

console.log("\narchiving")
await api(`/api/projects/${pb.id}/archive`, { method: "POST", body: {} })
ok(sup.projects.get(pb.id).status === "archived", "a workstream can be put away")
ok(sup.tasks.all({ projectId: pb.id }).every((t) => ["done", "cancelled"].includes(t.status)), "its open cards are cancelled")

console.log("\nunedited built-ins are moved to the current ones")
const legacyRepo = join(root, "legacy")
await mkdir(legacyRepo)
await run("git", ["init", "-q", "-b", "main"], { cwd: legacyRepo })
const { LEGACY } = await import("../src/legacy-defaults.mjs")
const YAML = await import("../src/yaml.mjs")
const oldProduct = YAML.parse(LEGACY.agents.product[0])
const oldAnalyse = YAML.parse(LEGACY.stages["story/analyse"][0]).stages[0]
const qaEdited = { id: "qa", title: "QA", role: "qa", prompt: "My own QA prompt.\n" }
await writeFile(join(legacyRepo, "botfarm-agents.yml"), YAML.stringify({ agents: [oldProduct, qaEdited] }))
await writeFile(join(legacyRepo, "botfarm-pipeline.yml"), YAML.stringify({ pipelines: [{ id: "story", title: "Mine", stages: [oldAnalyse] }] }))
const lw = await sup.workspaces.add({ path: legacyRepo })
const ll = await sup.workspaces.summary(lw.id)
const p2 = ll.agents.find((a) => a.id === "product")
ok(p2.prompt.includes("Work quickly") && p2.tools?.includes("read") && !p2.tools.includes("bash"), "the old product agent becomes the quick, read-only one")
ok(ll.agents.find((a) => a.id === "qa").prompt === "My own QA prompt.\n", "an agent you wrote is left alone")
ok(ll.pipelines[0].title === "Mine" && ll.pipelines[0].stages[0].title === "Polish the acceptance criteria", "the old analyse prompt is updated, your pipeline name kept")

console.log("\neach workstream keeps a manifest of its bots")
const YAMLm = await import("../src/yaml.mjs")
const manifestFile = join(repo, ".botfarm", "workstreams", `${pa.id}.yml`)
let man = YAMLm.parse(await readFile(manifestFile, "utf8"))
const teamIds = sup.projects.sessions(pa.id).map((s) => s.id).sort()
ok(man.bots.map((b) => b.session).sort().join() === teamIds.join(), `${pa.id}.yml lists every bot's opencode session`)
ok(man.bots.every((b) => b.persona && b.handle) && man.branch === pa.branch && man.story.includes("FRID"), "with who it is, the branch and the story")
ok((await readFile(join(repo, ".git", "info", "exclude"), "utf8")).includes(".botfarm/"), "and .botfarm/ is kept out of git")
await sup.release(bot.id)
await sup.saveManifest(pa.id)
man = YAMLm.parse(await readFile(manifestFile, "utf8"))
ok(man.previous?.some((b) => b.session === bot.id && b.replaced) && !man.bots.some((b) => b.session === bot.id), "a bot that leaves moves to previous, still findable")

console.log("\nlosing botfarm's own state does not lose the team")
const home2 = await mkdtemp(join(tmpdir(), "wsph2-"))
const sup2 = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home2, "m.json"), registryPath: join(home2, "r.json"), mcpBase: "http://127.0.0.1:4828", defaultWorkspace: repo })
await sup2.start()
const back = sup2.projects.get(pa.id)
ok(back && back.recovered && back.branch === pa.branch, "the workstream is recreated from its manifest")
const backTeam = sup2.projects.sessions(pa.id)
ok(backTeam.map((s) => s.id).sort().join() === man.bots.map((b) => b.session).sort().join(), "with the same bots, found by session id")
ok(backTeam.every((s) => s.persona), "who know what they are")
sup2.stop()

console.log("\nthe folder browser")
const listing = await listDirs(root)
ok(listing.dirs.some((d) => d.name === "java-parent-services" && d.isRepo), "lists folders and marks repositories")
ok(listing.parent && !listing.dirs.some((d) => d.name.startsWith(".")), "with a way up and no hidden folders")

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
