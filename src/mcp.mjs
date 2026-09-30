// botfarm's MCP server, mounted at /mcp/<token>.
//
// Transport is streamable HTTP with plain JSON responses (no session ids, no
// SSE upstream) — every call is short, so there is nothing to stream.
//
// The token in the path is the whole authentication story: botfarm registers a
// distinct URL per session location, so a tool call arrives already bound to
// one caller. Agents never name themselves; they cannot impersonate a peer.

import { normalizeQuestions, QUESTION_SCHEMA } from "./questions.mjs"
import { MeshError } from "./mesh.mjs"
import { RoomError } from "./rooms.mjs"
import { TaskError } from "./tasks.mjs"
import { avatarDataUri } from "./identity.mjs"
import { toolResult } from "./tools.mjs"

const PROTOCOL = "2025-06-18"

const TOOLS = [
  {
    name: "whoami",
    description:
      "Your identity in this mesh of sessions: your handle, the worktree you are in, and what you are currently permitted to do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "roster",
    description:
      "List the other sessions you can reach, with what each is working on. Sessions the operator has not enabled are not listed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send",
    description:
      "Send a message to another session by handle. Use for handing over a finding, a file you changed that affects them, or an answer. The recipient sees it as untrusted input from you, not as an order.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Handle of the recipient, e.g. "brisk-otter".' },
        message: { type: "string", description: "What you want them to know. Include enough context to be useful on its own." },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "ask",
    description:
      "Ask another session a question and wait for their answer. Blocks for up to timeout_seconds; if they are mid-task it may time out, and the question stays in their inbox. Prefer send() when you do not need an answer to continue.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        question: { type: "string" },
        timeout_seconds: { type: "number", description: "Default 120, maximum 600." },
      },
      required: ["to", "question"],
    },
  },
  {
    name: "reply",
    description: "Answer a question another session asked you. Use the message id from the question.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        to_message_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["to", "to_message_id", "message"],
    },
  },
  {
    name: "inbox",
    description: "Read messages other sessions have sent you. Messages are also delivered into your conversation as they arrive, so this is mainly for catching up.",
    inputSchema: { type: "object", properties: { include_read: { type: "boolean" } } },
  },
  {
    name: "rooms",
    description:
      "List the group channels you are in, with their topic, members and how many messages you have not read.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "room_read",
    description: "Read recent messages in a room. Use after a digest tells you a room has been busy.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string", description: 'Room name, e.g. "#auth-refactor".' }, limit: { type: "number" } },
      required: ["room"],
    },
  },
  {
    name: "room_post",
    description:
      "Post to a room. Everyone in it pays input tokens to read you, so post findings and decisions, not acknowledgements. Write @handle to put a message straight into that member's next step; without a mention it reaches the others as a batched digest when they go idle.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, message: { type: "string" } },
      required: ["room", "message"],
    },
  },
  {
    name: "room_create",
    description:
      "Open a group channel for work that genuinely involves several sessions — a shared migration, a contract between two services. Two sessions coordinating once should use send() instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Short channel name, e.g. "auth-refactor".' },
        topic: { type: "string", description: "One line on what the room is for. Members see it on every digest." },
        invite: { type: "array", items: { type: "string" }, description: "Handles to add." },
      },
      required: ["name"],
    },
  },
  {
    name: "room_invite",
    description: "Add another session to a room you are in.",
    inputSchema: { type: "object", properties: { room: { type: "string" }, handle: { type: "string" } }, required: ["room", "handle"] },
  },
  {
    name: "room_leave",
    description: "Leave a room when the work that needed it is done.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
  },
  {
    name: "spawn",
    description:
      "Open a separate session for a topic that does not belong in this conversation — an unrelated defect you noticed, a refactor worth doing later. The new session starts empty, so the task must stand on its own. It can get its own git worktree.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name for the new session." },
        task: { type: "string", description: "The complete brief. The new session cannot see your conversation." },
        branch: { type: "string", description: "Create a git worktree on this branch. Omit to work in the current directory." },
        agent: { type: "string", description: "Which opencode agent to use. Optional." },
      },
      required: ["task"],
    },
  },
  {
    name: "tasks",
    description:
      "Your task list: what is assigned to you, what you are working on now, and what is waiting on someone else.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include the whole board, not just your tasks." } } },
  },
  {
    name: "task_complete",
    description:
      "Finish the task you are working on and hand it to whoever is next. The summary is the only thing the next bot receives — it cannot see your conversation — so write it for a reader with no context.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        summary: { type: "string", description: "What you did and why, in enough detail that the next bot needs nothing else." },
        acceptance_criteria: { type: "array", items: { type: "string" }, description: "The criteria you set, or the ones you believe now hold." },
        artifacts: { type: "array", items: { type: "string" }, description: "Files you created or changed." },
        open_questions: {
          type: "array",
          items: { anyOf: [{ type: "string" }, QUESTION_SCHEMA] },
          description: "Anything unresolved. They go to the next stage with your handoff (or to the operator, if this stage waits for them). Give choices where there are obvious ones.",
        },
        tasks: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] }] },
          description: "Only when your task asks for it: the next stage's work split into independent pieces. Each becomes its own card, worked in parallel by several bots.",
        },
      },
      required: ["task_id", "summary"],
    },
  },
  {
    name: "send_back",
    description:
      "Send an earlier stage's work back because it does not hold up — a failing test, a broken build, a missed criterion. Do not fix it yourself: the bot that did it gets the card back with what you report, and your own card waits for the fix and then comes back to you to verify again. Be exact: they cannot see your conversation.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Your card (the one you are verifying on)." },
        to: { type: "string", description: 'The earlier stage id (e.g. "build"), or a card id.' },
        reason: { type: "string", description: "What is wrong, in a sentence or two." },
        failures: { type: "array", items: { type: "string" }, description: "Each failure: test or command, the error, and where (file:line) if known." },
        files: { type: "array", items: { type: "string" }, description: "Files involved. For a stage split into pieces, this picks the pieces that touched them." },
        pieces: { type: "array", items: { anyOf: [{ type: "number" }, { type: "string" }] }, description: "For a split stage: which pieces (their numbers) to send back. Omit with no files to add a new fix piece." },
      },
      required: ["task_id", "to"],
    },
  },
  {
    name: "notes_read",
    description:
      "Read what your teammates on this workstream have already worked out — maps of modules, where things live, gotchas. Call with no topic to list the notes, or with a topic to read one. Cheaper than re-reading the code.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "A note's topic, from the list." } } },
  },
  {
    name: "notes_write",
    description:
      "Save a short note (3–8 lines) the rest of the team can read instead of exploring the same code again: what a module does, where the entry points are, which files matter. Writing the same topic again replaces it.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: 'Short and findable, e.g. "Order cancellation flow".' },
        text: { type: "string", description: "The note. Paths and names, not prose." },
        files: { type: "array", items: { type: "string" }, description: "The files it is about." },
      },
      required: ["topic", "text"],
    },
  },
  {
    name: "handoff",
    description: "The full handoff an earlier stage wrote (your task shows a trimmed version). Call with the stage id, e.g. \"analyse\".",
    inputSchema: { type: "object", properties: { stage: { type: "string" } }, required: ["stage"] },
  },
  {
    name: "task_create",
    description:
      "Raise a task for someone else — a defect you found, a follow-up that does not belong in your own work. It lands on the operator's board and is offered to the assignee when they next go idle.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        brief: { type: "string", description: "Everything the assignee needs. They cannot see your conversation." },
        assignee: { type: "string", description: 'A handle, a persona name (anyone playing that part takes it), or "human" for your operator. Omit to leave it in the backlog.' },
        blocks: { type: "string", description: "Task id this one must be finished before." },
      },
      required: ["title", "brief"],
    },
  },
  {
    name: "ask_human",
    description:
      "Ask your operator something only they can answer — a decision, a missing credential, a judgement call about intent. It appears at the top of their board. Prefer deciding yourself and saying what you assumed; use this when being wrong would waste real work.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Ask one thing, plainly, with enough context to answer without opening your session." },
        options: { type: "array", items: { type: "string" }, description: "Concrete choices, when there are some. The operator can always answer in their own words, so no 'Other'." },
        multiple: { type: "boolean", description: "True if more than one option can be picked." },
        questions: { type: "array", items: QUESTION_SCHEMA, description: "Several questions at once, each with its own choices, instead of question/options." },
        wait_seconds: { type: "number", description: "Block for up to this long waiting for the answer. Default 0: ask, carry on with something else, and read the answer when it arrives." },
        task_id: { type: "string", description: "The task this is about, if any." },
      },
    },
  },
  {
    name: "task_note",
    description: "Add a line to a task the operator will see. Use for progress on something long, not for chatter.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, note: { type: "string" } }, required: ["task_id", "note"] },
  },
  {
    name: "notify",
    description: "Put a line on the operator's BotFarm dashboard. Use when something needs a human but does not need you to stop.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        level: { type: "string", enum: ["info", "warn", "error"] },
      },
      required: ["message"],
    },
  },
]

