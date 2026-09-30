// Minimal fake opencode v2 server: enough of /api to exercise botfarm locally.
import { createServer } from "node:http"

const sessions = new Map()
const messages = new Map()
const listeners = new Set()
const registered = [] // runtime MCP registrations, for tests
const created = [] // session create bodies, for tests
const prompts = [] // instance-engine prompt bodies, for tests
const pendingP = [], pendingQ = [], replies = []
const mcpState = new Map()
const mcpConnects = []
let mcpDown = false, mcpMode = false // the /mcp map routes switch on with /__mcp-down
let n = 0

function mkSession({ title, directory }) {
  const id = "ses_" + (++n).toString().padStart(4, "0")
  const s = { id, title, directory, time: { created: Date.now(), updated: Date.now() }, agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } }
  sessions.set(id, s)
  messages.set(id, [])
  return s
}
const emit = (payload) => {
  const frame = `data: ${JSON.stringify({ directory: "global", payload })}\n\n`
  for (const r of listeners) r.write(frame)
}

// seed two sessions, one of which works continuously
const a = mkSession({ title: "fix auth redirect", directory: "/home/claude/worktrees/app/fix-auth" })
const b = mkSession({ title: "flaky test triage", directory: "/home/claude/botfarm" })
const busy = new Set([a.id])

