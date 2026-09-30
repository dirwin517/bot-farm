// Who a bot is (its name), who owns a task (a session, a part, or you), and
// whether a pipeline can be edited without leaving the app.
import { spawn as spawnProc, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import { handleFor, adjectivesFor } from "../src/identity.mjs"
import * as YAML from "../src/yaml.mjs"

const run = promisify(execFile)
const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))

console.log("names carry the job")
ok(adjectivesFor("qa").includes("prying"), "a tester draws from a suspicious vocabulary")
ok(adjectivesFor("dev").includes("polishing"), "a builder from a making one")
ok(adjectivesFor("product").includes("framing"), "product from a shaping one")
ok(adjectivesFor(null).includes("brisk"), "anything else falls back to the generic list")
ok(adjectivesFor("qa", ["grumpy"])[0] === "grumpy", "a persona can bring its own words")
const taken = new Set()
const qa = handleFor("ses_q", taken, { role: "qa" })
const dev = handleFor("ses_d", taken, { role: "dev" })
ok(adjectivesFor("qa").includes(qa.split("-")[0]), `a QA session is named like one (@${qa})`)
ok(adjectivesFor("dev").includes(dev.split("-")[0]), `and a dev session like one (@${dev})`)
ok(handleFor("ses_q", new Set(), { role: "qa" }) === qa, "and the name is stable")

const repo = await mkdtemp(join(tmpdir(), "roles-"))
await run("git", ["init", "-q", "-b", "main"], { cwd: repo })
await writeFile(join(repo, "README.md"), "# demo\n")
await run("git", ["add", "."], { cwd: repo })
await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: repo })
const home = await mkdtemp(join(tmpdir(), "roleshome-"))

await sleep(600)
const sup = new Supervisor({
  url: "http://127.0.0.1:4096",
  statePath: join(home, "m.json"),
  registryPath: join(home, "r.json"),
  mcpBase: "http://127.0.0.1:4807",
})
await sup.start()
startServer({ supervisor: sup, port: 4807 })
const api = async (p, opts = {}) =>
  (await fetch("http://127.0.0.1:4807" + p, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })).json()

const r = await sup.pipelines.start({ pipeline: "story", repo, branch: "feat/x", story: "Something is wrong with login.", title: "Login" })
await sleep(500)

console.log("\nthe crew is named for what it does")
const named = Object.entries(r.sessions).map(([persona, id]) => [persona, sup.store.get(id).handle])
for (const [persona, handle] of named) {
  ok(adjectivesFor(persona).includes(handle.split("-")[0]), `${persona} → @${handle}`)
}
ok(new Set(named.map(([, h]) => h)).size === named.length, "and no two share a name")

console.log("\ntasks belong to a part, not only to one session")
const buildTask = sup.tasks.get(r.taskIds.build)
ok(buildTask.role === "dev", "a stage task records the part that owns it")
ok(buildTask.owner === "session", "as well as the session currently playing it")
const loose = sup.tasks.create({ title: "Fix the flake", brief: "x", role: "qa", owner: "role", projectId: r.projectId })
ok(loose.status === "queued" && !loose.assignee, "work can be addressed to a part with nobody named")
const qaSession = sup.store.get(r.sessions.qa)
qaSession.setStatus("idle")
await sup.pipelines.dispatch()
const claimed = sup.tasks.get(loose.id)
ok(claimed.assignee === qaSession.id, "whoever is playing that part picks it up")
ok(claimed.status === "active", "and it becomes theirs, so a second bot cannot take it too")

