// The supervisor keeps the registry in sync with one opencode server:
// discovery poll -> event stream -> debounced message diffing -> metrics.

import { routeFor } from "./craft.mjs"
import * as patches from "./patches.mjs"
import { normalizeQuestions, formatAnswers } from "./questions.mjs"
import { writeFile, readFile, mkdir, stat, open, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, basename, resolve as resolveDir } from "node:path"
import { OpencodeClient, sessionIdOf } from "./api.mjs"
import { Store, ingestMessages, toolOf, partsOf, summarizeToolInput } from "./store.mjs"
import { Mesh } from "./mesh.mjs"
import { Rooms } from "./rooms.mjs"
import { Registry } from "./registry.mjs"
import { estimate, normalise, TABLE } from "./pricing.mjs"
import { openDb } from "./db.mjs"
import { Tasks } from "./tasks.mjs"
import { Pipelines } from "./pipelines.mjs"
import { Projects } from "./projects.mjs"
import { Workspaces, readManifest, readManifests, writeManifest, manifestPath, opencodeSetup, resolveBot, readJsonc } from "./workspaces.mjs"
import { mintToken } from "./identity.mjs"
import * as git from "./git.mjs"
import { WorkspaceTools } from "./tools.mjs"
import { Farmhands } from "./farmhands.mjs"
import { ModelLedger, overQuota } from "./quota.mjs"
import { Recorder, ReplayShelf, bundle, validBundle } from "./replay.mjs"
import { buildPacket, createPr } from "./packets.mjs"
import { TOOLS as BUILTIN_TOOLS } from "./mcp.mjs"
import { TOOLS_DIR } from "./workspaces.mjs"

export class Supervisor {
  constructor({ url, statePath, onChange = () => {}, mcpBase = "http://127.0.0.1:4777", registryPath, pricing = {}, defaultWorkspace = null }) {
    this.defaultWorkspace = defaultWorkspace
    this.client = new OpencodeClient(url)
    this.store = new Store(statePath)
    this.onChange = onChange
    this.dirty = new Set()
    this.timers = []
    this.mcpBase = mcpBase
    this.streamHealthy = false
    this.lastEventAt = 0
    this.mesh = new Mesh(this)
    this.rooms = new Rooms(this)
    this.store.roomsSnapshot = () => this.rooms.snapshot()
    this.store.extra = () => ({
      board: this.tasks?.board() ?? [],
      runs: (this.pipelines?.runs() ?? []).slice(0, 12).map((r) => ({
        ...r,
        tasks: Object.entries(r.taskIds).map(([stage, id]) => {
          const t = this.tasks.get(id)
          return { stage, id, status: t?.status ?? "gone", persona: t?.persona, title: t?.title }
        }),
      })),
      unmanaged: this.unmanaged.length,
      projects: (this.projects?.snapshot() ?? []).map((p) => ({
        ...p,
        workspaceId: p.workspaceId ?? this.workspaces?.forPath(p.repo)?.id ?? null,
        budget: this.pipelines?.budgetView?.(p) ?? null,
      })),
      workspaces: this.workspaces?.list() ?? [],
      tools: Object.fromEntries((this.workspaces?.list() ?? []).map((w) => [w.id, this.wsTools?.list(w.id) ?? null])),
      levels: Object.fromEntries((this.workspaces?.list() ?? []).map((w) => [w.id, this.farmhands?.all(w.id) ?? []])),
      tasks: (this.tasks?.all() ?? []).map((t) => (t.status === "active" && t.assignee && !t.children ? { ...t, usage: this.pipelines?.taskUsage?.(t) } : t)),
    })
    this.store.roomsPersist = () => this.rooms.persist()
    this.tokens = new Map() // mcp token -> session id
    this.mcpCalls = new Map() // session id -> when it last started an botfarm_ tool
    // Live transcript plumbing, set by the web server: who is watching which
    // session, and how to reach them.
    this.isWatched = () => false
    this.live = () => {}
    this.registry = new Registry(registryPath ?? statePath.replace(/[^/]+$/, "registry.json"))
    this.pricing = pricing
    this.unmanaged = [] // sessions opencode knows about that botfarm is not running
    this.home = (registryPath ?? statePath).replace(/[^/]+$/, "").replace(/\/$/, "")
    this.store.pricing = () => pricing
  }

  // --- mesh plumbing -------------------------------------------------------

  sessionForToken(token) {
    const id = this.tokens.get(token)
    if (!id) return null
    const s = this.store.get(id)
    if (s) return s
    // One token per location: when several sessions share a worktree the
    // caller is whichever one is actually running a step right now.
    const dir = this.tokenDirs?.get(token)
    const candidates = this.store.list().filter((x) => x.directory === dir)
    return candidates.find((x) => x.status === "busy") ?? candidates[0] ?? null
  }

