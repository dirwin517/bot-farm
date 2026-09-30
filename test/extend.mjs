// One file per agent and pipeline in botfarm/, the split of the old single
// files, workspace tools from botfarm/mcps/ (served to bots and run from the
// test bench), and switching a running bot's model and reasoning level.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, readdir, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))
const repo = await mkdtemp(join(tmpdir(), "ext-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "a"), "x")
// An old-style workspace: the two single files, one prompt still naming botfarm_ tools.
await writeFile(join(repo, "botfarm-agents.yml"), `agents:
  - id: dev
    title: Dev Bot
    role: dev
    prompt: |
      Build it, then call botfarm_task_complete.
  - id: qa
    title: QA Bot
    role: qa
    prompt: Test it.
`)
await writeFile(join(repo, "botfarm-pipeline.yml"), `pipelines:
  - id: quick
    title: Quick
    stages:
      - id: build
        persona: dev
        receives: []
        prompt: "{{story}}"
      - id: verify
        persona: qa
        receives: [build]
        prompt: "{{story}}"
`)
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "exth-"))
process.env.BOT_FARM_WORKTREE_ROOT = join(home, "wt")
await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: join(home, "m.json"), registryPath: join(home, "r.json"), mcpBase: "http://127.0.0.1:4841" })
await sup.start()
startServer({ supervisor: sup, port: 4841 })
const api = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:4841${path}`, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}

console.log("one file per definition, named after its id")
const ws = await sup.workspaces.add({ path: repo, name: "ext" })
const files = await readdir(join(repo, "botfarm"))
ok(files.includes("dev.agent.botfarm.yml") && files.includes("qa.agent.botfarm.yml") && files.includes("quick.pipeline.botfarm.yml"), `the old files are split into botfarm/ (${files.filter((f) => f.endsWith(".yml")).join(", ")})`)
ok(await stat(join(repo, "botfarm-agents.yml.bak")).then(() => true, () => false) && !(await stat(join(repo, "botfarm-agents.yml")).then(() => true, () => false)), "and kept as .bak")
ok((await readFile(join(repo, "botfarm", "dev.agent.botfarm.yml"), "utf8")).includes("botfarm_task_complete"), "prompts are moved to the new tool names")
ok(files.includes("mcps") && (await readdir(join(repo, "botfarm", "mcps"))).includes("worktree_status.js"), "a tools folder with an example tool")
let lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.agents.map((a) => a.id).sort().join() === "dev,qa" && lib.pipelines[0].id === "quick" && lib.pipelines[0].file === "botfarm/quick.pipeline.botfarm.yml", "the library reads them, each with its file")
await writeFile(join(repo, "botfarm", "reviewer.agent.botfarm.yml"), "title: Reviewer\nrole: reviewer\nprompt: Review it.\n")
lib = (await api(`/api/workspaces/${ws.id}/library`)).body
ok(lib.agents.some((a) => a.id === "reviewer" && a.title === "Reviewer"), "a file dropped in by hand is picked up, its id from the name")
let r = await api(`/api/workspaces/${ws.id}/pipelines/solo`, { method: "PUT", body: { doc: { id: "solo", title: "Solo", stages: [{ id: "only", persona: "dev", receives: [], prompt: "{{story}}" }] } } })
ok(r.status === 200 && (await readdir(join(repo, "botfarm"))).includes("solo.pipeline.botfarm.yml"), "saving from the app writes its own file")
r = await api(`/api/workspaces/${ws.id}/file/pipelines?entry=solo`)
ok(r.body.text.includes("title: Solo") && !r.body.text.includes("quick"), "the YAML tab shows just that file")
r = await api(`/api/workspaces/${ws.id}/file/pipelines?entry=solo`, { method: "PUT", body: { text: "title: Solo two\nstages:\n  - id: only\n    persona: dev\n    receives: []\n" } })
ok(r.status === 200 && r.body.pipelines.find((p) => p.id === "solo").title === "Solo two", "and writes just that file")
r = await api(`/api/workspaces/${ws.id}/pipelines/solo`, { method: "DELETE" })
ok(!(await readdir(join(repo, "botfarm"))).includes("solo.pipeline.botfarm.yml"), "deleting removes the file")
r = await api(`/api/workspaces/${ws.id}/agents/bad%20id`, { method: "PUT", body: { doc: { id: "bad id", prompt: "x" } } })
ok(r.status >= 400, "an id that cannot be a file name is refused")

console.log("\nworkspace tools from botfarm/mcps/")
await writeFile(join(repo, "botfarm", "mcps", "shout.js"), `export const name = "shout"
export const description = "Upper-case some text."
export const inputSchema = { type: "object", properties: { text: { type: "string" }, times: { type: "number" } }, required: ["text"] }
export async function execute({ text, times = 1 }, ctx) { ctx.log("shouting", times); return { text: text.toUpperCase().repeat(times), where: ctx.repoRoot, bot: ctx.bot?.handle ?? null } }
`)
await writeFile(join(repo, "botfarm", "mcps", "broken.js"), `export const name = "roster"\nexport async function execute() {}\n`)
let tools = (await api(`/api/workspaces/${ws.id}/tools`)).body
ok(tools.tools.some((t) => t.name === "shout") && tools.tools.some((t) => t.name === "worktree_status"), "every .js file there is a tool")
ok(tools.errors.some((e) => e.file === "broken.js" && /built-in/.test(e.error)), "a file that takes a built-in name is reported, not loaded")
r = await api(`/api/workspaces/${ws.id}/tools/shout/run`, { method: "POST", body: { args: { text: "hi", times: 2 } } })
ok(r.body.ok && r.body.result.text === "HIHI" && r.body.result.where === repo && r.body.logs[0] === "shouting 2", "the test bench runs it in the workspace, with its log")
r = await api(`/api/workspaces/${ws.id}/tools/worktree_status/run`, { method: "POST", body: { args: {} } })
ok(r.body.ok && r.body.result.branch === "main", "the example tool runs git in the checkout")
await writeFile(join(repo, "botfarm", "mcps", "boom.js"), `export const name = "boom"\nexport async function execute() { throw new Error("kaboom") }\n`)
await sleep(600)
r = await api(`/api/workspaces/${ws.id}/tools/boom/run`, { method: "POST", body: {} })
ok(!r.body.ok && r.body.error === "kaboom", "a failing tool comes back as an error, not a crash (and new files load without a restart)")
r = await api(`/api/workspaces/${ws.id}/tools`, { method: "POST", body: { name: "fresh_tool" } })
ok(r.status === 201 && r.body.file === "fresh_tool.js" && r.body.tools.some((t) => t.name === "fresh_tool"), "New tool writes a working template")
r = await api(`/api/workspaces/${ws.id}/tools/fresh_tool.js/source`)
ok(r.body.text.includes('export const name = "fresh_tool"'), "its source can be read")
await api(`/api/workspaces/${ws.id}/tools/fresh_tool.js/source`, { method: "PUT", body: { text: r.body.text.replace("Say what this does", "Lists a folder") } })
tools = (await api(`/api/workspaces/${ws.id}/tools`)).body
ok(tools.tools.find((t) => t.name === "fresh_tool").description.startsWith("Lists a folder"), "and saving it reloads it")

console.log("\nbots see them as botfarm_* next to the built-ins")
const start = await sup.pipelines.start({ pipeline: "quick", workspace: ws.id, story: "US1: shout", title: "Shout" })
await sleep(300)
const dev = sup.store.get(start.sessions.dev)
const cfg = JSON.parse(await readFile(join(dev.directory, ".opencode", "opencode.json"), "utf8"))
ok(cfg.mcp.botfarm?.url?.includes("/mcp/") && !cfg.mcp.botfarm, "the worktree's MCP server is called botfarm")
const token = cfg.mcp.botfarm.url.split("/").pop()
const rpc = async (method, params) => (await (await fetch(`http://127.0.0.1:4841/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result
const init = await rpc("initialize", {})
ok(init.serverInfo.name === "botfarm", "and introduces itself as botfarm")
const listed = (await rpc("tools/list", {})).tools.map((t) => t.name)
ok(listed.includes("task_complete") && listed.includes("shout") && listed.includes("worktree_status"), "tools/list has the built-ins and the workspace's")
sup.mcpCalls.set(dev.id, Date.now())
const called = await rpc("tools/call", { name: "shout", arguments: { text: "ok" } })
ok(called.structuredContent?.text === "OK" && called.structuredContent.where === dev.directory, "a bot's call runs in its own worktree")
const devPrompt = (await (await fetch("http://127.0.0.1:4096/__prompts")).json()).find((p) => p.id === dev.id)
ok(JSON.stringify(devPrompt).includes("botfarm_task_complete") && !JSON.stringify(devPrompt).includes("botfarm_"), "prompts name the botfarm_ tools")

