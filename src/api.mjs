// Thin client for the opencode server (REST + SSE). Built-in fetch only.
//
// opencode's HTTP surface is explicitly experimental and has moved once already
// (v1: /session, /event  ->  v2: /api/session, /api/event). Rather than pin to
// one, we sniff the dialect at connect time and keep every path in one table.

const DIALECTS = {
  v2: {
    name: "v2",
    probe: "/api/info",
    events: "/api/event",
    sessions: () => "/api/session",
    active: () => "/api/session/active",
    session: (id) => `/api/session/${id}`,
    messages: (id) => `/api/session/${id}/message`,
    prompt: (id) => `/api/session/${id}/prompt`,
    interrupt: (id) => `/api/session/${id}/interrupt`,
    synthetic: (id) => `/api/session/${id}/synthetic`,
    mcp: (name) => `/api/experimental/mcp/${name}`,
    mcpList: () => "/api/mcp",
    mcpConnect: (name) => `/api/experimental/mcp/${name}/connect`,
    mcpDisconnect: (name) => `/api/experimental/mcp/${name}/disconnect`,
    toolIds: () => "/api/experimental/tool/ids",
    compact: (id) => `/api/session/${id}/compact`,
    permissions: (id) => `/api/session/${id}/permission`,
    permissionReply: (id, rid) => `/api/session/${id}/permission/${rid}/reply`,
    projects: () => "/api/project",
    createBody: ({ title, directory, agent, model }) => ({
      title,
      agent: agent ?? null,
      model: model ?? null,
      location: directory ? { directory } : null,
    }),
  },
  v1: {
    name: "v1",
    probe: "/app",
    events: "/event",
    sessions: () => "/session",
    active: () => null,
    session: (id) => `/session/${id}`,
    messages: (id) => `/session/${id}/message`,
    prompt: (id) => `/session/${id}/message`,
    interrupt: (id) => `/session/${id}/abort`,
    synthetic: null,
    mcp: null,
    mcpList: null,
    mcpConnect: null,
    mcpDisconnect: null,
    toolIds: null,
    compact: (id) => `/session/${id}/summarize`,
    permissions: () => null,
    permissionReply: (id, rid) => `/session/${id}/permissions/${rid}`,
    projects: () => "/project",
    createBody: ({ title }) => ({ title }),
  },
}

export class OpencodeClient {
  constructor(baseUrl = "http://127.0.0.1:4096") {
    this.base = baseUrl.replace(/\/+$/, "")
    this.dialect = null
    this.info = null
    this.shapes = new Map() // endpoint -> the request body shape this server took
    // Sessions run by the instance engine (/session/… ?directory=), keyed to
    // their directory. On current servers the v2 session runner cannot drive
    // some providers — Bedrock fails with "Unsupported API … aisdk:@ai-sdk/
    // amazon-bedrock" — while the instance engine (what the TUI uses) can.
    this.v1 = new Map()
  }

  markV1(id, directory) {
    if (id && directory) this.v1.set(id, directory)
  }

  async connect() {
    for (const d of [DIALECTS.v2, DIALECTS.v1]) {
      try {
        const res = await fetch(this.base + d.probe, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          this.dialect = d
          this.info = await res.json().catch(() => null)
          return d.name
        }
      } catch {}
    }
    throw new Error(`no opencode server at ${this.base} (start one with: opencode serve)`)
  }

  get ready() {
    return this.dialect !== null
  }