  /**
   * Which session is making this MCP call. A token identifies a location,
   * not a session: in a shared worktree we pick the session that has an
   * botfarm_ tool in flight (from the event stream), or the only busy one. When
   * neither settles it we wait briefly for the tool-start event to land.
   */
  async callerForToken(token, { wait = 400 } = {}) {
    const owner = this.store.get(this.tokens.get(token)) ?? null
    const dir = this.tokenDirs?.get(token) ?? owner?.directory
    if (!dir) return owner
    const deadline = Date.now() + wait
    while (true) {
      const pick = this.pickCaller(dir, owner)
      if (pick.sure || Date.now() >= deadline) return pick.session
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  pickCaller(dir, owner) {
    const here = this.store.list().filter((s) => s.directory === dir)
    if (here.length <= 1) return { session: here[0] ?? owner, sure: true }
    const now = Date.now()
    const calling = here
      .map((s) => [s, this.mcpCalls.get(s.id) ?? 0])
      .filter(([, t]) => now - t < 30_000)
      .sort((a, b) => b[1] - a[1])
    if (calling.length) return { session: calling[0][0], sure: true }
    const busy = here.filter((s) => s.status === "busy")
    if (busy.length === 1) return { session: busy[0], sure: true }
    return { session: busy[0] ?? owner ?? here[0], sure: false }
  }

  mcpUrlFor(session) {
    // opencode holds MCP config per location, so every session in a worktree
    // ends up on whichever URL was written last. Share one token per
    // directory on purpose, and work out the caller per call instead.
    if (!session.mcpToken && session.directory) {
      const sibling = this.store.list().find((x) => x.id !== session.id && x.mcpToken && x.directory === session.directory)
      if (sibling) session.mcpToken = sibling.mcpToken
    }
    if (!session.mcpToken) session.mcpToken = mintToken()
    this.tokens.set(session.mcpToken, session.id)
    ;(this.tokenDirs ??= new Map()).set(session.mcpToken, session.directory)
    return `${this.mcpBase}/mcp/${session.mcpToken}`
  }

  /**
   * Give a session the botfarm tools. Project-level config is the reliable route
   * (opencode reads it when the session's location loads); runtime
   * registration is attempted first so an already-open session can pick the
   * tools up without a restart.
   */
  async enableMesh(session) {
    const url = this.mcpUrlFor(session)
    const config = { type: "remote", url, enabled: true }
    let live = false
    try {
      await this.client.addMcpServer(MCP_NAME, config, session.directory)
      live = true
    } catch {}
    if (session.directory) await writeProjectConfig(session.directory, config).catch(() => {})
    this.store.note(
      live
        ? `mesh tools enabled for @${session.handle}`
        : `mesh tools written to ${session.directory}/.opencode — restart that session to load them`,
      session.id,
    )
    return { url, live }
  }

  async setPolicy(id, patch) {
    const s = this.store.get(id)
    if (!s) throw new Error("unknown session")
    const before = { ...s.policy }
    Object.assign(s.policy, patch)
    this.mesh.handles()
    const wasOff = before.talk === "off" && !before.spawn
    const isOn = s.policy.talk !== "off" || s.policy.spawn
    let result = {}
    if (wasOff && isOn) result = await this.enableMesh(s)
    this.onChange()
    return { policy: s.policy, ...result }
  }

  /** Put peer traffic into a session's transcript. */
  /**
   * An agent's `tools:` list, as the per-turn switch map opencode takes:
   * every built-in tool not on the list is off. The botfarm tools are always on,
   * or the bot could not hand off.
   */
  async toolSwitches(session) {
    if (!session?.allowedTools?.length) return undefined
    this.toolIdCache ??= new Map()
    let ids = this.toolIdCache.get(session.directory)
    if (!ids) {
      ids = await this.client.toolIds(session.directory).catch(() => [])
      if (ids.length) this.toolIdCache.set(session.directory, ids)
    }
    const allowed = new Set(session.allowedTools)
    const off = Object.fromEntries(ids.filter((t) => !allowed.has(t) && !/^(botfarm|botfarm)[_-]/.test(t)).map((t) => [t, false]))
    return Object.keys(off).length ? off : undefined
  }

  /** The agent, model and reasoning level every turn of this bot asks for. */
  turnSettings(s) {
    if (!s) return {}
    // What the operator set on this bot while it runs beats what its agent file says.
    // Then the card's routing (by difficulty), then the agent definition.
    const o = s.override ?? {}
    const r = s.route ?? {}
    const model = o.model ?? r.model ?? s.configuredModel ?? undefined
    const variant = ("variant" in o ? o.variant : "variant" in r ? r.variant : s.variantWanted) ?? undefined
    return { agent: s.agentName ?? undefined, model, variant }
  }

  async deliver(session, { text, description }) {
    await this.client.synthetic(session.id, text, description, { tools: await this.toolSwitches(session), ...this.turnSettings(session) })
    session.invocations = (session.invocations ?? 0) + 1
    session.updated = Date.now()
    this.dirty.add(session.id)
    this.onChange()
  }

  resumeChannel(a, b) {
    this.mesh.blocked.delete(`${a}>${b}`)
    this.mesh.blocked.delete(`${b}>${a}`)
    this.mesh.chain.delete([a, b].sort().join("|"))
    this.store.note("channel resumed by operator", a, "info")
    this.onChange()
  }

  async start() {
    await this.store.load()
    await this.registry.load()
    this.db = await openDb(`${this.home}/botfarm.db`)
    try { this.config = JSON.parse(await readFile(join(this.home, "config.json"), "utf8")) } catch { this.config = {} }
    this.tasks = new Tasks(this.db, { onChange: () => this.onChange() })
    this.farmhands = new Farmhands({ db: this.db })
    this.ledger = new ModelLedger(this.db)
    this.shelf = new ReplayShelf(join(this.home, "replays"))
    // Every visible change to a workstream's cards goes on its replay timeline.
    const save = this.tasks.save.bind(this.tasks)
    this.tasks.save = (task) => { const out = save(task); this.replay?.task(task); return out }
    this.pipelines = new Pipelines({ dir: this.home, tasks: this.tasks, supervisor: this })
    this.projects = new Projects({ db: this.db, supervisor: this })
    this.workspaces = new Workspaces({ db: this.db, supervisor: this })
    for (const ws of this.workspaces.list()) {
      await this.workspaces.ensureFiles(ws).catch((e) => this.store.note(`${ws.name}: ${e.message}`, null, "warn"))
      await this.workspaces.upgradeDefaults(ws).catch(() => {})
    }
    this.replay = new Recorder({ pathFor: (projectId) => this.replayPath(projectId) })
    // Each workspace's own tools (botfarm/mcps/*.js), served next to the built-ins.
    this.wsTools = new WorkspaceTools({ supervisor: this, dirFor: (ws) => join(ws.path, TOOLS_DIR), reserved: BUILTIN_TOOLS.map((t) => t.name) })
    for (const ws of this.workspaces.list()) await this.wsTools.load(ws).catch(() => {})
    this.wsTools.onChange((wsId) => this.toolsChanged(wsId).catch(() => {}))
    if (!this.workspaces.list().length && this.defaultWorkspace) {
      await this.workspaces.add({ path: this.defaultWorkspace }).catch((e) =>
        this.store.note(`default workspace ${this.defaultWorkspace}: ${e.message}`, null, "warn"),
      )
    }
    const loaded = await this.pipelines.load()
    this.store.note(`loaded ${loaded.personas} persona(s) and ${loaded.pipelines} pipeline(s) from ${this.home}`)
    for (const p of loaded.problems) this.store.note(`${p.file}: ${p.problems.join("; ")}`, null, "warn")
    this.rooms.restore(this.store.savedState?.rooms)
    const dialect = await this.client.connect()
    this.store.serverStatus = "connected"
    this.store.note(`connected to ${this.client.base} (api ${dialect})`)

    await this.recoverFromManifests().catch((e) => this.store.note(`manifest recovery: ${e.message}`, null, "warn"))
    await this.discover()
    this.applyManifestBots()
    await this.backfillBotSettings().catch(() => {})
    // Every workstream gets a manifest, including ones started before they existed.
    for (const p of this.projects.list()) if (p.id !== "default") await this.saveManifest(p.id).catch(() => {})
    this.subscribe()

    // Cadence depends on whether the event stream is carrying us. With a live
    // stream these are reconciliation, not the mechanism: statuses come from
    // events, and polling only catches what the stream missed.
    this.timers.push(setInterval(() => this.discover().catch(() => {}), 30_000))
    this.timers.push(setInterval(() => this.reconcile().catch(() => {}), 2_000))
    this.timers.push(setInterval(() => this.flushDirty().catch(() => {}), 1_200))
    this.timers.push(setInterval(() => { for (const s of this.store.list()) this.replay?.bot(s) }, 1_000))
    // Minutes per model: busy time, counted every 5 seconds.
    this.timers.push(setInterval(() => {
      for (const s of this.store.list()) {
        if (s.status !== "busy") continue
        const model = this.turnSettings(s).model ?? s.model
        if (model) this.ledger?.add(this.workspaceIdOf(s), model, s.project && s.project !== "default" ? s.project : null, { minutes: 5 / 60 }, Date.now(), s.persona ?? null)
      }
    }, 5_000))
    this.timers.push(setInterval(() => this.refreshGit().catch(() => {}), 15_000))
    // Every 20s while some bot has a failed MCP server (so one that comes up
    // late is picked up quickly), otherwise once a minute.
    this.timers.push(setInterval(() => {
      const failing = this.store.list().some((s) => s.mcp?.servers?.some((m) => RETRYABLE_MCP.has(m.status)))
      this.mcpTick = (this.mcpTick ?? 0) + 1
      if (failing || this.mcpTick % 3 === 0) this.refreshMcp().catch(() => {})
      this.watchWorkspaceConfig().catch(() => {})
      this.wsTools?.rescan(this.workspaces.list()).catch(() => {})
      this.flushToolRefresh().catch(() => {})
    }, 20_000))
    // Limits are checked every few seconds: a runaway bot burns a lot in a minute.
    this.timers.push(setInterval(() => this.pipelines?.checkBudgets().catch((e) => this.store.note(`budget check: ${e.message}`, null, "warn")), 5_000))
    this.watchWorkspaceConfig().catch(() => {})
    this.timers.push(setInterval(() => this.watchOpencodeLog().catch(() => {}), 3_000))
    this.refreshMcp().catch(() => {})
    this.timers.push(setInterval(() => this.pipelines?.dispatch().catch(() => {}), 10_000))
    this.timers.push(setInterval(() => this.store.save().catch(() => {}), 30_000))
    return dialect
  }

  stop() {
    this.replay?.stop().catch(() => {})
    this.wsTools?.close()
    this.registry.save().catch(() => {})
    this.db?.close?.()
    this.timers.forEach(clearInterval)
    this.sub?.stop()
    return this.store.save().catch(() => {})
  }

  subscribe() {
    this.sub = this.client.subscribe({
      onEvent: (payload) => {
        const type = payload?.type ?? ""
        const id = sessionIdOf(payload)
        this.lastEventAt = Date.now()
        // Keep the latest example of each event type for /api/debug.
        this.recentEvents ??= []
        if (type && !this.recentEvents.some((e) => e.type === type)) {
          this.recentEvents.push({ type, at: Date.now(), payload: JSON.stringify(payload).slice(0, 3000) })
          if (this.recentEvents.length > 40) this.recentEvents.shift()
        }
        if (id) {
          this.dirty.add(id)
          const s = this.store.get(id)
          // Any traffic about a session means it is doing something. Event
          // names change between releases; "there was an event" does not.
          const inAbortGrace = s?.abortedAt && Date.now() - s.abortedAt < 2000
          if (s && s.status === "idle" && !/idle|finished|completed|error|permission/.test(type) && !inAbortGrace) {
            s.setStatus("busy")
          }
          if (s) s.lastEventAt = Date.now()
          const live = livePart(payload)
          if (live?.tool && /^(botfarm|botfarm)[_-]/.test(live.tool.name)) {
            if (/pending|running/.test(live.tool.status)) this.mcpCalls.set(id, Date.now())
            else this.mcpCalls.delete(id)
          }
          if (live && this.isWatched(id)) this.live(id, { t: "part", sessionId: id, ...live })
        }

        // Only a few event names get special treatment; everything else just
        // marks the session dirty and the message diff does the real work.
        // Instance engine: session.status carries { type: "busy" | "idle" | "retry" }.
        if (type === "session.status" && id) {
          const s = this.store.get(id)
          const st = payload.properties?.status?.type ?? payload.properties?.status
          if (s && st === "idle") { s.setStatus("idle"); s.currentTool = null; s.abortedAt = null; this.rooms.flushAll(s).catch(() => {}); this.pipelines?.dispatch().catch(() => {}); this.pipelines?.idle(s) }
          else if (s && st && !(s.abortedAt && Date.now() - s.abortedAt < 2000)) { s.setStatus("busy"); s.updated = Date.now() }
          this.onChange()
          return
        }
        if (/session\.(created|updated)/.test(type)) {
          const info = payload.properties?.info ?? payload.info ?? payload.session
          if (info?.id) this.store.upsert(info)
        }
        if (/idle|completed|finished/.test(type) && id) {
          const s = this.store.get(id)
          if (s) {
            s.setStatus("idle")
            s.currentTool = null
            s.updated = Date.now()
            this.rooms.flushAll(s).catch(() => {})
            this.pipelines?.dispatch().catch(() => {})
            this.pipelines?.idle(s)
          }
        }
        if (/busy|started|running|step\.start/.test(type) && id) {
          const s = this.store.get(id)
          if (s && !(s.abortedAt && Date.now() - s.abortedAt < 2000)) { s.setStatus("busy"); s.updated = Date.now() }
        }
        if (/permission/.test(type) && id) {
          const s = this.store.get(id)
          if (s) { s.setStatus("waiting"); this.store.note(`${label(s)} needs a permission decision`, id, "warn") }
        }
        if ((/error/.test(type) || /step\.failed/.test(type)) && id) {
          const s = this.store.get(id)
          if (s) {
            s.lastError = errorText(payload.properties?.error ?? payload.error) ?? "error"
            s.setStatus("error")
            this.store.note(`@${s.handle ?? label(s)} failed: ${s.lastError}`, id, "error")
          }
        }
        this.onChange()
      },
      onStatus: (status, err) => {
        this.streamHealthy = status === "connected"
        if (status === "connected") this.lastEventAt = Date.now()
        this.store.serverStatus = status
        if (status === "disconnected") this.store.note(`event stream lost: ${err?.message ?? "?"}`, null, "warn")
        this.onChange()
      },
    })
  }

  async discover() {
    const list = await this.client.listSessions({ limit: 200 })
    const seen = new Set()
    const loose = []
    for (const info of list) {
      if (!info?.id) continue
      // The board shows what botfarm is running, not everything opencode has ever
      // opened. Unadopted sessions are offered, not displayed.
      if (!this.registry.has(info.id)) {
        loose.push({
          id: info.id,
          title: info.title ?? "untitled",
          directory: info.directory ?? info.location?.directory ?? null,
          updated: info.time?.updated ?? info.time?.created ?? 0,
        })
        continue
      }
      seen.add(info.id)
      const s = this.store.upsert(info)
      if (s.engine === "v1") this.client.markV1(s.id, s.directory)
      const entry = this.registry.get(info.id)
      s.project = entry.project ?? entry.group ?? "default"
      if (entry.label) s.label = entry.label
      if (s.dirty) { this.dirty.add(s.id); s.dirty = false }
    }
    this.unmanaged = loose.sort((a, b) => b.updated - a.updated).slice(0, 300)
    // The listing is one page. With a couple of hundred sessions in opencode,
    // the ones botfarm manages can fall off it (this is how a freshly restarted
    // team vanished from the board). Look those up one by one, and only drop
    // a session opencode says no longer exists.
    this.gone ??= new Map() // id -> when opencode last said it does not exist
    const missing = [...this.registry.entries.keys()].filter((id) => !seen.has(id) && Date.now() - (this.gone.get(id) ?? 0) > 600_000)
    await Promise.all(
      missing.slice(0, 40).map(async (id) => {
        try {
          const info = await this.client.getSession(id)
          if (!info?.id) throw new Error("-> 404")
          seen.add(id)
          this.gone.delete(id)
          const s = this.store.upsert(info)
          const entry = this.registry.get(id)
          s.project = entry.project ?? entry.group ?? "default"
          if (entry.label) s.label = entry.label
          if (s.dirty) { this.dirty.add(s.id); s.dirty = false }
        } catch (err) {
          if (/-> 404/.test(err.message)) this.gone.set(id, Date.now())
          else if (this.store.get(id)) seen.add(id) // a hiccup is not a deletion
        }
      }),
    )
    for (const id of [...this.store.sessions.keys()]) {
      if (!seen.has(id)) this.store.sessions.delete(id)
    }
    this.mesh.handles()
    for (const s of this.store.list()) if (s.mcpToken) this.tokens.set(s.mcpToken, s.id)
    this.onChange()
  }

  /**
   * Reconcile against the server. While the event stream is healthy this only
   * runs when something looks stale, so a quiet board makes no requests at all;
   * with the stream down it becomes the polling loop it used to be.
   */
  async reconcile() {
    const quiet = Date.now() - (this.lastEventAt ?? 0)
    if (this.streamHealthy) {
      const suspicious = this.store.list().some((s) => s.status === "busy" && Date.now() - (s.lastEventAt ?? 0) > 12_000)
      if (!suspicious && quiet < 12_000) return
      if (!suspicious && this.lastReconcile && Date.now() - this.lastReconcile < 15_000) return
    }
    this.lastReconcile = Date.now()
    await this.refreshStatuses()
  }

  async refreshStatuses() {
    const active = await this.client.activeSessionIds()
    if (!active) return
    for (const s of this.store.list()) {
      const busy = active.has(s.id)
      if (busy && s.status !== "busy") { s.setStatus("busy"); this.dirty.add(s.id) }
      else if (!busy && s.status === "busy") {
        s.setStatus("idle")
        s.currentTool = null
        this.dirty.add(s.id)
        this.rooms.flushAll(s).catch(() => {})
        this.pipelines?.dispatch().catch(() => {})
        this.pipelines?.idle(s)
      }
    }
    // Only chase a busy session whose events have gone quiet — a healthy
    // stream already marked it dirty when something happened.
    for (const s of this.store.list()) {
      if (s.status === "busy" && (!this.streamHealthy || Date.now() - (s.lastEventAt ?? 0) > 10_000)) this.dirty.add(s.id)
    }
    this.onChange()
  }

  async flushDirty() {
    // Someone has this session open: keep its transcript moving even if the
    // event stream only says "something happened" without the content.
    for (const s of this.store.list()) if (s.status === "busy" && this.isWatched(s.id)) this.dirty.add(s.id)
    if (this.dirty.size === 0) return
    const ids = [...this.dirty]
    this.dirty.clear()
    await Promise.all(
      ids.map(async (id) => {
        const s = this.store.get(id)
        if (!s) return
        try {
          const messages = await this.client.messages(id, { limit: 30, order: "desc" })
          const { tokenDelta, toolDelta, modelDeltas } = ingestMessages(s, messages)
          // Spend per model, for routing quotas ("$5 a day on Opus").
          for (const { model, totals } of modelDeltas ?? []) {
            const tokens = totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite
            const usd = estimate({ model, totals, reported: totals.cost, overrides: this.pricing }).usd
            this.ledger?.add(this.workspaceIdOf(s), model, s.project && s.project !== "default" ? s.project : null, { usd, tokens }, Date.now(), s.persona ?? null)
          }
          if (tokenDelta || toolDelta) s.updated = Date.now()
          if (this.isWatched(id)) this.pushTranscript(s, messages)
          const [perms, asks] = await Promise.all([this.client.pendingPermissions(id), this.client.pendingQuestions(id).catch(() => [])])
          s.pendingPermissions = perms.length
          s.permissionList = perms
          s.questionList = asks
          if ((perms.length || asks.length) && s.status !== "error") s.setStatus("waiting")
          else if (s.status === "waiting") s.setStatus("busy")
        } catch {}
      }),
    )
    this.onChange()
  }

  pushTranscript(s, messages) {
    this.live(s.id, {
      t: "transcript",
      sessionId: s.id,
      status: s.status,
      currentTool: s.currentTool,
      transcript: messages.slice(0, 40).map(summarizeMessage).filter(Boolean),
    })
  }

  /** A viewer opened a session: send it the transcript straight away. */
  async watchStarted(id) {
    const s = this.store.get(id)
    if (!s) return
    const messages = await this.client.messages(id, { limit: 40, order: "desc" }).catch(() => null)
    if (messages) this.pushTranscript(s, messages)
  }

  /** Raw shapes from opencode, for when parsing goes wrong. */
  async raw(id, limit = 3) {
    return {
      messages: await this.client.messages(id, { limit, order: "desc" }).catch((e) => ({ error: e.message })),
      events: this.recentEvents ?? [],
    }
  }

  /**
   * Put a workstream away: stop its bots, and optionally delete their
   * sessions and its worktree. The record, board and chat stay readable.
   */
  async archive(projectId, { removeSessions = false, removeWorktree = false } = {}) {
    const project = this.projects.get(projectId)
    if (!project) throw new Error("unknown workstream")
    const sessions = this.projects.sessions(projectId)
    for (const s of sessions) if (s.status === "busy") await this.abort(s.id).catch(() => {})
    if (removeSessions) for (const s of sessions) await this.remove(s.id)
    if (removeWorktree && project.worktree && project.worktree !== project.repo) {
      await git.removeWorktreeSet(project.worktree, { force: true }).catch((e) => this.store.note(`worktree removal failed: ${e.message}`, null, "warn"))
    }
    for (const t of this.tasks.all({ projectId })) {
      if (!["done", "cancelled"].includes(t.status)) this.tasks.update(t.id, { status: "cancelled" })
    }
    this.projects.save({ ...project, status: "archived" })
    await this.saveManifest(projectId)
    this.store.note(`archived ${project.name}`)
    this.onChange()
  }

  replayPath(projectId) {
    const p = this.projects?.get(projectId)
    const ws = p?.workspaceId ? this.workspaces.get(p.workspaceId) : this.workspaces?.forPath(p?.repo)
    return ws ? join(ws.path, ".botfarm", "workstreams", `${projectId}.replay.jsonl`) : join(this.home, "replays", "live", `${projectId}.jsonl`)
  }

  /** A workstream's replay as one portable document. */
  async exportReplay(projectId) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    const run = project.runId ? this.pipelines.run(project.runId) : null
    const room = project.roomId ? this.rooms.rooms.get(project.roomId) : null
    return bundle({
      project,
      run,
      team: this.projects.sessions(projectId).map((s) => s.snapshot(this.pricing)),
      tasks: this.tasks.all({ projectId }),
      messages: room?.messages ?? [],
      events: await this.replay.events(projectId),
      harvest: project.harvest ?? null,
    })
  }

  async importReplay(doc) {
    if (!validBundle(doc)) throw new Error("that is not a BotFarm replay file")
    return this.shelf.put({ ...doc, importedAt: new Date().toISOString() })
  }

  /** Write the workstream's PR packet next to its manifest and return it. */
  async writePacket(projectId) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    const run = project.runId ? this.pipelines.run(project.runId) : null
    const stages = run ? Object.values(run.taskIds).map((id) => this.tasks.get(id)).filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : this.tasks.all({ projectId })
    const sessions = this.projects.sessions(projectId)
    const bots = sessions.map((s) => ({ handle: s.handle, persona: s.persona, model: s.model ?? s.configuredModel, tokens: tokensOfSession(s), usd: s.cost(this.pricing)?.usd ?? 0 }))
    const totals = run ? this.pipelines.runUsage(run) : { tokens: bots.reduce((a, b) => a + b.tokens, 0), usd: bots.reduce((a, b) => a + b.usd, 0) }
    const dir = project.worktree ?? sessions[0]?.directory ?? null
    const packet = await buildPacket({ project, run, stages, bots, dir, totals })
    const ws = project.workspaceId ? this.workspaces.get(project.workspaceId) : this.workspaces.forPath(project.repo)
    const path = ws ? join(ws.path, ".botfarm", "workstreams", `${projectId}.pr.md`) : join(this.home, "packets", `${projectId}.pr.md`)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, packet.markdown)
    return { ...packet, path, dir, branch: project.branch ?? null }
  }

  async openPr(projectId) {
    const p = await this.writePacket(projectId)
    if (!p.dir || !p.branch) throw new Error("this workstream has no worktree branch to open a PR from")
    const out = await createPr({ dir: p.dir, branch: p.branch, title: p.title, bodyFile: p.path, base: p.base })
    this.store.note(`opened ${out.url}`, null, "info")
    this.replay?.note(projectId, `PR opened: ${out.url}`)
    const project = this.projects.get(projectId)
    if (project) this.projects.save({ ...project, prUrl: out.url })
    return out
  }

  /** The workspace a bot works for: its workstream's, or the one its checkout is in. */
  workspaceIdOf(s) {
    if (!s) return null
    const p = s.project && s.project !== "default" ? this.projects.get(s.project) : null
    return p?.workspaceId ?? this.workspaces?.forPath(p?.repo ?? s.repo ?? s.directory)?.id ?? null
  }

  /**
   * A tool file in botfarm/mcps/ changed. opencode keeps the tool list it
   * fetched when it connected, so reconnect BotFarm's MCP server for every
   * worktree of that workspace — now where nobody is mid-turn, otherwise as
   * soon as they are idle.
   */
  async toolsChanged(wsId) {
    const { tools, errors } = this.wsTools.list(wsId)
    this.store.note(`workspace tools reloaded: ${tools.map((t) => t.name).join(", ") || "none"}${errors.length ? ` · ${errors.length} file(s) with errors` : ""}`, null, errors.length ? "warn" : "info")
    this.pendingToolRefresh ??= new Set()
    for (const s of this.store.list()) if (s.directory && this.workspaceIdOf(s) === wsId) this.pendingToolRefresh.add(s.directory)
    await this.flushToolRefresh()
    this.onChange()
  }

  async flushToolRefresh() {
    for (const dir of [...(this.pendingToolRefresh ?? [])]) {
      if (this.store.list().some((x) => x.directory === dir && (x.status === "busy" || x.status === "waiting"))) continue
      this.pendingToolRefresh.delete(dir)
      await this.client.setMcpConnected(MCP_NAME, false, dir).catch(() => {})
      await this.client.setMcpConnected(MCP_NAME, true, dir).catch(() => {})
      this.toolIdCache?.delete(dir)
    }
  }

  /**
   * Upgrade or downgrade a running bot: another model, another reasoning
   * level. It applies from the bot's next turn (every prompt carries model and
   * variant), survives restarts and config refreshes, and `null` goes back to
   * what its agent definition says.
   */
  async setBotSettings(id, { model, variant } = {}) {
    const s = this.store.get(id)
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 })
    const o = { ...(s.override ?? {}) }
    if (model !== undefined) { if (model) o.model = String(model).trim(); else delete o.model }
    if (variant !== undefined) { if (variant && variant !== "default") o.variant = String(variant).trim(); else if (variant === "default") o.variant = null; else delete o.variant }
    s.override = Object.keys(o).length ? o : null
    const t = this.turnSettings(s)
    this.store.note(`@${s.handle} now runs on ${t.model ?? "opencode's default model"}${t.variant ? ` · ${t.variant}` : ""}${s.status === "busy" ? " from its next turn" : ""}`, s.id, "info")
    this.dirty.add(s.id)
    await this.store.save().catch(() => {})
    if (s.project && s.project !== "default") await this.saveManifest(s.project).catch(() => {})
    this.onChange()
    return s.snapshot(this.pricing)
  }

  /** The routing file plus how much of each tier's quota is used right now. */
  async routingView(wsId, projectId = null) {
    const doc = (await this.workspaces.routing(wsId)) ?? { enabled: false, tiers: {} }
    const usage = {}
    for (const [level, t] of Object.entries(doc.tiers ?? {})) {
      if (!t?.model || !t.quota) continue
      const per = t.quota.per ?? "day"
      const spent = this.ledger.spent(wsId, t.model, per, projectId)
      usage[level] = { per, spent, over: overQuota(t.quota, spent) }
    }
    // What each agent actually gets per size: its own rule, else the workspace's.
    const agents = []
    const lib = await this.workspaces.library(wsId).catch(() => null)
    for (const [id, a] of lib?.personas ?? []) {
      const row = { id, title: a.title ?? a.name ?? id, model: a.model ?? null, levels: {} }
      for (const level of ["easy", "normal", "hard"]) {
        const t = routeFor(level, { agentTiers: a.tiers ?? null, routing: doc })
        if (!t) { row.levels[level] = { source: "agent-default", model: a.model ?? null }; continue }
        let quota = null
        if (t.quota) {
          const key = t.source === "agent" ? `${t.model}@${id}` : t.model
          const spent = this.ledger.spent(wsId, key, t.quota.per, projectId)
          quota = { ...t.quota, spent, over: overQuota(t.quota, spent), scope: t.source === "agent" ? "this agent" : "everyone" }
        }
        row.levels[level] = { source: t.source, model: t.model ?? a.model ?? null, variant: t.variant ?? null, quota, fallback: t.fallback ?? null }
      }
      agents.push(row)
    }
    return { ...doc, usage, agents }
  }

  /** Models on offer in a workspace, for the routing page and the agent editor. */
  async workspaceModels(wsId) {
    const ws = this.workspaces.get(wsId)
    if (!ws) throw Object.assign(new Error("unknown workspace"), { status: 404 })
    const offered = await this.client.providers(ws.path).catch(() => [])
    const setup = await opencodeSetup(ws.path).catch(() => null)
    const named = [setup?.model, ...Object.values(setup?.agent ?? {}).map((a) => a.model)].filter(Boolean)
    const out = [...offered]
    for (const m of named) if (!out.some((x) => x.id === m)) out.push({ id: m, name: m.split("/").pop(), provider: m.split("/")[0], variants: [], fromConfig: true })
    const rank = (m) => (named.includes(m.id) ? 0 : 1)
    return { default: setup?.model ?? null, models: out.sort((a, b) => rank(a) - rank(b) || String(a.provider).localeCompare(String(b.provider)) || String(a.name).localeCompare(String(b.name))).slice(0, 400) }
  }

  /** Models a bot could be switched to: what opencode offers there, plus the workspace config's. */
  async modelsFor(id) {
    const s = this.store.get(id)
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 })
    const offered = await this.client.providers(s.directory).catch(() => [])
    const ws = this.workspaces?.forPath(s.repo ?? s.directory)
    const setup = ws ? await opencodeSetup(ws.path).catch(() => null) : null
    const named = [setup?.model, ...Object.values(setup?.agent ?? {}).map((a) => a.model), s.configuredModel, s.override?.model].filter(Boolean)
    const out = [...offered]
    for (const m of named) if (!out.some((x) => x.id === m)) out.push({ id: m, name: m.split("/").pop(), provider: m.split("/")[0], variants: [], fromConfig: true })
    // The workspace's own models first, then the rest by provider.
    const rank = (m) => (named.includes(m.id) ? 0 : 1)
    return {
      current: this.turnSettings(s),
      override: s.override ?? null,
      fromAgent: { model: s.configuredModel ?? null, variant: s.variantWanted ?? null },
      models: out.sort((a, b) => rank(a) - rank(b) || String(a.provider).localeCompare(String(b.provider)) || String(a.name).localeCompare(String(b.name))).slice(0, 400),
    }
  }

  /**
   * Bring a workstream's worktree up to date with its workspace: MCP servers
   * (added, removed, re-pointed), the workspace's agents and settings, and
   * each bot's BotFarm agent from the current botfarm-agents.yml. Then have
   * opencode re-open the worktree, which reconnects every MCP server and
   * fetches fresh tool lists — a tool deleted from a server stops being
   * offered, a new one appears. Bots mid-turn are not cut off: the reload
   * waits until the worktree is idle.
   */
  async syncWorkstreamConfig(projectId, { reason = "refresh" } = {}) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    const sessions = this.projects.sessions(projectId)
    const run = project.runId ? this.pipelines.run(project.runId) : null
    const dir = project.worktree ?? sessions[0]?.directory
    const repo = run?.repo ?? project.repo
    if (!dir) return { reloaded: false, reason: "no directory" }
    if (repo && dir !== repo) {
      const setup = await opencodeSetup(repo).catch(() => null)
      const lib = await this.pipelines.lib(run?.workspaceId ?? project.workspaceId).catch(() => null)
      const agents = {}
      for (const s of sessions) {
        if (!s.persona) continue
        const p = lib?.personas?.get(s.persona) ?? run?.personaDefs?.[s.persona]
        if (!p) continue
        agents[`botfarm-${s.persona}`] = botAgentConfig(setup, p)
        const r = resolveBot(setup ?? {}, p)
        s.configuredModel = r.model ?? s.configuredModel
        s.variantWanted = p.variant ?? null
        s.allowedTools = p.tools?.length ? p.tools : null
      }
      await writeProjectConfig(dir, null, agents, scopeLocalMcps(setup?.mcp ?? {}, dir), { source: repo })
    }
    return this.reloadDir(dir, reason)
  }

  /** Have opencode re-open a directory now, or as soon as nobody there is mid-turn. */
  async reloadDir(dir, reason = "refresh") {
    this.pendingReload ??= new Map()
    const busy = this.store.list().some((x) => x.directory === dir && (x.status === "busy" || x.status === "waiting"))
    if (busy) {
      if (!this.pendingReload.has(dir)) this.store.note(`${reason}: ${dir} will reload its config and MCP tools once its bots are idle`, null, "info")
      this.pendingReload.set(dir, reason)
      this.onChange()
      return { reloaded: false, pending: true }
    }
    this.pendingReload.delete(dir)
    await this.client.disposeInstance(dir).catch(() => {})
    await this.client.locationConfig(dir).catch(() => {})
    this.toolIdCache?.delete(dir)
    await this.refreshMcp(this.store.list().filter((x) => x.directory === dir), { force: true }).catch(() => {})
    this.store.note(`${reason}: reloaded config and MCP tools for ${dir}`, null, "info")
    this.onChange()
    return { reloaded: true }
  }

  /**
   * Notice the workspace's opencode config or botfarm-agents.yml changing and
   * push the change into every open workstream, instead of each worktree
   * keeping the copy it was made with.
   */
  async watchWorkspaceConfig() {
    this.configSigs ??= new Map()
    for (const ws of this.workspaces?.list?.() ?? []) {
      const files = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc", "botfarm-agents.yml"].map((f) => join(ws.path, f))
      const sig = (await Promise.all(files.map((f) => stat(f).then((st) => `${st.mtimeMs}:${st.size}`, () => "-")))).join("|")
      const before = this.configSigs.get(ws.id)
      this.configSigs.set(ws.id, sig)
      if (!before || before === sig) continue
      for (const p of this.projects.list()) {
        if (p.id === "default" || p.status === "archived" || (p.workspaceId ?? this.workspaces.forPath(p.repo)?.id) !== ws.id) continue
        if (!this.projects.sessions(p.id).length) continue
        await this.syncWorkstreamConfig(p.id, { reason: "workspace config changed" }).catch((e) => this.store.note(`config sync for ${p.name}: ${e.message}`, null, "warn"))
      }
    }
    for (const [dir, reason] of this.pendingReload ?? []) await this.reloadDir(dir, reason).catch(() => {})
  }

  /**
   * What deleting a workstream would take with it, so the dashboard can say so
   * before anything is gone: uncommitted files in the worktree, and commits on
   * its branch that exist nowhere else.
   */
  async deletePreview(projectId) {
    const project = this.projects.get(projectId)
    if (!project || projectId === "default") return null
    const worktree = project.worktree && project.worktree !== project.repo ? project.worktree : null
    const exists = worktree ? await stat(worktree).then(() => true, () => false) : false
    const changed = exists ? await git.changedFiles(worktree).catch(() => []) : []
    const repos = await this.workstreamRepos(project)
    let commits = 0
    let hasBranch = false
    for (const r of repos) {
      const n = project.branch ? await git.unmergedCommits(r, project.branch) : null
      if (n !== null) { hasBranch = true; commits += n }
    }
    return {
      id: project.id,
      name: project.name,
      worktree: exists ? worktree : null,
      changed: changed.length,
      files: changed.slice(0, 12).map((f) => f.path),
      branch: hasBranch ? project.branch : null,
      // Only a branch BotFarm named itself can go: one you chose was yours first.
      branchOwned: hasBranch && String(project.branch).startsWith("botfarm/"),
      commits,
      bots: this.projects.sessions(projectId).length,
      cards: this.tasks.all({ projectId }).length,
      messages: this.projects.room(projectId, { create: false })?.messages?.length ?? 0,
    }
  }

  /** The workstream's repository plus the service repos that got a worktree. */
  async workstreamRepos(project) {
    const root = project.repo ? await git.repoRoot(project.repo).catch(() => null) : null
    if (!root) return []
    return [root, ...git.serviceSources(root, project.services ?? []).map((s) => s.source)]
  }

  /**
   * Put another repository in a workstream that is already running: its own
   * worktree on the workstream's branch, inside the workstream's worktree
   * (a repo from outside the workspace is mounted under its folder name).
   * The bots are told in the chat and in the team notes.
   */
  async addRepoToWorkstream(projectId, entry) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    if (!project.worktree || !project.branch) throw new Error("this workstream has no worktree to add a repo to")
    const root = await git.repoRoot(project.repo).catch(() => null)
    const have = git.serviceSources(root, project.services ?? [])
    const svc = await git.checkService(root, entry, { taken: have.map((h) => h.rel) })
    if (have.some((h) => h.source === svc.source)) throw new Error(`${svc.source} is already in this workstream (at ${have.find((h) => h.source === svc.source).rel}/)`)
    const wt = await git.addServiceWorktree(project.worktree, svc, project.branch)
    if (wt.error && !wt.branch) throw new Error(`could not make a worktree for ${svc.rel}: ${wt.error}`)
    await git.carryConfig(svc.source, wt.path).catch(() => {})
    const fresh = this.projects.get(projectId)
    fresh.services = [...(fresh.services ?? []), svc.external ? (svc.rel === basename(svc.source) ? svc.source : { path: svc.source, as: svc.rel }) : svc.rel]
    this.projects.save(fresh)
    await this.saveManifest(projectId).catch(() => {})
    const line = `📁 ${svc.rel}/ is now in this worktree — a worktree of ${svc.source} on ${project.branch}${wt.error ? ` (note: ${wt.error})` : ""}.`
    const room = this.projects.room(projectId, { create: false })
    if (room) await this.rooms.post(room, null, line, { quiet: true }).catch(() => {})
    const run = fresh.runId ? this.pipelines.run(fresh.runId) : null
    if (run) this.pipelines.addNote(run.id, { topic: "Repos in this worktree", text: this.reposText(fresh), files: [], by: "botfarm" })
    this.store.note(line)
    this.onChange()
    return { rel: svc.rel, path: wt.path, source: svc.source, branch: wt.branch ?? project.branch, warning: wt.error ?? null }
  }

  // --- the work as patches, applied to the real repos -----------------------

  patchesDir(project) {
    const ws = project.workspaceId ? this.workspaces.get(project.workspaceId) : this.workspaces.forPath(project.repo)
    return ws ? join(ws.path, ".botfarm", "workstreams", `${project.id}.patches`) : join(this.home, "patches", project.id)
  }

  /** Each repo's patch and whether it would go in cleanly; writes the .patch files. */
  async previewPatches(projectId) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    if (!project.worktree) throw new Error("this workstream has no worktree")
    const list = await patches.buildPatches(project, this.patchesDir(project))
    const out = []
    for (const p of list) out.push({ ...view(p), check: p.error ? null : await patches.checkApply(p) })
    const busy = this.projects.sessions(projectId).filter((x) => x.status === "busy").map((x) => x.handle)
    return { project: projectId, dir: this.patchesDir(project), busy, repos: out, applied: project.applied ?? null }
    function view(p) {
      const { patch, tree, ...rest } = p
      return { ...rest, bytes: patch?.length ?? 0 }
    }
  }

  /** Apply the chosen repos' patches (all with changes, by default). Never commits. */
  async applyPatches(projectId, { repos = null } = {}) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    const list = await patches.buildPatches(project, this.patchesDir(project))
    const results = []
    for (const p of list) {
      if (repos && !repos.includes(p.rel)) continue
      if (p.error) { results.push({ rel: p.rel, how: "failed", note: p.error }); continue }
      if (!p.file) { results.push({ rel: p.rel, how: "nothing" }); continue }
      results.push({ ...(await patches.applyPatch(p)), real: p.real, file: p.file, branch: p.realBranch, count: p.files.length })
    }
    const fresh = this.projects.get(projectId)
    fresh.applied = { at: Date.now(), results }
    this.projects.save(fresh)
    const done = results.filter((r) => r.how !== "nothing")
    const say = done.map((r) => `${r.rel || basename(project.repo)}: ${r.how === "clean" ? `${r.count} file(s) applied` : r.how === "conflicts" ? `applied with conflicts in ${r.conflicts.join(", ")}` : r.how === "3way" ? "applied (3-way, staged)" : r.how === "partial" ? "partly applied — see .rej files" : `not applied (${String(r.note ?? "").split("\n")[0]})`}`)
    const room = this.projects.room(projectId, { create: false })
    if (room && done.length) await this.rooms.post(room, null, `📦 Applied the work to your repos — ${say.join("; ")}. Nothing is committed.`, { quiet: true }).catch(() => {})
    this.store.note(`${project.name}: applied patches — ${say.join("; ") || "nothing to apply"}`)
    this.onChange()
    return fresh.applied
  }

  /** Take back the patches that went in cleanly. */
  async undoPatches(projectId) {
    const project = this.projects.get(projectId)
    if (!project?.applied) throw new Error("nothing has been applied from this workstream")
    const repos = patches.workstreamRepos(project)
    const out = []
    for (const r of project.applied.results.filter((x) => x.how === "clean" && x.file)) {
      const repo = repos.find((x) => x.rel === r.rel)
      out.push(await patches.undoPatch({ rel: r.rel, real: repo?.real ?? r.real, file: r.file }))
    }
    const fresh = this.projects.get(projectId)
    fresh.applied = { ...fresh.applied, undone: { at: Date.now(), results: out } }
    this.projects.save(fresh)
    this.onChange()
    return out
  }

  /** "./ is X; ./spt is a worktree of ~/workspace/spt" — for prompts and notes. */
  reposText(project) {
    const root = project.repo ?? null
    const extra = git.serviceSources(root, project.services ?? [])
    if (!extra.length) return ""
    return [`./ — ${basename(root ?? project.repo ?? "")}`, ...extra.map((s) => `./${s.rel}/ — ${s.external ? `a separate repo (${s.source})` : "nested repo"}, on ${project.branch}`)].join("\n")
  }

  /**
   * Delete a workstream for good: its bots and their opencode sessions (old
   * replaced ones too), its worktree, its cards, chat, run and manifest, and —
   * if asked, and only for a botfarm/ branch — its branch. Uncommitted work
   * in the worktree stops it unless `force` says you have seen that.
   */
  async deleteWorkstream(projectId, { deleteBranch = false, force = false } = {}) {
    const project = this.projects.get(projectId)
    if (!project) throw Object.assign(new Error("unknown workstream"), { status: 404 })
    if (projectId === "default") throw new Error("the default workstream cannot be deleted")
    const preview = await this.deletePreview(projectId)
    if (preview.changed && !force) {
      throw Object.assign(new Error(`${preview.changed} uncommitted file${preview.changed > 1 ? "s" : ""} in ${preview.worktree} would be lost`), { status: 409, code: "dirty" })
    }
    const ws = project.workspaceId ? this.workspaces.get(project.workspaceId) : this.workspaces?.forPath(project.repo)
    const manifest = ws ? await readManifest(ws, projectId) : null

    // Bots first, so nothing is mid-turn in a worktree that is about to vanish.
    const sessions = this.projects.sessions(projectId)
    for (const s of sessions) {
      clearTimeout(this.pipelines.idleTimers?.get(s.id))
      if (s.status === "busy" || s.status === "waiting") await this.abort(s.id).catch(() => {})
    }
    const ids = new Set([...sessions.map((s) => s.id), ...(manifest?.bots ?? []).map((b) => b?.session), ...(manifest?.previous ?? []).map((b) => b?.session)].filter(Boolean))
    for (const [id, e] of this.registry.entries) if ((e.project ?? e.group) === projectId) ids.add(id)
    for (const id of ids) {
      await this.client.deleteSession(id).catch(() => {})
      this.store.sessions.delete(id)
      this.registry.release(id)
    }
    await this.registry.save().catch(() => {})

    if (preview.worktree) {
      await git.removeWorktreeSet(preview.worktree, { force: true }).catch((e) => this.store.note(`worktree removal failed: ${e.message}`, null, "warn"))
    }
    let branchGone = false
    if (deleteBranch && preview.branchOwned) {
      for (const r of await this.workstreamRepos(project)) {
        if (await git.unmergedCommits(r, project.branch) === null) continue
        await git.deleteBranch(r, project.branch).then(() => (branchGone = true), (e) => this.store.note(`could not delete ${project.branch} in ${r}: ${e.message}`, null, "warn"))
      }
    }

    for (const t of this.tasks.all({ projectId })) this.tasks.remove(t.id)
    for (const run of this.pipelines.runs().filter((r) => r.projectId === projectId || r.id === project.runId)) this.db.delete("runs", run.id)
    const room = project.roomId ? this.rooms.rooms.get(project.roomId) : null
    if (room) this.rooms.rooms.delete(room.id)
    if (ws) await unlink(manifestPath(ws, projectId)).catch(() => {})
    this.db.delete("projects", projectId)

    this.store.note(`deleted workstream ${project.name}${branchGone ? ` and branch ${project.branch}` : project.branch ? ` (branch ${project.branch} kept)` : ""}`, null, "warn")
    this.onChange()
    return { ok: true, sessions: ids.size, worktree: !!preview.worktree, branch: branchGone ? project.branch : null }
  }

  /**
   * Write the workstream's manifest: who is on the team, by opencode session
   * id, plus everyone they replaced. Called whenever the team changes.
   */
  async saveManifest(projectId) {
    const project = this.projects.get(projectId)
    const ws = project?.workspaceId ? this.workspaces.get(project.workspaceId) : this.workspaces?.forPath(project?.repo)
    if (!project || !ws) return null
    const before = (await readManifest(ws, projectId)) ?? {}
    const bot = (s) => ({
      persona: s.persona ?? null,
      title: s.personaTitle ?? null,
      role: s.role ?? null,
      handle: s.handle ?? null,
      session: s.id,
      model: s.override?.model ?? s.model ?? s.configuredModel ?? null,
      ...(s.override ? { override: s.override } : {}),
    })
    const team = this.projects.sessions(projectId).map(bot)
    // A bot that is still registered to this workstream but not loaded right
    // now (opencode down, not listed yet) stays on the team: only a bot that
    // was released or moved counts as replaced.
    for (const b of before.bots ?? []) {
      if (!b?.session || team.some((t) => t.session === b.session)) continue
      const entry = this.registry.get(b.session)
      if (entry && (entry.project ?? entry.group) === projectId) team.push(b)
    }
    const current = new Set(team.map((b) => b.session))
    const previous = [
      ...(before.previous ?? []),
      ...(before.bots ?? []).filter((b) => b?.session && !current.has(b.session)).map((b) => ({ ...b, replaced: new Date().toISOString() })),
    ].filter((b, i, all) => b?.session && !current.has(b.session) && all.findIndex((x) => x.session === b.session) === i)
    const run = project.runId ? this.pipelines.run(project.runId) : null
    const doc = {
      id: project.id,
      name: project.name,
      workspace: ws.id,
      pipeline: project.pipeline ?? null,
      pipelineTitle: project.pipelineTitle ?? null,
      run: project.runId ?? null,
      status: project.status ?? null,
      branch: project.branch ?? null,
      worktree: project.worktree ?? null,
      created: new Date(project.created ?? Date.now()).toISOString(),
      updated: new Date().toISOString(),
      bots: team,
      previous,
      stages: run ? Object.fromEntries(Object.entries(run.taskIds).map(([st, id]) => [st, this.tasks.get(id)?.status ?? "gone"])) : undefined,
      story: project.story ?? undefined,
    }
    if (!doc.stages) delete doc.stages
    if (!doc.story) delete doc.story
    return writeManifest(ws, doc).catch((e) => this.store.note(`could not write the manifest for ${project.name}: ${e.message}`, null, "warn"))
  }

  /**
   * Bring workstreams back from their manifests: any bot session the
   * registry has forgotten is adopted again into its workstream, and a
   * workstream botfarm has no record of is recreated (its board and chat history
   * are gone, but the bots and their worktree are back).
   */
  async recoverFromManifests() {
    let adopted = 0
    let recreated = 0
    this.manifestBots = new Map()
    for (const ws of this.workspaces.list()) {
      for (const m of await readManifests(ws)) {
        if (!this.projects.get(m.id)) {
          this.db.put("projects", {
            id: m.id, name: m.name ?? m.id, repo: ws.path, branch: m.branch ?? null, worktree: m.worktree ?? null,
            services: [], workspaceId: ws.id, pipeline: m.pipeline ?? null, pipelineTitle: m.pipelineTitle ?? null,
            runId: m.run ?? null, story: m.story ?? null, status: m.status ?? "open", roomId: null,
            created: Date.parse(m.created) || Date.now(), recovered: true,
          })
          recreated++
        }
        for (const b of m.bots ?? []) {
          if (!b?.session) continue
          this.manifestBots.set(b.session, { ...b, project: m.id })
          if (!this.registry.has(b.session)) {
            this.registry.adopt(b.session, { createdByBotfarm: true, project: m.id, label: b.persona ?? null })
            adopted++
          }
        }
      }
    }
    if (adopted) await this.registry.save()
    if (adopted || recreated) this.store.note(`recovered from manifests: ${adopted} bot(s)${recreated ? `, ${recreated} workstream(s)` : ""}`)
    return { adopted, recreated }
  }

  /** Once sessions are loaded, fill in what a manifest knows and the store lost. */
  applyManifestBots() {
    for (const [id, b] of this.manifestBots ?? []) {
      const s = this.store.get(id)
      if (!s) continue
      s.persona ??= b.persona
      s.personaTitle ??= b.title
      s.role ??= b.role ?? b.persona
      if (s.project !== b.project && (s.project ?? "default") === "default") {
        s.project = b.project
        this.projects.attach(id, b.project)
      }
    }
    this.manifestBots = null
  }

  /**
   * opencode logs a turn that dies before it starts ("Failed to drain
   * Session …") but does not always send an event for it, so the bot just
   * sits there. Follow the log and put those errors on the bot.
   */
  async watchOpencodeLog() {
    const file = this.opencodeLog ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "log", "opencode.log")
    let size
    try { size = (await stat(file)).size } catch { return }
    if (this.logOffset == null || size < this.logOffset) { this.logOffset = size; return } // start at the end; follow a rotation
    if (size === this.logOffset) return
    const fh = await open(file, "r")
    try {
      const len = Math.min(size - this.logOffset, 2_000_000)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, this.logOffset)
      this.logOffset += len
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.includes("level=ERROR")) continue
        const id = /sessionID=(ses_[A-Za-z0-9]+)/.exec(line)?.[1]
        const s = id && this.store.get(id)
        if (!s) continue
        const cause = /cause="([^\n]*?)(?:\\n|"\s|$)/.exec(line)?.[1] ?? /message="([^"]+)"/.exec(line)?.[1] ?? "error"
        s.lastError = errorText(cause.replace(/\\"/g, '"'))
        s.setStatus("error")
        this.store.note(`@${s.handle} could not run: ${s.lastError}`, s.id, "error")
      }
    } finally {
      await fh.close()
    }
    this.onChange()
  }

  /**
   * Bots started before botfarm passed model/agent/MCP explicitly: look their
   * workspace's opencode.json up now so their next turn runs on it.
   */
  async backfillBotSettings() {
    const dirs = new Map()
    for (const s of this.store.list()) {
      if (!s.persona || s.configuredModel) continue
      const ws = this.workspaces.forPath(s.repo ?? s.directory)
      if (!ws) continue
      const setup = await opencodeSetup(ws.path).catch(() => null)
      if (!setup?.found) continue
      const r = resolveBot(setup, {})
      s.agentName = r.agent
      s.configuredModel = r.model
      s.variantWanted = r.variant
      if (s.directory) dirs.set(s.directory, setup)
    }
    for (const [dir, setup] of dirs) {
      for (const [name, cfg] of Object.entries(setup.mcp)) if (cfg.enabled !== false) await this.client.addMcpServer(name, cfg, dir).catch(() => {})
    }
    if (dirs.size) this.store.note(`applied the workspace's opencode model, agent and MCP servers to bots in ${dirs.size} worktree(s)`)
  }

  /** Set a price for a model the table does not know, and keep it in config.json. */
  async setPrice(model, { input, output }) {
    const key = normalise(model)
    if (!key) throw new Error("which model?")
    if (!(Number(input) >= 0 && Number(output) >= 0)) throw new Error("prices are USD per million tokens, input and output")
    this.pricing[key] = { input: Number(input), output: Number(output) }
    const file = join(this.home, "config.json")
    let config = {}
    try { config = JSON.parse(await readFile(file, "utf8")) } catch {}
    config.pricing = { ...(config.pricing ?? {}), [key]: this.pricing[key] }
    await writeFile(file, JSON.stringify(config, null, 2) + "\n")
    this.onChange()
    return { model: key, ...this.pricing[key] }
  }

  pricingView() {
    const t = this.store.totals()
    return { table: TABLE, overrides: this.pricing, unknown: t.unknownModels }
  }

  /**
   * Which MCP servers each session's location has, and whether ours is one
   * of them — asked once per directory, since sessions in a worktree share it.
   */
  async refreshMcp(sessions = this.store.list(), { reconnect = true, force = false } = {}) {
    const byDir = new Map()
    for (const s of sessions) if (s.directory) byDir.set(s.directory, [...(byDir.get(s.directory) ?? []), s])
    this.mcpRetry ??= new Map()
    for (const [dir, list] of byDir) {
      let servers = await this.client.mcpServers(dir).catch(() => null)
      if (!servers) continue
      // opencode tries a remote MCP server once, when it opens a directory. If
      // the server was down then (docker still starting, a restart), it stays
      // "failed" for that directory until something asks again — so ask.
      const failed = reconnect ? servers.filter((m) => RETRYABLE_MCP.has(m.status) && !BOTFARM_MCP_NAMES.has(m.name ?? m.id)) : []
      let retried = false
      for (const m of failed) {
        const name = m.name ?? m.id
        const key = `${dir}\n${name}`
        const last = this.mcpRetry.get(key) ?? 0
        if (!force && Date.now() - last < 30_000) continue
        this.mcpRetry.set(key, Date.now())
        retried = true
        const ok = await this.client.setMcpConnected(name, true, dir).then(() => true, () => false)
        if (ok) this.store.note(`reconnecting MCP ${name} for ${dir}`, null, "info")
      }
      if (retried) servers = (await this.client.mcpServers(dir).catch(() => null)) ?? servers
      const view = servers.map((m) => ({
        name: m.name ?? m.id,
        connected: m.status ? m.status === "connected" : !!m.connected,
        status: m.status ?? (m.connected ? "connected" : "disconnected"),
        error: m.error ? String(m.error).slice(0, 300) : null,
        tools: (m.tools ?? []).length,
      }))
      for (const v of view) {
        const key = `${dir}\n${v.name}`
        if (v.connected && this.mcpRetry.has(key)) {
          this.mcpRetry.delete(key)
          this.store.note(`MCP ${v.name} is connected again for ${dir}`, null, "info")
        }
      }
      const mcp = { total: view.length, connected: view.filter((v) => v.connected).length, botfarm: view.some((v) => BOTFARM_MCP_NAMES.has(v.name) && v.connected), servers: view, at: Date.now() }
      for (const s of list) s.mcp = mcp
    }
    this.onChange()
  }

  async refreshGit() {
    await Promise.all(
      this.store.list().map(async (s) => {
        if (!s.directory) return
        const st = await git.status(s.directory)
        if (st) {
          s.branch = st.branch
          s.git = st
        }
      }),
    )
  }

  // --- registry ------------------------------------------------------------

  async adopt(ids, meta = {}) {
    for (const id of [].concat(ids)) {
      this.registry.adopt(id, { ...meta, project: meta.project ?? meta.group ?? "default" })
      this.dirty.add(id)
    }
    await this.registry.save()
    await this.discover()
    for (const id of [].concat(ids)) this.projects.attach(id, this.registry.get(id)?.project ?? "default")
    this.store.note(`added ${[].concat(ids).length} session(s) to the board`)
    return this.store.snapshot()
  }

  async release(id, { disableMesh = true } = {}) {
    const s = this.store.get(id)
    if (s && disableMesh) s.policy.talk = "off"
    this.registry.release(id)
    this.store.sessions.delete(id)
    for (const r of this.rooms.rooms.values()) r.members.delete(id)
    await this.registry.save()
    // Re-discover straight away so it reappears in the adoption pool rather
    // than vanishing until the next poll.
    await this.discover().catch(() => {})
    this.store.note("removed a session from the board; the session itself is untouched", null, "info")
    this.onChange()
  }

  async setProject(id, project) {
    this.registry.update(id, { project })
    this.projects.attach(id, project)
    await this.registry.save()
    this.onChange()
  }

  /** The operator answering a question a bot asked. */
  async answer(taskId, text, answers = null) {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error("unknown task")
    const questions = task.questions?.length ? task.questions : normalizeQuestions({ question: task.stage ? task.title : task.brief, options: task.options })
    if (answers) {
      task.answers = answers
      text = formatAnswers(questions, answers)
    }
    if (!String(text ?? "").trim()) throw new Error("an answer needs something in it")
    task.answer = String(text ?? "").slice(0, 8000)
    task.status = "done"
    this.tasks.save(task)
    const asker = task.askedBy ? this.store.get(task.askedBy) : null
    if (asker) {
      await this.deliver(asker, {
        text: [
          `[botfarm] your operator answered: ${task.brief}`,
          "",
          task.answer,
          "",
          "---",
          "This came from the human running this session, not from another agent.",
        ].join("\n"),
        description: "answer from the operator",
      })
    }
    this.store.note(`answered "${task.title.slice(0, 60)}"`, asker?.id ?? null)
    // A human stage in a pipeline is a question too: answering it is its
    // handoff, so whatever waits on it can start.
    if (task.stage) {
      task.handoff ??= { summary: task.answer, acceptance_criteria: [], artifacts: [], open_questions: [], at: Date.now(), by: "operator" }
      this.tasks.save(task)
    }
    this.tasks.unblock()
    await this.pipelines?.dispatch()
    this.pipelines?.checkRunDone(task.runId)
    this.onChange()
    return task
  }

  // --- tools ---------------------------------------------------------------

  async tools(session) {
    const [servers, ids] = await Promise.all([
      this.client.mcpServers(session.directory),
      this.client.toolIds(session.directory),
    ])
    const disabled = session.disabledTools ?? []
    return {
      servers: servers.map((m) => ({
        name: m.name ?? m.id,
        status: m.status ?? (m.connected ? "connected" : "disconnected"),
        connected: m.status ? m.status === "connected" : !!m.connected,
        tools: (m.tools ?? []).map((t) => t.name ?? t),
      })),
      builtin: ids.filter((t) => !t.includes("_")).map((t) => ({ name: t, enabled: !disabled.includes(t) })),
      disabled,
    }
  }

  async setMcp(session, name, connected) {
    await this.client.setMcpConnected(name, connected, session.directory)
    this.store.note(`${connected ? "connected" : "disconnected"} MCP server "${name}" for ${session.directory}`, session.id)
    this.onChange()
  }

  /**
   * Per-tool switches are config, not a runtime call: opencode reads them when
   * the location loads, so this takes effect on the session's next start.
   */
  async setTool(session, name, enabled) {
    session.disabledTools ??= []
    session.disabledTools = enabled
      ? session.disabledTools.filter((t) => t !== name)
      : [...new Set([...session.disabledTools, name])]
    if (session.directory) {
      await writeProjectTools(session.directory, session.disabledTools).catch(() => {})
    }
    this.store.note(`${enabled ? "enabled" : "disabled"} tool "${name}" — applies when that session restarts`, session.id, "warn")
    this.onChange()
    return session.disabledTools
  }

  // --- actions -------------------------------------------------------------

  async abort(id) {
    await this.client.interrupt(id)
    const s = this.store.get(id)
    if (s) { s.setStatus("idle"); s.currentTool = null; s.abortedAt = Date.now() }
    this.store.note(`aborted ${label(s ?? { id })}`, id, "warn")
    this.dirty.add(id)
    this.onChange()
  }

  async send(id, text) {
    this.mesh.operatorTouched(id)
    for (const r of this.rooms.rooms.values()) if (r.members.has(id)) r.burst = 0
    const s = this.store.get(id)
    await this.client.prompt(id, text, { tools: await this.toolSwitches(s), ...this.turnSettings(s) })
    if (s) { s.setStatus("busy"); s.updated = Date.now(); s.invocations = (s.invocations ?? 0) + 1 }
    this.store.note(`queued "${text.slice(0, 60)}" -> ${label(s ?? { id })}`, id)
    this.dirty.add(id)
    this.onChange()
  }

  async spawn({ repo, branch, worktreePath, task, agent, model, variant = null, team = null, title, label: name, group, services = [], persona = null, personaTitle = null, role = null, adjectives = null, tools = null, parentID = null, depth = 0, origin = null, policy = null }) {
    // A session can live in any directory opencode can open. Only a worktree
    // needs a repository, so that is the only case that insists on one.
    const where = await git.inspect(repo)
    if (!where.exists) throw new Error(`${where.path}: ${where.reason}`)
    if (branch && !where.isRepo) throw new Error(`${where.path}: ${where.reason}`)
    repo = where.root ?? where.path
    let directory = repo
    let createdBranch = null
    if (branch) {
      const wt = await git.addWorktreeSet(repo, branch, { path: worktreePath, include: services })
      directory = wt.path
      createdBranch = wt.branch
      const failed = wt.children.filter((c) => c.error)
      this.store.note(
        `${wt.reused ? "reusing" : "created"} worktree ${wt.path} on ${wt.branch}` +
          (wt.children.length ? ` plus ${wt.children.length - failed.length} service worktree(s)` : ""),
      )
      for (const f of failed) this.store.note(`could not create a worktree for ${f.rel}: ${f.error}`, null, "warn")
      // Bring the checkout's opencode setup (MCP servers, agents, rules) along.
      const carried = await git.carryConfig(repo, directory).catch(() => [])
      for (const c of wt.children.filter((c) => !c.error)) await git.carryConfig(c.source ?? join(repo, c.rel), c.path).catch(() => {})
      if (carried.length && !wt.reused) this.store.note(`copied ${carried.join(", ")} into the worktree`)
    }
    // How this bot runs is decided here, from the workspace's opencode.json,
    // and written into the worktree's own .opencode/opencode.json as an
    // opencode agent — "botfarm-<persona>": the base opencode agent (build,
    // unless the BotFarm agent names another) with this bot's model,
    // reasoning level and tool limits. That is the only per-session knob a
    // current opencode server honours; a prompt cannot carry model or tools.
    const setup = await opencodeSetup(repo).catch(() => null)
    const base = resolveBot(setup ?? {}, { agent, model, variant })
    const botAgents = {}
    for (const [key, p] of Object.entries(team ?? (persona ? { [persona]: { agent, model, variant, tools, title: personaTitle } } : {}))) {
      botAgents[`botfarm-${key}`] = botAgentConfig(setup, p)
    }
    const myAgent = persona ? `botfarm-${persona}` : base.agent
    const wantsMesh = (policy?.talk ?? "open") !== "off" || policy?.spawn
    let token = null
    if (wantsMesh) token = this.store.list().find((x) => x.mcpToken && x.directory === directory)?.mcpToken ?? mintToken()
    // Local MCP servers (localhost / host.docker.internal) are told which checkout this worktree
    // is, with an X-Repo-Root header on every connection — so their tools read, edit and build
    // the worktree, not the main checkout it was branched from.
    const scoped = directory !== repo ? scopeLocalMcps(setup?.mcp ?? {}, directory) : {}
    const added = await writeProjectConfig(directory, token ? { type: "remote", url: `${this.mcpBase}/mcp/${token}`, enabled: true } : null, botAgents, scoped, { source: repo }).catch((e) => {
      this.store.note(`could not write ${directory}/.opencode/opencode.json: ${e.message}`, null, "warn")
      return []
    })
    // opencode reads a directory's config once, when it first opens it. A new
    // agent entry for a directory it already has open needs it re-read —
    // safe only while nobody there is mid-turn.
    this.openedDirs ??= new Set()
    if (added.length && this.openedDirs.has(directory)) {
      const busy = this.store.list().some((x) => x.directory === directory && x.status === "busy")
      if (!busy) await this.client.disposeInstance(directory).catch(() => {})
    }
    const cfg = await this.client.locationConfig(directory)
    this.openedDirs.add(directory)
    let useAgent = myAgent
    if (cfg && myAgent && !cfg.agent?.[myAgent]) {
      this.store.note(`opencode did not load agent ${myAgent} for ${directory}; using ${base.agent ?? "its default"}`, null, "warn")
      useAgent = base.agent
    }
    if (!cfg) this.store.note(`opencode would not show the config it uses for ${directory}`, null, "warn")
    const want = persona ? botAgents[`botfarm-${persona}`] ?? {} : {}
    const runModel = want.model ?? base.model
    const runVariant = want.variant ?? null
    // The instance engine first — it is what the opencode TUI runs on, and it
    // can drive every provider the config sets up (the v2 session runner
    // cannot, e.g. Bedrock: "Unsupported API … aisdk:@ai-sdk/amazon-bedrock").
    // It also takes agent, model and tool switches on every turn.
    let info = null
    let engine = "v2"
    if (this.client.dialect?.name === "v2") {
      info = await this.client.createSessionV1({ title: title ?? name ?? branch ?? "botfarm session", directory, agent: useAgent, model: runModel }).catch((e) => {
        if (!/-> (404|405)\b/.test(e.message)) this.store.note(`instance-engine session failed (${e.message.slice(0, 120)}); trying the v2 API`, null, "warn")
        return null
      })
      if (info?.id) engine = "v1"
    }
    if (!info?.id) {
      info = await this.client.createSession({
        title: title ?? name ?? branch ?? "botfarm session",
        directory,
        agent: useAgent,
        model: runModel,
        variant: runVariant,
      })
      // Belt and braces: set them again on the session itself.
      if (useAgent) await this.client.setSessionAgent(info.id, useAgent).catch(() => {})
      if (runModel) await this.client.setSessionModel(info.id, runModel, runVariant).catch(() => {})
    }
    agent = useAgent
    model = runModel
    variant = runVariant
    const mcpNotes = cfg?.mcp ? Object.entries(cfg.mcp).filter(([, m]) => m?.enabled !== false).map(([n]) => n) : []
    const projectId = group ?? "default"
    this.registry.adopt(info.id, { createdByBotfarm: true, project: projectId, label: name ?? branch ?? null })
    await this.registry.save()
    const s = this.store.upsert({ ...info, directory })
    s.project = projectId
    s.label = name ?? branch ?? null
    s.branch = createdBranch
    s.repo = repo
    s.persona = persona
    s.personaTitle = personaTitle
    s.configuredModel = model ?? null
    s.engine = engine
    s.agentName = agent ?? null
    s.variantWanted = variant ?? null
    if (mcpNotes.length) this.store.note(`@${s.handle ?? "bot"} runs as ${agent ?? "default"} on ${model ?? "default model"}, MCP: ${mcpNotes.join(", ")}`, s.id)
    if (token) s.mcpToken = token
    s.role = role ?? persona
    s.adjectives = adjectives
    if (tools?.length) s.allowedTools = tools
    s.parentID = parentID
    s.depth = depth
    s.origin = origin
    if (policy) Object.assign(s.policy, policy)
    this.mesh.handles()
    this.projects.attach(s.id, projectId)
    if (s.policy.talk !== "off" || s.policy.spawn) await this.enableMesh(s)
    this.refreshMcp([s]).catch(() => {})
    if (task) await this.send(s.id, task)
    this.store.note(`started ${label(s)} in ${directory}`, s.id)
    this.onChange()
    return s.snapshot()
  }

  async remove(id, { worktree = false, force = false } = {}) {
    const s = this.store.get(id)
    await this.client.deleteSession(id).catch(() => {})
    if (worktree && s?.directory) {
      const root = await git.commonDir(s.directory)
      if (root && root !== s.directory) {
        await git.removeWorktree(root, s.directory, { force }).catch((e) => this.store.note(`worktree removal failed: ${e.message}`, id, "warn"))
      }
    }
    this.store.sessions.delete(id)
    this.store.note(`removed ${label(s ?? { id })}`, id, "warn")
    this.onChange()
  }

  async detail(id) {
    const s = this.store.get(id)
    if (!s) return null
    const [messages, perms, gitStatus, commit] = await Promise.all([
      this.client.messages(id, { limit: 40, order: "desc" }).catch(() => []),
      this.client.pendingPermissions(id).catch(() => []),
      s.directory ? git.status(s.directory) : null,
      s.directory ? git.lastCommit(s.directory) : null,
    ])
    return {
      ...s.snapshot(),
      mcpUrl: s.mcpToken ? `${this.mcpBase}/mcp/${s.mcpToken}` : null,
      tools: await this.tools(s).catch(() => ({ servers: [], builtin: [], disabled: [] })),
      peers: this.mesh.roster(s),
      rooms: this.rooms.visibleTo(s).map((r) => ({
        id: r.id, name: r.name, topic: r.topic, muted: r.muted, mode: r.mode,
        members: r.members.size, unread: r.unread.get(s.id) ?? 0,
      })),
      inbox: s.inbox.slice(-25).reverse(),
      outbox: s.outbox.slice(-25).reverse(),
      children: this.store.list().filter((x) => x.parentID === s.id).map((x) => ({ handle: x.handle, id: x.id, status: x.status, title: x.title })),
      git: gitStatus,
      lastCommit: commit,
      permissions: perms,
      toolLog: s.toolLog.slice(-40).reverse(),
      transcript: messages.slice(0, 40).map(summarizeMessage).filter(Boolean),
    }
  }
}

