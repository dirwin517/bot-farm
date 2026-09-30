// Personas and pipelines: definitions from YAML, runs on top of tasks.
//
// A persona is a bot template (system prompt, model, tools, mesh policy).
// A pipeline is an ordered list of stages, each naming a persona and — this is
// the part that matters — naming which earlier handoffs it receives. Dropping
// the QA write-up from the reviewer's prompt is an edit to one line of YAML.
//
// Running a pipeline creates: one worktree, one session per distinct persona,
// one task per stage chained by dependsOn, and one group chat so the bots can
// talk without going through the operator.

import * as git from "./git.mjs"
import { normalizeQuestions, questionText, formatAnswers } from "./questions.mjs"
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join, basename } from "node:path"
import * as YAML from "./yaml.mjs"
import { render, variables } from "./template.mjs"
import { difficulty, routeFor, trimText, trimHandoff, localBrief, stuckReason } from "./craft.mjs"
import { xpForCard, budgetBonus, perksAt } from "./farmhands.mjs"
import { overQuota } from "./quota.mjs"
import { mkdir as mkdirp, writeFile as writeF } from "node:fs/promises"
import { buildPacket } from "./packets.mjs"

const DEFAULT_HANDOFF_PROMPT = `
When you have finished, call botfarm_task_complete with:
  summary              what you did, in enough detail that the next bot needs nothing else
  acceptance_criteria  the criteria you believe now hold (or the ones you set)
  artifacts            files you created or changed, as paths
  open_questions       anything you could not resolve
Do not mark the task complete until the work is actually done.`

export class Pipelines {
  constructor({ dir, tasks, supervisor }) {
    this.dir = dir // ~/.botfarm
    this.tasks = tasks
    this.sup = supervisor
    this.personas = new Map()
    this.definitions = new Map()
    this.problems = []
  }

  get db() {
    return this.tasks.db
  }

  // --- definitions ---------------------------------------------------------

  async load() {
    this.personas.clear()
    this.definitions.clear()
    this.problems = []
    await this.ensureDefaults()
    for (const [sub, target, kind] of [
      ["personas", this.personas, "persona"],
      ["pipelines", this.definitions, "pipeline"],
    ]) {
      const folder = join(this.dir, sub)
      let files = []
      try {
        files = (await readdir(folder)).filter((f) => /\.ya?ml$/.test(f))
      } catch {}
      for (const file of files) {
        try {
          const doc = YAML.parse(await readFile(join(folder, file), "utf8"))
          const id = doc.id ?? basename(file).replace(/\.ya?ml$/, "")
          const problems = kind === "persona" ? checkPersona(doc) : this.checkPipeline(doc)
          if (problems.length) this.problems.push({ file, problems })
          target.set(id, { ...doc, id, file: join(folder, file) })
        } catch (err) {
          this.problems.push({ file, problems: [err.message] })
        }
      }
    }
    return { personas: this.personas.size, pipelines: this.definitions.size, problems: this.problems }
  }

  checkPipeline(doc) {
    return checkPipelineDoc(doc, this.personas)
  }

  /** Global definitions (~/.botfarm), or a workspace's own files. */
  async lib(workspaceId) {
    if (workspaceId && this.sup.workspaces?.get(workspaceId)) return this.sup.workspaces.library(workspaceId)
    return { personas: this.personas, definitions: this.definitions, problems: this.problems }
  }

  /** The definition a run was started with, frozen at start. */
  defFor(run) {
    return run?.def ?? (run ? this.definitions.get(run.pipeline) : null)
  }

  personaFor(run, name) {
    return run?.personaDefs?.[name] ?? this.personas.get(name)
  }

  async ensureDefaults() {
    for (const [sub, files] of Object.entries(DEFAULTS)) {
      const folder = join(this.dir, sub)
      await mkdir(folder, { recursive: true })
      for (const [name, body] of Object.entries(files)) {
        const path = join(folder, name)
        try {
          await readFile(path)
        } catch {
          await writeFile(path, body)
        }
      }
    }
  }

  list() {
    return {
      personas: [...this.personas.values()].map((p) => ({
        id: p.id,
        title: p.title ?? p.id,
        role: p.role ?? p.id,
        model: p.model ?? null,
        tools: p.tools ?? null,
        may_spawn: !!p.may_spawn,
        file: p.file,
      })),
      pipelines: [...this.definitions.values()].map((p) => ({
        id: p.id,
        title: p.title ?? p.id,
        description: p.description ?? "",
        stages: (p.stages ?? []).map((s) => ({
          id: s.id,
          persona: s.persona,
          receives: s.receives ?? [],
          human: !!s.human,
          title: s.title ?? null,
          after: s.after ?? null,
          split: s.split ?? null,
          parallel: s.parallel ?? null,
          limits: s.limits ?? null,
        })),
        file: p.file,
      })),
      problems: this.problems,
    }
  }

  /** Raw definition, for editing. */
  definition(kind, id) {
    const map = kind === "personas" ? this.personas : this.definitions
    const doc = map.get(id)
    if (!doc) return null
    const { file, ...rest } = doc
    return { id, file, doc: rest, yaml: YAML.stringify(rest) }
  }

  /**
   * Write a definition back to YAML. Structured edits and hand edits are the
   * same file, so a pipeline changed in the dashboard is still a file you can
   * diff, commit and send to someone.
   */
  async saveDefinition(kind, id, body) {
    const folder = join(this.dir, kind)
    await mkdir(folder, { recursive: true })
    const doc = body.yaml ? YAML.parse(body.yaml) : body.doc
    if (!doc || typeof doc !== "object") throw new Error("nothing to save")
    doc.id = id
    const problems = kind === "personas" ? checkPersona(doc) : this.checkPipeline(doc)
    const path = join(folder, `${id}.yaml`)
    await writeFile(path, YAML.stringify(doc) + "\n")
    await this.load()
    return { id, path, problems, doc }
  }

  async deleteDefinition(kind, id) {
    const map = kind === "personas" ? this.personas : this.definitions
    const doc = map.get(id)
    if (doc?.file) await rm(doc.file).catch(() => {})
    await this.load()
  }

  // --- runs ----------------------------------------------------------------

  runs() {
    return this.db.all("runs").sort((a, b) => b.created - a.created)
  }

  run(id) {
    return this.db.get("runs", id)
  }

  /**
   * Start a pipeline: worktree, one session per persona, one task per stage.
   * Only the first stage is queued; the rest are blocked on their predecessor
   * until a handoff lands.
   */
  async start({ pipeline, repo, branch, story, title, group, project, services, workspace = null, limits = null, parallel = null }) {
    const ws = workspace ? this.sup.workspaces?.get(workspace) : null
    if (workspace && !ws) throw new Error(`no workspace "${workspace}"`)
    const lib = await this.lib(ws?.id)
    const def = lib.definitions.get(pipeline)
    if (!def) throw new Error(`no pipeline called "${pipeline}"`)
    if (!story?.trim()) throw new Error("a pipeline needs a story or task to work on")
    repo ??= ws?.path
    services = ws ? this.sup.workspaces.serviceEntries(ws, services ?? ws.services ?? []) : services ?? []
    const label = title?.trim() || topicFrom(story).replace(/…$/, "")

    // Every run is its own workstream — its own branch, team, chat and board
    // — unless you name an existing one to add to. Two DE-something stories
    // through the same pipeline are two workstreams, not one crowded board.
    let target = project || group ? this.sup.projects.find(project ?? group) : null
    if (!target) {
      if (ws && !branch) branch = `botfarm/${slugify(label)}`
      const clash = branch && this.sup.projects.list().find((p) => p.repo === repo && p.branch === branch && p.status !== "archived")
      if (clash) throw new Error(`workstream "${clash.name}" is already on branch ${branch} — pick another branch`)
      target = this.sup.projects.create({ name: label, repo, branch, services, unique: true })
    }
    const projectId = target.id
    const runId = "run_" + Date.now().toString(36)
    const stages = def.stages ?? []
    // Human stages have no bot behind them, so they need no session.
    const personas = [...new Set(stages.filter((s) => !s.human && s.persona).map((s) => s.persona))]

    const sessions = {}
    const briefs = {}
    const personaDefs = {}
    // Every bot's opencode agent goes into the worktree config before the
    // first session opens it, so all of them load together.
    const team = Object.fromEntries(personas.map((n) => [n, teamEntry(lib.personas.get(n), n)]))
    for (const name of personas) {
      const persona = lib.personas.get(name)
      if (!persona) throw new Error(`pipeline "${pipeline}" wants agent "${name}", which is not defined`)
      personaDefs[name] = { ...persona, file: undefined }
      const s = await this.sup.spawn({
        repo,
        services, // nested service repos get a worktree each, in the same layout
        branch, // every persona shares one worktree: they are working on the same change
        title: `${persona.title ?? name} · ${title ?? story.slice(0, 40)}`,
        label: `${name}`,
        group: projectId,
        agent: persona.agent ?? null,
        model: persona.model ?? null,
        variant: persona.variant ?? null,
        persona: name,
        personaTitle: persona.title ?? name,
        team,
        role: persona.role ?? name,
        adjectives: persona.adjectives ?? null,
        tools: persona.tools ?? null,
        policy: {
          talk: persona.talk ?? "open",
          rooms: persona.rooms ?? "member",
          spawn: !!persona.may_spawn,
          ...(persona.policy ?? {}),
        },
      })
      sessions[name] = s.id
      // The brief is held until this bot's first stage is dispatched, and then
      // sent together with the task. Briefing every bot up front left the
      // later stages awake with a persona and nothing to do, so they went
      // looking for work: reading a truncated room topic and asking the
      // product bot for criteria it had not written yet.
      const brief = [persona.prompt, def.context, stageContextFor(def, name)].filter(Boolean).join("\n\n")
      if (brief.trim()) briefs[name] = render(brief, { story, run: runId, project: projectId })
    }

    // The project's chat is the run's chat; there is only one conversation.
    const room = this.sup.projects.room(projectId)
    for (const id of Object.values(sessions)) {
      const s = this.sup.store.get(id)
      if (s) this.sup.rooms.join(room, s, { silent: true })
    }
    // The topic is a label, not the spec: every stage gets the whole story in
    // its task. A topic cut mid-sentence reads like truncated requirements.
    room.topic = title ?? topicFrom(story)

    const taskIds = {}
    let previous = null
    for (const [i, stage] of stages.entries()) {
      // A stage waits for the one before it, unless it says what it waits for
      // ("after: [analyse]") — which is how dev and QA start together for TDD.
      const deps = Array.isArray(stage.after)
        ? stage.after.map((id) => taskIds[id]).filter(Boolean)
        : previous ? [previous] : []
      const task = this.tasks.create({
        title: stage.title ?? `${stage.id} — ${title ?? story.slice(0, 40)}`,
        brief: story,
        runId,
        projectId,
        stage: stage.id,
        persona: stage.persona,
        // Addressed to the part, and to the session currently playing it.
        role: lib.personas.get(stage.persona)?.role ?? stage.persona,
        assignee: stage.human ? null : sessions[stage.persona],
        owner: stage.human ? "human" : "session",
        kind: stage.human ? "question" : "work",
        dependsOn: deps,
        createdBy: "pipeline",
        order: i,
      })
      if (stage.split || stage.limits) {
        // A split stage becomes one card per item of an earlier handoff's list,
        // worked by up to `parallel` bots of its kind at once; the stages after
        // it wait for every piece (see expandSplits and joinParent).
        if (stage.split) task.split = { from: stage.split === true ? "tasks" : String(stage.split), parallel: clampParallel(parallel?.[stage.id] ?? stage.parallel ?? 3) }
        if (stage.limits) task.limits = cleanLimits(stage.limits)
        this.tasks.save(task)
      }
      taskIds[stage.id] = task.id
      previous = task.id
    }

    const run = {
      id: runId,
      pipeline: def.id,
      title: title ?? story.slice(0, 80),
      story,
      repo,
      branch,
      projectId,
      roomId: room.id,
      sessions,
      taskIds,
      briefs,
      briefed: [],
      workspaceId: ws?.id ?? null,
      def: { ...def, file: undefined },
      personaDefs,
      limits: cleanLimits(limits ?? def.limits),
      paused: null,
      pausedMs: 0,
      status: "running",
      created: Date.now(),
    }
    this.db.put("runs", run)
    // Re-read: creating the chat above saved a newer copy of the project.
    target = this.sup.projects.get(projectId) ?? target
    Object.assign(target, {
      workspaceId: ws?.id ?? target.workspaceId ?? null,
      pipeline: def.id,
      pipelineTitle: def.title ?? def.id,
      runId,
      story,
      status: "running",
      repo: target.repo ?? repo,
      branch: target.branch ?? branch,
      worktree: this.sup.store.get(Object.values(sessions)[0])?.directory ?? target.worktree ?? null,
    })
    this.sup.projects.save(target)
    this.sup.store.note(`pipeline ${def.id} started: ${stages.length} stages, ${personas.length} bots`, null, "info")

    // The first stage goes out now. Nobody else has been told anything yet,
    // so the later bots sit idle until their own stage is handed to them.
    // Every stage with nothing to wait for starts now (usually just the first;
    // with "after:" several can). Nobody else has been told anything yet.
    const openers = stages.filter((st) => !st.human && !this.tasks.get(taskIds[st.id])?.dependsOn?.length)
    await this.dispatch({ force: true, sessions: [...new Set(openers.map((st) => sessions[st.persona]))].map((id) => this.sup.store.get(id)).filter(Boolean) })
    await this.sup.saveManifest(projectId)
    return run
  }