export function createMcpHandler({ mesh, supervisor }) {
  return async function handle(req, res, token) {
    if (req.method === "GET" || req.method === "DELETE") {
      // No server-initiated messages: decline the SSE channel politely.
      res.writeHead(405, { allow: "POST" })
      return res.end()
    }
    if (req.method !== "POST") {
      res.writeHead(405)
      return res.end()
    }

    const body = await readJson(req).catch(() => null)
    if (!body) return rpc(res, null, null, { code: -32700, message: "parse error" })

    const caller = await supervisor.callerForToken(token)
    if (!caller && body.method !== "initialize") {
      return rpc(res, body.id, null, { code: -32001, message: "This BotFarm endpoint is no longer bound to a session." })
    }

    switch (body.method) {
      case "initialize":
        return rpc(res, body.id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "botfarm", version: "0.2.0", title: "BotFarm" },
          instructions:
            "These tools reach the other opencode sessions the operator is running. Use roster to see who is working on what, " +
            "send/ask to coordinate, and spawn to move an unrelated topic into its own session instead of derailing this one.",
        })
      case "notifications/initialized":
        res.writeHead(202)
        return res.end()
      case "ping":
        return rpc(res, body.id, {})
      case "tools/list":
        // Built-ins, then the workspace's own tools from botfarm/mcps/.
        return rpc(res, body.id, { tools: [...visibleTools(caller), ...(caller ? supervisor.wsTools?.mcpList(supervisor.workspaceIdOf(caller)) ?? [] : [])] })
      case "tools/call":
        return rpc(res, body.id, await call(body.params ?? {}, caller, mesh, supervisor))
      default:
        return rpc(res, body.id, null, { code: -32601, message: `unknown method ${body.method}` })
    }
  }
}