  async req(path, { method = "GET", body, query } = {}) {
    if (!path) return null
    const url = new URL(this.base + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v))
    }
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`${method} ${url.pathname} -> ${res.status} ${text.slice(0, 300)}`)
    }
    if (res.status === 204) return null
    const ct = res.headers.get("content-type") ?? ""
    return ct.includes("json") ? res.json() : res.text()
  }

  // `data` wrapping differs between routes and versions; unwrap defensively.
  static unwrap(payload) {
    if (payload == null) return []
    if (Array.isArray(payload)) return payload
    if (Array.isArray(payload.data)) return payload.data
    if (payload.data && typeof payload.data === "object") return payload.data
    return payload
  }

  async listSessions({ directory, limit = 100 } = {}) {
    const out = await this.req(this.dialect.sessions(), { query: { directory, limit: String(limit), order: "desc" } })
    const list = OpencodeClient.unwrap(out)
    return Array.isArray(list) ? list : []
  }

  // Sessions with a live agent loop owned by this server process.
  async activeSessionIds() {
    const path = this.dialect.active()
    let out = null
    if (path) {
      try {
        const data = OpencodeClient.unwrap(await this.req(path))
        out = new Set(Array.isArray(data) ? data.map((x) => (typeof x === "string" ? x : x.id ?? x.sessionID)) : Object.keys(data ?? {}))
      } catch {}
    }
    // Instance-engine sessions report through /session/status, per directory.
    for (const dir of new Set(this.v1.values())) {
      try {
        const map = await this.req("/session/status", { query: { directory: dir } })
        out ??= new Set()
        for (const [id, st] of Object.entries(map ?? {})) if ((st?.type ?? st) !== "idle") out.add(id)
      } catch {}
    }
    return out
  }

  getSession(id) {
    return this.req(this.dialect.session(id)).then(OpencodeClient.unwrap)
  }

  createSession(opts) {
    const query = this.dialect.name === "v1" ? { directory: opts.directory } : undefined
    // No variant on the model ref: the session runner rejects a variant the
    // model does not list ("Variant unavailable … medium") and the turn dies.
    // The reasoning level lives on the bot's opencode agent instead.
    const ref = modelRef(opts.model)
    const body = this.dialect.createBody(opts)
    // v2 takes model as { id, providerID, variant }. Fall back to no model
    // (and then no agent) rather than failing to create the session.
    return this.postShaped("create", this.dialect.sessions(), [
      () => ({ ...body, model: ref }),
      () => ({ ...body, model: ref ? { providerID: ref.providerID, modelID: ref.id } : null }),
      () => ({ ...body, model: null }),
      () => ({ ...body, model: null, agent: null }),
    ], { query }).then(OpencodeClient.unwrap)
  }

  deleteSession(id) {
    return this.req(this.dialect.session(id), { method: "DELETE" })
  }

  messages(id, { limit = 20, order = "desc" } = {}) {
    if (this.v1.has(id)) {
      // Oldest first there; everything here reads newest first.
      return this.req(`/session/${id}/message`, { query: { directory: this.v1.get(id), limit: String(limit) } }).then((out) => {
        const list = OpencodeClient.unwrap(out)
        return Array.isArray(list) ? list.slice().reverse() : []
      })
    }
    return this.req(this.dialect.messages(id), { query: { limit: String(limit), order } }).then((out) => {
      const list = OpencodeClient.unwrap(out)
      return Array.isArray(list) ? list : []
    })
  }

  /**
   * Body shapes here have already changed under us once: v2 wraps the text as
   * { prompt: { text } } where v1 took { parts: [...] }. Rather than pin to
   * one and fail with a 400 that says nothing useful, try the known shapes in
   * order and remember which one this server accepted.
   */
  async postShaped(key, path, builders, { query } = {}) {
    // Cache the *index* of the shape that worked, never the body itself:
    // caching the body would resend the first message's text forever.
    const known = this.shapes.get(key)
    const order = known === undefined ? builders.map((_, i) => i) : [known, ...builders.map((_, i) => i).filter((i) => i !== known)]
    let last
    for (const i of order) {
      try {
        const out = await this.req(path, { method: "POST", body: builders[i](), query })
        this.shapes.set(key, i)
        return out
      } catch (err) {
        // Only a payload rejection means "wrong shape" — anything else is real.
        if (!/-> 4(00|22)\b/.test(err.message)) throw err
        last = err
      }
    }
    throw new Error(`${path}: no accepted request shape (${last?.message ?? "unknown"})`)
  }

  /**
   * `tools` is opencode's per-turn switch map ({ bash: false, … }): the only
   * reliable way to narrow what one session in a shared worktree may use.
   * Shapes with it are tried first; a server that refuses the key still gets
   * the message.
   */
  /** Questions opencode's own question tool is waiting on for this session. */
  async pendingQuestions(id) {
    if (!this.v1.has(id)) return []
    const list = await this.req("/question", { query: { directory: this.v1.get(id) } }).catch(() => [])
    return (Array.isArray(list) ? list : []).filter((q) => q.sessionID === id).map((q) => ({ id: q.id, questions: q.questions ?? [] }))
  }

  /** answers: one array of chosen labels (or typed text) per question. */
  replyQuestion(id, requestId, answers) {
    return this.req(`/question/${requestId}/reply`, { method: "POST", body: { answers }, query: { directory: this.v1.get(id) } })
  }

  rejectQuestion(id, requestId) {
    return this.req(`/question/${requestId}/reject`, { method: "POST", body: {}, query: { directory: this.v1.get(id) } })
  }

  /** Instance engine: create a session in a directory, on an agent and model. */
  async createSessionV1({ title, directory, agent, model }) {
    const ref = modelRef(model)
    const body = { title, ...(agent ? { agent } : {}), ...(ref ? { model: { providerID: ref.providerID, modelID: ref.id } } : {}) }
    let info
    try {
      info = OpencodeClient.unwrap(await this.req("/session", { method: "POST", body, query: { directory } }))
    } catch (e) {
      // Older servers take neither agent nor model at creation.
      if (!/-> 4(00|22)\b/.test(e.message)) throw e
      info = OpencodeClient.unwrap(await this.req("/session", { method: "POST", body: { title }, query: { directory } }))
    }
    if (info?.id) this.markV1(info.id, directory)
    return info
  }

  /** Instance engine: queue a turn. Agent, model and tool switches go with every turn. */
  promptV1(id, text, { agent, model, variant, tools, synthetic = false } = {}) {
    const ref = modelRef(model)
    return this.req(`/session/${id}/prompt_async`, {
      method: "POST",
      query: { directory: this.v1.get(id) },
      body: {
        parts: [{ type: "text", text, ...(synthetic ? { synthetic: true } : {}) }],
        ...(agent ? { agent } : {}),
        ...(ref ? { model: { providerID: ref.providerID, modelID: ref.id } } : {}),
        ...(variant ? { variant } : {}),
        ...(tools ? { tools } : {}),
      },
    })
  }

  prompt(id, text, { agent, model, variant, tools } = {}) {
    if (this.v1.has(id)) return this.promptV1(id, text, { agent, model, variant, tools })
    const base = this.dialect.name === "v2"
      ? [() => ({ prompt: { text } }), () => ({ prompt: text }), () => ({ text })]
      : [() => ({ parts: [{ type: "text", text }] }), () => ({ prompt: { text } })]
    const extras = turnExtras({ agent, model, variant, tools })
    const shapes = extras ? [...base.map((b) => () => ({ ...b(), ...extras })), ...base] : base
    return this.postShaped(extras ? "prompt+x" : "prompt", this.dialect.prompt(id), shapes)
  }

  interrupt(id, { resume = false } = {}) {
    if (this.v1.has(id)) return this.req(`/session/${id}/abort`, { method: "POST", body: {}, query: { directory: this.v1.get(id) } })
    return this.req(this.dialect.interrupt(id), {
      method: "POST",
      body: this.dialect.name === "v2" ? undefined : {},
      query: this.dialect.name === "v2" ? { resume: String(resume) } : undefined,
    })
  }

  /**
   * Deliver text into a running session. A synthetic message is the right
   * shape for peer traffic: it enters the transcript as content the session
   * did not ask for, rather than masquerading as the operator's own turn.
   */
  async synthetic(id, text, description, { tools, agent, model, variant } = {}) {
    if (this.v1.has(id)) return this.promptV1(id, text, { tools, agent, model, variant })
    const path = this.dialect.synthetic?.(id)
    if (!path) return this.prompt(id, text, { tools, agent, model, variant })
    try {
      // Text first in every shape: a lenient server that accepts the body but
      // finds no text would deliver an empty message, which is worse than a
      // 400 because nothing reports it.
      const base = [
        () => ({ text, description, resume: true }),
        () => ({ text }),
        () => ({ message: { text }, description, resume: true }),
        () => ({ prompt: { text }, description, resume: true }),
      ]
      const extras = turnExtras({ agent, model, variant, tools })
      const shapes = extras ? [...base.map((b) => () => ({ ...b(), ...extras })), ...base] : base
      return await this.postShaped(extras ? "synthetic+x" : "synthetic", path, shapes)
    } catch {
      return this.prompt(id, text, { tools, agent, model, variant })
    }
  }

  /** Register a remote MCP server for one location, if the server supports it. */
  async addMcpServer(name, config, directory) {
    // Current servers: POST /mcp?directory=… { name, config } (the instance
    // API, which is what actually runs a location's MCP servers).
    try {
      return await this.req("/mcp", { method: "POST", body: { name, config }, query: { directory } })
    } catch (e) {
      if (!/-> (404|405)\b/.test(e.message)) throw e
    }
    const path = this.dialect.mcp?.(name)
    if (!path) throw new Error("this opencode version has no runtime MCP registration")
    for (const query of [{ "location[directory]": directory }, { location: JSON.stringify({ directory }) }, { directory }]) {
      try {
        return await this.req(path, { method: "PUT", body: { config }, query })
      } catch (e) {
        var last = e
      }
    }
    throw last
  }

  /** Location-scoped queries need the directory encoded the way this server wants it. */
  async locationReq(path, { method = "GET", body, directory } = {}) {
    if (!path) return null
    for (const query of [{ "location[directory]": directory }, { location: JSON.stringify({ directory }) }, { directory }]) {
      try {
        return await this.req(path, { method, body, query })
      } catch (e) {
        var last = e
      }
    }
    throw last
  }

  async mcpServers(directory) {
    // GET /mcp?directory=… answers { name: { status, error? } }.
    const map = await this.req("/mcp", { query: { directory } }).catch(() => null)
    if (map && typeof map === "object" && !Array.isArray(map) && !map.data) {
      return Object.entries(map).map(([name, st]) => ({ name, status: st?.status ?? "unknown", error: st?.error ?? null, connected: st?.status === "connected" }))
    }
    const out = await this.locationReq(this.dialect.mcpList?.(), { directory }).catch(() => null)
    const list = OpencodeClient.unwrap(out)
    return Array.isArray(list) ? list : []
  }

  /**
   * The config the server resolves for a directory. Asking for it also makes
   * the server open that directory as an instance and read its project
   * config — which a session created through the v2 API alone does not do.
   */
  /** Providers and their models as opencode resolves them for a directory (with variants where known). */
  async providers(directory) {
    const out = await this.req("/config/providers", { query: { directory } }).catch(() => null)
    const list = out?.providers ?? out?.data?.providers ?? (Array.isArray(out) ? out : [])
    return list.flatMap((p) => Object.entries(p.models ?? {}).map(([id, m]) => ({
      id: `${p.id}/${id}`,
      name: m.name ?? id,
      provider: p.name ?? p.id,
      variants: Object.keys(m.variants ?? {}),
      reasoning: !!(m.reasoning ?? m.capabilities?.reasoning),
    })))
  }

  async locationConfig(directory) {
    return this.req("/config", { query: { directory } }).catch(() => null)
  }

  /** v2: set a session's agent / model after the fact. */
  async setSessionAgent(id, agent) {
    return this.req(`/api/session/${id}/agent`, { method: "POST", body: { agent } })
  }
  async setSessionModel(id, model, variant) {
    const ref = modelRef(model)
    return this.req(`/api/session/${id}/model`, { method: "POST", body: { model: ref } })
  }

  async toolIds(directory) {
    const out = await this.locationReq(this.dialect.toolIds?.(), { directory }).catch(() => null)
    const list = OpencodeClient.unwrap(out)
    return Array.isArray(list) ? list : []
  }

  async setMcpConnected(name, connected, directory) {
    try {
      return await this.req(`/mcp/${encodeURIComponent(name)}/${connected ? "connect" : "disconnect"}`, { method: "POST", body: {}, query: { directory } })
    } catch (e) {
      if (!/-> (404|405)\b/.test(e.message)) throw e
    }
    const path = connected ? this.dialect.mcpConnect?.(name) : this.dialect.mcpDisconnect?.(name)
    return this.locationReq(path, { method: "POST", body: {}, directory })
  }

  /**
   * Ask opencode to drop what it has cached for a location, so the next
   * session there re-reads its config. Best effort: the route has moved
   * between versions and older servers do not have it.
   */
  async disposeInstance(directory) {
    const paths = this.dialect.name === "v2" ? ["/api/instance/dispose", "/instance/dispose"] : ["/instance/dispose"]
    for (const path of paths) {
      for (const query of [{ directory }, { "location[directory]": directory }]) {
        try {
          await this.req(path, { method: "POST", body: {}, query })
          return true
        } catch {}
      }
    }
    return false
  }

  compact(id) {
    return this.req(this.dialect.compact(id), { method: "POST", body: {} })
  }

  async pendingPermissions(id) {
    if (this.v1.has(id)) {
      // Instance engine: GET /permission?directory= lists every pending ask there.
      const list = await this.req("/permission", { query: { directory: this.v1.get(id) } }).catch(() => [])
      return (Array.isArray(list) ? list : []).filter((p) => p.sessionID === id).map((p) => ({
        id: p.id,
        action: p.permission,
        patterns: p.patterns ?? [],
        always: p.always ?? [],
        metadata: p.metadata ?? {},
      }))
    }
    const path = this.dialect.permissions(id)
    if (!path) return []
    try {
      const out = await this.req(path)
      const list = OpencodeClient.unwrap(out)
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  async replyPermission(id, requestId, decision) {
    if (this.v1.has(id)) {
      const directory = this.v1.get(id)
      try {
        return await this.req(`/permission/${requestId}/reply`, { method: "POST", body: { reply: decision }, query: { directory } })
      } catch (e) {
        if (!/-> (404|405)\b/.test(e.message)) throw e
        return this.req(`/session/${id}/permissions/${requestId}`, { method: "POST", body: { response: decision }, query: { directory } })
      }
    }
    return this.req(this.dialect.permissionReply(id, requestId), {
      method: "POST",
      body: this.dialect.name === "v2" ? { decision } : { response: decision },
    })
  }

  /**
   * Long-lived SSE subscription with backoff. `onEvent` receives the decoded
   * payload plus whatever routing envelope the server wrapped it in
   * (v2 wraps as { directory, project, workspace, payload }).
   */
  subscribe({ onEvent, onStatus = () => {} }) {
    let stopped = false
    let backoff = 500
    const ctrls = new Set()
    const controller = { stop: () => { stopped = true; for (const c of ctrls) c.abort() } }

    const run = async (path, primary) => {
      while (!stopped) {
        const ctrl = new AbortController()
        ctrls.add(ctrl)
        try {
          const res = await fetch(this.base + path, {
            headers: { accept: "text/event-stream" },
            signal: ctrl.signal,
          })
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
          if (primary) onStatus("connected")
          backoff = 500
          let buf = ""
          for await (const chunk of res.body) {
            buf += Buffer.from(chunk).toString("utf8")
            let idx
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const raw = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const data = raw
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("")
              if (!data) continue
              try {
                const parsed = JSON.parse(data)
                onEvent(parsed.payload ?? parsed, parsed)
              } catch {}
            }
          }
          throw new Error("event stream ended")
        } catch (err) {
          if (stopped) return
          if (primary) onStatus("disconnected", err)
          // A server without the global (instance-engine) stream: stop asking.
          if (!primary && /event stream 404/.test(err.message)) return
          await new Promise((r) => setTimeout(r, backoff))
          backoff = Math.min(backoff * 2, 15000)
        }
      }
    }
    run(this.dialect.events, true)
    // The instance engine publishes on /global/event, not the v2 stream.
    if (this.dialect.name === "v2") run("/global/event", false)
    return controller
  }
}