  /**
   * Run a workstream again from one stage. Everything before it keeps its
   * handoff; that stage and everything after go back to waiting their turn.
   * With `fresh`, every bot is replaced by a new opencode session in the same
   * worktree — which is how a changed opencode.json, agent definition or MCP
   * setup reaches them — and the old sessions leave the board (their
   * transcripts stay in opencode).
   */
  async restart(projectId, { stage = null, fresh = true } = {}) {
    const project = this.sup.projects.get(projectId)
    const run = project?.runId ? this.run(project.runId) : null
    if (!run) throw new Error("this workstream was not started from a pipeline")
    const def = this.defFor(run)
    const stages = def?.stages ?? []
    const tasks = stages.map((s) => this.tasks.get(run.taskIds[s.id]))
    const from = stage
      ? stages.findIndex((s) => s.id === stage)
      : Math.max(0, tasks.findIndex((t) => t && t.status !== "done"))
    if (from < 0) throw new Error(`no stage "${stage}" in this pipeline`)

    // Stop whoever is mid-turn so nothing lands on a card we are resetting.
    const old = Object.entries(run.sessions).map(([persona, id]) => [persona, this.sup.store.get(id)]).filter(([, s]) => s)
    for (const [, s] of old) if (s.status === "busy") await this.sup.abort(s.id).catch(() => {})

    const swap = new Map()
    if (fresh) {
      // Bring the worktree's config up to date, then have opencode forget
      // the location so the new sessions actually read it.
      const dir = old[0]?.[1]?.directory
      if (dir) {
        await git.carryConfig(run.repo, dir).catch(() => {})
        const reloaded = await this.sup.client.disposeInstance(dir)
        if (!reloaded) this.sup.store.note("opencode would not reload this worktree's config; if MCP changes are missing, restart opencode serve", null, "warn")
      }
      const room = this.sup.rooms.rooms.get(run.roomId)
      for (const [key, s] of old) {
        const name = s.persona ?? key
        const persona = run.personaDefs?.[name] ?? (await this.lib(run.workspaceId)).personas.get(name)
        if (!persona) continue
        const next = await this.sup.spawn({
          repo: run.repo,
          services: project.services ?? [],
          branch: run.branch,
          title: `${persona.title ?? name} · ${project.name}`,
          label: name,
          group: projectId,
          agent: persona.agent ?? null,
          model: persona.model ?? null,
        variant: persona.variant ?? null,
          persona: name,
          personaTitle: persona.title ?? name,
          team: Object.fromEntries(old.map(([k, x]) => [x.persona ?? k, teamEntry(run.personaDefs?.[x.persona ?? k], x.persona ?? k)]).filter(([, v]) => v)),
          role: persona.role ?? name,
          adjectives: persona.adjectives ?? null,
          tools: persona.tools ?? null,
          policy: { talk: persona.talk ?? "open", rooms: persona.rooms ?? "member", spawn: !!persona.may_spawn, ...(persona.policy ?? {}) },
        })
        swap.set(s.id, next.id)
        run.sessions[key] = next.id
        if (room && !room.members.has(next.id)) this.sup.rooms.join(room, this.sup.store.get(next.id), { silent: true })
      }
      run.briefed = []
      for (const t of this.tasks.all({ projectId })) {
        if (swap.has(t.assignee)) { t.assignee = swap.get(t.assignee); this.tasks.save(t) }
      }
      // What the old bots spent still counts against the workstream's budget.
      run.retired ??= { tokens: 0, usd: 0 }
      for (const [oldId] of swap) {
        const o = this.sup.store.get(oldId)
        if (o) { run.retired.tokens += tokensOf(o); run.retired.usd += this.costOf(o) }
      }
      for (const [oldId] of swap) await this.sup.release(oldId, { disableMesh: false }).catch(() => {})
    }

    for (const [i, st] of stages.entries()) {
      const t = this.tasks.get(run.taskIds[st.id]) // re-read: the swap above reassigned them
      if (!t || i < from) continue
      // A split card goes back to being one card; its pieces are made again
      // from the (possibly new) handoff when it comes round.
      if (t.children) {
        for (const id of t.children) this.tasks.remove(id)
        delete t.children
        t.owner = "session"
        t.assignee = run.sessions[t.persona] ?? null
      }
      t.budget = null
      t.pausedAt = null
      if (t.baseDeps) t.dependsOn = t.baseDeps
      for (const k of ["baseDeps", "rework", "recheck", "rounds", "round", "history", "lastSendBack", "extraRounds", "prefer", "preferUntil", "pendingSendBack"]) delete t[k]
      Object.assign(t, {
        status: i === from ? (t.owner === "human" ? "waiting" : "queued") : "blocked",
        queuedAt: i === from ? Date.now() : null,
        handoff: null, answer: null, answers: null, files: [],
        startedAt: null, nudgedAt: null, escalated: false,
      })
      this.tasks.save(t)
    }
    run.status = "running"
    run.paused = null
    this.db.put("runs", run)
    this.sup.projects.save({ ...this.sup.projects.get(projectId), status: "running" })
    const room = this.sup.rooms.rooms.get(run.roomId)
    if (room) await this.sup.rooms.post(room, null, `Restarting from ${stages[from].id}${fresh ? " with fresh bots" : ""}. Earlier handoffs are kept.`).catch(() => {})
    this.sup.store.note(`${project.name}: restarted from ${stages[from].id}${fresh ? ` with ${swap.size} fresh bot(s)` : ""}`)
    this.tasks.unblock()
    await this.dispatch({ force: true, sessions: this.sup.projects.sessions(projectId) })
    await this.sup.saveManifest(projectId)
    return { from: stages[from].id, fresh: swap.size }
  }

  /** Bring one more agent into a workstream's team, in the same worktree. */
  async addBot(projectId, agentId) {
    const project = this.sup.projects.get(projectId)
    if (!project) throw new Error("unknown workstream")
    const lib = await this.lib(project.workspaceId ?? this.sup.workspaces?.forPath(project.repo)?.id)
    const persona = lib.personas.get(agentId)
    if (!persona) throw new Error(`no agent called "${agentId}"`)
    const s = await this.sup.spawn({
      repo: project.repo,
      services: project.services ?? [],
      branch: project.branch,
      title: `${persona.title ?? agentId} · ${project.name}`,
      label: agentId,
      group: projectId,
      agent: persona.agent ?? null,
      model: persona.model ?? null,
        variant: persona.variant ?? null,
      persona: agentId,
      personaTitle: persona.title ?? agentId,
      role: persona.role ?? agentId,
      adjectives: persona.adjectives ?? null,
      tools: persona.tools ?? null,
      policy: { talk: persona.talk ?? "open", rooms: persona.rooms ?? "member", spawn: !!persona.may_spawn, ...(persona.policy ?? {}) },
    })
    const run = project.runId ? this.run(project.runId) : null
    if (run) {
      run.sessions[`${agentId}${run.sessions[agentId] ? "-" + s.handle : ""}`] = s.id
      run.briefs ??= {}
      run.briefs[agentId] ??= render(persona.prompt ?? "", { story: run.story, run: run.id, project: projectId })
      run.personaDefs ??= {}
      run.personaDefs[agentId] ??= { ...persona, file: undefined }
      this.db.put("runs", run)
    }
    const room = this.sup.projects.room(projectId)
    if (room && !room.members.has(s.id)) this.sup.rooms.join(room, this.sup.store.get(s.id), { silent: true })
    await this.sup.saveManifest(projectId)
    return s
  }

  // --- handoffs ------------------------------------------------------------

  /**
   * An agent finishing a stage. The handoff is structured on purpose: prose
   * alone gives the next bot nothing to template against, and "what did you
   * actually change" is the question every downstream stage asks first.
   */
  async complete(task, { summary, acceptance_criteria = [], artifacts = [], open_questions = [], tasks = [] }) {
    if (!summary?.trim()) throw new Error("a handoff needs a summary — the next bot cannot see your conversation")
    // Questions can come as plain strings or with choices; keep both the
    // structured form (for the operator's answer form) and plain lines.
    const questions = normalizeQuestions(open_questions)
    open_questions = questionText(questions)
    task.handoff = {
      summary: summary.trim(),
      acceptance_criteria,
      artifacts,
      open_questions,
      questions,
      tasks: normalizeItems(tasks),
      at: Date.now(),
      by: task.persona,
    }
    // The next bot reads a brief, not the whole write-up: squeezed by rules,
    // or by a local model when one is configured. The full text stays here.
    const hcfg = this.sup.config?.handoffs ?? {}
    const maxChars = Number(hcfg.maxChars) > 200 ? Number(hcfg.maxChars) : 1800
    task.handoff.brief = hcfg.local?.url && hcfg.local?.model
      ? await localBrief(task.handoff.summary, { ...hcfg.local, maxChars })
      : trimText(task.handoff.summary, maxChars)
    const worker = this.sup.store.get(task.assignee)
    if (worker?.route?.taskId === task.id) worker.route = null
    this.awardXp(task, worker)
    const reworked = task.rework ? task.round : null
    task.rework = null
    task.recheck = null
    const run = task.runId ? this.run(task.runId) : null
    // Open questions travel with the handoff to the next stage, which can
    // settle them or ask. Stopping the whole line for them is opt-in per
    // stage ("hold_on_questions: true"): a product bot always has some.
    const stage = this.defFor(run)?.stages?.find((s) => s.id === task.stage)
    // One piece of a split stage never holds the line on its own: its questions
    // travel with the joined handoff.
    const hold = !task.parentId && open_questions.length && (stage ? !!stage.hold_on_questions : !task.runId)
    task.status = hold ? "review" : "done"
    task.files = artifacts
    this.tasks.save(task)

    // The card's report: time, tokens, cost, who, the files it changed (with
    // their diffs as they stood when it finished) and any screenshots.
    const report = await this.cardReport(task).catch((e) => { this.sup.store.note(`card report: ${e.message}`, null, "warn"); return null })
    if (run && this.sup.rooms.rooms.get(run.roomId)) {
      const room = this.sup.rooms.rooms.get(run.roomId)
      const author = this.sup.store.get(task.assignee)
      await this.sup.rooms
        .post(room, author, `Finished ${task.stage}${reworked ? ` (round ${reworked})` : ""}${task.item ? ` (${task.item.index}/${task.item.total}: ${task.item.title})` : ""}: ${summary.slice(0, 600)}${open_questions.length ? `\n\nOpen questions: ${open_questions.join("; ")}` : ""}`, { quiet: true, meta: report ? this.cardMeta(task, report) : null })
        .catch(() => {})
    }

    if (task.parentId) await this.joinParent(task.parentId)
    this.tasks.unblock()
    await this.dispatch()
    this.checkRunDone(task.runId)
    return task
  }

  checkRunDone(runId) {
    const run = runId ? this.run(runId) : null
    if (!run || run.status === "done") return
    const all = Object.values(run.taskIds).map((id) => this.tasks.get(id)).filter(Boolean)
    if (!all.every((t) => t.status === "done")) return
    run.status = "done"
    run.finishedAt = Date.now()
    this.db.put("runs", run)
    const ws = this.sup.projects.get(run.projectId)
    if (ws && ws.status === "running") this.sup.projects.save({ ...ws, status: "done" })
    this.sup.saveManifest(run.projectId).catch(() => {})
    this.sup.store.note(`pipeline ${run.pipeline} finished`, null, "info")
    this.harvest(run).catch((e) => this.sup.store.note(`harvest: ${e.message}`, null, "warn"))
  }

  /**
   * The operator lets a held stage go on, optionally answering its open
   * questions. The answers ride along to every stage that receives it.
   */
  async release(task, note = "", answers = null) {
    if (answers && task.handoff?.questions?.length) {
      const said = formatAnswers(task.handoff.questions, answers)
      note = [said, note?.trim()].filter(Boolean).join("\n\n")
      task.handoff.answers = answers
    }
    if (note?.trim()) {
      task.handoff ??= { summary: "", acceptance_criteria: [], artifacts: [], open_questions: [], at: Date.now(), by: task.persona }
      task.handoff.operator_notes = note.trim()
    }
    task.status = "done"
    this.tasks.save(task)
    const run = task.runId ? this.run(task.runId) : null
    const room = run ? this.sup.rooms.rooms.get(run.roomId) : null
    if (room && note?.trim()) await this.sup.rooms.post(room, null, `On ${task.stage ?? task.title}: ${note.trim()}`).catch(() => {})
    if (task.parentId) await this.joinParent(task.parentId)
    this.tasks.unblock()
    await this.dispatch()
    this.checkRunDone(task.runId)
    return task
  }