console.log("\nthe human is an assignee too")
const rpc = (session) => {
  const url = sup.mcpUrlFor(session)
  let id = 0
  return async (name, args = {}) => {
    // Every bot in a run shares one worktree, and opencode keeps one MCP URL
    // per worktree, so the URL alone cannot say who is calling. In real use
    // the event stream announces the botfarm_ tool starting; stand in for that.
    sup.mcpCalls.set(session.id, Date.now())
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    })
    const out = (await res.json()).result
    return { isError: !!out.isError, data: out.structuredContent, text: out.content[0].text }
  }
}
const dev2 = sup.store.get(r.sessions.dev)
const callDev = rpc(dev2)
let out = await callDev("ask_human", {
  question: "Should the return path survive a second SSO hop, or is one enough?",
  options: ["one hop is enough", "must survive any number"],
})
ok(!out.isError && out.data.asked, "a bot can ask its operator directly")
const question = sup.tasks.get(out.data.task_id)
ok(question.owner === "human" && question.kind === "question", "which lands as a human-owned question")
ok(question.status === "waiting", "waiting, not queued — nothing dispatches it")
ok(question.options.length === 2, "with the choices it offered")
ok(sup.tasks.forHuman().some((t) => t.id === question.id), "and it surfaces in what needs you")

out = await callDev("tasks")
ok(out.data.yours.some((t) => t.id === question.id), "the asker can see it is still open")

await api(`/api/tasks/${question.id}/answer`, { method: "POST", body: { answer: "One hop is enough." } })
await sleep(300)
const answered = sup.tasks.get(question.id)
ok(answered.status === "done" && answered.answer === "One hop is enough.", "answering closes it")
const devMsgs = (await sup.client.messages(dev2.id, { limit: 20 })).flatMap((m) => (m.parts ?? []).map((p) => p.text ?? ""))
ok(devMsgs.some((t) => t.includes("your operator answered")), "and the answer goes back to the bot that asked")
ok(devMsgs.some((t) => t.includes("came from the human running this session")), "marked as coming from you, not from a peer")

console.log("\na pipeline can have a stage that is yours")
const story = sup.pipelines.definitions.get("story")
ok(story.stages.some((st) => st.human), "the shipped pipeline ends with a human sign-off")
const signoff = sup.tasks.all({ runId: r.id }).find((t) => t.stage === "signoff")
ok(signoff?.owner === "human", "which becomes a task for you when its turn comes")
ok(!signoff.assignee, "never dispatched to a bot")

console.log("\nediting definitions")
const def = await api("/api/pipelines/story")
ok(def.doc.stages.length === 5 && def.yaml.includes("stages:"), "a definition can be read back as structure and as YAML")
const edited = structuredClone(def.doc)
edited.stages.splice(1, 0, { id: "spike", persona: "dev", title: "Spike it first", receives: ["analyse"], prompt: "Try it roughly: {{story}}" })
let saved = await api("/api/pipelines/story", { method: "PUT", body: { doc: edited } })
ok(saved.problems.length === 0, "a stage can be inserted")
ok(sup.pipelines.definitions.get("story").stages.length === 6, "and takes effect without a restart")
const onDisk = YAML.parse(await readFile(join(home, "pipelines", "story.yaml"), "utf8"))
ok(onDisk.stages[1].id === "spike", "written back to the YAML file, still yours to diff and commit")

const broken = structuredClone(edited)
broken.stages[2].receives = ["nope"]
saved = await api("/api/pipelines/story", { method: "PUT", body: { doc: broken } })
ok(saved.problems.some((p) => p.includes("nope")), "a stage receiving something that does not exist is reported, not swallowed")

const persona = await api("/api/personas/qa")
const pdoc = { ...persona.doc, model: "anthropic/claude-haiku-4-5", tools: ["read", "grep", "bash"], adjectives: ["grumpy", "dubious"] }
saved = await api("/api/personas/qa", { method: "PUT", body: { doc: pdoc } })
ok(saved.problems.length === 0, "a persona's model, tools and vocabulary can be changed")
ok(sup.pipelines.personas.get("qa").model === "anthropic/claude-haiku-4-5", "and is live immediately")
const fresh = handleFor("ses_new_qa", new Set(), {
  role: "qa",
  adjectives: sup.pipelines.personas.get("qa").adjectives,
})
ok(fresh.startsWith("grumpy") || fresh.startsWith("dubious"), `so the next tester is named from it (@${fresh})`)

await sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
