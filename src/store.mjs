// Session registry + rolling per-minute metrics.
//
// Metrics come from the message projection rather than from event payloads:
// event names churn between opencode releases, but every assistant message
// carries its own usage and every tool call is a part with a stable id. We let
// the event stream tell us *that* something changed and then diff the messages.

import { colorFor } from "./identity.mjs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DEFAULT_POLICY } from "./mesh.mjs"
import { estimate } from "./pricing.mjs"

const WINDOW = 60 // minutes of history kept per session

const nowMinute = () => Math.floor(Date.now() / 60000)

class Series {
  constructor(points = []) {
    this.points = points // [{ m, tok, tool }] ascending, max WINDOW
  }
  add(minute, tok, tool) {
    const last = this.points[this.points.length - 1]
    if (last && last.m === minute) {
      last.tok += tok
      last.tool += tool
    } else {
      this.points.push({ m: minute, tok, tool })
      while (this.points.length > WINDOW * 2) this.points.shift()
    }
  }
  // Dense arrays of the last `n` minutes, ending at the current minute.
  dense(n = WINDOW) {
    const end = nowMinute()
    const tok = new Array(n).fill(0)
    const tool = new Array(n).fill(0)
    for (const p of this.points) {
      const i = n - 1 - (end - p.m)
      if (i >= 0 && i < n) {
        tok[i] += p.tok
        tool[i] += p.tool
      }
    }
    return { tok, tool }
  }
  rate(minutes = 5) {
    const end = nowMinute()
    let tok = 0
    let tool = 0
    for (const p of this.points) if (end - p.m < minutes) { tok += p.tok; tool += p.tool }
    return { tokPerMin: Math.round(tok / minutes), toolPerMin: +(tool / minutes).toFixed(1) }
  }
}