/** Tools the operator has switched off simply do not exist for that session. */
function visibleTools(caller) {
  return TOOLS.filter((t) => {
    if (!caller) return true
    if (t.name === "spawn") return caller.policy.spawn
    if (["send", "ask", "reply"].includes(t.name)) return caller.policy.talk === "open"
    if (["roster", "inbox"].includes(t.name)) return caller.policy.talk !== "off"
    if (t.name === "room_create") return caller.policy.rooms === "create"
    if (t.name.startsWith("room") || t.name === "rooms") return caller.policy.rooms !== "off"
    if (t.name.startsWith("task") || t.name === "tasks" || t.name === "send_back") return caller.policy.tasks !== "off"
    return true
  })
}

async function call(params, caller, mesh, supervisor) {
  const { name, arguments: args = {} } = params
  try {
    switch (name) {
      case "whoami":
        return ok({
          handle: caller.handle,
          session_id: caller.id,
          title: caller.title,
          worktree: caller.directory,
          branch: caller.branch,
          opened_by: caller.origin ?? "operator",
          may_message_peers: caller.policy.talk === "open",
          may_receive_messages: caller.policy.talk !== "off",
          may_spawn_sessions: caller.policy.spawn,
          reachable_peers: mesh.roster(caller).length,
        })

      case "roster": {
        const peers = mesh.roster(caller)
        return ok(
          peers.length
            ? { peers }
            : { peers: [], note: "No other sessions are reachable. The operator enables this per session in the BotFarm dashboard." },
        )
      }

      case "send": {
        const m = await mesh.send(caller, args.to, args.message)
        return ok({ delivered: true, message_id: m.id, to: m.to, note: `@${m.to} will see this at their next step. They may not reply.` })
      }

      case "ask":
        return ok(await mesh.ask(caller, args.to, args.question, args.timeout_seconds ?? 120))

      case "reply": {
        const target = mesh.resolve(args.to)
        if (!target) throw new MeshError("unknown_peer", `No session named "${args.to}".`)
        const m = await mesh.send(caller, args.to, args.message, { kind: "reply", askId: args.to_message_id })
        return ok({ delivered: true, message_id: m.id })
      }

      case "inbox": {
        const items = args.include_read ? caller.inbox : mesh.unread(caller)
        return ok({
          messages: items.map((m) => ({ id: m.id, from: m.from, at: new Date(m.at).toISOString(), kind: m.kind, text: m.text })),
        })
      }

      case "rooms": {
        const list = supervisor.rooms.visibleTo(caller).map((r) => ({
          name: r.name,
          topic: r.topic,
          muted: r.muted,
          delivery: r.mode === "push" ? "every message is delivered" : "mentions are delivered, the rest arrive as a digest when you go idle",
          members: supervisor.rooms.members(r).map((m) => (m.id === caller.id ? "you" : "@" + m.handle)),
          unread: r.unread.get(caller.id) ?? 0,
        }))
        return ok(list.length ? { rooms: list } : { rooms: [], note: "You are not in any rooms. The operator adds sessions to rooms from the dashboard." })
      }

      case "room_read": {
        const room = requireRoom(supervisor, caller, args.room)
        return ok({ room: room.name, topic: room.topic, messages: supervisor.rooms.read(room, caller, args.limit ?? 20) })
      }

      case "room_post": {
        const room = requireRoom(supervisor, caller, args.room)
        const m = await supervisor.rooms.post(room, caller, args.message)
        const others = room.members.size - 1
        return ok({
          posted: true,
          message_id: m.id,
          room: room.name,
          reached: m.mentions.length ? `delivered now to ${m.mentions.map((h) => "@" + h).join(", ")}` : `queued for ${others} member(s), delivered as they go idle`,
        })
      }

      case "room_create": {
        const invited = (args.invite ?? []).map((h) => mesh.resolve(h)).filter(Boolean)
        const room = supervisor.rooms.create({
          name: args.name,
          topic: args.topic,
          createdBy: caller.handle,
          members: [caller, ...invited],
        })
        return ok({ created: true, room: room.name, members: supervisor.rooms.members(room).map((m) => "@" + m.handle) })
      }

      case "room_invite": {
        const room = requireRoom(supervisor, caller, args.room)
        const target = mesh.resolve(args.handle)
        if (!target) throw new RoomError("unknown", `No session named "${args.handle}".`)
        if (target.policy.rooms === "off") throw new RoomError("not_allowed", `@${target.handle} is not allowed in rooms. The operator can change that.`)
        supervisor.rooms.join(room, target)
        return ok({ room: room.name, added: "@" + target.handle })
      }

      case "room_leave": {
        const room = requireRoom(supervisor, caller, args.room)
        supervisor.rooms.leave(room, caller)
        return ok({ room: room.name, left: true })
      }

      case "spawn": {
        const s = await mesh.spawn(caller, args)
        return ok({
          created: true,
          handle: s.handle,
          session_id: s.id,
          worktree: s.directory,
          note: `@${s.handle} is now working on this separately. It cannot see this conversation. You can botfarm_ask it for a status later.`,
        })
      }

      case "notes_read": {
        const runId = runOfCaller(supervisor, caller)
        if (!runId) return ok({ notes: [], note: "You are not on a pipeline workstream, so there are no team notes." })
        const notes = supervisor.pipelines.notes(runId)
        if (!args.topic) return ok({ notes: notes.map((n) => ({ topic: n.topic, by: "@" + n.by, files: n.files.length })) })
        const want = String(args.topic).toLowerCase()
        const n = notes.find((x) => x.topic.toLowerCase() === want) ?? notes.find((x) => x.topic.toLowerCase().includes(want))
        return n ? ok(n) : err(`No note about "${args.topic}". Topics: ${notes.map((x) => x.topic).join(", ") || "none yet"}.`)
      }

      case "notes_write": {
        const runId = runOfCaller(supervisor, caller)
        if (!runId) return err("You are not on a pipeline workstream, so there is nowhere to keep team notes.")
        const n = supervisor.pipelines.addNote(runId, { topic: args.topic, text: args.text, files: args.files, by: caller.handle })
        return ok({ saved: n.topic, note: "Your teammates see this topic in their next task and can read it with botfarm_notes_read." })
      }

      case "handoff": {
        const runId = runOfCaller(supervisor, caller)
        const run = runId ? supervisor.pipelines.run(runId) : null
        const t = run ? supervisor.tasks.get(run.taskIds?.[args.stage]) : null
        if (!t) return err(`No stage "${args.stage}" on your workstream.${run ? ` Stages: ${Object.keys(run.taskIds).join(", ")}.` : ""}`)
        if (!t.handoff) return err(`${args.stage} has not handed off yet.`)
        const { brief, questions, ...full } = t.handoff
        return ok({ stage: args.stage, by: t.persona, ...full })
      }

      case "tasks": {
        const role = caller.role ?? caller.persona
        const mine = [
          ...supervisor.tasks.all({ assignee: caller.id }),
          ...(role ? supervisor.tasks.all({ role }).filter((t) => !t.assignee) : []),
          ...supervisor.tasks.all({ owner: "human" }).filter((t) => t.askedBy === caller.id),
        ]
        const out = {
          yours: mine.map(brief),
          working_on: mine.filter((t) => t.status === "active").map((t) => t.id),
        }
        if (args.all) out.board = supervisor.tasks.board().map((c) => ({ status: c.status, tasks: c.tasks.map(brief) }))
        return ok(out)
      }

      case "task_complete": {
        const task = supervisor.tasks.get(args.task_id)
        if (!task) throw new TaskError("unknown_task", `No task ${args.task_id}. Call botfarm_tasks to see yours.`)
        if (task.assignee && task.assignee !== caller.id) {
          // Sessions sharing a worktree share an MCP endpoint and cannot
          // always be told apart. The task id is the stronger evidence: if
          // its assignee works in the same place, it is the one calling.
          const owner = supervisor.store.get(task.assignee)
          if (!owner || owner.directory !== caller.directory) {
            throw new TaskError("not_yours", `${task.id} is assigned to someone else.`)
          }
        }
        const done = await supervisor.pipelines.complete(task, args)
        const next = supervisor.tasks.all({ runId: task.runId }).filter((t) => t.dependsOn.includes(task.id))
        return ok({
          completed: done.id,
          status: done.status,
          note: done.status === "review"
            ? "This stage waits for the operator when it has open questions, so it is in review until they let it go on."
            : next.length
              ? `Handed to ${next.map((t) => "@" + (supervisor.store.get(t.assignee)?.handle ?? t.persona)).join(", ")}.`
              : "Nothing was waiting on this.",
        })
      }

      case "send_back": {
        const task = supervisor.tasks.get(args.task_id)
        if (!task) throw new TaskError("unknown_task", `No task ${args.task_id}. Call botfarm_tasks to see yours.`)
        if (task.assignee && task.assignee !== caller.id) {
          const owner = supervisor.store.get(task.assignee)
          if (!owner || owner.directory !== caller.directory) throw new TaskError("not_yours", `${task.id} is assigned to someone else.`)
        }
        if (task.status !== "active") throw new TaskError("bad_request", `${task.id} is ${task.status}, not the card you are working on.`)
        const out = await supervisor.pipelines.sendBack(task, { to: args.to, reason: args.reason, failures: args.failures, files: args.files, pieces: args.pieces })
        if (out.paused) return ok({ sent: false, paused: true, why: out.why, note: "Not sent: the operator decides what happens next. Stop here and end your turn; you will hear back." })
        return ok({
          sent: out.sent.map((t) => `${t.title}${t.to ? ` → @${t.to}` : ""}`),
          fix: `${out.round} of ${out.max}`,
          note: "Sent. Your card now waits for the fix and comes back to you to verify. Stop here and end your turn — do not start fixing it yourself.",
        })
      }

      case "ask_human": {
        const questions = normalizeQuestions(args.questions?.length ? args.questions : { question: args.question, options: args.options, multiple: args.multiple })
        if (!questions.length) throw new TaskError("bad_request", "Ask something: question, or questions: [{ question, options }].")
        args.question = questions.map((q) => q.question).join("\n")
        const task = supervisor.tasks.create({
          title: questions[0].question.slice(0, 90) + (questions.length > 1 ? ` (+${questions.length - 1})` : ""),
          brief: args.question,
          kind: "question",
          owner: "human",
          options: questions[0].options.map((o) => o.label),
          askedBy: caller.id,
          projectId: caller.project ?? null,
          runId: currentRunId(supervisor, caller),
          createdBy: caller.handle,
        })
        task.questions = questions
        supervisor.tasks.save(task)
        if (args.task_id) supervisor.tasks.note(args.task_id, `asked the operator: ${args.question}`, caller.handle)
        supervisor.store.note(`@${caller.handle} needs you: ${String(args.question).slice(0, 90)}`, caller.id, "warn")
        supervisor.onChange()

        const wait = Math.min(600, Math.max(0, args.wait_seconds ?? 0))
        const deadline = Date.now() + wait * 1000
        while (wait && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000))
          const fresh = supervisor.tasks.get(task.id)
          if (fresh?.answer) return ok({ answered: true, answer: fresh.answer })
        }
        return ok({
          asked: true,
          task_id: task.id,
          note: wait
            ? "No answer yet. It is on their board; carry on with something else and the answer will arrive in this session."
            : "Asked. The answer will arrive here as a message — carry on with what you can do meanwhile.",
        })
      }

      case "task_create": {
        const target = args.assignee ? resolveAssignee(supervisor, mesh, caller, args.assignee) : null
        const blocked = args.blocks ? supervisor.tasks.get(args.blocks) : null
        const forHuman = ["human", "operator", "you", "me"].includes(String(args.assignee ?? "").toLowerCase())
        const asRole = !target && !forHuman && args.assignee ? String(args.assignee).replace(/^@/, "") : null
        const task = supervisor.tasks.create({
          title: args.title,
          brief: args.brief,
          projectId: caller.project ?? null,
          runId: currentRunId(supervisor, caller),
          assignee: target?.id ?? null,
          role: asRole,
          owner: forHuman ? "human" : target ? "session" : asRole ? "role" : "unassigned",
          askedBy: caller.id,
          createdBy: caller.handle,
        })
        if (blocked) {
          blocked.dependsOn = [...new Set([...blocked.dependsOn, task.id])]
          if (blocked.status !== "active") blocked.status = "blocked"
          supervisor.tasks.save(blocked)
        }
        await supervisor.pipelines.dispatch()
        supervisor.store.note(`@${caller.handle} raised "${task.title}"${target ? ` for @${target.handle}` : ""}`, caller.id, "warn")
        return ok({
          created: task.id,
          assigned_to: forHuman ? "your operator" : target ? "@" + target.handle : asRole ? `whoever is playing "${asRole}"` : "the backlog",
          note: forHuman
            ? "It is on their board."
            : target || asRole
              ? "It will be handed over when they next finish what they are doing."
              : "Nobody is assigned; the operator will triage it.",
        })
      }

      case "task_note": {
        const task = supervisor.tasks.get(args.task_id)
        if (!task) throw new TaskError("unknown_task", `No task ${args.task_id}.`)
        supervisor.tasks.note(task.id, args.note, caller.handle)
        return ok({ noted: true })
      }

      case "notify":
        supervisor.store.note(`@${caller.handle}: ${String(args.message).slice(0, 200)}`, caller.id, args.level === "error" ? "error" : args.level === "warn" ? "warn" : "info")
        supervisor.onChange()
        return ok({ posted: true })

      default: {
        const wsId = supervisor.workspaceIdOf(caller)
        if (wsId && supervisor.wsTools?.get(wsId, name)) {
          const ws = supervisor.workspaces.get(wsId)
          const out = await supervisor.wsTools.run(wsId, name, args, {
            repoRoot: caller.directory ?? ws?.path,
            workspace: ws ? { id: ws.id, name: ws.name, path: ws.path } : null,
            bot: { id: caller.id, handle: caller.handle, persona: caller.persona ?? null, project: caller.project ?? null },
          })
          supervisor.store.note(`@${caller.handle} ran ${name} (${out.ok ? `${out.ms}ms` : `failed: ${out.error}`})`, caller.id, out.ok ? "info" : "warn")
          return toolResult(out)
        }
        return err(`unknown tool "${name}"`)
      }
    }
  } catch (e) {
    // Tool errors go back as results, not protocol errors, so the model can read
    // and act on them instead of seeing an opaque transport failure.
    return err(e instanceof MeshError || e instanceof RoomError || e instanceof TaskError ? `${e.code}: ${e.message}` : e.message)
  }
}

