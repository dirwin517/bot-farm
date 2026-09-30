// End-to-end smoke test: mock opencode -> supervisor -> dashboard API.
import { spawn } from "node:child_process"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"

const mock = spawn(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1 }
const ok = (c, m) => (c ? console.log("  ok  " + m) : fail(m))

await sleep(600)
const sup = new Supervisor({ url: "http://127.0.0.1:4096", statePath: "/tmp/botfarm-test-" + Date.now() + ".json", registryPath: "/tmp/botfarm-reg-" + Math.random().toString(36).slice(2) + ".json" })
await sup.start()
const { url } = startServer({ supervisor: sup, port: 4788 })
const get = async (p, o) => (await fetch(url + p, o)).json()

// the board only shows sessions botfarm manages, so adopt the mock's two first
await sup.adopt(sup.unmanaged.map((x) => x.id))
await sleep(2600)
let state = await get("/api/state")
console.log("\nstate after 7s")
ok(state.sessions.length === 2, "two sessions discovered")
ok(state.totals.busy === 1, "one session reported busy")
const busy = state.sessions.find((s) => s.status === "busy")
ok(busy.tokPerMin > 0, `token rate is live (${busy.tokPerMin}/min)`)
ok(busy.totals.tools > 0, `tool calls counted (${busy.totals.tools})`)
ok(busy.spark.tok.length === 60 && busy.spark.tok.at(-1) > 0, "sparkline has 60 buckets with a live tail")
ok(busy.contextTokens > 0, `context tokens tracked (${busy.contextTokens})`)
ok(!!busy.lastText, "latest assistant text captured")

const idle = state.sessions.find((s) => s.status === "idle")
console.log("\nsend a prompt to the idle session")
await fetch(`${url}/api/sessions/${idle.id}/send`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "continue" }),
})
await sleep(1800)
state = await get("/api/state")
const woken = state.sessions.find((s) => s.id === idle.id)
ok(woken.status === "busy", "idle session went busy after continue")
ok(woken.tokPerMin > 0, `woken session burning tokens (${woken.tokPerMin}/min)`)

console.log("\ndetail view")
const d = await get(`/api/sessions/${busy.id}`)
ok(d.toolLog.length > 0, `tool log populated (${d.toolLog.length} entries, first: ${d.toolLog[0]?.name})`)
ok(d.transcript.length > 0, `transcript rendered (${d.transcript.length} messages)`)
ok(typeof d.totals.output === "number" && d.totals.output > 0, `output tokens accumulated (${d.totals.output})`)

console.log("\nabort")
await fetch(`${url}/api/sessions/${busy.id}/abort`, { method: "POST" })
await sleep(1800)
state = await get("/api/state")
ok(state.sessions.find((s) => s.id === busy.id).status === "idle", "aborted session reports idle")

console.log("\nstatic + stream")
const html = await fetch(url + "/")
ok(html.status === 200 && (await html.text()).includes("botfarm"), "dashboard html served")
const es = await fetch(url + "/api/stream", { headers: { accept: "text/event-stream" } })
const first = await es.body[Symbol.asyncIterator]().next()
ok(Buffer.from(first.value).toString().startsWith("data: "), "SSE stream pushes state frames")

console.log("\nmetrics persistence")
await sup.store.save()
ok((await import("node:fs")).existsSync(sup.store.statePath), "metrics snapshot written")

await sup.stop()
mock.kill()
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed")
process.exit(process.exitCode ?? 0)