export class Session {
  constructor(info) {
    this.id = info.id
    this.title = info.title ?? "untitled"
    this.directory = info.directory ?? info.location?.directory ?? info.worktree ?? null
    this.projectID = info.projectID ?? info.project ?? null
    this.parentID = info.parentID ?? null
    this.agent = info.agent ?? null
    this.model = modelLabel(info)
    this.created = info.time?.created ?? info.created ?? Date.now()
    this.updated = info.time?.updated ?? Date.now()
    this.status = "idle" // idle | busy | waiting | error
    this.busySince = null
    this.currentTool = null
    this.lastError = null
    this.lastText = ""
    this.pendingPermissions = 0
    this.label = null // user-assigned name, pm2 style
    this.branch = null
    this.git = null
    this.handle = null // stable mesh name, assigned by Mesh.handles()
    this.policy = { ...DEFAULT_POLICY }
    this.inbox = []
    this.outbox = []
    this.parentID = info.parentID ?? null
    this.depth = 0
    this.origin = null // handle of the agent that opened this session
    this.repo = null
    this.mcpToken = null
    this.project = "default"
    this.persona = null
    this.role = null
    this.adjectives = null
    this.allowedTools = null
    this.disabledTools = []
    this.totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tools: 0, toolErrors: 0 }
    this.contextTokens = 0
    this.series = new Series()
    this.seenTools = new Map() // partId -> status we last counted
    this.msgTokens = new Map() // messageId -> last counted total
    this.toolLog = [] // recent tool calls for the detail view
    this.dirty = true
  }

  setStatus(next) {
    if (next === this.status) return
    if (next === "busy") this.busySince = Date.now()
    if (this.status === "busy") this.busySince = null
    this.status = next
  }

  applyInfo(info) {
    if (info.title) this.title = info.title
    const dir = info.directory ?? info.location?.directory
    if (dir) this.directory = dir
    if (info.agent) this.agent = info.agent
    const m = modelLabel(info)
    if (m) this.model = m
    this.updated = info.time?.updated ?? this.updated
  }

  record({ tokens = 0, tools = 0 }) {
    if (tokens || tools) this.series.add(nowMinute(), tokens, tools)
  }

  snapshot(overrides = {}) {
    const { tok, tool } = this.series.dense()
    return {
      id: this.id,
      name: this.label ?? this.title,
      handle: this.handle,
      color: colorFor(this.id),
      role: this.role,
      persona: this.persona,
      personaTitle: this.personaTitle ?? null,
      configuredModel: this.override?.model ?? this.configuredModel ?? null,
      agentName: this.agentName ?? null,
      variant: this.variant ?? this.override?.variant ?? this.variantWanted ?? null,
      override: this.override ?? null,
      mode: this.mode ?? this.agentName ?? null,
      invocations: this.invocations ?? 0,
      mcp: this.mcp ?? null,
      title: this.title,
      policy: this.policy,
      unread: this.inbox.filter((m) => !m.read).length,
      inboxTotal: this.inbox.length,
      lastPeer: this.inbox.at(-1)?.from ?? null,
      parentID: this.parentID,
      origin: this.origin,
      depth: this.depth,
      directory: this.directory,
      branch: this.branch,
      agent: this.agent,
      model: this.model,
      status: this.status,
      busySince: this.busySince,
      currentTool: this.currentTool,
      lastError: this.lastError,
      lastText: this.lastText.slice(0, 320),
      pendingPermissions: this.pendingPermissions,
      permissions: this.permissionList ?? [],
      questions: this.questionList ?? [],
      created: this.created,
      updated: this.updated,
      totals: this.totals,
      cost: this.cost(overrides),
      tokens: this.totals.input + this.totals.output + this.totals.reasoning + this.totals.cacheRead + this.totals.cacheWrite,
      project: this.project,
      contextTokens: this.contextTokens,
      git: this.git,
      ...this.series.rate(5),
      spark: { tok, tool },
      tools: this.toolLog.slice(-8),
    }
  }

  /** Provider cost when we get one, our own arithmetic when we don't. */
  cost(overrides = {}) {
    return estimate({ model: this.model, totals: this.totals, reported: this.totals.cost, overrides })
  }

  persist() {
    return {
      id: this.id,
      label: this.label,
      project: this.project,
      persona: this.persona,
      role: this.role,
      adjectives: this.adjectives,
      disabledTools: this.disabledTools,
      allowedTools: this.allowedTools,
      personaTitle: this.personaTitle ?? null,
      configuredModel: this.configuredModel ?? null,
      agentName: this.agentName ?? null,
      variantWanted: this.variantWanted ?? null,
      override: this.override ?? null,
      variant: this.variant ?? null,
      invocations: this.invocations ?? 0,
      engine: this.engine ?? null,
      directory: this.directory ?? null,
      handle: this.handle,
      policy: this.policy,
      parentID: this.parentID,
      depth: this.depth,
      origin: this.origin,
      repo: this.repo,
      mcpToken: this.mcpToken,
      inbox: this.inbox.slice(-40),
      outbox: this.outbox.slice(-40),
      toolLog: this.toolLog.slice(-40),
      branch: this.branch,
      totals: this.totals,
      points: this.series.points,
      msgTokens: [...this.msgTokens],
      seenTools: [...this.seenTools],
    }
  }

  restore(saved) {
    this.label = saved.label ?? null
    this.project = saved.project ?? saved.group ?? "default"
    this.persona = saved.persona ?? null
    this.role = saved.role ?? saved.persona ?? null
    this.adjectives = saved.adjectives ?? null
    this.disabledTools = saved.disabledTools ?? []
    this.allowedTools = saved.allowedTools ?? null
    this.personaTitle = saved.personaTitle ?? null
    this.configuredModel = saved.configuredModel ?? null
    this.agentName = saved.agentName ?? null
    this.engine = saved.engine ?? null
    if (!this.directory && saved.directory) this.directory = saved.directory
    this.variantWanted = saved.variantWanted ?? null
    this.override = saved.override ?? null
    this.variant = saved.variant ?? null
    this.invocations = saved.invocations ?? 0
    this.handle = saved.handle ?? null
    this.policy = { ...DEFAULT_POLICY, ...(saved.policy ?? {}) }
    this.parentID = saved.parentID ?? this.parentID
    this.depth = saved.depth ?? 0
    this.origin = saved.origin ?? null
    this.repo = saved.repo ?? null
    this.mcpToken = saved.mcpToken ?? null
    this.inbox = saved.inbox ?? []
    this.outbox = saved.outbox ?? []
    // seenTools survives a restart, so the tool log has to survive with it —
    // otherwise old calls are skipped as "already counted" and never logged.
    this.toolLog = saved.toolLog ?? []
    this.branch = saved.branch ?? null
    Object.assign(this.totals, saved.totals ?? {})
    this.series = new Series(saved.points ?? [])
    this.msgTokens = new Map(saved.msgTokens ?? [])
    this.seenTools = new Map(saved.seenTools ?? [])
  }
}