  /** Context handed to a stage: the story, the AC so far, and chosen handoffs. */
  contextFor(task) {
    const run = task.runId ? this.run(task.runId) : null
    const def = this.defFor(run)
    const stage = def?.stages?.find((s) => s.id === task.stage)
    const handoffs = {}
    let acceptance = []
    for (const id of stage?.receives ?? []) {
      const t = this.tasks.get(run?.taskIds?.[id])
      if (t?.handoff) {
        handoffs[id] = { ...trimHandoff(t.handoff, { maxChars: Number(this.sup.config?.handoffs?.maxChars) > 200 ? Number(this.sup.config.handoffs.maxChars) : 1800 }), stage: id, persona: t.persona }
        if (t.handoff.acceptance_criteria?.length) acceptance = t.handoff.acceptance_criteria
      }
    }
    return {
      story: task.brief,
      title: task.title,
      task: { id: task.id, title: task.title, stage: task.stage },
      acceptance_criteria: acceptance.length ? acceptance : task.acceptance ?? [],
      handoffs,
      received: Object.values(handoffs),
      run: run ? { id: run.id, pipeline: run.pipeline, branch: run.branch, repo: run.repo } : null,
      peers: run ? Object.entries(run.sessions).map(([persona, id]) => ({ persona, handle: this.sup.store.get(id)?.handle })) : [],
      room: run ? this.sup.rooms.rooms.get(run.roomId)?.name : null,
      item: task.item ?? null,
      siblings: task.parentId ? (this.tasks.get(task.parentId)?.children ?? []).filter((id) => id !== task.id).map((id) => this.tasks.get(id)).filter(Boolean).map((t) => ({ title: t.title, handle: this.sup.store.get(t.assignee)?.handle ?? null })) : [],
    }
  }

