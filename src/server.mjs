import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { basename, dirname, join } from "node:path"
import * as git from "./git.mjs"
import { createMcpHandler } from "./mcp.mjs"
import { avatarFor } from "./identity.mjs"
import { isWebSocketUpgrade, accept } from "./ws.mjs"
import { listDirs } from "./workspaces.mjs"
import { cleanLimits } from "./pipelines.mjs"

const here = dirname(fileURLToPath(import.meta.url))

export function startServer({ supervisor, port = 4777, host = "127.0.0.1", repos = [] }) {
  const clients = new Set() // SSE responses
  const sockets = new Set() // websocket connections
  const mcp = createMcpHandler({ mesh: supervisor.mesh, supervisor })
  let pending = null

  const push = (conn) => {
    const json = JSON.stringify(supervisor.store.snapshot())
    if (conn) return conn.send(json)
    for (const c of sockets) c.send(json)
    const frame = `data: ${json}\n\n`
    for (const res of clients) res.write(frame)
  }

  const broadcast = () => {
    if (pending || (clients.size === 0 && sockets.size === 0)) return
    pending = setTimeout(() => {
      pending = null
      push()
    }, 200)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname
    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        const html = await readFile(join(here, "public", "index.html"))
        return send(res, 200, html, "text/html; charset=utf-8")
      }
      // The previous dashboard, kept for the things the new one leaves out.
      if (req.method === "GET" && path === "/classic") {
        const html = await readFile(join(here, "public", "classic.html"))
        return send(res, 200, html, "text/html; charset=utf-8")
      }

      // --- workspaces: a folder, its agents and pipelines -----------------
      if (path === "/api/pricing" && req.method === "GET") return json(res, 200, supervisor.pricingView())
      if (path === "/api/pricing" && req.method === "PUT") {
        const body = await readJson(req)
        const out = await supervisor.setPrice(body.model, body)
        broadcast()
        return json(res, 200, out)
      }
      if (req.method === "GET" && path === "/api/fs") {
        return json(res, 200, await listDirs(url.searchParams.get("path") ?? "~"))
      }
      if (path === "/api/workspaces" && req.method === "GET") {
        return json(res, 200, supervisor.workspaces.list())
      }
      if (path === "/api/workspaces" && req.method === "POST") {
        const body = await readJson(req)
        const ws = await supervisor.workspaces.add({ path: body.path, name: body.name })
        broadcast()
        return json(res, 201, ws)
      }
      // The workspace's own tools (botfarm/mcps/*.js) and their test bench.
      const toolsPath = /^\/api\/workspaces\/([^/]+)\/tools(?:\/([^/]+)(?:\/(run|source))?)?$/.exec(path)
      if (toolsPath) {
        const ws = supervisor.workspaces.get(decodeURIComponent(toolsPath[1]))
        if (!ws) return json(res, 404, { error: "unknown workspace" })
        const item = toolsPath[2] ? decodeURIComponent(toolsPath[2]) : null
        const op = toolsPath[3]
        try {
          if (!item && req.method === "GET") { await supervisor.wsTools.load(ws); return json(res, 200, supervisor.wsTools.list(ws.id)) }
          if (!item && req.method === "POST") { const body = await readJson(req); const out = await supervisor.wsTools.create(ws, body.name); broadcast(); return json(res, 201, out) }
          if (item && op === "run" && req.method === "POST") {
            const body = await readJson(req).catch(() => ({}))
            // Run where a bot would: a workstream's worktree, or the workspace itself.
            const dir = body.directory && (body.directory === ws.path || supervisor.store.list().some((s) => s.directory === body.directory) || supervisor.projects.list().some((p) => p.worktree === body.directory)) ? body.directory : ws.path
            const out = await supervisor.wsTools.run(ws.id, item, body.args ?? {}, { repoRoot: dir, workspace: { id: ws.id, name: ws.name, path: ws.path }, bot: null })
            return json(res, 200, { ...out, directory: dir })
          }
          if (item && op === "source" && req.method === "GET") return json(res, 200, await supervisor.wsTools.source(ws, item))
          if (item && op === "source" && req.method === "PUT") { const body = await readJson(req); const out = await supervisor.wsTools.save(ws, item, body.text); broadcast(); return json(res, 200, out) }
          if (item && !op && req.method === "DELETE") { const out = await supervisor.wsTools.remove(ws, item); broadcast(); return json(res, 200, out) }
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }
      const wsPath = /^\/api\/workspaces\/([^/]+)(?:\/(library|workstreams|agents|pipelines|file|repos)(?:\/([^/]+))?)?$/.exec(path)
      if (wsPath) {
        const id = decodeURIComponent(wsPath[1])
        const ws = supervisor.workspaces.get(id)
        if (!ws) return json(res, 404, { error: "unknown workspace" })
        const [, , sub, rest] = wsPath
        const entry = rest ? decodeURIComponent(rest) : null
        if (!sub && req.method === "GET") return json(res, 200, ws)
        if (!sub && req.method === "POST") {
          const body = await readJson(req)
          return json(res, 200, supervisor.workspaces.update(id, { name: body.name ?? ws.name, services: body.services ?? ws.services }))
        }
        if (!sub && req.method === "DELETE") {
          supervisor.workspaces.remove(id)
          broadcast()
          return json(res, 200, { ok: true })
        }
        if (sub === "library" && req.method === "GET") {
          const [lib, where] = await Promise.all([supervisor.workspaces.summary(id), git.inspect(ws.path)])
          return json(res, 200, { ...lib, nested: where.nested ?? [], linked: ws.linked ?? [], branch: where.branch ?? null })
        }
        // Repos from outside the workspace its workstreams take along.
        if (sub === "repos" && req.method === "POST") {
          const body = await readJson(req)
          try {
            const out = await supervisor.workspaces.addLinked(id, { path: body.path, as: body.as || null })
            // And, if asked, into the workstreams already running here.
            const added = []
            if (body.running) {
              const l = out.linked.at(-1)
              for (const p of supervisor.projects.list().filter((p) => p.workspaceId === id && p.status === "running" && p.worktree)) {
                added.push(await supervisor.addRepoToWorkstream(p.id, l.as === basename(l.path) ? l.path : l).then((r) => ({ project: p.id, ...r }), (e) => ({ project: p.id, error: e.message })))
              }
            }
            broadcast()
            return json(res, 200, { ...out, added })
          } catch (err) {
            return json(res, 400, { error: err.message })
          }
        }
        if (sub === "repos" && req.method === "DELETE") {
          const out = supervisor.workspaces.removeLinked(id, url.searchParams.get("path"))
          broadcast()
          return json(res, 200, out)
        }
        if ((sub === "agents" || sub === "pipelines") && entry && (req.method === "PUT" || req.method === "DELETE")) {
          const body = req.method === "PUT" ? await readJson(req) : null
          const out = await supervisor.workspaces.saveEntry(id, sub, entry, body ? body.doc : null)
          broadcast()
          return json(res, 200, out)
        }
        // One definition's file: /file/agents?entry=dev, /file/pipelines?entry=story
        if (sub === "file" && entry && req.method === "GET") return json(res, 200, await supervisor.workspaces.readRaw(id, entry, url.searchParams.get("entry")))
        if (sub === "file" && entry && req.method === "PUT") {
          const body = await readJson(req)
          const out = await supervisor.workspaces.writeRaw(id, entry, body.text ?? "", url.searchParams.get("entry") ?? body.entry)
          broadcast()
          return json(res, 200, out)
        }
        if (sub === "workstreams" && req.method === "POST") {
          const body = await readJson(req)
          const run = await supervisor.pipelines.start({ ...body, workspace: id })
          broadcast()
          return json(res, 201, run)
        }
      }
      const restart = /^\/api\/projects\/([^/]+)\/restart$/.exec(path)
      if (req.method === "POST" && restart) {
        const body = await readJson(req).catch(() => ({}))
        const out = await supervisor.pipelines.restart(decodeURIComponent(restart[1]), { stage: body.stage ?? null, fresh: body.fresh !== false })
        broadcast()
        return json(res, 200, out)
      }
      const bots = /^\/api\/projects\/([^/]+)\/bots$/.exec(path)
      if (req.method === "POST" && bots) {
        const body = await readJson(req)
        const s = await supervisor.pipelines.addBot(decodeURIComponent(bots[1]), body.agent)
        broadcast()
        return json(res, 201, s)
      }
      const archive = /^\/api\/projects\/([^/]+)\/archive$/.exec(path)
      if (req.method === "POST" && archive) {
        const body = await readJson(req).catch(() => ({}))
        await supervisor.archive(decodeURIComponent(archive[1]), body)
        broadcast()
        return json(res, 200, { ok: true })
      }

      const botSettings = /^\/api\/sessions\/([^/]+)\/(settings|models)$/.exec(path)
      if (botSettings) {
        const id = decodeURIComponent(botSettings[1])
        try {
          if (botSettings[2] === "models" && req.method === "GET") return json(res, 200, await supervisor.modelsFor(id))
          if (botSettings[2] === "settings" && req.method === "POST") {
            const out = await supervisor.setBotSettings(id, await readJson(req).catch(() => ({})))
            broadcast()
            return json(res, 200, out)
          }
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }
      const reconnect = /^\/api\/sessions\/([^/]+)\/mcp\/reconnect$/.exec(path)
      if (req.method === "POST" && reconnect) {
        const s = supervisor.store.get(decodeURIComponent(reconnect[1]))
        if (!s) return json(res, 404, { error: "unknown session" })
        await supervisor.refreshMcp(supervisor.store.list().filter((x) => x.directory === s.directory), { force: true })
        broadcast()
        return json(res, 200, s.mcp ?? {})
      }

      // PR packet: GET builds and saves it, POST pushes the branch and opens the PR with gh.
      const pr = /^\/api\/projects\/([^/]+)\/pr$/.exec(path)
      if (pr) {
        try {
          if (req.method === "GET") return json(res, 200, await supervisor.writePacket(decodeURIComponent(pr[1])))
          if (req.method === "POST") { const out = await supervisor.openPr(decodeURIComponent(pr[1])); broadcast(); return json(res, 200, out) }
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }
      // Replays: export a workstream as one file; import, list and open saved ones.
      const rexport = /^\/api\/projects\/([^/]+)\/replay$/.exec(path)
      if (rexport && req.method === "GET") {
        try {
          const doc = await supervisor.exportReplay(decodeURIComponent(rexport[1]))
          const name = `${String(doc.project.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.botfarm-replay.json`
          const buf = Buffer.from(JSON.stringify(doc))
          res.writeHead(200, { "content-type": "application/json", "content-length": buf.length, ...(url.searchParams.get("download") ? { "content-disposition": `attachment; filename="${name}"` } : {}) })
          return res.end(buf)
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }
      const replays = /^\/api\/replays(?:\/([^/]+))?$/.exec(path)
      if (replays) {
        try {
          if (!replays[1] && req.method === "GET") return json(res, 200, await supervisor.shelf.list())
          if (!replays[1] && req.method === "POST") return json(res, 201, { id: await supervisor.importReplay(await readJson(req)) })
          if (replays[1] && req.method === "GET") return json(res, 200, await supervisor.shelf.get(decodeURIComponent(replays[1])))
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }
      // Model routing by difficulty (botfarm/routing.botfarm.yml) and the models to pick from.
      const routing = /^\/api\/workspaces\/([^/]+)\/(routing|models)$/.exec(path)
      if (routing) {
        const wsId = decodeURIComponent(routing[1])
        try {
          if (routing[2] === "models" && req.method === "GET") return json(res, 200, await supervisor.workspaceModels(wsId))
          if (routing[2] === "routing" && req.method === "GET") return json(res, 200, await supervisor.routingView(wsId))
          if (routing[2] === "routing" && req.method === "PUT") { const out = await supervisor.workspaces.saveRouting(wsId, await readJson(req)); broadcast(); return json(res, 200, out) }
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }
      const harvest = /^\/api\/workspaces\/([^/]+)\/harvest$/.exec(path)
      if (harvest && req.method === "GET") {
        const wsId = decodeURIComponent(harvest[1])
        return json(res, 200, { ...supervisor.farmhands.totals(wsId), levels: supervisor.farmhands.all(wsId) })
      }

      // Pause / resume a whole workstream by hand.
      const pr2 = /^\/api\/projects\/([^/]+)\/(pause|resume)$/.exec(path)
      if (pr2 && req.method === "POST") {
        try {
          const pid = decodeURIComponent(pr2[1])
          const run = pr2[2] === "pause" ? await supervisor.pipelines.pauseByHand(pid) : await supervisor.pipelines.budgetRun(pid, { action: "continue" })
          broadcast()
          return json(res, 200, { paused: run.paused ?? null, status: run.status })
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }
      // A finished card's report (diffs as they were when it finished) and its screenshots.
      const rep = /^\/api\/tasks\/([^/]+)\/(report|image)(?:\/(\d+))?$/.exec(path)
      if (rep && req.method === "GET") {
        const task = supervisor.tasks.get(decodeURIComponent(rep[1]))
        if (!task?.report) return json(res, 404, { error: "no report for that card" })
        if (rep[2] === "report") return json(res, 200, { ...task.report, title: task.title, stage: task.stage ?? null, summary: task.handoff?.summary ?? "" })
        const im = task.report.images?.[Number(rep[3] ?? 0)]
        if (!im) return json(res, 404, { error: "no such image" })
        try {
          let file
          if (im.task) {
            const sub = supervisor.tasks.get(im.task)?.report?.images?.[im.n]
            if (!sub) return json(res, 404, { error: "no such image" })
            Object.assign(im, sub)
          }
          if (im.source === "shot") file = join(supervisor.home, "shots", im.file.replace(/[^\w.-]/g, ""))
          else {
            const dir = supervisor.store.get(task.assignee)?.directory ?? supervisor.projects.get(task.projectId)?.worktree
            const full = join(dir, im.path)
            if (!dir || !full.startsWith(dir + "/")) return json(res, 400, { error: "outside the worktree" })
            file = full
          }
          const buf = await readFile(file)
          const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[file.split(".").pop().toLowerCase()] ?? "application/octet-stream"
          res.writeHead(200, { "content-type": type, "content-length": buf.length, "cache-control": "max-age=3600" })
          return res.end(buf)
        } catch (err) {
          return json(res, 404, { error: err.message })
        }
      }

      const pbudget = /^\/api\/projects\/([^/]+)\/budget$/.exec(path)
      if (req.method === "POST" && pbudget) {
        const body = await readJson(req).catch(() => ({}))
        try {
          const run = await supervisor.pipelines.budgetRun(decodeURIComponent(pbudget[1]), body)
          broadcast()
          return json(res, 200, { limits: run.limits, paused: run.paused, status: run.status })
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }
      const tbudget = /^\/api\/tasks\/([^/]+)\/budget$/.exec(path)
      if (req.method === "POST" && tbudget) {
        const body = await readJson(req).catch(() => ({}))
        const task = supervisor.tasks.get(decodeURIComponent(tbudget[1]))
        if (!task) return json(res, 404, { error: "unknown task" })
        try {
          const out = body.limits !== undefined && !body.action
            ? supervisor.tasks.update(task.id, { limits: cleanLimits(body.limits) })
            : await supervisor.pipelines.budgetTask(task, body)
          broadcast()
          return json(res, 200, out)
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }

      const ppatch = /^\/api\/projects\/([^/]+)\/patches(?:\/(apply|undo|file))?$/.exec(path)
      if (ppatch) {
        const pid = decodeURIComponent(ppatch[1])
        try {
          if (!ppatch[2] && req.method === "GET") return json(res, 200, await supervisor.previewPatches(pid))
          if (ppatch[2] === "file" && req.method === "GET") {
            // One repo's patch, to download.
            const view = await supervisor.previewPatches(pid)
            const r = view.repos.find((x) => x.rel === (url.searchParams.get("rel") ?? ""))
            if (!r?.file) return json(res, 404, { error: "no patch for that repo" })
            const { readFile } = await import("node:fs/promises")
            const body = await readFile(r.file)
            res.writeHead(200, { "content-type": "text/x-diff; charset=utf-8", "content-disposition": `attachment; filename="${r.file.split("/").pop()}"` })
            return res.end(body)
          }
          if (ppatch[2] === "apply" && req.method === "POST") {
            const body = await readJson(req).catch(() => ({}))
            const out = await supervisor.applyPatches(pid, { repos: Array.isArray(body.repos) ? body.repos : null })
            broadcast()
            return json(res, 200, out)
          }
          if (ppatch[2] === "undo" && req.method === "POST") {
            const out = await supervisor.undoPatches(pid)
            broadcast()
            return json(res, 200, out)
          }
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }

      const prepos = /^\/api\/projects\/([^/]+)\/repos$/.exec(path)
      if (req.method === "POST" && prepos) {
        const body = await readJson(req).catch(() => ({}))
        try {
          const entry = body.as ? { path: body.path, as: body.as } : body.path
          const out = await supervisor.addRepoToWorkstream(decodeURIComponent(prepos[1]), entry)
          broadcast()
          return json(res, 200, out)
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }

      const sback = /^\/api\/tasks\/([^/]+)\/send-back$/.exec(path)
      if (req.method === "POST" && sback) {
        const body = await readJson(req).catch(() => ({}))
        const task = supervisor.tasks.get(decodeURIComponent(sback[1]))
        if (!task) return json(res, 404, { error: "unknown task" })
        try {
          // From the board: the operator sends a finished card back to its bot.
          const out = await supervisor.pipelines.sendBack(null, { to: task.id, reason: body.reason, failures: body.failures ?? [], files: body.files ?? [] })
          broadcast()
          return json(res, 200, out)
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }

      const sync = /^\/api\/projects\/([^/]+)\/refresh-config$/.exec(path)
      if (req.method === "POST" && sync) {
        try {
          const out = await supervisor.syncWorkstreamConfig(decodeURIComponent(sync[1]), { reason: "refresh requested" })
          broadcast()
          return json(res, 200, out)
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message })
        }
      }

      const del = /^\/api\/projects\/([^/]+)\/delete$/.exec(path)
      if (del && req.method === "GET") {
        const out = await supervisor.deletePreview(decodeURIComponent(del[1]))
        return out ? json(res, 200, out) : json(res, 404, { error: "unknown workstream" })
      }
      if (del && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}))
        try {
          const out = await supervisor.deleteWorkstream(decodeURIComponent(del[1]), body)
          broadcast()
          return json(res, 200, out)
        } catch (err) {
          return json(res, err.status ?? 400, { error: err.message, code: err.code })
        }
      }

      const mcpPath = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(path)
      if (mcpPath) return mcp(req, res, mcpPath[1])

      if (req.method === "GET" && /^\/avatar\/[^/]+\.svg$/.test(path)) {
        const id = decodeURIComponent(path.slice(8, -4))
        const handle = url.searchParams.get("h") || supervisor.store.get(id)?.handle || null
        return send(res, 200, avatarFor(id, { size: 128, handle }), "image/svg+xml")
      }

      if (req.method === "GET" && path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        res.write(`data: ${JSON.stringify(supervisor.store.snapshot())}\n\n`)
        clients.add(res)
        const beat = setInterval(() => res.write(": ping\n\n"), 20000)
        req.on("close", () => { clients.delete(res); clearInterval(beat) })
        return
      }

      if (req.method === "GET" && path === "/api/state") {
        return json(res, 200, supervisor.store.snapshot())
      }

      if (req.method === "GET" && path === "/api/repos") {
        const out = []
        for (const repo of repos) {
          const root = await git.repoRoot(repo)
          if (!root) continue
          out.push({ path: root, worktrees: await git.listWorktrees(root).catch(() => []) })
        }
        return json(res, 200, out)
      }

      const raw = /^\/api\/sessions\/([^/]+)\/raw$/.exec(path)
      if (req.method === "GET" && raw) {
        return json(res, 200, await supervisor.raw(decodeURIComponent(raw[1]), Number(url.searchParams.get("limit") ?? 3)))
      }
      if (req.method === "GET" && path === "/api/debug/events") {
        return json(res, 200, supervisor.recentEvents ?? [])
      }

      const detail = /^\/api\/sessions\/([^/]+)$/.exec(path)
      if (req.method === "GET" && detail) {
        const d = await supervisor.detail(decodeURIComponent(detail[1]))
        return d ? json(res, 200, d) : json(res, 404, { error: "unknown session" })
      }

      if (req.method === "POST" && path === "/api/sessions") {
        const body = await readJson(req)
        const s = await supervisor.spawn(body)
        return json(res, 201, s)
      }

      if (req.method === "GET" && path === "/api/repo") {
        return json(res, 200, await git.inspect(url.searchParams.get("path") ?? ""))
      }

      // --- pipelines and tasks --------------------------------------------
      if (req.method === "GET" && path === "/api/pipelines") {
        return json(res, 200, supervisor.pipelines.list())
      }
      const defPath = /^\/api\/(pipelines|personas)\/([^/]+)$/.exec(path)
      if (defPath && (req.method === "GET" || req.method === "PUT" || req.method === "DELETE")) {
        const kind = defPath[1]
        const id = decodeURIComponent(defPath[2])
        if (req.method === "GET") {
          const doc = supervisor.pipelines.definition(kind, id)
          return doc ? json(res, 200, doc) : json(res, 404, { error: "not found" })
        }
        if (req.method === "PUT") {
          const body = await readJson(req)
          const saved = await supervisor.pipelines.saveDefinition(kind, id, body)
          broadcast()
          return json(res, saved.problems?.length ? 200 : 200, saved)
        }
        await supervisor.pipelines.deleteDefinition(kind, id)
        broadcast()
        return json(res, 200, { ok: true })
      }
      if (req.method === "POST" && path === "/api/pipelines/reload") {
        return json(res, 200, await supervisor.pipelines.load())
      }
      if (req.method === "POST" && path === "/api/runs") {
        const body = await readJson(req)
        const run = await supervisor.pipelines.start(body)
        broadcast()
        return json(res, 201, run)
      }
      const runExport = /^\/api\/runs\/([^/]+)\/export$/.exec(path)
      if (req.method === "GET" && runExport) {
        return send(res, 200, supervisor.pipelines.exportRun(decodeURIComponent(runExport[1])), "text/yaml; charset=utf-8")
      }
      if (req.method === "POST" && path === "/api/tasks") {
        const body = await readJson(req)
        const task = supervisor.tasks.create({ ...body, createdBy: "operator" })
        await supervisor.pipelines.dispatch()
        broadcast()
        return json(res, 201, task)
      }
      const taskPath = /^\/api\/tasks\/([^/]+)(\/(diff|note|answer|continue))?$/.exec(path)
      if (taskPath) {
        const id = decodeURIComponent(taskPath[1])
        const task = supervisor.tasks.get(id)
        if (!task) return json(res, 404, { error: "unknown task" })
        if (req.method === "GET" && taskPath[3] === "diff") {
          const run = task.runId ? supervisor.pipelines.run(task.runId) : null
          const dir = supervisor.store.get(task.assignee)?.directory ?? run?.repo
          const file = url.searchParams.get("file")
          return json(res, 200, { files: await git.changedFiles(dir), diff: file ? await git.diffFile(dir, file) : null, dir })
        }
        if (req.method === "GET") return json(res, 200, task)
        if (req.method === "POST" && taskPath[3] === "answer") {
          const body = await readJson(req)
          const answered = await supervisor.answer(id, body.answer, body.answers ?? null)
          broadcast()
          return json(res, 200, answered)
        }
        if (req.method === "POST" && taskPath[3] === "continue") {
          const body = await readJson(req)
          const out = await supervisor.pipelines.release(task, body.note, body.answers ?? null)
          broadcast()
          return json(res, 200, out)
        }
        if (req.method === "POST" && taskPath[3] === "note") {
          const body = await readJson(req)
          return json(res, 200, supervisor.tasks.note(id, body.note))
        }
        if (req.method === "POST") {
          const body = await readJson(req)
          const updated = supervisor.tasks.update(id, body)
          supervisor.tasks.unblock()
          await supervisor.pipelines.dispatch()
          broadcast()
          return json(res, 200, updated)
        }
        if (req.method === "DELETE") {
          supervisor.tasks.remove(id)
          broadcast()
          return json(res, 200, { ok: true })
        }
      }

      // --- registry ------------------------------------------------------
      if (req.method === "GET" && path === "/api/unmanaged") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase()
        const rows = supervisor.unmanaged.filter(
          (s) => !q || `${s.title} ${s.directory ?? ""}`.toLowerCase().includes(q),
        )
        return json(res, 200, { sessions: rows.slice(0, 80), total: supervisor.unmanaged.length })
      }
      if (req.method === "POST" && path === "/api/adopt") {
        const body = await readJson(req)
        await supervisor.adopt(body.ids ?? [], { project: body.project ?? body.group ?? "default" })
        broadcast()
        return json(res, 200, { ok: true })
      }
      // --- projects --------------------------------------------------------
      if (req.method === "POST" && path === "/api/projects") {
        const body = await readJson(req)
        const project = supervisor.projects.create(body)
        if (body.sessions?.length) for (const id of body.sessions) supervisor.projects.attach(id, project.id)
        await supervisor.registry.save()
        broadcast()
        return json(res, 201, project)
      }
      const projectPath = /^\/api\/projects\/([^/]+)(\/(chat|board))?$/.exec(path)
      if (projectPath) {
        const id = decodeURIComponent(projectPath[1])
        if (req.method === "GET") {
          const project = supervisor.projects.get(id)
          if (!project) return json(res, 404, { error: "unknown project" })
          return json(res, 200, {
            ...project,
            sessions: supervisor.projects.sessions(id).map((s) => s.snapshot()),
            tasks: supervisor.projects.tasks(id),
          })
        }
        if (req.method === "POST" && projectPath[3] === "chat") {
          const body = await readJson(req)
          const room = supervisor.projects.room(id)
          await supervisor.rooms.post(room, null, body.message)
          broadcast()
          return json(res, 200, { ok: true, roomId: room.id })
        }
        if (req.method === "DELETE") {
          supervisor.projects.remove(id)
          await supervisor.registry.save()
          broadcast()
          return json(res, 200, { ok: true })
        }
      }

      const meta = /^\/api\/sessions\/([^/]+)\/(group|release|tools|mcp)$/.exec(path)
      if (req.method === "POST" && meta) {
        const id = decodeURIComponent(meta[1])
        const session = supervisor.store.get(id)
        const body = await readJson(req).catch(() => ({}))
        if (meta[2] === "group") await supervisor.setProject(id, body.project ?? body.group)
        if (meta[2] === "release") await supervisor.release(id)
        if (meta[2] === "tools") {
          if (!session) return json(res, 404, { error: "unknown session" })
          await supervisor.setTool(session, body.name, body.enabled)
        }
        if (meta[2] === "mcp") {
          if (!session) return json(res, 404, { error: "unknown session" })
          await supervisor.setMcp(session, body.name, body.connected)
        }
        broadcast()
        return json(res, 200, { ok: true })
      }

      // --- rooms ---------------------------------------------------------
      if (path === "/api/rooms" && req.method === "POST") {
        const body = await readJson(req)
        const members = (body.members ?? []).map((id) => supervisor.store.get(id)).filter(Boolean)
        const room = supervisor.rooms.create({ name: body.name, topic: body.topic, members, mode: body.mode })
        return json(res, 201, { id: room.id, name: room.name })
      }

      const room = /^\/api\/rooms\/([^/]+)\/(post|members|mute)$/.exec(path)
      if (req.method === "POST" && room) {
        const target = supervisor.rooms.find(decodeURIComponent(room[1]))
        if (!target) return json(res, 404, { error: "unknown room" })
        const body = await readJson(req)
        if (room[2] === "post") await supervisor.rooms.post(target, null, body.message)
        if (room[2] === "mute") supervisor.rooms.setMuted(target, !!body.muted)
        if (room[2] === "members") {
          const s = supervisor.store.get(body.sessionId)
          if (!s) return json(res, 404, { error: "unknown session" })
          if (body.remove) supervisor.rooms.leave(target, s)
          else {
            if (s.policy.rooms === "off") await supervisor.setPolicy(s.id, { rooms: "member" })
            supervisor.rooms.join(target, s)
          }
        }
        broadcast()
        return json(res, 200, { ok: true })
      }

      if (req.method === "DELETE" && /^\/api\/rooms\/[^/]+$/.test(path)) {
        const target = supervisor.rooms.find(decodeURIComponent(path.slice(11)))
        if (target) supervisor.rooms.rooms.delete(target.id)
        broadcast()
        return json(res, 200, { ok: true })
      }

      if (req.method === "POST" && path === "/api/channels/resume") {
        const body = await readJson(req)
        supervisor.resumeChannel(body.a, body.b)
        return json(res, 200, { ok: true })
      }

      const policy = /^\/api\/sessions\/([^/]+)\/policy$/.exec(path)
      if (req.method === "POST" && policy) {
        const body = await readJson(req)
        const out = await supervisor.setPolicy(decodeURIComponent(policy[1]), body)
        return json(res, 200, out)
      }

      const action = /^\/api\/sessions\/([^/]+)\/(abort|send|compact|permission|question)$/.exec(path)
      if (req.method === "POST" && action) {
        const id = decodeURIComponent(action[1])
        const body = await readJson(req).catch(() => ({}))
        if (action[2] === "abort") await supervisor.abort(id)
        if (action[2] === "send") {
          if (!body.text?.trim()) return json(res, 400, { error: "text is required" })
          await supervisor.send(id, body.text.trim())
        }
        if (action[2] === "compact") await supervisor.client.compact(id)
        if (action[2] === "permission") {
          await supervisor.client.replyPermission(id, body.requestId, body.decision ?? "once")
          const s = supervisor.store.get(id)
          if (s) { s.permissionList = (s.permissionList ?? []).filter((p) => p.id !== body.requestId); s.pendingPermissions = s.permissionList.length; if (!s.pendingPermissions && !(s.questionList ?? []).length) s.setStatus("busy") }
          supervisor.store.note(`${body.decision === "reject" ? "denied" : "allowed"} @${s?.handle ?? "bot"} ${body.decision === "always" ? "(always) " : ""}${body.what ?? ""}`.trim(), id)
          supervisor.dirty.add(id)
        }
        if (action[2] === "question") {
          if (body.reject) await supervisor.client.rejectQuestion(id, body.requestId)
          else await supervisor.client.replyQuestion(id, body.requestId, body.answers ?? [])
          const s = supervisor.store.get(id)
          if (s) { s.questionList = (s.questionList ?? []).filter((q) => q.id !== body.requestId); if (!(s.permissionList ?? []).length && !s.questionList.length) s.setStatus("busy") }
          supervisor.dirty.add(id)
        }
        broadcast()
        return json(res, 200, { ok: true })
      }

      if (req.method === "DELETE" && detail) {
        await supervisor.remove(decodeURIComponent(detail[1]), {
          worktree: url.searchParams.get("worktree") === "1",
          force: url.searchParams.get("force") === "1",
        })
        return json(res, 200, { ok: true })
      }

      json(res, 404, { error: "not found" })
    } catch (err) {
      json(res, 500, { error: err.message })
    }
  })

  // Websocket clients come in through the upgrade handshake rather than a route.
  server.on("upgrade", (req, socket) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`)
    if (pathname !== "/api/socket" || !isWebSocketUpgrade(req)) return socket.destroy()
    const conn = accept(req, socket, {
      onMessage: (text, c) => {
        if (text === "resync") return push(c)
        // "watch:<id>" / "unwatch:<id>": live transcript for an open session.
        const m = /^(watch|unwatch):(.+)$/.exec(text)
        if (!m) return
        c.watch ??= new Set()
        if (m[1] === "watch") {
          c.watch.add(m[2])
          supervisor.watchStarted(m[2]).catch(() => {})
        } else c.watch.delete(m[2])
      },
      onClose: (c) => sockets.delete(c),
    })
    sockets.add(conn)
    push(conn)
  })

  supervisor.onChange = broadcast
  // Live frames go only to the sockets looking at that session, unbatched:
  // the point is to see the text as it is written.
  supervisor.isWatched = (id) => {
    for (const c of sockets) if (c.watch?.has(id)) return true
    return false
  }
  supervisor.live = (id, frame) => {
    const text = JSON.stringify(frame)
    for (const c of sockets) if (c.watch?.has(id)) c.send(text)
  }
  server.listen(port, host)
  return { server, url: `http://${host}:${port}`, broadcast, sockets, clients }
}

function send(res, status, body, type) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  res.end(body)
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json")
}
async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