/** "amazon-bedrock/anthropic.claude-sonnet-5" → { providerID, modelID }. */
export function modelRef(model, variant = null) {
  if (!model) return null
  if (typeof model === "object") return { ...model, ...(variant ? { variant } : {}) }
  const i = String(model).indexOf("/")
  const ref = i > 0 ? { providerID: model.slice(0, i), id: model.slice(i + 1) } : { providerID: "", id: model }
  if (variant) ref.variant = variant
  return ref
}

/** What each turn should run with; null when there is nothing to say. */
function turnExtras({ agent, model, variant, tools }) {
  const x = {}
  if (agent) x.agent = agent
  if (model) { const r = modelRef(model, variant); x.model = { providerID: r.providerID, modelID: r.id } }
  if (variant) x.variant = variant
  if (tools) x.tools = tools
  return Object.keys(x).length ? x : null
}

/**
 * Pull the session id out of an event payload without depending on the exact
 * event name — opencode renames these between releases, the id field is stable.
 */
export function sessionIdOf(payload) {
  if (!payload || typeof payload !== "object") return null
  const p = payload.properties ?? payload
  return (
    p.sessionID ??
    p.sessionId ??
    payload.data?.sessionID ??
    p.session?.id ??
    p.info?.sessionID ??
    p.message?.sessionID ??
    p.part?.sessionID ??
    p.item?.sessionID ??
    (typeof p.id === "string" && p.id.startsWith("ses") ? p.id : null)
  )
}