export function modelLabel(info) {
  if (!info) return null
  // v1 puts providerID/modelID flat on assistant messages; v2 nests them, and
  // has used both { modelID } and { id } inside.
  if (typeof info.modelID === "string") return [info.providerID, info.modelID].filter(Boolean).join("/")
  const m = info.model ?? info.assistant?.model ?? info.metadata?.model
  if (!m) return null
  if (typeof m === "string") return m
  const id = m.modelID ?? m.id ?? m.model ?? m.name
  if (!id || typeof id !== "string") return null
  return [m.providerID ?? m.provider, id].filter((x) => typeof x === "string" && x).join("/")
}

/** Reasoning level / model variant ("high", "low", "max"…), wherever this server puts it. */
export function variantOf(info) {
  const v = info?.variant ?? info?.model?.variant ?? info?.reasoningEffort ?? info?.reasoning_effort ?? info?.options?.reasoningEffort ?? info?.effort ?? info?.thinking?.effort
  return typeof v === "string" && v ? v : null
}

/**
 * Tool calls have been a part of type "tool" with { tool, state: { status } }
 * in v1, and other names elsewhere. Normalise everything we have seen to
 * { name, status, input, output, start, end }, or null if it is not a tool.
 */
export function toolOf(part) {
  if (!part || typeof part !== "object") return null
  if (!/^(tool|tool-call|tool_call|tool-invocation|tool_use|tool-use)$/.test(part.type ?? "")) return null
  const st = typeof part.state === "object" && part.state ? part.state : {}
  let status = st.status ?? (typeof part.state === "string" ? part.state : null) ?? part.status ?? "pending"
  if (/^(done|success|succeeded|result|output-available|complete)$/.test(status)) status = "completed"
  if (/^(failed|failure|output-error)$/.test(status)) status = "error"
  if (/^(input-streaming|input-available|call)$/.test(status)) status = "running"
  return {
    name: part.tool ?? part.name ?? part.toolName ?? part.tool_name ?? "tool",
    status,
    input: st.input ?? part.input ?? part.args ?? null,
    output: st.output ?? part.output ?? part.result ?? null,
    error: st.error ?? part.error ?? null,
    title: st.title ?? null,
    start: st.time?.start ?? part.time?.start ?? null,
    end: st.time?.end ?? part.time?.end ?? null,
  }
}

/** Parts can be on the message, on its info, or called content. */
export function partsOf(raw) {
  const info = raw?.info ?? raw ?? {}
  const parts = raw?.parts ?? info.parts ?? raw?.content ?? info.content
  return Array.isArray(parts) ? parts : []
}

export class Store {
  constructor(statePath) {
    this.sessions = new Map()
    this.statePath = statePath
    this.serverStatus = "connecting"
    this.events = [] // recent activity feed
  }

  upsert(info) {
    let s = this.sessions.get(info.id)
    if (!s) {
      s = new Session(info)
      const saved = this.savedState?.sessions?.[info.id]
      if (saved) s.restore(saved)
      this.sessions.set(info.id, s)
    } else s.applyInfo(info)
    return s
  }

  get(id) {
    return this.sessions.get(id)
  }