  promptFor(task) {
    const run = task.runId ? this.run(task.runId) : null
    const def = this.defFor(run)
    const stage = def?.stages?.find((s) => s.id === task.stage)
    const ctx = this.contextFor(task)
    let body = stage?.prompt
      ? render(stage.prompt, ctx)
      : render(GENERIC_TASK_PROMPT, ctx)
    // Every stage sees the whole story. A stage prompt that leaves it out is
    // usually an oversight, and without it the bot goes asking for it in chat.
    if (stage?.prompt && !variables(stage.prompt).includes("story") && ctx.story) {
      body = `Story:\n\n${ctx.story}\n\n${body}`
    }
    // Questions an earlier stage left open, and anything the operator said
    // about them, whether or not the stage prompt mentions them.
    const open = ctx.received.filter((h) => h.open_questions?.length || h.operator_notes)
    if (open.length) {
      body += "\n\n" + open.map((h) => [
        h.open_questions?.length ? `@${h.persona} (${h.stage}) left these open:\n${h.open_questions.map((q) => `  - ${q}`).join("\n")}` : "",
        h.operator_notes ? `The operator's answer: ${h.operator_notes}` : h.open_questions?.length ? "Settle them from the code and the story where you can; ask in the chat or with botfarm_ask_human if one blocks you." : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    }
    if (task.item && !variables(stage?.prompt ?? "").includes("item")) {
      body += `\n\nYour part — ${task.item.index} of ${task.item.total}: ${task.item.title}` + (task.item.detail ? `\n${task.item.detail}` : "")
    }
    if (task.item) {
      body += "\n\n" + [
        `This stage was split into ${task.item.total} pieces, worked at the same time by several bots in the same worktree.`,
        ctx.siblings.length ? `The others: ${ctx.siblings.map((x) => `"${x.title}"${x.handle ? ` (@${x.handle})` : ""}`).join(", ")}.` : "",
        "Do only your piece. Touch only the files it needs, never revert or reformat someone else's changes,",
        "and if you must change a file another piece owns, say so in the chat first. Do not commit; the next stage sees the whole worktree.",
      ].filter(Boolean).join("\n")
    }
    if (task.rework) {
      const r = task.rework
      const last = task.history?.at(-1)
      body = [
        r.early
          ? `⚠ @${r.by} already checked this and found a problem — fix it as part of this card:`
          : `↩ Round ${r.round}: @${r.by}${r.fromStage ? ` (${r.fromStage})` : ""} sent this card back. Fix what they found — only that, and anything it breaks:`,
        this.reworkText(r),
        last?.summary ? `\nWhat was handed off last time${last.by ? ` (by @${last.by})` : ""}:\n${trimText(last.summary, 900)}` : "",
        r.early ? "" : "\nThe worktree already has the earlier work in it; change what is needed rather than starting over. Run the checks that failed yourself if you can. Then call botfarm_task_complete again, with a summary of what you changed this round and why it fixes each failure.",
        "\n--- the original card ---\n",
      ].filter(Boolean).join("\n") + "\n" + body
    }
    if (task.recheck) {
      const rc = task.recheck
      const fixed = rc.cards.map((id) => this.tasks.get(id)).filter((t) => t?.handoff)
      body += `\n\n↻ Fix ${rc.round}: you sent ${rc.to} back (${rc.reason ? trimText(rc.reason, 200) : "see your last message"}). The fix is in:\n` +
        (fixed.length ? fixed.map((t) => `@${this.sup.store.get(t.assignee)?.handle ?? t.persona}${t.item ? ` (piece ${t.item.index})` : ""}: ${trimText(t.handoff.summary, 700)}`).join("\n\n") : "(no handoff text)") +
        `\n\nVerify it again from scratch — run the tests and builds, do not take the summary's word for it.`
    }
    const targets = this.sendBackTargets(task)
    if (targets.length) {
      const used = Object.values(task.rounds ?? {}).reduce((a, b) => Math.max(a, b), 0)
      body += `\n\nIf what you received does not hold up — a failing test, a broken build, a missed criterion — do not fix it yourself: call botfarm_send_back with the stage and exactly what failed. ` +
        `The bot that did it fixes it, and this card comes back to you to verify. You can send back to: ${targets.map((t) => `${t.stage} (${t.by.length ? t.by.map((h) => "@" + h).join(", ") : t.persona}${t.pieces ? `, ${t.pieces} pieces — name the pieces or files` : ""})`).join(", ")}. ` +
        `Rounds so far: ${used} of ${this.maxRounds(task)}. When it passes, complete your card as usual.`
    }
    const project = task.projectId ? this.sup.projects.get(task.projectId) : null
    const repos = project?.services?.length ? this.sup.reposText(project) : ""
    if (repos) body += `\n\nRepos in this worktree (each on the workstream's branch; commit in the repo you changed):\n${repos}`
    const shared = this.sharedContext(task)
    if (shared) body += "\n\n" + shared
    let handoff = render(stage?.handoff_prompt ?? DEFAULT_HANDOFF_PROMPT, ctx)
    const feeds = this.splitFedBy(def, stage)
    if (feeds && !task.item) {
      handoff += `\n  tasks                REQUIRED: the work for the next stage (${feeds.id}) split into independent pieces,` +
        `\n                       as [{ "title": "...", "detail": "..." }]. Each becomes its own card for a ${feeds.persona} bot;` +
        `\n                       up to ${feeds.parallel ?? 3} run at the same time in the same worktree, so make them touch different` +
        `\n                       files or areas. Usually 2–10 pieces; one piece if it cannot be split. Add` +
        `\n                       "difficulty": "easy" | "normal" | "hard" to a piece when it is obvious — easy ones run on a cheaper model.`
    }
    return [
      `[botfarm] task ${task.id} — ${task.title}`,
      "",
      body,
      "",
      handoff,
    ].join("\n")
  }

  /** The split stage that takes its pieces from this stage's handoff, if any. */
  splitFedBy(def, stage) {
    if (!def || !stage) return null
    const stages = def.stages ?? []
    const i = stages.findIndex((x) => x.id === stage.id)
    const field = (x) => String(x.split === true ? "tasks" : x.split)
    return stages.find((x, j) => {
      if (!x.split || j <= i) return false
      const f = field(x)
      if (f.includes(".")) return f.split(".")[0] === stage.id
      const deps = Array.isArray(x.after) ? x.after : [stages[j - 1]?.id]
      return f === "tasks" && (deps.includes(stage.id) || (x.receives ?? []).includes(stage.id))
    }) ?? null
  }

  // --- fan-out / join ------------------------------------------------------

  /** The list a split card fans out over: `tasks` (or `stage.field`) from the handoffs it waits on. */
  splitItems(parent) {
    const from = parent.split?.from ?? "tasks"
    const [stageId, field] = from.includes(".") ? from.split(".") : [null, from]
    const run = parent.runId ? this.run(parent.runId) : null
    const sources = stageId
      ? [this.tasks.get(run?.taskIds?.[stageId])]
      : (parent.dependsOn ?? []).map((id) => this.tasks.get(id))
    for (const t of sources) {
      const items = normalizeItems(t?.handoff?.[field])
      if (items.length) return items.slice(0, 50)
    }
    return []
  }

  /**
   * Split cards whose inputs have landed become one card per item, addressed
   * to the part (any bot of that kind in this workstream), and enough bots of
   * that kind are brought in to work `parallel` of them at once.
   */
  async expandSplits() {
    const spawned = []
    for (const parent of this.tasks.all().filter((t) => t.split && !t.children && t.status === "queued" && this.tasks.ready(t))) {
      const run = parent.runId ? this.run(parent.runId) : null
      if (run?.paused) continue
      const items = this.splitItems(parent)
      if (!items.length) {
        parent.split = null
        this.tasks.save(parent)
        this.sup.store.note(`"${parent.title}": the handoff before it had no ${parent.split?.from ?? "tasks"} list, so it runs as one card`, null, "warn")
        continue
      }
      const persona = parent.persona
      const role = run?.personaDefs?.[persona]?.role ?? persona
      const children = items.map((it, i) => {
        const c = this.tasks.create({
          title: it.title,
          brief: parent.brief,
          runId: parent.runId,
          projectId: parent.projectId,
          stage: parent.stage,
          persona,
          role,
          owner: "role",
          kind: "work",
          createdBy: "pipeline",
          order: (parent.order ?? 0) + (i + 1) / 1000,
        })
        Object.assign(c, { parentId: parent.id, item: { ...it, index: i + 1, total: items.length }, limits: parent.limits ?? null })
        return this.tasks.save(c)
      })
      Object.assign(parent, { children: children.map((c) => c.id), status: "active", assignee: null, owner: "group", startedAt: Date.now() })
      this.tasks.save(parent)
      const want = Math.min(parent.split.parallel ?? 1, items.length)
      if (run) spawned.push(...(await this.ensureBots(run, persona, want)))
      this.sup.store.note(`${parent.stage} split into ${items.length} cards for up to ${want} ${persona} bot${want > 1 ? "s" : ""}`, null, "info")
    }
    return spawned
  }

  /** Bots of one kind on a run, bringing in more (same worktree, same brief) up to `n`. */
  async ensureBots(run, persona, n) {
    const have = Object.values(run.sessions ?? {}).map((id) => this.sup.store.get(id)).filter((s) => s && (s.persona ?? null) === persona)
    const out = []
    const project = this.sup.projects.get(run.projectId)
    const def = run.personaDefs?.[persona]
    if (!def || !project) return out
    for (let k = have.length; k < n; k++) {
      const s = await this.sup.spawn({
        repo: run.repo,
        services: project.services ?? [],
        branch: run.branch,
        title: `${def.title ?? persona} ${k + 1} · ${project.name}`,
        label: persona,
        group: run.projectId,
        agent: def.agent ?? null,
        model: def.model ?? null,
        variant: def.variant ?? null,
        persona,
        personaTitle: def.title ?? persona,
        role: def.role ?? persona,
        adjectives: def.adjectives ?? null,
        tools: def.tools ?? null,
        policy: { talk: def.talk ?? "open", rooms: def.rooms ?? "member", spawn: !!def.may_spawn, ...(def.policy ?? {}) },
      }).catch((e) => { this.sup.store.note(`could not add a ${persona} bot: ${e.message}`, null, "warn"); return null })
      if (!s) break
      const fresh = this.run(run.id) ?? run
      fresh.sessions[`${persona}-${k + 1}`] = s.id
      this.db.put("runs", fresh)
      run.sessions = fresh.sessions
      const room = this.sup.rooms.rooms.get(run.roomId)
      const live = this.sup.store.get(s.id)
      if (room && live && !room.members.has(s.id)) this.sup.rooms.join(room, live, { silent: true })
      if (live) out.push(live)
    }
    if (out.length) await this.sup.saveManifest(run.projectId).catch(() => {})
    return out
  }

  /** When the last piece of a split card lands, the card lands with all their handoffs joined. */
  async joinParent(parentId) {
    const parent = this.tasks.get(parentId)
    if (!parent?.children || parent.status === "done") return
    const kids = parent.children.map((id) => this.tasks.get(id)).filter(Boolean)
    if (!kids.every((k) => ["done", "cancelled"].includes(k.status))) return
    const done = kids.filter((k) => k.handoff)
    const uniq = (xs) => [...new Set(xs)]
    parent.handoff = {
      summary: done.map((k) => `[${k.item?.index}/${k.item?.total}] ${k.title} — @${this.sup.store.get(k.assignee)?.handle ?? k.persona}:\n${k.handoff.summary}`).join("\n\n")
        + (kids.length > done.length ? `\n\n${kids.length - done.length} piece(s) were stopped before finishing.` : ""),
      acceptance_criteria: uniq(done.flatMap((k) => k.handoff.acceptance_criteria ?? [])),
      artifacts: uniq(done.flatMap((k) => k.handoff.artifacts ?? [])),
      open_questions: uniq(done.flatMap((k) => k.handoff.open_questions ?? [])),
      questions: done.flatMap((k) => k.handoff.questions ?? []),
      parts: done.map((k) => ({ title: k.title, summary: k.handoff.summary, by: k.assignee })),
      at: Date.now(),
      by: parent.persona,
    }
    parent.files = parent.handoff.artifacts
    parent.status = "done"
    this.tasks.save(parent)
    const run = parent.runId ? this.run(parent.runId) : null
    const room = run ? this.sup.rooms.rooms.get(run.roomId) : null
    const sum = (k) => kids.reduce((a, x) => a + (x.report?.[k] ?? 0), 0)
    parent.report = { minutes: parent.startedAt ? (Date.now() - parent.startedAt) / 60000 : 0, tokens: sum("tokens"), usd: sum("usd"), files: parent.handoff.artifacts.slice(0, 60), diffs: [], images: kids.flatMap((k) => (k.report?.images ?? []).map((im, i) => ({ ...im, task: k.id, n: i }))).slice(0, 12), bots: [...new Set(kids.map((k) => this.sup.store.get(k.assignee)?.handle).filter(Boolean))], pieces: kids.length }
    this.tasks.save(parent)
    if (room) await this.sup.rooms.post(room, null, `Finished ${parent.stage}: all ${kids.length} pieces are in (${done.length} done${kids.length > done.length ? `, ${kids.length - done.length} stopped` : ""}).`, { quiet: true, meta: this.cardMeta(parent, parent.report) }).catch(() => {})
  }

  /**
   * Hand queued tasks to sessions. Normally a busy session is left alone until
   * it finishes, which is the whole point of queuing — but two cases must not
   * wait for an idle transition:
   *
   *   force:   a session that was just created and handed its persona brief is
   *            "busy" by definition, so a fresh pipeline would otherwise sit
   *            there doing nothing until something else woke it.
   *   stalled: a queued task nobody has taken for a while. opencode queues
   *            prompts durably, so delivering to a busy session is safe; a
   *            missed idle event should not strand a run forever.
   */
  async dispatch({ force = false, sessions = null } = {}) {
    const spawned = await this.expandSplits()
    const candidates = sessions ? [...sessions, ...spawned] : this.sup.store.list()
    const fresh = new Set(spawned.map((s) => s.id))
    for (const session of candidates) {
      const task = this.tasks.nextFor(session.id, { role: session.role ?? session.persona, projectId: session.project ?? null, alive: (id) => this.aliveOn(id, session.project) })
      if (!task) continue
      if (task.runId && this.run(task.runId)?.paused) continue
      // Rework waits for the bot that did it first while it has its chance,
      // rather than being pushed into its queue behind other work.
      if (task.prefer === session.id && session.status !== "idle" && Date.now() <= (task.preferUntil ?? 0)) continue
      const stalled = Date.now() - (task.queuedAt ?? task.updated) > 45_000
      if (session.status !== "idle" && !force && !stalled && !fresh.has(session.id)) continue
      if (stalled && session.status !== "idle") {
        this.sup.store.note(`queueing "${task.title}" behind @${session.handle}'s current work`, session.id, "warn")
      }
      task.status = "active"
      task.startedAt = Date.now()
      task.nudgedAt = null
      task.tokensAtStart = tokensOf(session)
      task.usdAtStart = this.costOf(session)
      await this.routeCard(task, session).catch(() => {})
      // Where the worktree stood when this card began, so its report shows what
      // this card changed — through any tool, MCP server or script.
      task.baseline = session.directory ? await git.snapshot(session.directory).catch(() => null) : null
      task.pausedMs = 0
      task.noRun = false
      // Role work becomes this session's work the moment it is picked up, so
      // two bots playing the same part cannot both take it.
      if (!task.assignee) task.assignee = session.id
      if (task.prefer) {
        if (task.prefer !== session.id) this.sup.store.note(`"${task.title}" went to @${session.handle} — @${this.sup.store.get(task.prefer)?.handle ?? "the bot that did it first"} was not free`, session.id, "info")
        task.prefer = null
        task.preferUntil = null
      }
      this.tasks.save(task)
      const brief = this.takeBrief(task, session)
      const text = this.promptFor(task)
      if (brief) {
        // First contact: the persona and the task arrive as one operator turn,
        // so the bot starts with its instructions and its work together.
        await this.sup.send(session.id, `${brief}\n\n---\n\n${text}`)
      } else {
        // Whatever was said in the room since this bot last looked rides along
        // with the card, so nobody has to be woken separately to read it.
        const room = task.runId ? this.sup.rooms.rooms.get(this.run(task.runId)?.roomId) : null
        await this.sup.deliver(session, {
          text: text + earlier(room, session, "since you last looked"),
          description: `task ${task.stage ?? ""} ${task.title}`.trim(),
        })
      }
      this.sup.store.note(`@${session.handle} picked up "${task.title}"`, session.id)
    }
  }

  /**
   * A bot on a pipeline run with no open cards: everything assigned to it is
   * done or cancelled. Chatter between bots does not wake it (only the
   * operator, a direct question, or a new card does). Sessions outside
   * pipeline runs are never resting: they keep the plain chat behaviour.
   */
  resting(session) {
    const onRun = this.runs().some((run) => Object.values(run.sessions ?? {}).includes(session.id))
    if (!onRun) return false
    return !this.tasks.all({ assignee: session.id }).some((t) => !["done", "cancelled"].includes(t.status))
  }

  /** A bot in a run whose first stage has not been handed to it yet. */
  awaitingStage(session) {
    for (const run of this.runs()) {
      if (run.status !== "running" || !run.briefs) continue
      if (Object.values(run.sessions ?? {}).includes(session.id)) return !(run.briefed ?? []).includes(session.id)
    }
    return false
  }

  /** The persona brief for this session's first task in a run, once. */
  takeBrief(task, session) {
    const run = task.runId ? this.run(task.runId) : null
    if (!run?.briefs) return null
    run.briefed ??= []
    if (run.briefed.includes(session.id)) return null
    run.briefed.push(session.id)
    this.db.put("runs", run)
    const persona = session.persona ?? task.persona
    const body = run.briefs[persona]
    const peers = Object.entries(run.sessions ?? {})
      .filter(([, id]) => id !== session.id)
      .map(([p, id]) => `@${this.sup.store.get(id)?.handle ?? p} (${p})`)
    const room = this.sup.rooms.rooms.get(run.roomId)
    return [
      `[botfarm] You are @${session.handle ?? persona}, the ${persona} on this run.` +
        (peers.length ? ` The others are ${peers.join(", ")}${room ? `, in ${room.name}` : ""}.` : ""),
      "Your task is below and has everything you need. Other stages run before and after yours: do not do their work,",
      "and do not wait for anyone unless your task says to.",
      body ? `\n${body}` : "",
      earlier(room, session),
    ].join("\n")
  }

  // --- sending work back ----------------------------------------------------
  //
  // Plan → Code → Verify → Fail → Code → Verify → Pass. A checker (QA, the
  // reviewer, the operator) that finds something wrong does not fix it: it
  // sends the earlier card back with what failed. That card goes back to To
  // do for the bot that did it first (another of its kind takes it if that
  // bot is gone or stays busy), and the checker's card waits for the fix and
  // then comes back to the same checker to verify again. Rounds are counted
  // per checker card and target; past `max_rounds`, or when the same failure
  // comes back twice, it stops and asks the operator.

  /** A session that still works on this workstream. */
  aliveOn(id, projectId) {
    const s = id ? this.sup.store.get(id) : null
    return !!s && (!projectId || !s.project || s.project === projectId) && s.status !== "error"
  }

  /** The earlier stages a card may send back to, with who did them. */
  sendBackTargets(task) {
    const run = task?.runId ? this.run(task.runId) : null
    const def = this.defFor(run)
    const stages = def?.stages ?? []
    const stage = stages.find((s) => s.id === task.stage)
    if (!stage || stage.send_back === false || this.maxRounds(task) === 0) return []
    const i = stages.indexOf(stage)
    const allowed = Array.isArray(stage.send_back) ? stage.send_back : stages.slice(0, i).filter((s) => !s.human).map((s) => s.id)
    return allowed.map((id) => {
      const t = this.tasks.get(run.taskIds?.[id])
      const who = t?.children ? [...new Set(t.children.map((c) => this.sup.store.get(this.tasks.get(c)?.assignee)?.handle).filter(Boolean))] : [this.sup.store.get(t?.assignee)?.handle].filter(Boolean)
      return { stage: id, persona: stages.find((s) => s.id === id)?.persona ?? null, by: who, pieces: t?.children?.length ?? 0 }
    }).filter((x) => x.persona)
  }

  maxRounds(task) {
    const run = task.runId ? this.run(task.runId) : null
    const def = this.defFor(run)
    const stage = def?.stages?.find((s) => s.id === task.stage)
    const base = stage?.max_rounds ?? def?.max_rounds ?? this.sup.config?.maxRounds ?? 3
    return base + (task.extraRounds ?? 0)
  }

  /**
   * Send earlier work back. `from` is the checker's card (null when the
   * operator does it from the board). `to` is a stage id or a card id.
   * `pieces` (1-based numbers or card ids) or `files` pick pieces of a split
   * stage; with neither, a new "fix" piece is added.
   */
  async sendBack(from, { to, reason = "", failures = [], files = [], pieces = [], by = null } = {}) {
    reason = String(reason ?? "").trim()
    failures = (Array.isArray(failures) ? failures : [failures]).map((f) => String(typeof f === "object" && f ? JSON.stringify(f) : f ?? "").trim()).filter(Boolean).slice(0, 30)
    files = (Array.isArray(files) ? files : [files]).map(String).filter(Boolean).slice(0, 60)
    if (!reason && !failures.length) throw new Error("say what is wrong: a reason and/or the failures — the bot fixing it cannot see your conversation")
    const get = (id) => (typeof id === "string" && id ? this.tasks.get(id) : null)
    const runId = from?.runId ?? get(to)?.runId
    const run = runId ? this.run(runId) : null
    if (!run) throw new Error("sending back only works inside a pipeline workstream")
    let target = get(run.taskIds?.[to]) ?? get(to)
    if (target?.runId !== run.id) target = null
    if (!target) throw new Error(`no stage or card "${to}" on this workstream. Stages: ${Object.keys(run.taskIds).join(", ")}`)
    if (target.owner === "human" || target.kind === "question") throw new Error("that card is for the operator; ask them with botfarm_ask_human instead")
    const top = target.parentId ? this.tasks.get(target.parentId) : target
    const key = top.stage ?? top.id
    if (from) {
      if (from.id === target.id || from.id === top.id) throw new Error("that is your own card — fix it yourself or finish it")
      const ok = this.sendBackTargets(from).map((x) => x.stage)
      if (!ok.includes(key)) throw new Error(ok.length ? `${from.stage} can send back to: ${ok.join(", ")}` : `${from.stage} cannot send work back (its pipeline says so)`)
    }
    const by_ = by ?? (from ? this.sup.store.get(from.assignee)?.handle ?? from.persona : "operator")
    const room = this.sup.rooms.rooms.get(run.roomId)

    // Rounds, and the same failure twice, are counted per checker card.
    let round = 1
    if (from) {
      from.rounds ??= {}
      round = (from.rounds[key] ?? 0) + 1
      const max = this.maxRounds(from)
      const sig = (failures.length ? failures.join("\n") : reason).toLowerCase().replace(/\d+(\.\d+)?\s*(ms|s)\b/g, "").replace(/\s+/g, " ").slice(0, 600)
      const same = round > 1 && sig.length >= 20 && from.lastSendBack?.[key]?.sig === sig
      if (round > max || same) {
        const why = same ? `the same failure came back after round ${round - 1}` : `${key} has been sent back ${round - 1} time${round > 2 ? "s" : ""} (max ${max})`
        from.status = "review"
        from.budget = { kind: "rounds", why, to: key, round: round - 1, max, at: Date.now() }
        from.pausedAt = Date.now()
        from.pendingSendBack = { to, reason, failures, files, pieces }
        this.tasks.save(from)
        this.sup.store.note(`⏸ "${from.title}": ${why} — waiting for you`, from.assignee, "warn")
        this.sup.replay?.note(from.projectId, `${from.stage}: ${why}`, "warn")
        if (room) await this.sup.rooms.post(room, this.sup.store.get(from.assignee) ?? null, `⏸ I wanted to send ${key} back again, but ${why}. Waiting for the operator.`, { quiet: true }).catch(() => {})
        this.sup.onChange()
        return { paused: true, why, round: round - 1, max }
      }
      from.lastSendBack = { ...(from.lastSendBack ?? {}), [key]: { sig, at: Date.now() } }
    } else {
      round = (top.round ?? 1) + 1
    }

    // Which cards go back.
    let reopen = []
    let added = null
    if (top.children) {
      const kids = top.children.map((id) => this.tasks.get(id)).filter(Boolean)
      const want = (Array.isArray(pieces) ? pieces : [pieces]).filter((p) => p !== undefined && p !== null && p !== "")
      if (target !== top) reopen = [target]
      else if (want.length) reopen = kids.filter((k) => want.some((p) => String(p) === k.id || Number(p) === k.item?.index))
      else if (files.length) {
        const hit = (a, b) => a === b || a.endsWith("/" + b) || b.endsWith("/" + a)
        reopen = kids.filter((k) => [...(k.files ?? []), ...(k.handoff?.artifacts ?? []), ...(k.report?.files ?? []).map((f) => f.path ?? f)].some((f) => files.some((x) => hit(String(f), x))))
      }
      if (!reopen.length && kids.length === 1) reopen = kids
      if (!reopen.length) {
        // Nobody owns what failed: a new piece, for any bot of that kind.
        const total = kids.length + 1
        added = this.tasks.create({
          title: `Fix: ${(failures[0] ?? reason).split("\n")[0].slice(0, 80)}`,
          brief: top.brief, runId: top.runId, projectId: top.projectId, stage: top.stage, persona: top.persona,
          role: run.personaDefs?.[top.persona]?.role ?? top.persona, owner: "role", kind: "work", createdBy: by_,
          order: (top.order ?? 0) + total / 1000,
        })
        Object.assign(added, { parentId: top.id, item: { title: added.title, detail: reason, index: total, total }, limits: top.limits ?? null, round, rework: { round, reason, failures, files, by: by_, fromTask: from?.id ?? null, fromStage: from?.stage ?? null } })
        this.tasks.save(added)
        top.children = [...top.children, added.id]
      }
    } else reopen = [target]

    for (const t of reopen) {
      const prev = t.assignee
      if (["done", "cancelled", "review"].includes(t.status)) {
        t.history = [...(t.history ?? []), { round: t.round ?? 1, summary: String(t.handoff?.summary ?? "").slice(0, 2000), usd: t.report?.usd ?? null, tokens: t.report?.tokens ?? null, minutes: t.report?.minutes ?? null, by: this.sup.store.get(prev)?.handle ?? null, at: Date.now() }].slice(-12)
        t.round = (t.round ?? 1) + 1
        t.rework = { round: t.round, reason, failures, files, by: by_, fromTask: from?.id ?? null, fromStage: from?.stage ?? null }
        t.status = "queued"
        t.queuedAt = Date.now()
        t.budget = null
        t.xp = null
        t.pausedAt = null
        // Addressed to the part, preferring the bot that did it.
        t.owner = "role"
        t.role = run.personaDefs?.[t.persona]?.role ?? t.persona
        t.assignee = null
        t.prefer = this.aliveOn(prev, run.projectId) ? prev : null
        t.preferUntil = t.prefer ? Date.now() + (this.sup.config?.preferMs ?? 90_000) : null
        this.tasks.save(t)
      } else {
        // Still being worked on (dev and QA side by side): tell its bot now.
        this.tasks.note(t.id, `${by_} found: ${[reason, ...failures].filter(Boolean).join(" · ").slice(0, 1500)}`, by_)
        t.rework = { round: t.round ?? 1, reason, failures, files, by: by_, fromTask: from?.id ?? null, fromStage: from?.stage ?? null, early: true }
        this.tasks.save(t)
        const s = t.status === "active" ? this.sup.store.get(t.assignee) : null
        if (s) await this.sup.deliver(s, { text: `[botfarm] @${by_} checked your work on "${t.title}" and found a problem:\n${this.reworkText(t.rework)}\nFix it as part of this card before you complete it.`, description: `rework ${t.title}` }).catch(() => {})
      }
    }
    if (top.children && (reopen.length || added)) { top.status = "active"; this.tasks.save(top) }

    // Make sure someone of that kind is there to take it.
    const persona = top.persona
    if (!Object.values(run.sessions ?? {}).some((id) => this.aliveOn(id, run.projectId) && this.sup.store.get(id)?.persona === persona)) {
      await this.ensureBots(run, persona, 1).catch(() => {})
    }

    // The checker's card (or, from the board, whatever was waiting on it) waits for the fix.
    const waitOn = top.children ? top.id : target.id
    const waiters = from ? [from] : this.tasks.all({ runId: run.id }).filter((t) => t.id !== top.id && !t.parentId && this.dependsOnTransitively(t, top.id) && ["active", "queued", "review"].includes(t.status) && t.owner !== "human")
    for (const w of waiters) {
      if (w.status === "active" && !from) {
        const s = this.sup.store.get(w.assignee)
        if (s && (s.status === "busy" || s.status === "waiting")) await this.sup.abort(s.id).catch(() => {})
      }
      w.baseDeps ??= [...(w.dependsOn ?? [])]
      w.dependsOn = [...new Set([...(w.dependsOn ?? []), waitOn])]
      w.status = "blocked"
      w.queuedAt = null
      w.recheck = { round, to: key, reason, cards: [...reopen.map((t) => t.id), ...(added ? [added.id] : [])], by: by_ }
      if (from && w === from) from.rounds[key] = round
      this.tasks.save(w)
    }

    const names = [...reopen, ...(added ? [added] : [])]
    const whoFor = names.map((t) => t.prefer ? "@" + (this.sup.store.get(t.prefer)?.handle ?? t.persona) : `a ${t.persona} bot`)
    const max = from ? this.maxRounds(from) : null
    const text = `↩ ${by_ === "operator" ? "You" : "@" + by_} sent ${key}${names.length && top.children ? ` (${names.map((t) => t.item ? `piece ${t.item.index}` : t.title).join(", ")})` : ""} back to ${[...new Set(whoFor)].join(", ") || "its bot"}${from ? ` — fix ${round} of ${max}` : ""}: ${(reason || failures[0]).slice(0, 400)}${failures.length > (reason ? 0 : 1) ? `\n${failures.slice(reason ? 0 : 1, 6).map((f) => "• " + f.slice(0, 200)).join("\n")}` : ""}`
    if (room) await this.sup.rooms.post(room, from ? this.sup.store.get(from.assignee) : null, text, { quiet: true, meta: { kind: "sendback", to: key, round, max, cards: names.map((t) => t.id), from: from?.id ?? null } }).catch(() => {})
    this.sup.store.note(text.split("\n")[0], from?.assignee ?? null, "warn")
    this.sup.replay?.note(run.projectId, text.split("\n")[0])
    this.tasks.unblock()
    await this.dispatch()
    return { sent: names.map((t) => ({ id: t.id, title: t.title, to: t.prefer ? this.sup.store.get(t.prefer)?.handle ?? null : null })), round, max, waiting: waiters.map((w) => w.id) }
  }

  dependsOnTransitively(task, id, seen = new Set()) {
    for (const d of task.dependsOn ?? []) {
      if (d === id) return true
      if (seen.has(d)) continue
      seen.add(d)
      const t = this.tasks.get(d)
      if (t && this.dependsOnTransitively(t, id, seen)) return true
    }
    return false
  }

  reworkText(r) {
    return [
      r.reason ? `  ${r.reason}` : "",
      r.failures?.length ? `What failed:\n${r.failures.map((f) => `  - ${f}`).join("\n")}` : "",
      r.files?.length ? `Files: ${r.files.join(", ")}` : "",
    ].filter(Boolean).join("\n")
  }

  /** The operator answers a card that stopped sending work back. */
  async roundsDecision(task, action) {
    const pending = task.pendingSendBack
    const was = task.budget
    task.pausedMs = (task.pausedMs ?? 0) + (task.pausedAt ? Date.now() - task.pausedAt : 0)
    task.pausedAt = null
    task.budget = null
    task.pendingSendBack = null
    const s = this.sup.store.get(task.assignee)
    if (action === "continue" && pending) {
      // One more round, and forget the "same failure" match so it can go.
      task.extraRounds = (task.extraRounds ?? 0) + Math.max(0, (was.round + 1) - this.maxRounds(task))
      if (task.lastSendBack?.[was.to]) task.lastSendBack[was.to].sig = null
      task.status = "active"
      this.tasks.save(task)
      return this.sendBack(task, pending)
    }
    // Accept: the checker finishes with what it has.
    task.status = "active"
    task.nudgedAt = null
    this.tasks.save(task)
    if (s) await this.sup.deliver(s, {
      text: `[botfarm] The operator read where ${was.to} stands and says: no more rounds. Finish task ${task.id} — "${task.title}" — now with botfarm_task_complete, and list whatever still fails in open_questions so it is not lost.`,
      description: `finish ${task.title}`,
    })
    return task
  }

  // --- routing, shared notes, loops, XP -------------------------------------

  /**
   * Pick the model for a card by how hard it looks: the agent's `tiers:` or
   * the workspace's botfarm/routing.botfarm.yml. The bot's own override (Model…)
   * always wins. Recorded on the card so the board can show it.
   */
  async routeCard(task, session) {
    const run = task.runId ? this.run(task.runId) : null
    const stage = this.defFor(run)?.stages?.find((s) => s.id === task.stage)
    const ctx = this.contextFor(task)
    const d = difficulty({
      explicit: task.item?.difficulty ?? stage?.difficulty ?? task.difficultyWanted ?? null,
      title: task.title,
      detail: task.item?.detail ?? "",
      story: task.item ? "" : task.brief ?? "",
      criteria: ctx.acceptance_criteria ?? [],
    })
    const wsId = run?.workspaceId ?? this.sup.workspaceIdOf(session)
    const routing = wsId ? await this.sup.workspaces.routing(wsId).catch(() => null) : null
    const persona = run?.personaDefs?.[task.persona ?? session.persona] ?? null
    const tier = routeFor(d.level, { agentTiers: persona?.tiers ?? null, routing })
    const route = tier ? this.applyQuota(tier, { wsId, projectId: task.projectId, persona: task.persona ?? session.persona }) : null
    task.difficulty = { ...d, route: route ? { model: route.model, variant: route.variant, fellBack: route.fellBack ?? null } : null }
    session.route = route ? { ...route, source: tier.source, persona: task.persona ?? session.persona, taskId: task.id, level: d.level, wsId, projectId: task.projectId, switchMode: routing?.switch === "next-turn" ? "next-turn" : "now" } : null
    if (route) this.sup.store.note(`"${task.title}" looks ${d.level} (${d.why}) → ${route.model ?? "same model"}${route.variant ? ` · ${route.variant}` : ""}${route.fellBack ? ` (${route.fellBack.why})` : ""}`, session.id, "info")
  }

  /**
   * A tier with a quota on its model: once the workspace has spent it in the
   * period (a day, week, month or this workstream), use the fallback instead.
   */
  applyQuota(tier, { wsId, projectId, persona = null }) {
    if (!tier.quota || !tier.model || !this.sup.ledger) return tier
    // An agent's own quota counts only that agent's spend; a workspace quota counts everyone's.
    const key = tier.source === "agent" && persona ? `${tier.model}@${persona}` : tier.model
    const spent = this.sup.ledger.spent(wsId, key, tier.quota.per, projectId)
    const hit = overQuota(tier.quota, spent)
    if (!hit) return tier
    const { quota, fallback, ...rest } = tier
    const label = { usd: `$${Number(hit.limit).toFixed(2)}`, tokens: `${Math.round(hit.limit / 1000)}k tokens`, minutes: `${Math.round(hit.limit)} min` }[hit.kind]
    return {
      model: fallback?.model ?? undefined,
      variant: fallback?.variant ?? (fallback?.model ? undefined : rest.variant),
      fellBack: { from: tier.model, why: `${tier.model.split("/").pop()} quota of ${label} per ${tier.quota.per} used`, hit },
    }
  }

  /**
   * Cards already running on a model whose quota just ran out move to the
   * fallback: at once (the turn is stopped and picked up again on the
   * fallback) or from the bot's next turn, per the routing file's `switch:`.
   */
  async checkQuotas() {
    for (const s of this.sup.store.list()) {
      const r = s.route
      if (!r?.quota || r.fellBack || s.override?.model) continue
      const next = this.applyQuota(r, { wsId: r.wsId, projectId: r.projectId, persona: r.persona })
      if (!next.fellBack) continue
      s.route = { ...next, source: r.source, persona: r.persona, taskId: r.taskId, level: r.level, wsId: r.wsId, projectId: r.projectId, switchMode: r.switchMode }
      const task = this.tasks.get(r.taskId)
      if (task?.difficulty) { task.difficulty = { ...task.difficulty, route: { model: next.model, variant: next.variant, fellBack: next.fellBack } }; this.tasks.save(task) }
      const to = next.model ? next.model.split("/").pop() : "its agent's own model"
      this.sup.store.note(`@${s.handle}: ${next.fellBack.why} — switching to ${to}${next.variant ? ` · ${next.variant}` : ""}`, s.id, "warn")
      this.sup.replay?.note(task?.projectId ?? s.project, `@${s.handle} moved to ${to}: ${next.fellBack.why}`, "warn")
      if (r.switchMode === "now" && s.status === "busy" && task?.status === "active") {
        await this.sup.abort(s.id).catch(() => {})
        await this.sup.deliver(s, {
          text: `[botfarm] ${next.fellBack.why}, so you are now running on ${to}. Carry on with task ${task.id} — "${task.title}" — from where you left off.`,
          description: `continue ${task.title} on ${to}`,
        }).catch(() => {})
      }
    }
  }

  /**
   * What a finished card cost and changed. Diffs are taken now, per file the
   * card handed over (capped), so later stages' edits do not rewrite history.
   * Screenshots are image attachments from the bot's tool results since the
   * card started, and image files among its artifacts.
   */
  async cardReport(task) {
    const s = this.sup.store.get(task.assignee)
    const usage = this.taskUsage(task)
    const dir = s?.directory ?? (task.runId ? this.sup.projects.get(task.projectId)?.worktree : null)
    const listed = [...new Set((task.handoff?.artifacts ?? []).map(String))].slice(0, 60)
    let files = listed
    const diffs = []
    let budget = 160_000
    if (dir && task.baseline) {
      // What changed on disk during the card, however it was changed.
      const changes = await git.changesSince(dir, task.baseline).catch(() => [])
      const norm = (f) => String(f).replace(/^\.\//, "").replace(dir + "/", "")
      const listedSet = new Set(listed.map(norm))
      for (const c of changes) diffs.push({ ...c, unlisted: !listedSet.has(c.file) })
      files = [...new Set([...listed.map(norm), ...changes.map((c) => c.file)])].slice(0, 80)
    } else if (dir) {
      for (const f of files.slice(0, 20)) {
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f)) continue
        let d = await git.diffFile(dir, f).catch(() => "")
        if (!d) continue
        // A new, untracked file comes back as its contents: show it as all added.
        if (!/^diff --git /m.test(d)) d = `--- /dev/null\n+++ b/${f}\n@@ new file @@\n` + d.replace(/\n$/, "").split("\n").map((l) => "+" + l).join("\n")
        const lines = d.split("\n")
        const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
        const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length
        const cap = Math.min(budget, 24_000)
        if (cap <= 0) { diffs.push({ file: f, added, removed, truncated: true, diff: "" }); continue }
        const truncated = d.length > cap
        if (truncated) d = d.slice(0, cap)
        budget -= d.length
        diffs.push({ file: f, added, removed, truncated, diff: d })
      }
    }
    const images = []
    for (const f of files.filter((x) => /\.(png|jpe?g|gif|webp)$/i.test(x) && !diffs.some((d) => d.file === x && d.deleted)).slice(0, 6)) images.push({ source: "worktree", path: f, name: f.split("/").pop() })
    if (s) {
      const msgs = await this.sup.client.messages(s.id, { limit: 60, order: "desc" }).catch(() => [])
      const since = task.startedAt ?? 0
      const shots = []
      for (const m of msgs) {
        const info = m.info ?? m
        const at = info.time?.created ?? info.time?.start ?? 0
        if (at && at < since) continue
        for (const p of m.parts ?? []) {
          const atts = [
            ...(p.type === "file" ? [p] : []),
            ...(Array.isArray(p.state?.attachments) ? p.state.attachments : []),
            ...(Array.isArray(p.attachments) ? p.attachments : []),
          ]
          for (const a of atts) {
            const mime = a.mime ?? a.mimeType ?? ""
            const url = a.url ?? (a.data ? `data:${mime};base64,${a.data}` : "")
            if (/^image\//.test(mime) && /^data:/.test(url)) shots.push({ mime, url, name: a.filename ?? a.name ?? `${p.tool ?? "screenshot"}` })
          }
        }
      }
      if (shots.length) {
        const out = join(this.sup.home, "shots")
        await mkdirp(out, { recursive: true })
        for (const [i, sh] of shots.slice(0, 8).entries()) {
          const ext = (sh.mime.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "")
          const file = `${task.id}-${i}.${ext}`
          const b64 = sh.url.slice(sh.url.indexOf(",") + 1)
          await writeF(join(out, file), Buffer.from(b64, "base64")).catch(() => {})
          images.push({ source: "shot", file, name: sh.name })
        }
      }
    }
    const report = {
      minutes: task.startedAt ? Math.max(0, Date.now() - task.startedAt - (task.pausedMs ?? 0)) / 60000 : 0,
      tokens: usage.tokens,
      usd: usage.usd,
      model: s ? (this.sup.turnSettings(s).model ?? s.model ?? null) : null,
      handle: s?.handle ?? null,
      files,
      diffs,
      images,
      tracked: !!task.baseline,
    }
    delete task.baseline // done with it; keep the task record small
    task.report = report
    this.tasks.save(task)
    return report
  }

  /** The small part of a report that rides on the chat message; the diffs are fetched when opened. */
  cardMeta(task, r) {
    return {
      kind: "card",
      taskId: task.id,
      title: task.title,
      stage: task.stage ?? null,
      piece: task.item ? `${task.item.index}/${task.item.total}` : null,
      minutes: r.minutes,
      tokens: r.tokens,
      usd: r.usd,
      model: r.model ?? null,
      xp: task.xp?.gained ?? null,
      files: (r.diffs?.length ? r.diffs.map((d) => ({ file: d.file, added: d.added, removed: d.removed, ...(d.unlisted ? { unlisted: true } : {}), ...(d.created ? { created: true } : {}), ...(d.deleted ? { deleted: true } : {}) })) : (r.files ?? []).map((f) => ({ file: f }))).slice(0, 40),
      images: (r.images ?? []).length,
      pieces: r.pieces ?? null,
      bots: r.bots ?? null,
      open: task.handoff?.open_questions?.length ?? 0,
    }
  }

  /** Stop every bot on a workstream until you resume it. */
  async pauseByHand(projectId) {
    const project = this.sup.projects.get(projectId)
    const run = project?.runId ? this.run(project.runId) : null
    if (!run) throw new Error("this workstream was not started from a pipeline")
    if (run.paused) return run
    await this.pauseRun(run, { kind: "manual" })
    return run
  }

  /** What the rest of the team already knows: saved notes, and files they have read. */
  sharedContext(task) {
    const run = task.runId ? this.run(task.runId) : null
    if (!run) return ""
    const notes = run.notes ?? []
    const me = task.assignee
    const read = new Map()
    for (const id of Object.values(run.sessions ?? {})) {
      if (id === me) continue
      const s = this.sup.store.get(id)
      for (const c of s?.toolLog ?? []) {
        if (!/(^|_)read$|^read/i.test(c.name) || !c.summary || c.status === "error") continue
        if (!read.has(c.summary)) read.set(c.summary, s.handle)
      }
    }
    const out = []
    if (notes.length) out.push(`Team notes (read the ones you need with botfarm_notes_read before exploring): ${notes.slice(-15).map((n) => `"${n.topic}" (@${n.by})`).join(", ")}.`)
    if (read.size) out.push(`Files teammates have already read — check the notes or ask before re-reading them all: ${[...read].slice(-20).map(([f, h]) => `${f} (@${h})`).join(", ")}.`)
    out.push("When you have mapped an area others will need (a module, a flow, where something lives), save 3–8 lines with botfarm_notes_write so nobody has to read it all again.")
    return out.join("\n")
  }

  notes(runId) {
    return this.run(runId)?.notes ?? []
  }

  addNote(runId, { topic, text, files = [], by }) {
    const run = this.run(runId)
    if (!run) throw new Error("no workstream for this bot")
    const t = String(topic ?? "").trim().slice(0, 80)
    if (!t || !String(text ?? "").trim()) throw new Error("a note needs a topic and some text")
    run.notes ??= []
    const at = run.notes.findIndex((n) => n.topic.toLowerCase() === t.toLowerCase())
    const note = { topic: t, text: trimText(String(text), 1500), files: (files ?? []).slice(0, 30).map(String), by, at: Date.now() }
    if (at >= 0) run.notes[at] = note
    else run.notes.push(note)
    run.notes = run.notes.slice(-60)
    this.db.put("runs", run)
    this.sup.replay?.note(run.projectId, `@${by} saved a note: ${t}`)
    return note
  }

  /** Is this card's bot going round in circles? Only calls since the card started count. */
  async loopCheck(task, usage, now = Date.now()) {
    if (task.loopQuietUntil && now < task.loopQuietUntil) return null
    const s = this.sup.store.get(task.assignee)
    if (!s || s.status !== "busy") return null
    const calls = (s.toolLog ?? []).filter((c) => (c.at ?? 0) >= (task.startedAt ?? 0))
    const persona = task.runId ? this.run(task.runId)?.personaDefs?.[task.persona] : null
    const canEdit = !persona?.tools?.length || persona.tools.some((t) => /edit|write|patch|\*/.test(t))
    const ceiling = Number(this.sup.config?.loops?.tokensWithoutEdits) > 0 ? Number(this.sup.config.loops.tokensWithoutEdits) : 250_000
    // Only ask git once the token ceiling is in play, and at most once a minute per card.
    let edited
    if (canEdit && usage.tokens > ceiling && task.baseline && s.directory) {
      this.editedCache ??= new Map()
      const hit = this.editedCache.get(task.id)
      if (hit && now - hit.at < 60_000) edited = hit.edited
      else { edited = await git.changedSince(s.directory, task.baseline).catch(() => undefined); this.editedCache.set(task.id, { at: now, edited }) }
    }
    return stuckReason(calls, { tokens: usage.tokens, canEdit, tokenCeiling: ceiling, edited })
  }

  levelFor(task) {
    const run = task.runId ? this.run(task.runId) : null
    const wsId = run?.workspaceId ?? null
    return this.sup.farmhands?.get(wsId, task.persona ?? "bot")?.level ?? 1
  }

  /** A card's limits with the level perks (Seasoned +10%, Veteran +20%) applied. */
  effectiveLimits(task) {
    const bonus = budgetBonus(this.levelFor(task))
    if (!task.limits || !bonus) return task.limits
    return Object.fromEntries(Object.entries(task.limits).map(([k, v]) => [k, v * (1 + bonus)]))
  }

  awardXp(task, worker) {
    if (!this.sup.farmhands || !task.persona || task.owner === "human") return null
    const run = task.runId ? this.run(task.runId) : null
    const usage = this.taskUsage(task)
    let { xp, reasons } = xpForCard({ task, usage, paused: !!task.pausedMs || !!task.autoExtended, openQuestions: task.handoff?.open_questions?.length ?? 0 })
    // A fix round earns a little, never a full card again: bugs must not pay.
    // Catching something that needed fixing is worth a little to the checker.
    if (task.rework && task.round > 1) { xp = 3; reasons = [[`fixed in round ${task.round}`, 3]] }
    else if (task.rounds && Object.keys(task.rounds).length) { const n = Object.values(task.rounds).reduce((a, b) => a + b, 0); reasons.push([`sent back ${n} time${n > 1 ? "s" : ""} and verified the fix`, 2]); xp += 2 }
    const out = this.sup.farmhands.award(run?.workspaceId ?? null, task.persona, xp, { reasons, card: task.title })
    task.xp = { gained: xp, reasons: reasons.map(([r, n]) => `${r} +${n}`) }
    if (run) {
      run.xp ??= {}
      run.xp[task.persona] = (run.xp[task.persona] ?? 0) + xp
      if (out.levelUp) (run.levelUps ??= []).push({ persona: task.persona, level: out.levelUp.level, hat: out.levelUp.hat, title: out.levelUp.title })
      this.db.put("runs", run)
    }
    if (out.levelUp) {
      this.sup.store.note(`🎉 ${task.persona} reached level ${out.levelUp.level} — ${out.levelUp.title} ${out.levelUp.hat ?? ""}`, worker?.id ?? null, "info")
      this.sup.replay?.note(task.projectId, `${task.persona} reached level ${out.levelUp.level} ${out.levelUp.hat ?? ""}`)
    }
    return out
  }

  /** A finished workstream: totals for the harvest log, the celebration, and its PR packet. */
  async harvest(run) {
    const project = this.sup.projects.get(run.projectId)
    const bots = this.sup.projects.sessions(run.projectId)
    const used = this.runUsage(run)
    const cards = this.tasks.all({ runId: run.id }).filter((t) => t.status === "done" && !t.children)
    const h = {
      id: run.id,
      ws: run.workspaceId ?? null,
      project: run.projectId,
      name: project?.name ?? run.title,
      at: Date.now(),
      minutes: used.minutes,
      usd: used.usd,
      tokens: used.tokens,
      budget: run.limits?.usd ?? null,
      saved: run.limits?.usd ? run.limits.usd - used.usd : null,
      cards: cards.length,
      botMinutes: cards.reduce((a, t) => a + (t.startedAt ? Math.max(0, (t.updated ?? Date.now()) - t.startedAt - (t.pausedMs ?? 0)) : 0), 0) / 60000,
      xp: Object.values(run.xp ?? {}).reduce((a, n) => a + n, 0),
      xpBy: run.xp ?? {},
      levelUps: run.levelUps ?? [],
      bots: bots.map((s) => ({ handle: s.handle, persona: s.persona })),
    }
    this.sup.farmhands?.saveHarvest(h)
    if (project) this.sup.projects.save({ ...this.sup.projects.get(run.projectId), harvest: h })
    this.sup.replay?.harvest(run.projectId, h)
    await this.sup.writePacket(run.projectId).catch(() => {})
    this.sup.onChange()
    return h
  }

  // --- budgets ---------------------------------------------------------------

  costOf(session) {
    if (!session?.cost) return 0
    return session.cost(this.sup.store.pricing?.() ?? {})?.usd ?? 0
  }

  /** Minutes, tokens and dollars one card has used since it was picked up. */
  taskUsage(task, now = Date.now()) {
    const s = this.sup.store.get(task.assignee)
    const paused = (task.pausedMs ?? 0) + (task.pausedAt ? now - task.pausedAt : 0)
    return {
      minutes: task.startedAt ? Math.max(0, now - task.startedAt - paused) / 60000 : 0,
      tokens: s ? Math.max(0, tokensOf(s) - (task.tokensAtStart ?? 0)) : 0,
      usd: s ? Math.max(0, this.costOf(s) - (task.usdAtStart ?? 0)) : 0,
    }
  }

  /** What a whole workstream has used: every bot on it, and its time since it started. */
  runUsage(run, now = Date.now()) {
    const sessions = this.sup.projects.sessions(run.projectId)
    const paused = (run.pausedMs ?? 0) + (run.paused?.at ? now - run.paused.at : 0)
    return {
      minutes: Math.max(0, now - run.created - paused) / 60000,
      tokens: sessions.reduce((a, s) => a + tokensOf(s), 0) + (run.retired?.tokens ?? 0),
      usd: sessions.reduce((a, s) => a + this.costOf(s), 0) + (run.retired?.usd ?? 0),
    }
  }

  /**
   * Stop anything that has gone past its time, token or dollar limit and ask
   * the operator. A card over its own limit stops alone; a workstream over its
   * limit stops every bot on it. Nothing continues until you say so.
   */
  async checkBudgets(now = Date.now()) {
    await this.checkQuotas().catch((e) => this.sup.store.note(`quota check: ${e.message}`, null, "warn"))
    for (const run of this.runs()) {
      if (run.status !== "running" || run.paused) continue
      const hit = overLimit(run.limits, this.runUsage(run, now))
      if (hit) { await this.pauseRun(run, hit); continue }
    }
    for (const task of this.tasks.all({ status: "active" })) {
      if (task.children || !task.assignee) continue
      if (task.runId && this.run(task.runId)?.paused) continue
      const usage = this.taskUsage(task, now)
      const loop = await this.loopCheck(task, usage, now)
      if (loop) { await this.pauseTask(task, loop); continue }
      if (!task.limits) continue
      const limits = this.effectiveLimits(task)
      const hit = overLimit(limits, usage)
      if (!hit) continue
      // Trusted bots (level 5) extend themselves once per card before asking.
      const lvl = this.levelFor(task)
      if (perksAt(lvl).some((p) => p.kind === "autoextend") && !task.autoExtended) {
        task.autoExtended = true
        task.limits = Object.fromEntries(Object.entries(task.limits).map(([k, v]) => [k, k === hit.kind ? Math.max(v, hit.used) * 1.25 : v]))
        this.tasks.save(task)
        this.sup.store.note(`"${task.title}" reached its ${limitText(hit)} limit — its bot is Trusted (level ${lvl}), so it got 25% more once`, task.assignee, "info")
        continue
      }
      await this.pauseTask(task, hit)
    }
  }

  async pauseTask(task, hit) {
    const s = this.sup.store.get(task.assignee)
    if (s && (s.status === "busy" || s.status === "waiting")) await this.sup.abort(s.id).catch(() => {})
    task.status = "review"
    task.budget = { ...hit, at: Date.now() }
    task.pausedAt = Date.now()
    this.tasks.save(task)
    this.sup.store.note(hit.kind === "loop"
      ? `⏸ @${s?.handle ?? "a bot"} looks stuck on "${task.title}": ${hit.why} — stopped and waiting for you`
      : `⏸ "${task.title}" reached its ${limitText(hit)} limit — stopped @${s?.handle ?? "its bot"} and waiting for you`, s?.id ?? null, "warn")
    this.sup.replay?.note(task.projectId, hit.kind === "loop" ? `@${s?.handle} looked stuck: ${hit.why}` : `"${task.title}" hit its ${hit.kind} limit`, "warn")
  }

  /** Give a paused card more room and let its bot carry on (or stop it for good). */
  async budgetTask(task, { action = "continue", add = null, limits = undefined } = {}) {
    if (!task.budget) throw new Error("this card is not paused on a limit")
    const now = Date.now()
    if (task.budget.kind === "rounds" && action !== "stop") return this.roundsDecision(task, action)
    if (action === "stop") {
      task.status = "cancelled"
      task.budget = { ...task.budget, stopped: true }
      this.tasks.save(task)
      this.sup.store.note(`stopped "${task.title}" at its limit`, task.assignee, "warn")
      if (task.parentId) await this.joinParent(task.parentId)
      this.tasks.unblock()
      await this.dispatch()
      this.checkRunDone(task.runId)
      return task
    }
    if (task.budget.kind === "loop") {
      // Not a limit: nothing to raise. Leave the loop check quiet for a while
      // and tell the bot what it looked like.
      task.loopQuietUntil = now + 10 * 60_000
    } else if (limits !== undefined) {
      const next = cleanLimits(limits)
      const hit = overLimit(next, this.taskUsage({ ...task, pausedAt: null, pausedMs: (task.pausedMs ?? 0) + (task.pausedAt ? now - task.pausedAt : 0) }, now))
      if (hit) throw new Error(`still over the ${limitText(hit)} limit — raise it past what is used`)
      task.limits = next
    } else task.limits = raiseLimits(task.limits, task.budget, add)
    task.pausedMs = (task.pausedMs ?? 0) + (task.pausedAt ? now - task.pausedAt : 0)
    task.pausedAt = null
    const was = task.budget
    task.budget = null
    task.status = "active"
    task.nudgedAt = null
    this.tasks.save(task)
    const s = this.sup.store.get(task.assignee)
    if (s && was.kind === "loop") await this.sup.deliver(s, {
      text: `[botfarm] You were stopped on task ${task.id} — "${task.title}" — because you looked stuck: ${was.why}. The operator says carry on. Try a different approach rather than repeating the same step; check botfarm_notes_read and ask in the chat if you are missing something.`,
      description: `continue ${task.title}`,
    })
    else if (s) await this.sup.deliver(s, {
      text: `[botfarm] You were stopped at this card's ${limitText(was)} limit. The operator gave you more room (${limitsText(task.limits)}). Carry on with task ${task.id} — "${task.title}" — from where you left off, and call botfarm_task_complete when it is done.`,
      description: `continue ${task.title}`,
    })
    return task
  }

  async pauseRun(run, hit) {
    const interrupted = []
    for (const s of this.sup.projects.sessions(run.projectId)) {
      if (s.status !== "busy" && s.status !== "waiting") continue
      await this.sup.abort(s.id).catch(() => {})
      for (const t of this.tasks.all({ assignee: s.id, status: "active" })) interrupted.push(t.id)
    }
    run.paused = { ...hit, at: Date.now(), interrupted }
    this.db.put("runs", run)
    this.sup.store.note(hit.kind === "manual" ? `⏸ workstream paused — ${interrupted.length} bot(s) stopped until you resume it` : `⏸ workstream reached its ${limitText(hit)} limit — every bot on it is stopped until you raise it`, null, "warn")
    this.sup.replay?.note(run.projectId, hit.kind === "manual" ? "paused by you" : `paused at its ${hit.kind} limit`, "warn")
    this.sup.onChange()
  }

  /** Raise (or clear) a workstream's limits and pick up where it stopped — or stop it. */
  async budgetRun(projectId, { action = "continue", limits = undefined } = {}) {
    const project = this.sup.projects.get(projectId)
    const run = project?.runId ? this.run(project.runId) : null
    if (!run) throw new Error("this workstream was not started from a pipeline")
    const now = Date.now()
    if (action === "stop") {
      for (const s of this.sup.projects.sessions(projectId)) if (s.status === "busy") await this.sup.abort(s.id).catch(() => {})
      for (const t of this.tasks.all({ runId: run.id })) if (!["done", "cancelled"].includes(t.status)) this.tasks.update(t.id, { status: "cancelled" })
      run.status = "stopped"
      run.paused = null
      this.db.put("runs", run)
      this.sup.projects.save({ ...project, status: "stopped" })
      this.sup.store.note(`stopped workstream ${project.name}`, null, "warn")
      return run
    }
    if (limits !== undefined) run.limits = cleanLimits(limits)
    const paused = run.paused
    if (paused) {
      // Still over after the change? Say so rather than resume into another stop.
      const hit = overLimit(run.limits, this.runUsage({ ...run, paused: null, pausedMs: (run.pausedMs ?? 0) + (now - paused.at) }, now))
      if (hit) throw new Error(`still over the ${limitText(hit)} limit — raise it past what is used`)
      run.pausedMs = (run.pausedMs ?? 0) + (now - paused.at)
      run.paused = null
    }
    this.db.put("runs", run)
    if (paused) {
      for (const id of paused.interrupted ?? []) {
        const t = this.tasks.get(id)
        const s = t && this.sup.store.get(t.assignee)
        if (t?.status !== "active" || !s) continue
        await this.sup.deliver(s, { text: `[botfarm] The workstream was paused${paused.kind === "manual" ? " by the operator" : ` at its ${limitText(paused)} limit`} and has been resumed. Carry on with task ${t.id} — "${t.title}" — from where you left off.`, description: `resume ${t.title}` }).catch(() => {})
      }
      this.sup.store.note(`resumed workstream ${project.name} (${limitsText(run.limits)})`, null, "info")
      await this.dispatch()
    }
    this.sup.onChange()
    return run
  }

  /** For the dashboard: limits, use and pause state of the workstream behind a project. */
  budgetView(project) {
    const run = project?.runId ? this.run(project.runId) : null
    if (!run) return null
    return { limits: run.limits ?? null, used: this.runUsage(run), paused: run.paused ?? null, status: run.status }
  }

  // --- watchdog --------------------------------------------------------------

  /**
   * A session went idle. If it still holds an active task, it most likely
   * finished its turn without calling botfarm_task_complete — and nothing
   * downstream will ever start. Remind it once; if it stops again, hand the
   * task to the operator instead of letting the run sit there forever.
   */
  idle(session, { delay = 5_000 } = {}) {
    this.idleTimers ??= new Map()
    clearTimeout(this.idleTimers.get(session.id))
    this.idleTimers.set(
      session.id,
      setTimeout(() => {
        this.idleTimers.delete(session.id)
        const fresh = this.sup.store.get(session.id)
        // Busy again: opencode was only between turns.
        if (!fresh || fresh.status !== "idle") return
        this.checkForgotten(fresh).catch((err) => this.sup.store.note(`watchdog: ${err.message}`, session.id, "warn"))
      }, delay),
    )
  }

  async checkForgotten(session, { now = Date.now(), grace = 15_000 } = {}) {
    const open = this.tasks.all({ assignee: session.id, status: "active" }).filter((t) => t.owner !== "human" && !(t.runId && this.run(t.runId)?.paused))
    for (const task of open) {
      if (now - (task.startedAt ?? task.updated) < grace) continue
      // Handed the card but never spent a token: the turn did not run at all
      // (wrong model, provider error). A reminder would fail the same way.
      if (tokensOf(session) === (task.tokensAtStart ?? 0)) {
        if (!task.noRun) {
          task.noRun = true
          this.tasks.save(task)
          this.sup.store.note(`@${session.handle} was handed "${task.title}" but never ran${session.lastError ? `: ${session.lastError}` : " — see the opencode log"}. Fix it, then Restart the workstream.`, session.id, "error")
        }
        continue
      }
      if (!task.nudgedAt) {
        task.nudgedAt = now
        this.tasks.save(task)
        await this.sup.deliver(session, {
          text: [
            `[botfarm] You stopped, but task ${task.id} (${task.title}) is still open.`,
            "",
            "Nothing downstream starts until you hand off. If the work is done, call botfarm_task_complete now with",
            "your summary, acceptance_criteria, artifacts and open_questions. If you are blocked, call",
            "botfarm_task_complete with what you have and put the blocker in open_questions, or use botfarm_ask_human.",
          ].join("\n"),
          description: `reminder: hand off ${task.stage ?? task.title}`,
        })
        this.sup.store.note(`@${session.handle} went idle without handing off "${task.title}" — reminded it`, session.id, "warn")
        continue
      }
      if (task.escalated || now - task.nudgedAt < grace) continue
      task.escalated = true
      task.status = "review"
      this.tasks.save(task)
      this.tasks.create({
        title: `@${session.handle} stopped without finishing "${task.stage ?? task.title}"`.slice(0, 120),
        brief: [
          `@${session.handle} went idle twice with ${task.id} still open, even after a reminder.`,
          session.lastText ? `Its last words: "${session.lastText}"` : "",
          "Your answer is sent to it. Or move the task to done on the board to let the run continue.",
        ].filter(Boolean).join("\n\n"),
        kind: "question",
        owner: "human",
        askedBy: session.id,
        projectId: task.projectId,
        runId: task.runId,
        createdBy: "watchdog",
      })
      this.sup.store.note(`@${session.handle} is stuck on "${task.title}" — it needs you`, session.id, "error")
    }
  }

  // --- export --------------------------------------------------------------

  /** Turn a finished run back into a pipeline definition you can share. */
  exportRun(runId) {
    const run = this.run(runId)
    if (!run) throw new Error("unknown run")
    const def = this.defFor(run)
    const stages = (def?.stages ?? []).map((s) => {
      const task = this.tasks.get(run.taskIds[s.id])
      return {
        ...s,
        notes: task?.handoff?.summary ? `previous run: ${task.handoff.summary.slice(0, 200)}` : undefined,
      }
    })
    return YAML.stringify({
      id: `${run.pipeline}-from-${run.id.slice(-4)}`,
      title: def?.title ?? run.pipeline,
      description: `Exported from run ${run.id}`,
      stages,
    })
  }
}

/** What was said in the chat before this bot's stage started, handed over once. */
function earlier(room, session, when = "before your stage started") {
  if (!room) return ""
  const ids = room.pending.get(session.id) ?? []
  if (!ids.length) return ""
  room.pending.set(session.id, [])
  room.unread?.set(session.id, 0)
  const msgs = room.messages.filter((m) => ids.includes(m.id))
  if (!msgs.length) return ""
  return [
    `\n\nSaid in ${room.name} ${when} (lines marked operator are the human running this; @handles are other agents):`,
    ...msgs.map((m) => `${m.from === "operator" ? "operator" : "@" + m.from}: ${m.text}`),
  ].join("\n")
}

/** Items for a split: strings or { title, detail } objects, from a handoff list. */
function normalizeItems(list) {
  if (!Array.isArray(list)) return []
  return list.map((x) => {
    if (typeof x === "string") return x.trim() ? { title: x.trim().slice(0, 200) } : null
    if (x && typeof x === "object") {
      const title = String(x.title ?? x.name ?? x.summary ?? "").trim()
      const detail = String(x.detail ?? x.description ?? x.details ?? "").trim()
      const diff = ["easy", "normal", "hard"].includes(String(x.difficulty ?? "").toLowerCase()) ? String(x.difficulty).toLowerCase() : null
      return title ? { title: title.slice(0, 200), ...(detail ? { detail: detail.slice(0, 4000) } : {}), ...(diff ? { difficulty: diff } : {}) } : null
    }
    return null
  }).filter(Boolean)
}

const LIMIT_UNITS = { minutes: "time", tokens: "token", usd: "dollar" }
function overLimit(limits, used) {
  if (!limits) return null
  for (const kind of ["usd", "tokens", "minutes"]) {
    if (limits[kind] > 0 && used[kind] >= limits[kind]) return { kind, limit: limits[kind], used: used[kind] }
  }
  return null
}
const fmtLimit = (kind, v) => kind === "usd" ? `$${Number(v).toFixed(2)}` : kind === "tokens" ? `${Math.round(v).toLocaleString("en-US")} tokens` : `${Math.round(v)} min`
const limitText = (hit) => `${LIMIT_UNITS[hit.kind]} (${fmtLimit(hit.kind, hit.limit)})`
const limitsText = (l) => l ? Object.entries(l).map(([k, v]) => fmtLimit(k, v)).join(", ") : "no limits"
/** The limit that was hit goes up by what the operator adds, or by half again. */
function raiseLimits(limits, hit, add) {
  const out = { ...(limits ?? {}) }
  const extra = cleanLimits(add)
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = Math.max(out[k] ?? 0, hit.kind === k ? hit.used : 0) + v
  else if (hit) out[hit.kind] = Math.max(hit.limit, hit.used) * 1.5
  return cleanLimits(out)
}

const clampParallel = (n) => Math.max(1, Math.min(10, Math.round(Number(n) || 1)))

/** { minutes, tokens, usd } with only positive numbers kept, or null. */
export function cleanLimits(l) {
  if (!l || typeof l !== "object") return null
  const out = {}
  for (const k of ["minutes", "tokens", "usd"]) {
    const v = Number(l[k] ?? (k === "usd" ? l.dollars ?? l.cost : undefined))
    if (Number.isFinite(v) && v > 0) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

const tokensOf = (s) => {
  const t = s?.totals ?? {}
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
}

function teamEntry(p, name) {
  if (!p) return null
  return { agent: p.agent ?? null, model: p.model ?? null, variant: p.variant ?? null, tools: p.tools ?? null, title: p.title ?? name }
}

function slugify(s, max = 36) {
  const full = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return (full.length <= max ? full : full.slice(0, max).replace(/-[^-]*$/, "")) || "work"
}

function topicFrom(story) {
  const line = String(story ?? "").split(/\n/).map((l) => l.trim()).find(Boolean) ?? ""
  if (line.length <= 90) return line
  return line.slice(0, 90).replace(/\s+\S*$/, "") + "…"
}

function stageContextFor(def, persona) {
  return (def.stages ?? [])
    .filter((st) => st.persona === persona && st.context)
    .map((st) => st.context)
    .join("\n\n")
}

export function checkPersona(doc) {
  const out = []
  if (!doc.prompt) out.push("no prompt")
  if (doc.tools && !Array.isArray(doc.tools)) out.push("tools should be a list")
  if (doc.tiers && (typeof doc.tiers !== "object" || Object.keys(doc.tiers).some((k) => !["easy", "normal", "hard"].includes(k)))) out.push("tiers has easy, normal and hard, each { model, variant }")
  return out
}

const GENERIC_TASK_PROMPT = `{{story}}

{{#acceptance_criteria}}Acceptance criteria:
{{#acceptance_criteria}}  - {{.}}
{{/acceptance_criteria}}
{{/acceptance_criteria}}
{{#received}}
From {{persona}} ({{stage}}):
{{summary}}
{{#artifacts}}  changed: {{.}}
{{/artifacts}}
{{/received}}`

// Shipped once into ~/.botfarm so there is something to run on day one, and never
// overwritten afterwards — they are yours to edit.
export const DEFAULTS = {
  personas: {
    "product.yaml": `id: product
title: Product Bot
role: product
# A light touch on purpose: this bot polishes criteria, it does not study the
# code. Only read-only tools, and a small budget of them.
tools: [read, grep, glob, list]
# model: anthropic/claude-haiku-4-5   # a smaller model is usually plenty here
prompt: |
  You are the product analyst on this change. Your job is to polish the
  acceptance criteria you are handed into a list a developer can build against
  and a tester can verify. You are not the engineer: understanding the code
  deeply, designing the change and finding edge cases in the implementation
  are the dev's job, not yours.

  Work quickly:
  - Start from the story and any criteria it already has. Keep what is there;
    tighten wording, make each one observable, fill obvious gaps.
  - Look at the code only to get names right (the endpoint, the entity, the
    error type) — a handful of searches at most, no deep reading, no running
    anything. If you catch yourself tracing call chains, stop.
  - "Login works" is not a criterion. "After SSO login the user lands on /home
    and the session cookie is SameSite=Lax" is. Four to eight is usually right.
  - Things you genuinely cannot decide go in open_questions, with choices where
    there are obvious ones. Do not ask what the dev can find out from the code.

  Then call botfarm_task_complete. You do not write production code.
`,
    "dev.yaml": `id: dev
title: Dev Bot
role: dev
prompt: |
  You are the engineer on this change.

  You will be handed acceptance criteria. Build the smallest change that
  satisfies all of them, following the conventions already in the repository.
  If a criterion is ambiguous or wrong, say so in your handoff rather than
  guessing quietly — and ask the product bot in the group chat if it blocks you.

  Commit nothing you have not run.
`,
    "qa.yaml": `id: qa
title: QA Bot
role: qa
prompt: |
  You are the tester on this change.

  You will be handed the criteria and a description of what was built. Verify
  each criterion against the running code, then write automated tests that
  would fail if the behaviour regressed. Tests that pass whether or not the
  feature works are worse than no tests; check that each one fails before the
  fix and passes after.

  Report every criterion you could not verify. Do not fix the code yourself —
  raise a task for the dev bot instead.
may_spawn: false
`,
    "reviewer.yaml": `id: reviewer
title: Double-Check Bot
role: reviewer
prompt: |
  You are the final check.

  You will be handed the original story, the acceptance criteria, what was
  built and what was tested. Your only question is whether the whole chain
  holds together: does the delivered change actually satisfy the criteria, and
  do the criteria actually satisfy the story?

  Be specific about gaps. "Criterion 3 is untested: the test asserts the
  redirect fires but not that the cookie is set" is useful. "Looks good" is
  not. If something is missing, raise a task for whoever should fix it.
`,
  },
  pipelines: {
    "story.yaml": `id: story
title: Story to verified change
description: Product sharpens the story, dev builds it, QA proves it, a reviewer checks the chain.
stages:
  - id: analyse
    persona: product
    title: Polish the acceptance criteria
    receives: []
    prompt: |
      Story:

      {{story}}

      Polish this into acceptance criteria. Keep the criteria it already has,
      sharpen them, add only what is clearly missing. Glance at the code only
      to get names right — the dev does the deep reading. Put the list in
      acceptance_criteria on your handoff; everything downstream is built and
      tested against it.

  - id: build
    persona: dev
    title: Implement the change
    receives: [analyse]
    prompt: |
      Original story:

      {{story}}

      {{#handoffs.analyse}}
      {{persona}} sharpened it into these criteria:
      {{#acceptance_criteria}}  - {{.}}
      {{/acceptance_criteria}}

      Their notes: {{summary}}
      {{#open_questions}}Unresolved: {{.}}
      {{/open_questions}}
      {{/handoffs.analyse}}

      Implement it. {{#room}}You can reach the others in {{room}}.{{/room}}

  - id: verify
    persona: qa
    title: Test the change and automate the proof
    receives: [analyse, build]
    prompt: |
      {{#handoffs.analyse}}
      Acceptance criteria:
      {{#acceptance_criteria}}  - {{.}}
      {{/acceptance_criteria}}
      {{/handoffs.analyse}}

      {{#handoffs.build}}
      What was built, per {{persona}}:
      {{summary}}
      {{#artifacts}}  changed: {{.}}
      {{/artifacts}}
      {{/handoffs.build}}

      Verify each criterion and write the automated tests. List in
      open_questions any criterion you could not verify.

  - id: check
    persona: reviewer
    title: Check the chain end to end
    receives: [analyse, build, verify]
    prompt: |
      Original story:

      {{story}}

      {{#received}}
      --- {{persona}} ({{stage}}) ---
      {{summary}}
      {{#open_questions}}  open: {{.}}
      {{/open_questions}}
      {{/received}}

      Does the delivered change satisfy the criteria, and do the criteria
      satisfy the story? Raise a task for anything that does not hold.

  # A stage with "human: true" is yours: it lands in Needs you rather than
  # being dispatched, and the pipeline waits for your answer.
  - id: signoff
    human: true
    title: Sign off before this ships
    receives: [check]
    prompt: |
      {{#handoffs.check}}{{summary}}{{/handoffs.check}}

      Anything you want changed before this ships?
`,
  },
}

export function checkPipelineDoc(doc, personas) {
  const out = []
  const stages = doc.stages ?? []
  if (!stages.length) out.push("no stages")
  const ids = stages.map((s) => s.id)
  for (const s of stages) {
    if (!s.id) out.push("a stage has no id")
    if (!s.persona && !s.human) out.push(`stage ${s.id}: no persona (or mark it human: true)`)
    if (s.persona && !s.human && !personas.has(s.persona)) out.push(`stage ${s.id}: no persona called "${s.persona}"`)
    for (const r of s.receives ?? []) {
      if (!ids.includes(r)) out.push(`stage ${s.id} receives "${r}", which is not a stage in this pipeline`)
    }
    const before = ids.slice(0, ids.indexOf(s.id))
    if (s.after !== undefined && !Array.isArray(s.after)) out.push(`stage ${s.id}: after must be a list of earlier stage ids`)
    for (const a of Array.isArray(s.after) ? s.after : []) {
      if (!before.includes(a)) out.push(`stage ${s.id} is after "${a}", which is not an earlier stage`)
    }
    if (s.split && s.human) out.push(`stage ${s.id}: a human stage cannot be split`)
    if (s.difficulty !== undefined && !["easy", "normal", "hard"].includes(s.difficulty)) out.push(`stage ${s.id}: difficulty must be easy, normal or hard`)
    if (s.max_rounds !== undefined && !(Number.isInteger(s.max_rounds) && s.max_rounds >= 0 && s.max_rounds <= 20)) out.push(`stage ${s.id}: max_rounds is a whole number from 0 (never send back) to 20`)
    if (s.send_back !== undefined && s.send_back !== false) {
      const list = Array.isArray(s.send_back) ? s.send_back : null
      if (!list) out.push(`stage ${s.id}: send_back is a list of earlier stage ids, or false`)
      for (const a of list ?? []) if (!before.includes(a)) out.push(`stage ${s.id} can send back to "${a}", which is not an earlier stage`)
    }
    if (s.split && typeof s.split === "string" && s.split.includes(".") && !before.includes(s.split.split(".")[0])) out.push(`stage ${s.id} splits on "${s.split}", but ${s.split.split(".")[0]} is not an earlier stage`)
    if (s.parallel !== undefined && !(Number(s.parallel) >= 1 && Number(s.parallel) <= 10)) out.push(`stage ${s.id}: parallel must be 1–10`)
    if (s.limits !== undefined && (typeof s.limits !== "object" || !cleanLimits(s.limits))) out.push(`stage ${s.id}: limits needs minutes, tokens and/or usd as positive numbers`)
    // A prompt referring to a handoff it does not receive renders empty and
    // the bot silently works with less context than the author intended.
    for (const v of variables(s.prompt ?? "")) {
      if (v === "handoffs" && !(s.receives ?? []).length) out.push(`stage ${s.id}: prompt uses handoffs but receives nothing`)
    }
  }
  return out
}