console.log("\nupgrade or downgrade a running bot")
r = await api(`/api/sessions/${dev.id}/models`)
ok(r.body.models.some((m) => m.id === "amazon-bedrock/anthropic.claude-opus-5" && m.variants.includes("max")), "the models opencode offers are listed, with their reasoning levels")
r = await api(`/api/sessions/${dev.id}/settings`, { method: "POST", body: { model: "amazon-bedrock/anthropic.claude-opus-5", variant: "high" } })
ok(r.status === 200 && r.body.override.model.endsWith("opus-5") && r.body.configuredModel.endsWith("opus-5"), "switching to opus is recorded on the bot")
await sup.send(dev.id, "carry on")
let last = (await (await fetch("http://127.0.0.1:4096/__prompts")).json()).filter((p) => p.id === dev.id).at(-1)
ok(last.model?.modelID === "anthropic.claude-opus-5" && last.variant === "high", "its next turn runs on opus, high")
await sup.syncWorkstreamConfig(start.projectId)
ok(sup.store.get(dev.id).override?.model?.endsWith("opus-5"), "a config refresh keeps it")
const manifest = await readFile(join(repo, ".botfarm", "workstreams", `${start.projectId}.yml`), "utf8")
ok(manifest.includes("opus-5"), "and the workstream manifest records it")
r = await api(`/api/sessions/${dev.id}/settings`, { method: "POST", body: { model: null, variant: null } })
await sup.send(dev.id, "again")
last = (await (await fetch("http://127.0.0.1:4096/__prompts")).json()).filter((p) => p.id === dev.id).at(-1)
ok(!r.body.override && last.model?.modelID !== "anthropic.claude-opus-5", "and it can go back to what its agent says")

sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
