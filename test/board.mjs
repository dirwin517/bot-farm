// The board is a registry, not a listing: ownership, groups, cost, tools.
import { spawn as spawnProc } from "node:child_process"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"
import { estimate, normalise, rateFor } from "../src/pricing.mjs"
import { handleFor, avatarFor, GLYPH } from "../src/identity.mjs"

const mock = spawnProc(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))

console.log("identities")
ok(GLYPH.size >= 64, `the creature roster is ${GLYPH.size} strong`)
ok(new Set(GLYPH.values()).size === GLYPH.size, "every creature has its own glyph — no two share a face")
const taken = new Set()
const creatures = new Set()
for (let i = 0; i < 300; i++) {
  const h = handleFor("ses_test_" + i, taken)
  taken.add(h)
  creatures.add(h.split("-").slice(1).join("-"))
}
ok(taken.size === 300, "300 sessions get 300 distinct handles")
ok(creatures.size > 40, `spread across ${creatures.size} different creatures`)
const svg = avatarFor("ses_test_1", { handle: [...taken][0] })
ok(/viewBox="0 0 32 32"/.test(svg) && /<text/.test(svg), "and each renders as a glyph avatar")
ok(avatarFor("x", { handle: "brisk-otter" }) === avatarFor("x", { handle: "brisk-otter" }), "deterministic across calls")

console.log("\npricing")
ok(normalise("us.anthropic.claude-sonnet-4-20250514-v1:0") === "claude-sonnet-4", "a Bedrock id normalises to its family")
ok(normalise("anthropic/claude-opus-4-1-20250805") === "claude-opus-4-1", "a provider-prefixed id normalises too")
ok(rateFor("us.anthropic.claude-sonnet-4-20250514-v1:0")?.input === 3, "and finds a rate")
const bedrock = estimate({
  model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  totals: { input: 100_000, output: 20_000, cacheRead: 1_000_000, cacheWrite: 50_000 },
  reported: 0,
})
ok(bedrock.usd > 0 && bedrock.estimated, `Bedrock sessions get a price anyway ($${bedrock.usd.toFixed(3)})`)
ok(Math.abs(bedrock.usd - (0.3 + 0.3 + 0.3 + 0.1875)) < 0.01, "cache reads are a tenth and writes a quarter more")
ok(estimate({ model: "x", totals: {}, reported: 4.2 }).estimated === false, "a reported cost is used as-is")
ok(estimate({ model: "some-new-model", totals: { input: 5 } }).unknownModel === "some-new-model", "an unpriced model says so rather than guessing")
ok(estimate({ model: "gpt-4o", totals: { input: 1e6 }, overrides: { "gpt-4o": { input: 99, output: 1 } } }).usd === 99, "config overrides win")

await sleep(600)
const sup = new Supervisor({
  url: "http://127.0.0.1:4096",
  statePath: "/tmp/botfarm-reg-state-" + Date.now() + ".json",
  registryPath: "/tmp/botfarm-reg-" + Date.now() + ".json",
  mcpBase: "http://127.0.0.1:4795",
})
await sup.start()
const { url } = startServer({ supervisor: sup, port: 4795 })
const get = async (p) => (await fetch(url + p)).json()
const post = async (p, body) =>
  (await fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json()

console.log("\nan empty board")
let state = await get("/api/state")
ok(state.sessions.length === 0, "sessions opencode knows about do not appear on their own")
ok(state.unmanaged === 2, `they are offered instead (${state.unmanaged} available)`)
let loose = await get("/api/unmanaged")
ok(loose.sessions.length === 2 && loose.sessions[0].title, "the adoption list carries enough to choose by")
ok((await get("/api/unmanaged?q=flaky")).sessions.length === 1, "the list is searchable")

console.log("\nadopting")
await post("/api/adopt", { ids: [loose.sessions[0].id], project: "auth-work" })
await sleep(1400)
state = await get("/api/state")
ok(state.sessions.length === 1, "only the adopted session is on the board")
ok(state.unmanaged === 1, "the rest stay out of the way")
ok(state.projects.some((p) => p.id === "auth-work"), "the project is created and counted")
ok(!!state.sessions[0].handle, `it gets an identity (@${state.sessions[0].handle})`)

console.log("\ncost on a card")
const adopted = state.sessions[0]
ok(adopted.cost && typeof adopted.cost.usd === "number", "every card carries a cost")
const detail = await get(`/api/sessions/${adopted.id}`)
ok(detail.cost.estimated === true, "which is marked as an estimate when the provider gave us none")

console.log("\nlast message on the card")
ok(typeof adopted.lastText === "string" && adopted.lastText.length > 0, `the card shows what you would be continuing ("${adopted.lastText.slice(0, 40)}…")`)

console.log("\ntools")
ok(detail.tools.servers.length === 2, `MCP servers are listed (${detail.tools.servers.map((s) => s.name).join(", ")})`)
ok(detail.tools.servers.find((s) => s.name === "playwright")?.connected === false, "with their connection state")
ok(detail.tools.builtin.length > 0 && detail.tools.builtin.every((t) => t.enabled), "built-in tools start enabled")
await post(`/api/sessions/${adopted.id}/tools`, { name: "bash", enabled: false })
const after = await get(`/api/sessions/${adopted.id}`)
ok(after.tools.builtin.find((t) => t.name === "bash")?.enabled === false, "a tool can be switched off")
ok((await post(`/api/sessions/${adopted.id}/mcp`, { name: "playwright", connected: true })).ok, "an MCP server can be connected")

console.log("\ngroups and release")
await post(`/api/sessions/${adopted.id}/group`, { project: "default" })
state = await get("/api/state")
ok(state.sessions[0].project === "default", "a session can be moved between projects")
await post(`/api/sessions/${adopted.id}/release`, {})
state = await get("/api/state")
ok(state.sessions.length === 0 && state.unmanaged === 2, "releasing puts it back in the pool without deleting it")

console.log("\nrestart")
await sup.registry.load()
const reopened = sup.projects.get("auth-work")
ok(!!reopened && reopened.name === "auth-work", "the project itself outlives the sessions in it")

await sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