  list() {
    return [...this.sessions.values()]
  }

  note(text, sessionId = null, level = "info") {
    this.events.unshift({ at: Date.now(), text, sessionId, level })
    if (this.events.length > 120) this.events.pop()
  }

  totals() {
    const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tools: 0, toolErrors: 0 }
    const all = new Series()
    let busy = 0
    let usd = 0
    let unpriced = 0
    const unknown = new Set()
    const overrides = this.pricing?.() ?? {}
    for (const s of this.sessions.values()) {
      for (const k of Object.keys(t)) t[k] += s.totals[k] ?? 0
      const c = s.cost(overrides)
      usd += c.usd
      if (c.unknownModel) { unpriced++; unknown.add(c.unknownModel) }
      if (s.status === "busy") busy++
      for (const p of s.series.points) all.add(p.m, p.tok, p.tool)
    }
    const { tok, tool } = all.dense()
    return { ...t, tokens: t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite, usd, unpriced, unknownModels: [...unknown], busy, sessions: this.sessions.size, spark: { tok, tool }, ...all.rate(5) }
  }

  snapshot() {
    return {
      at: Date.now(),
      serverStatus: this.serverStatus,
      rooms: this.roomsSnapshot?.() ?? [],
      ...(this.extra?.() ?? {}),
      totals: this.totals(),
      sessions: this.list().map((s) => s.snapshot(this.pricing?.() ?? {})).sort(sortSessions),
      events: this.events.slice(0, 40),
    }
  }

  async load() {
    try {
      this.savedState = JSON.parse(await readFile(this.statePath, "utf8"))
    } catch {
      this.savedState = { sessions: {} }
    }
  }

  async save() {
    const out = { sessions: {}, rooms: this.roomsPersist?.() ?? [] }
    for (const s of this.sessions.values()) out.sessions[s.id] = s.persist()
    await mkdir(dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, JSON.stringify(out))
  }
}

const RANK = { busy: 0, waiting: 1, error: 2, idle: 3 }
function sortSessions(a, b) {
  const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
  return r !== 0 ? r : b.updated - a.updated
}

/**
 * Diff a freshly fetched page of messages into the session's counters.
 * Handles both the v1 ({ info, parts }) and v2 (flat message with parts) shapes.
 */