/** The useful part of an opencode error: its message, not just its class name. */
export function errorText(e) {
  if (!e) return null
  if (typeof e === "string") return e.slice(0, 300)
  const msg = e.data?.message ?? e.message ?? e.data?.error?.message
  let text = msg ?? e.name ?? "error"
  // Provider errors embed a JSON body; pull its message out.
  const inner = /"message"\s*:\s*"([^"]+)"/.exec(text)
  if (inner) text = `${e.name ?? "error"}: ${inner[1]}`
  return String(text).slice(0, 300)
}

function label(s) {
  return s?.label ?? s?.title ?? s?.id ?? "session"
}

export function summarizeMessage(raw) {
  const info = raw.info ?? raw
  const all = partsOf(raw)
  const role = info.role ?? info.type
  const parts = all.map((p, i) => partView(p, info.id, i)).filter(Boolean)
  const text = parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n")
  const tools = parts.filter((p) => p.kind === "tool").map((p) => ({ name: p.name, status: p.status }))
  if (!parts.length) return null
  return {
    id: info.id,
    role,
    at: info.time?.created ?? info.created ?? null,
    done: !!(info.time?.completed ?? info.finish),
    text: text.slice(0, 1200),
    tools,
    parts,
  }
}

/** One part, trimmed to what a transcript view needs. */
function partView(p, messageId, i = 0) {
  if (!p || typeof p !== "object") return null
  const id = p.id ?? `${messageId}:${i}`
  const tool = toolOf(p)
  if (tool) {
    const out = typeof tool.output === "string" ? tool.output : tool.output ? JSON.stringify(tool.output) : ""
    return {
      id, kind: "tool", name: tool.name, status: tool.status,
      summary: tool.title ?? summarizeToolInput(tool.input),
      output: (tool.error ? String(tool.error) : out).slice(0, 600),
      ms: tool.start && tool.end ? tool.end - tool.start : null,
    }
  }
  if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string" && p.text.trim()) {
    if (p.synthetic && p.type === "text" && p.ignored) return null
    return { id, kind: p.type, text: p.text.slice(-6000) }
  }
  return null
}