const brief = (t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  stage: t.stage,
  owner: t.owner === "human" ? "your operator" : t.owner === "role" ? `anyone playing "${t.role}"` : t.owner,
  kind: t.kind,
  answer: t.answer ?? undefined,
  blocked_by: t.dependsOn,
  raised_by: t.createdBy,
})

/** Accept a handle, or a persona name within the caller's own pipeline run. */
function resolveAssignee(supervisor, mesh, caller, ref) {
  const direct = mesh.resolve(ref)
  if (direct) return direct
  const runId = currentRunId(supervisor, caller)
  const run = runId ? supervisor.pipelines.run(runId) : null
  const id = run?.sessions?.[String(ref).replace(/^@/, "")]
  return id ? supervisor.store.get(id) : null
}

function runOfCaller(supervisor, caller) {
  return currentRunId(supervisor, caller) ?? supervisor.projects.get(caller.project)?.runId ?? null
}

function currentRunId(supervisor, caller) {
  return supervisor.tasks.all({ assignee: caller.id }).find((t) => t.runId)?.runId ?? null
}

function requireRoom(supervisor, caller, ref) {
  const room = supervisor.rooms.find(ref)
  if (!room) throw new RoomError("unknown_room", `No room called "${ref}". Call botfarm_rooms to see the ones you are in.`)
  if (!room.members.has(caller.id)) throw new RoomError("not_member", `@${caller.handle} is not in ${room.name}.`)
  return room
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj })
const err = (message) => ({ content: [{ type: "text", text: message }], isError: true })

function rpc(res, id, result, error) {
  const payload = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }
  const buf = Buffer.from(JSON.stringify(payload))
  res.writeHead(200, { "content-type": "application/json", "content-length": buf.length })
  res.end(buf)
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export { TOOLS, avatarDataUri }