export function ingestMessages(session, messages) {
  let tokenDelta = 0
  const modelDeltas = new Map() // model -> token deltas this pass, for per-model quotas
  let toolDelta = 0
  let latestContext = session.contextTokens
  let runningTool = null
  let gotText = false
  let seenModel = false
  let seenVariant = false

  for (const raw of messages) {
    const info = raw.info ?? raw
    const parts = partsOf(raw)
    const id = info.id
    if (!id) continue

    // What each turn actually ran on: the newest message wins, since the
    // model and its reasoning level can change mid-session.
    if (!seenModel) {
      const m = modelLabel(info)
      if (m && (info.role === "assistant" || info.type === "assistant")) {
        session.model = m
        seenModel = true
      }
    }
    const v = variantOf(info)
    if (v && !seenVariant) { session.variant = v; seenVariant = true }
    if ((info.mode || info.agent) && typeof (info.mode ?? info.agent) === "string") session.mode ??= info.mode ?? info.agent
    if (info.role === "assistant" || info.type === "assistant") {
      const u = usageOf(info, parts)
      const total = u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
      const prev = session.msgTokens.get(id) ?? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      if (total > prev.total) {
        tokenDelta += total - prev.total
        const m = modelLabel(info) ?? session.model ?? "unknown"
        const md = modelDeltas.get(m) ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
        for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost"]) {
          const d = Math.max(0, u[k] - (prev[k] ?? 0))
          session.totals[k] += d
          md[k] += d
        }
        modelDeltas.set(m, md)
        session.msgTokens.set(id, { total, ...u })
      }
      // context window occupancy = newest assistant message's input side
      if (u.input + u.cacheRead > 0) latestContext = Math.max(latestContext, u.input + u.cacheRead)
      if (info.error) {
        const e = info.error
        const msg = typeof e === "string" ? e : e.data?.message ?? e.message ?? e.name ?? "error"
        const inner = /"message"\s*:\s*"([^"]+)"/.exec(msg)
        session.lastError = String(inner ? `${e.name ?? "error"}: ${inner[1]}` : msg).slice(0, 300)
      }
    }

    for (const part of parts) {
      if (!gotText && part.type === "text" && part.text && (info.role === "assistant" || info.type === "assistant")) {
        session.lastText = tail(part.text)
        gotText = true
      }
      const tool = toolOf(part)
      if (!tool) continue
      const { status, name } = tool
      const key = part.id ?? part.callID ?? part.toolCallId ?? `${id}:${name}`
      const seen = session.seenTools.get(key)
      if (status === "running" || status === "streaming") {
        if (!runningTool) runningTool = { name, since: tool.start ?? Date.now() }
      }
      if (seen === status) continue
      session.seenTools.set(key, status)
      if (status === "completed" || status === "error") {
        toolDelta++
        session.totals.tools++
        if (status === "error") session.totals.toolErrors++
        const start = tool.start
        const end = tool.end ?? Date.now()
        session.toolLog.push({
          name,
          status,
          ms: start ? Math.max(0, end - start) : null,
          at: end,
          summary: summarizeToolInput(tool.input),
          sig: inputSig(tool.input),
        })
        if (session.toolLog.length > 60) session.toolLog.shift()
      }
    }
  }

  session.contextTokens = latestContext
  session.currentTool = runningTool
  session.record({ tokens: tokenDelta, tools: toolDelta })
  return { tokenDelta, toolDelta, modelDeltas: [...modelDeltas].map(([model, totals]) => ({ model, totals })) }
}

function usageOf(info, parts) {
  const t = info.tokens ?? info.usage ?? info.metadata?.usage ?? {}
  let out = {
    input: num(t.input ?? t.prompt ?? t.inputTokens),
    output: num(t.output ?? t.completion ?? t.outputTokens),
    reasoning: num(t.reasoning ?? t.reasoningTokens),
    cacheRead: num(t.cache?.read ?? t.cacheRead ?? t.cache_read),
    cacheWrite: num(t.cache?.write ?? t.cacheWrite ?? t.cache_write),
    cost: num(info.cost),
  }
  if (out.input + out.output === 0) {
    // fall back to step-finish parts, which carry usage in some versions
    for (const p of parts) {
      if (p.type === "step-finish" || p.type === "stepFinish") {
        const u = p.tokens ?? p.usage ?? {}
        out.input += num(u.input)
        out.output += num(u.output)
        out.reasoning += num(u.reasoning)
        out.cacheRead += num(u.cache?.read ?? u.cacheRead)
        out.cacheWrite += num(u.cache?.write ?? u.cacheWrite)
        out.cost += num(p.cost)
      }
    }
  }
  return out
}

/**
 * The end of a message is what you are continuing from; the beginning is
 * usually preamble. Take the closing sentences, not the opening ones.
 */
function tail(text, sentences = 2) {
  const clean = String(text).replace(/```[\s\S]*?```/g, " [code] ").replace(/\s+/g, " ").trim()
  const parts = clean.split(/(?<=[.!?])\s+/)
  const out = parts.slice(-sentences).join(" ")
  return out.length > 320 ? "…" + out.slice(-320) : out
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return ""
  // The usual fields first; any tool's (an MCP server's) first short string otherwise.
  const v = input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.description ?? input.query
    ?? Object.values(input).find((x) => typeof x === "string" && x.trim())
  return typeof v === "string" ? v.slice(0, 90) : ""
}

/**
 * The whole input, as a short fingerprint: two calls are "the same call" only
 * when every argument matches, not just the tool or the summary.
 */
export function inputSig(input) {
  if (input === undefined) return null
  const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
    : JSON.stringify(v ?? null)
  const text = canon(input)
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `${text.length}:${h.toString(36)}`
}