/**
 * Pull a transcript-shaped update out of an event, if it carries one.
 * v1 sends message.part.updated with the whole part (and sometimes a
 * `delta`); newer servers send just { partID, delta }. Anything else is
 * left to the message diff.
 */
export function livePart(payload) {
  const p = payload?.properties ?? payload ?? {}
  const part = p.part ?? (p.item?.type ? p.item : null)
  const messageId = part?.messageID ?? part?.messageId ?? p.messageID ?? p.messageId ?? null
  if (part && typeof part === "object") {
    const view = partView(part, messageId)
    if (!view) return null
    const out = { messageId, part: view }
    if (typeof p.delta === "string") out.delta = p.delta
    if (view.kind === "tool") out.tool = { name: view.name, status: view.status }
    return out
  }
  const partId = p.partID ?? p.partId
  if (partId && typeof p.delta === "string") {
    return { messageId, part: { id: partId, kind: p.field === "reasoning" ? "reasoning" : "text" }, delta: p.delta }
  }
  return null
}


/**
 * Merge the botfarm MCP entry into <dir>/.opencode/opencode.json, and keep that
 * directory out of git: a worktree the agent is about to commit from should
 * not gain a tracked file because the operator switched a toggle.
 */
/** Copies of the workspace's local remote MCP servers that carry this worktree as X-Repo-Root. */
/** BotFarm's own MCP server: what bots see as botfarm_task_complete etc. ("botfarm" is its old name). */
export const MCP_NAME = "botfarm"
const BOTFARM_MCP_NAMES = new Set([MCP_NAME, "botfarm"])