let step = 0
setInterval(() => {
  step++
  for (const id of busy) {
    const msgs = messages.get(id)
    const mid = "msg_" + id + "_" + Math.floor(step / 3)
    let m = msgs.find((x) => x.id === mid)
    if (!m) {
      m = { id, role: "assistant", id: mid, sessionID: id, time: { created: Date.now() }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parts: [] }
      msgs.unshift(m)
    }
    m.tokens.output += 150 + Math.floor(Math.random() * 400)
    m.tokens.input = 12000 + step * 40
    m.tokens.cache.read = 30000
    if (step % 2 === 0) {
      const pid = "prt_" + step
      m.parts.push({
        id: pid, type: "tool", name: ["bash", "read", "edit", "grep"][step % 4],
        state: { status: "completed", input: { command: "npm test -- --watch=false" }, time: { start: Date.now() - 1200, end: Date.now() } },
      })
    }
    m.parts.push({ type: "text", text: "Working on the redirect handler, step " + step })
    emit({ type: "message.part.updated", properties: { sessionID: id } })
  }
}, 500)

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const p = url.pathname
  const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)) }

  if (p === "/api/info") return json({ version: "mock", hostname: "127.0.0.1" })
  if (p === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ payload: { type: "server.connected" } })}\n\n`)
    listeners.add(res)
    req.on("close", () => listeners.delete(res))
    return
  }
  if (p === "/api/mcp") return json({ data: [{ name: "botfarm", status: "connected", tools: [{ name: "send" }, { name: "roster" }] }, { name: "playwright", status: "disconnected" }] })
  if (p === "/api/experimental/tool/ids") return json({ data: ["bash", "edit", "read", "grep", "webfetch"] })
  if (/^\/api\/experimental\/mcp\/[^/]+\/(connect|disconnect)$/.test(p)) return json({ ok: true })
  if (/^\/api\/experimental\/mcp\/[^/]+$/.test(p) && req.method === "PUT") {
    const body = JSON.parse(await text(req))
    registered.push({ name: p.split("/").pop(), directory: url.searchParams.get("location[directory]") ?? url.searchParams.get("directory"), config: body.config })
    return json({ ok: true })
  }
  // --- the instance engine (/session…?directory=), as the TUI uses it ------
  if (p === "/global/event") {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ payload: { type: "server.connected" } })}\n\n`)
    listeners.add(res)
    req.on("close", () => listeners.delete(res))
    return
  }
  if (p === "/session" && req.method === "POST") {
    const body = JSON.parse(await text(req))
    created.push({ ...body, engine: "v1", location: { directory: url.searchParams.get("directory") } })
    const s = mkSession({ title: body.title, directory: url.searchParams.get("directory") })
    return json(s)
  }
  if (p === "/session/status") {
    return json(Object.fromEntries([...sessions.keys()].map((id) => [id, { type: busy.has(id) ? "busy" : "idle" }])))
  }
  const v1 = /^\/session\/([^/]+)\/(prompt_async|message|abort)$/.exec(p)
  if (v1 && sessions.has(v1[1])) {
    const id = v1[1]
    if (v1[2] === "message") return json((messages.get(id) ?? []).slice(0, Number(url.searchParams.get("limit") ?? 50)).slice().reverse().map((m) => ({ info: m, parts: m.parts })))
    if (v1[2] === "abort") { busy.delete(id); return json(true) }
    const body = JSON.parse(await text(req))
    prompts.push({ id, ...body })
    messages.get(id).unshift({ id: "msg_in_" + Math.random().toString(36).slice(2, 7), sessionID: id, role: "user", time: { created: Date.now() }, parts: body.parts })
    busy.add(id)
    res.writeHead(204)
    return res.end()
  }
  if (p === "/__prompts") return json(prompts)
  if (p === "/config/providers") {
    return json({ providers: [{ id: "amazon-bedrock", name: "Amazon Bedrock", models: {
      "anthropic.claude-sonnet-5": { name: "Claude Sonnet 5", variants: { low: {}, medium: {}, high: {} } },
      "anthropic.claude-opus-5": { name: "Claude Opus 5", variants: { low: {}, medium: {}, high: {}, max: {} } },
    } }], default: {} })
  }
  // Pending asks from the instance engine, and a way for tests to raise one.
  if (p === "/__ask" && req.method === "POST") {
    const body = JSON.parse(await text(req))
    const id = (body.kind === "question" ? "que_" : "per_") + Math.random().toString(36).slice(2, 8)
    ;(body.kind === "question" ? pendingQ : pendingP).push({ id, ...body.request, sessionID: body.sessionID })
    emit({ type: body.kind === "question" ? "question.asked" : "permission.asked", properties: { sessionID: body.sessionID, id } })
    return json({ id })
  }
  if (p === "/permission") return json(pendingP)
  if (p === "/question") return json(pendingQ)
  const rep = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(p)
  if (rep) {
    const body = JSON.parse((await text(req)) || "{}")
    replies.push({ kind: rep[1], id: rep[2], action: rep[3], ...body })
    const list = rep[1] === "permission" ? pendingP : pendingQ
    const i = list.findIndex((x) => x.id === rep[2])
    if (i >= 0) list.splice(i, 1)
    return json(true)
  }
  // MCP status per directory. "local-dev" starts failed, as when the docker
  // server was down when opencode opened the directory; /connect fixes it
  // unless /__mcp-down says the server is still down.
  if (p === "/mcp" && req.method === "GET" && mcpMode) {
    const dir = url.searchParams.get("directory")
    return json({ botfarm: { status: "connected" }, "local-dev": mcpState.get(dir) ?? { status: "failed", error: "server unavailable" }, rag: { status: "disabled" } })
  }
  const conn = /^\/mcp\/([^/]+)\/connect$/.exec(p)
  if (conn && req.method === "POST" && mcpMode) {
    mcpConnects.push({ name: decodeURIComponent(conn[1]), directory: url.searchParams.get("directory") })
    if (!mcpDown) mcpState.set(url.searchParams.get("directory"), { status: "connected" })
    return json(true)
  }
  if (p === "/__mcp-down") { mcpMode = true; mcpDown = url.searchParams.get("down") === "1"; if (mcpDown) mcpState.clear(); return json(mcpDown) }
  if (p === "/__mcp-connects") return json(mcpConnects)
  if (p === "/__replies") return json(replies)
  if (p === "/__registered") return json(registered)
  if (p === "/config" && req.method === "GET") {
    // What a real server resolves for a directory: its opencode.json files, merged.
    const { readFileSync } = await import("node:fs")
    const dir = url.searchParams.get("directory")
    const out = { agent: {}, mcp: {} }
    for (const f of ["opencode.json", ".opencode/opencode.json"]) {
      try {
        const c = JSON.parse(readFileSync(dir + "/" + f, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"))
        Object.assign(out.agent, c.agent ?? {}); Object.assign(out.mcp, c.mcp ?? {}); if (c.model) out.model = c.model
      } catch {}
    }
    return json(out)
  }
  if (p === "/__created") return json(created)
  // Oldest first and capped, like a real server with a long history: the
  // newest sessions are the ones that fall off a single page.
  if (p === "/api/session" && req.method === "GET") return json({ data: [...sessions.values()].slice(0, Number(url.searchParams.get("limit") ?? 1000)) })
  if (p === "/api/session" && req.method === "POST") {
    const body = JSON.parse(await text(req))
    created.push(body)
    const s = mkSession({ title: body.title, directory: body.location?.directory })
    emit({ type: "session.created", properties: { info: s } })
    return json({ data: s })
  }
  if (p === "/api/session/active") return json({ data: Object.fromEntries([...busy].map((id) => [id, true])) })
  const m = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(p)
  if (m) {
    const id = m[1]
    const tail = m[2] ?? ""
    if (!sessions.has(id)) return json({ error: "not found" }, 404)
    if (tail === "/message") return json({ data: (messages.get(id) ?? []).slice(0, Number(url.searchParams.get("limit") ?? 20)) })
    if (tail === "/prompt" || tail === "/synthetic") {
      const body = JSON.parse(await text(req))
      if (tail === "/prompt" && !body.prompt) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ _tag: "InvalidRequestError", message: 'Missing key\n at ["prompt"]', kind: "Payload" }))
      }
      const promptText = body.prompt?.text ?? body.message?.text ?? body.prompt ?? body.text ?? ""
      if (!promptText) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ _tag: "InvalidRequestError", message: "no text in payload", kind: "Payload" }))
      }
      messages.get(id).unshift({
        id: "msg_in_" + Math.random().toString(36).slice(2, 7), sessionID: id,
        role: tail === "/synthetic" ? "synthetic" : "user",
        time: { created: Date.now() },
        parts: [{ type: "text", text: promptText }],
      })
      busy.add(id)
      emit({ type: "message.updated", properties: { sessionID: id } })
      return json({ data: { id: "msg_x" } })
    }
    if (tail === "/interrupt") { busy.delete(id); return json({ interrupted: true }) }
    if (tail === "/permission") return json({ data: [] })
    if (tail === "/compact") { res.writeHead(204); return res.end() }
    if (!tail && req.method === "DELETE") { sessions.delete(id); busy.delete(id); res.writeHead(204); return res.end() }
    if (!tail) return json({ data: sessions.get(id) })
  }
  json({ error: "no route " + p }, 404)
}).listen(4096, () => console.log("mock opencode on http://127.0.0.1:4096"))

async function text(req) {
  const c = []
  for await (const x of req) c.push(x)
  return Buffer.concat(c).toString()
}