/** MCP states worth asking opencode to connect again ("disabled" is a choice). */
const RETRYABLE_MCP = new Set(["failed", "error", "disconnected"])

export function scopeLocalMcps(mcp, directory) {
  const out = {}
  for (const [name, cfg] of Object.entries(mcp ?? {})) {
    if (cfg?.type !== "remote" || !cfg.url) continue
    let url
    try { url = new URL(cfg.url) } catch { continue }
    if (!["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "::1"].includes(url.hostname)) continue
    // Belt and suspenders: opencode's SSE transport does not reliably forward custom
    // headers (EventSource-style clients can't set them at all), so the query param
    // is what actually pins the connection to this worktree - the header is kept for
    // any transport that does honour it. Without one of these, every tool call quietly
    // falls back to the server's default checkout (the main repo, not the worktree).
    url.searchParams.set("root", directory)
    out[name] = { ...cfg, url: url.toString(), headers: { ...(cfg.headers ?? {}), "X-Repo-Root": directory } }
  }
  return out
}

/**
 * `source` is the workspace checkout. With it, everything that is not BotFarm's
 * own (MCP servers, the workspace's agents, other settings) is taken fresh from
 * the checkout's .opencode/opencode.json rather than merged into what the
 * worktree had — otherwise a server you removed or renamed in the workspace
 * lives on in every worktree made before the change.
 */
async function writeProjectConfig(dir, botfarm, agents = {}, mcps = {}, { source = null } = {}) {
  const folder = join(dir, ".opencode")
  // Never write through a link into someone's shared config folder.
  await git.ensureOwnOpencodeDir(dir)
  const file = join(folder, "opencode.json")
  let existing = {}
  try {
    existing = JSON.parse(await readFile(file, "utf8"))
  } catch {}
  if (source && resolveDir(source) !== resolveDir(dir)) {
    const src = (await readJsonc(join(source, ".opencode", "opencode.json"))) ?? (await readJsonc(join(source, ".opencode", "opencode.jsonc"))) ?? {}
    const keepOwn = existing.mcp?.[MCP_NAME] ?? existing.mcp?.botfarm
    const botfarmAgents = Object.fromEntries(Object.entries(existing.agent ?? {}).filter(([k]) => k.startsWith("botfarm-")))
    const tools = existing.tools
    existing = { ...src, mcp: { ...(src.mcp ?? {}), ...(keepOwn ? { [MCP_NAME]: keepOwn } : {}) }, agent: { ...(src.agent ?? {}), ...botfarmAgents } }
    if (tools) existing.tools = tools
  }
  existing.$schema ??= "https://opencode.ai/config.json"
  // The tools used to be served as "botfarm"; a worktree keeps one entry, under the new name.
  if (existing.mcp?.botfarm) { existing.mcp[MCP_NAME] ??= existing.mcp.botfarm; delete existing.mcp.botfarm }
  if (botfarm) existing.mcp = { ...(existing.mcp ?? {}), [MCP_NAME]: botfarm }
  if (Object.keys(mcps).length) existing.mcp = { ...(existing.mcp ?? {}), ...mcps }
  if (existing.mcp && !Object.keys(existing.mcp).length) delete existing.mcp
  const added = []
  existing.agent ??= {}
  for (const [name, a] of Object.entries(agents)) {
    if (JSON.stringify(existing.agent[name]) !== JSON.stringify(a)) added.push(name)
    existing.agent[name] = a
  }
  if (!Object.keys(existing.agent).length) delete existing.agent
  await writeFile(file, JSON.stringify(existing, null, 2) + "\n")
  await git.excludeLocally(dir, ".opencode/").catch(() => {})
  return added
}

/**
 * One BotFarm agent as an opencode agent: the workspace's opencode agent it
 * builds on (prompt, permissions), with its own model, reasoning level and
 * tool limits. The botfarm tools are always on, or it could not hand off.
 */
function botAgentConfig(setup, p = {}) {
  const r = resolveBot(setup ?? {}, p)
  const base = (r.agent && setup?.agent?.[r.agent]) || {}
  const out = { ...base, mode: "primary", description: `BotFarm ${p.title ?? "agent"}` }
  delete out.disable
  if (r.model) out.model = r.model
  // A reasoning level only if the BotFarm agent asks for one: the session
  // runner refuses a variant its model does not list ("Variant unavailable
  // for amazon-bedrock/anthropic.claude-sonnet-5: medium") and the turn
  // never starts. The workspace agent's own variant is not inherited.
  delete out.variant
  if (p.variant) out.variant = p.variant
  if (p.tools?.length) {
    out.tools = { "*": false, ...Object.fromEntries(p.tools.map((t) => [t, true])), "botfarm*": true }
    // opencode turns `tools` into permissions, and a more specific allow in
    // the base agent (say "some-server*": "allow" on plan) beats "*": false — so
    // MCP servers the BotFarm agent does not list are denied by name, last,
    // where they win. Listed ones ("github_*", say) are left to the workspace's own
    // rules, which may still deny some of their tools.
    const listed = (name) => p.tools.some((t) => globMatch(t, `${name}_x`) || t === name || t.startsWith(`${name}_`) || t.startsWith(`${name}*`))
    const deny = {}
    for (const name of Object.keys(setup?.mcp ?? {})) if (!BOTFARM_MCP_NAMES.has(name) && !listed(name)) deny[`${name}_*`] = "deny"
    if (Object.keys(deny).length) {
      const perm = typeof out.permission === "object" && out.permission ? { ...out.permission } : {}
      for (const k of Object.keys(perm)) if (Object.keys(deny).some((d) => k.startsWith(d.slice(0, -2)))) delete perm[k]
      out.permission = { ...perm, ...deny }
    }
  } else if (out.tools) out.tools = { ...out.tools, "botfarm*": true }
  return out
}

function globMatch(pattern, name) {
  const re = new RegExp("^" + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
  return re.test(name)
}

/** Tool switches live in the worktree's own opencode config. */
async function writeProjectTools(dir, disabled) {
  const folder = join(dir, ".opencode")
  await git.ensureOwnOpencodeDir(dir)
  const file = join(folder, "opencode.json")
  let existing = {}
  try {
    existing = JSON.parse(await readFile(file, "utf8"))
  } catch {}
  existing.$schema ??= "https://opencode.ai/config.json"
  existing.tools = Object.fromEntries(disabled.map((t) => [t, false]))
  if (!disabled.length) delete existing.tools
  await writeFile(file, JSON.stringify(existing, null, 2) + "\n")
  await git.excludeLocally(dir, ".opencode/").catch(() => {})
}

const tokensOfSession = (s) => {
  const t = s?.totals ?? {}
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
}
