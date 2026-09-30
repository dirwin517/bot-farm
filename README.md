# botfarm

A kanban style process manager for [opencode](https://opencode.ai) sessions: run several agents at once,
watch what they are burning, steer them without entering them, and — if you allow it — let them talk
to each other.

```
npm link           # or: node src/cli.mjs up
botfarm up            # starts opencode serve if needed, opens the dashboard
```

The dashboard is at `http://127.0.0.1:4777`. No dependencies; Node 20+ and `git`.

---

## BotFarm: workspaces and workstreams

The dashboard is organised around two things:

- **Workspace** — a folder and its opencode config. The first one is the folder you start BotFarm in
  (change it with `"defaultWorkspace"` in `~/.botfarm/config.json` or `botfarm up --workspace <dir>`); open
  more with the folder browser under the workspace name. A workspace's bots are defined at
  its root, created with the built-in set if missing — a `botfarm/` folder with one file per definition,
  named after its id:
  - `botfarm/<id>.agent.botfarm.yml` — one agent: `{ title, role, prompt, model?, variant?, tools?, tiers?, may_spawn? }`
  - `botfarm/<id>.pipeline.botfarm.yml` — one pipeline: `{ title, description?, limits?, stages: [{ id, title?, persona | human: true, receives: [stage ids], after?: [stage ids], split?: tasks, parallel?, difficulty?, limits?: { minutes, tokens, usd }, prompt }] }`
  - `botfarm/routing.botfarm.yml` — model routing by difficulty (off until `enabled: true`)
  - `botfarm/mcps/*.js` — your own tools, served to every bot in the workspace (see below)

  Older `botfarm-agents.yml` / `botfarm-pipeline.yml` files are split into these on first start and kept as
  `.bak`. Edit them in the app (Pipelines / Agents in the sidebar, as a form or as that one file's YAML) or
  by hand; hand edits are picked up without a restart.
- **Workstream** — one story going through one pipeline. Starting a pipeline always makes a new
  workstream with its own branch and worktree, its own team of bots, its own channel and its own board.
  Two DoUserStory runs are two workstreams side by side. A workstream keeps the pipeline definition it
  started with, so editing the pipeline later changes only new workstreams.

**Parallel work.** A stage normally starts when the one before it hands off. Give it
`after: [stage ids]` to start as soon as those are done instead — dev and QA both `after: [analyse]`
build and write tests side by side (TDD), and a stage `after: [build, tests]` waits for both.
`split: tasks` on a stage fans it out: the stage it waits on is asked for a `tasks` list
(`[{ title, detail }]`) on its handoff, each item becomes its own card, and up to `parallel: N` bots of
that kind (default 3, max 10; overridable when you start the workstream) work them at once in the same
worktree — extra bots are added to the team as needed. The next stage waits for every piece and gets
their handoffs joined. Use `{{#item}}{{title}} {{detail}}{{/item}}` in the split stage's prompt, or let
BotFarm add "Your part — n of N" itself. See the `story-parallel` example.

**Limits.** `limits: { minutes, tokens, usd }` on a stage applies to each of its cards (each piece of a
split); `limits:` on a pipeline, or the Limits box when you start one, applies to the whole workstream.
When a card reaches a limit its bot is stopped and the card waits in Needs you (Continue gives half as
much again, Set limits… for exact numbers, or Stop); when the workstream reaches one every bot on it
stops until you raise it. Limits can be changed any time from the workstream header.

The workstream page has the team down the left (grouped by kind, live status and spend), the board
with the chat under it, and a **Farm** view of the same board: cards are crops moving from the shed to
the field to the silo, and each bot walks to the card it is working on.

**BotFarm's MCP server** is called `botfarm`: bots see `botfarm_task_complete`, `botfarm_room_post`,
`botfarm_notes_read` and so on (it used to be `botfarm`; old worktrees are renamed automatically).

**Your own tools.** Every `.js` file in `botfarm/mcps/` exports `name`, `description`, `inputSchema` and
`execute(args, ctx)` and becomes `botfarm_<name>` for the workspace's bots. `ctx.repoRoot` is the calling
bot's worktree, `ctx.exec(cmd, args)` runs a program there, `ctx.log(...)` writes to the test bench. Saving
a file reloads it; bots get the new list on their next idle moment. **Tools** in the sidebar is the test
bench: a form from the schema (or raw JSON), where to run it, the result and log, and the source to edit.

**Switching a bot's model.** Model… in a bot's panel picks another model and reasoning level for that bot
from its next turn (Opus for a hard fix, Sonnet or Haiku to save money), kept across restarts, without
touching the agent file.

**Keeping it cheap — no paid model involved in any of these:**
- *Routing by difficulty*: each card is sized easy / normal / hard from its words, length and criteria
  (or `difficulty:` on a stage or split piece) and gets the model from `routing.botfarm.yml` or the agent's
  `tiers:`. The card shows its size and model. All of it is editable in the app: **Model routing** in
  the sidebar, **Difficulty** on each stage in the pipeline editor, **Model by difficulty** in the agent editor.
  A tier can cap its model — *Quota and fallback*: e.g. up to $5 a day on Opus, then Sonnet (also tokens or
  minutes, per day / week / month / workstream). Spend is counted per workspace per model; once it runs out,
  new cards take the fallback and bots already on it move over, at once or on their next turn.
  *Per agent*: an agent's `tiers:` override the workspace rules size by size (give only the reviewer its
  own `hard:` and it still uses the workspace's easy/normal), and apply even with workspace routing off.
  An agent's own quota counts only that agent's spend (e.g. "the reviewer gets $3/day of Opus"); a
  workspace quota counts everyone's. **Model routing → What each agent gets** shows the effective model,
  reasoning, quota and where each came from, per agent and size. One-line YAML maps
  (`quota: { usd: 3, per: day }`) work in hand-edited files.
- *Apply to my repos*: from the harvest (**Apply to my repos…**) or any time after (**Apply to repos…** in the
  workstream header), every repo in the workstream — parent, services, linked repos — becomes a patch of what
  its worktree has that your checkout does not (edits, new files, commits on the branch, from the merge-base),
  leaving out BotFarm's own files. The dialog shows, per repo, where it goes (path and current branch), the
  files, whether it applies cleanly / needs a 3-way merge / will conflict / is already there, and warns about
  your own uncommitted edits to the same files. Applying never commits or stages a clean patch: it lands as
  working-tree changes to review and commit yourself. Otherwise it falls back to a 3-way apply (conflict
  markers) and then `--reject` (.rej files). **Undo last apply** reverses the clean ones. Patches are kept in
  `.botfarm/workstreams/<id>.patches/` and can be downloaded. API: `GET /api/projects/:id/patches`,
  `…/patches/file?rel=`, `POST …/patches/apply {repos?}`, `POST …/patches/undo`.
- *Repos from anywhere*: a workstream's worktree can hold repos from outside the workspace. **Add repo**
  in the new-workstream dialog (e.g. `~/workspace/spt`, optional folder name) links it to the workspace;
  each workstream it is ticked for gets a worktree of it on the same branch, mounted at `<worktree>/spt/`
  (hidden from the parent's git status via `info/exclude`). **+ Repo** on a running workstream adds one after
  the fact; the bots are told in the chat, the team notes and every card ("Repos in this worktree").
  Card diffs, snapshots, PR stats and deleting the workstream (worktrees and `botfarm/` branches) cover them.
  API: `POST /api/workspaces/:id/repos {path, as?, running?}`, `DELETE …/repos?path=`, `POST /api/projects/:id/repos {path, as?}`.
  Docker MCPs see it only if the path is under a mounted folder (`~/workspace`, `~/worktrees`).
- *Send back (fix loops)*: Plan → Code → Verify → Fail → Code → Verify → Pass. A checker that finds a
  failing test, broken build or missed criterion calls `botfarm_send_back { task_id, to, reason, failures, files }`
  instead of fixing it. The earlier card goes back to To do with what failed and its last handoff kept
  ("↩ round 2"), preferring the bot that did it (another bot of that kind takes it after ~90s if that one is
  busy or gone); the checker's card waits and comes back to the same checker to verify ("↻ verify 2"). For a
  split stage only the pieces that touched the named files go back, or a new "Fix:" piece is added. Any
  earlier stage is a valid target unless the stage says `send_back: [build]` or `send_back: false`;
  `max_rounds` (per stage or pipeline, default 3, also in the pipeline editor as *Fix rounds*) caps it, and
  the same failure twice stops too — then you choose *One more round*, *Accept as is* or *Stop*. You can
  send a done card back yourself: drag it to To do, or *Send back…* on the card. Fix rounds earn little XP;
  the checker gets a little for catching them.
- *Loop detection* counts a call as repeated only when the tool **and every argument** match (a fingerprint of
  the whole input, key order ignored) — three greps for different things are work. An edit in between resets
  the count, so build → fix → build is fine.
- *Trimmed handoffs*: the next bot reads a brief (long code blocks become pointers, repeats go, cut at
  ~1800 characters); `botfarm_handoff(stage)` fetches the full text. For a local model instead, set
  `"handoffs": { "local": { "url": "http://localhost:11434", "model": "qwen2.5:3b" } }` in
  `~/.botfarm/config.json` (falls back to the rules).
- *Team notes*: `botfarm_notes_write` / `botfarm_notes_read`; every card lists the notes and the files
  teammates already read.
- *Loop stop*: the same call three times, five failures in a row, or ~250k tokens without an edit pauses
  the card and asks you (`"loops": { "tokensWithoutEdits": N }` to tune).

**Card events in the chat.** Every finished card posts a card to the channel: who did it, how long it
took, tokens, cost, model, XP, every file that changed on disk while it ran, with the diff from where the file stood when the card
began — whatever changed it: opencode's tools, an MCP server, a script (files it did not list in its
handoff are marked) — open *Changes*, and any screenshots (images among its files, or image results from its tools; click to
enlarge). Split stages post one more when all their pieces are in. These never wake the other bots.

**Pause / Resume** in a workstream's header stops every bot on it (mid-card) until you resume; resuming
tells each stopped bot to pick its card up again.

**When a workstream finishes**: a *PR packet* (`.botfarm/workstreams/<id>.pr.md` — criteria with the tests
behind them, files, commits, how to test, open questions, cost; **Open PR…** pushes and runs `gh pr
create`), a *harvest* (a small celebration and a line in the home page's harvest log) and XP.

**Levels.** Each kind of bot earns XP per workspace for clean work only — a handoff, no pauses, under
budget, nothing left open. Levels bring hats on the farm and small perks: level 3 +10% card limits,
level 5 the first limit hit extends itself once, level 8 +20%.

**Replays.** Replay on a workstream scrubs through everything that happened (farm, team, chat). Save
replay file gives one portable JSON; open it from the home page of any BotFarm.

A stage with open questions still hands off: the questions go to the next stage with its card. Set
`hold_on_questions: true` on a stage (or "wait for me" in the editor) to stop there until you press
**Continue** on the card, optionally with answers that every later stage receives.

Questions for you look like the ones Claude and opencode ask: a bot's `botfarm_ask_human` (or a held
stage's open questions) can offer choices per question — pick one, or several — and every question can
also be answered in your own words; a question without choices is open-ended. They appear at the bottom
of the chat and on the card, answerable in place.

An agent's `tools:` list is enforced on every turn (everything else built in is switched off; the botfarm
tools stay on). The built-in product agent is read-only and told to polish the criteria it is given,
not to study the code — that is the dev's job. Unedited built-ins in an existing workspace are moved to
the current ones on start; anything you changed is left alone.

A workstream's page is a kanban (To do, Doing, Needs you, Done — drag cards between them) next to its
group chat. Posting there reaches the whole team, or only the bots you @mention; bots whose stage has
not started read it with their first card. Click a bot to watch its transcript live, or a card for its
handoff, criteria and open questions. `+ Card` and `+ Bot` add work and teammates by hand; Archive
stops the bots and puts the workstream away.

Each workstream also writes `.botfarm/workstreams/<id>.yml` in the workspace (excluded from git
locally): its branch, worktree, story, stage statuses, and the opencode session id of every bot — plus
the ones they replaced. On start botfarm re-adopts any bot its own state has forgotten, and recreates a
workstream it has no record of, so a lost `~/.botfarm` or a new machine gets the team back.

The previous dashboard is still at `/classic` for everything else (adopting sessions, rooms, the
global board).

## The board is a registry, not a listing

opencode accumulates every session you have ever opened. Listing them all turns the dashboard into an
archive browser — 250 cards, none of them what you are working on. botfarm shows only sessions it
manages: ones it started, plus ones you explicitly add with **Add existing…**. The rest sit behind a
one-line banner offering them. `Remove` puts a session back in that pool; it never deletes anything.

The registry is also where botfarm keeps the metadata opencode has no place for: group, label, mesh
policy, lineage, disabled tools. It lives in `~/.botfarm/registry.json`.

## Projects

A project is the thing you actually work on: a checkout, the sessions working in it, the tasks they
are working through, and the conversation they are having about it. Those used to be four separate
ideas here — a group, a worktree, a board and a room — which meant four things to create before
anything could happen. They are one object now.

Opening a project gives you all of it on one screen: who is working and what they are doing, that
project's kanban board, and that project's chat with a composer, side by side. Creating a project
creates its chat; moving a session into a project moves it into that chat; the project's board is
its tasks. The global board is still there as a view across every project, rather than as the
primary one.

A pipeline run creates its project, so starting one is the only step.

## The board

Every session is a card: identity, worktree, two sparklines (tokens/min and tools/min over the last
hour), the closing sentences of the last message so you can see what you would be continuing, and the
controls you actually reach for. Click one and you get a centred modal: the full scrollable
transcript with a composer on the left, stats, cost, tools and mesh settings on the right.

- **Continue without entering** — type into the box on the card and press enter. The prompt is queued
  on that session; you never leave the board.
- **Abort** — one session, or all running sessions from the header.
- **Inspect** — slides open the usage breakdown, tool timeline with durations, changed files, peers
  and transcript.
- Cards sort by attention: running, then waiting on a permission, then errored, then idle.

### Transport

The dashboard is pushed to over a websocket (`/api/socket`), falling back to server-sent events if
the socket will not connect. Neither polls. Actions stay on plain HTTP: they are one-shot, they want
status codes and retries, and multiplexing them over the socket would mean reinventing request ids
and error handling that `fetch` already has.

botfarm's own traffic to opencode is event-driven too. Session status comes from the event stream, and
the periodic checks are reconciliation rather than the mechanism — they run when the stream goes
quiet or a session looks stale. A board with nothing happening makes **zero** requests per second;
with the stream down the polling loop comes back automatically.

Request bodies are negotiated rather than pinned. opencode's prompt endpoint moved from
`{parts: [...]}` to `{prompt: {text}}`, so botfarm tries the known shapes, keeps the index of the one
that worked, and reports clearly if none is accepted.

Metrics come from each session's message list, not from event payloads. opencode's HTTP surface is
experimental and event names have already changed once; assistant messages always carry their own
usage and tool calls are always parts with stable ids. The event stream only says *something changed
in session X* — the message diff does the counting. The client also sniffs the v1/v2 path dialect at
connect time, so a rename of `/session` to `/api/session` doesn't break it.

## Worktrees and multi-repo projects

A session is a pod; a pod can own a git worktree so parallel agents never fight over one checkout.

Paths are expanded the way a shell would: `~/workspace/app`, `$HOME/app` and relative paths all work.
Before anything is created, the dialogs probe the path and tell you what is there — a missing
directory and a directory that is not a repository are different problems and say so.

**Projects that contain other repositories** — a parent repo with the services cloned into a
gitignored folder — get one worktree per repository, laid out exactly like the original tree: a
worktree of the parent, and a worktree of each selected service at the same relative path inside it.
Every repo ends up on its own branch and the agent sees the directory structure it expects. The
dialog lists the nested repositories it found (git will not mention them, since the parent ignores
them) and you tick the ones in scope; leaving them all unticked gives you the parent alone.

Changed-files and diffs aggregate across all of them, each file tagged with the repo it belongs to,
and removing a session removes every worktree it created without touching your original checkouts.

```
botfarm new ~/code/app --branch fix/auth-redirect --task "Fix the redirect loop after SSO login"
```

That creates the worktree (under `~/worktrees/<repo>/<branch>` unless you set `BOT_FARM_WORKTREE_ROOT`),
opens a session located there, and sends the first instruction. Each card shows the branch and a live
`+142 −18 · 7 files` from `git status`. `botfarm rm <id> --worktree` removes both.

## The mesh

Sessions are isolated by default. **Nothing is shared until you turn it on, per session.**

Each session has an identity: a stable handle like `@prying-heron` and an avatar that *is* the
creature in the handle, on a colour drawn from the adjective. **The adjective carries the job** —
testers draw from a suspicious vocabulary (prying, nervous, squinting, needling), builders from a
making one (stacking, moulding, polishing, welding), product from a shaping one (framing, scoping,
sketching), reviewers from a weighing one (tallying, auditing, squaring). `@prying-heron` reads as a
tester before you have looked at anything else on the card, and in a four-bot room the handle is
doing the work a job title would. A persona can supply its own `adjectives:` list. The handle isn't decoration — it's the
addressing scheme. A model copies a three-syllable handle reliably and a 26-character ulid
unreliably, and you can hold six handles in your head at once.

Avatars are two axes a person can name out loud ("the orange badger"), which is what makes forty
cards scannable — sixty-four creatures against sixteen backgrounds, so a thousand sessions come and
go before two of them wear the same face. They are generated locally, instantly, and
deterministically — no model, no download, no network.

In the inspector, each session gets two switches:

| Setting | Effect |
| --- | --- |
| `Off` (default) | Invisible to other sessions and unreachable by them. |
| `Receive only` | Appears in other sessions' rosters and can be messaged; cannot initiate. |
| `Send and receive` | Full participant. |
| `Can open sessions` | May create new sessions for unrelated topics. Off by default. |

### How a session gets the tools

botfarm exposes an MCP server at `/mcp/<token>`, with **a distinct token per session**. That token is
the whole authentication story: a tool call arrives already bound to one caller, so an agent cannot
claim to be a peer. When you enable the mesh for a session, botfarm registers the server with opencode
at runtime and also writes it into `<worktree>/.opencode/opencode.json`:

```json
{
  "mcp": {
    "botfarm": { "type": "remote", "url": "http://127.0.0.1:4777/mcp/<token>", "enabled": true }
  }
}
```

Runtime registration lets an already-open session pick the tools up immediately; the project config
is the reliable fallback (restart that session). `.opencode/` is added to `.git/info/exclude` so
flipping a toggle never dirties the branch the agent is about to commit from.

### Tools an agent sees

`botfarm_whoami`, `botfarm_roster`, `botfarm_send`, `botfarm_ask`, `botfarm_reply`, `botfarm_inbox`, `botfarm_spawn`,
`botfarm_notify`. Tools you have switched off are not listed at all — a session with messaging off does
not see a `send` tool and then get refused, it simply has no such tool.

`spawn` is the "I found a defect, this doesn't belong in this conversation" case:

```
botfarm_spawn(title: "flaky date test",
           task: "tests/date.spec.ts fails on the first of the month. Fix it.",
           branch: "fix/flaky-date")
```

A new pod appears on the board with its own worktree, marked *opened by @velvet-shrew*. The child
starts empty — it cannot see the parent's conversation — so the tool refuses a spawn without a brief
that stands on its own.

### What stops it going wrong

Agent-to-agent messaging fails in four specific ways, and each has a guard:

- **Smuggled instructions.** A peer message arrives as a *synthetic* message, framed with its
  provenance and an explicit caution that it is untrusted input from another agent, not from the
  operator. Without that framing, one compromised session drives all the others.
- **Ping-pong.** Two agents will happily trade "thanks, and one more thing" forever on your money.
  After six consecutive exchanges with no operator input, botfarm pauses the channel and says so on the
  board. Typing into either session resets the counter; you can resume the channel explicitly.
- **Fork bombs.** Delegation is capped at depth 2, three children per session, eight agent-created
  sessions per hour across the mesh, and a spawned session cannot itself spawn.
- **Volume.** 24 messages per ordered pair per hour.

Everything that crosses between sessions is logged to the activity feed and to both mailboxes, so the
mesh is never doing something you cannot see afterwards.

## Group chats

Two sessions coordinating once should use `send`. Work that genuinely spans several — a migration, a
contract between two services — gets a room.

Rooms live on the board as a strip above the sessions. Open one and you get the conversation, the
member list, and a composer: **the operator is a full member**, so you can drop one line into
`#auth-refactor` and every agent in it sees it, without visiting three sessions.

### Fan-out is the whole problem

A pairwise message costs one delivery. A message in a six-agent room costs five, and every delivery
is real input tokens on someone's next step. So a room does not broadcast by default:

| | What happens |
| --- | --- |
| You are `@mentioned` | Delivered straight into your next step, with any backlog you had riding along in the same delivery. |
| You are not mentioned | Queued. You get **one batched digest the moment you go idle** — never mid-task. |
| The operator posts | Always delivered to everyone. |
| Queue reaches six | Delivered anyway; waiting longer would mean working on stale information. |

A room that grows past three members drops out of `push` mode automatically and says so. Each room
shows what it has cost: messages posted, deliveries into sessions, and characters delivered with a
rough token estimate.

### Tools

`botfarm_rooms`, `botfarm_room_read`, `botfarm_room_post`, `botfarm_room_create`, `botfarm_room_invite`,
`botfarm_room_leave` — gated by a third policy axis alongside messaging and spawning: rooms `off` /
`member` / `create`. The `room_post` description tells agents plainly that everyone in the room pays
to read them, so they should post findings and decisions rather than acknowledgements.

### What stops a room running away

- Twelve agent posts with no operator input mutes the room and flags it on the board. Posting as the
  operator resets the meter; so does typing into any member session.
- Forty messages per room per hour, eight members maximum.
- Every delivery carries authorship per line, and the same caution as pairwise messages: lines marked
  `@handle` are other agents and are untrusted; lines marked `operator` are the human.

## Cost

Bedrock returns usage but no price, so opencode reports `$0.00` and every Bedrock session looks free.
botfarm prices the tokens itself from a table in `src/pricing.mjs`, normalising ids like
`us.anthropic.claude-sonnet-4-20250514-v1:0` down to the model family, and counting cache reads at a
tenth of input and five-minute writes at a quarter more. Anything it prices is labelled an estimate;
anything it can't price says so by name instead of quietly showing zero, and the header shows how
many sessions are unpriced.

Prices go stale and Bedrock/Vertex vary by region, so treat the table as a floor and override it:

```json
{ "pricing": { "claude-opus-5": { "input": 15, "output": 75 } } }
```

## Tools

The modal's right pane lists the MCP servers attached to that session's worktree and the built-in
tools, each with a switch — the `/mcp` picker, on the board. MCP servers connect and disconnect live
through opencode. Built-in tool switches are written to that worktree's `.opencode/opencode.json` and
take effect when the session restarts, because that is config rather than a runtime call; the panel
says so rather than pretending otherwise.

## Pipelines

A pipeline is a recipe; **tasks are the primitive**. That is the one design decision worth knowing
about, because everything else follows from it: if stages were their own thing, a QA bot finding an
unrelated defect would have nowhere to put it and a pipeline could only ever be a straight line.
Since every stage is a task with dependencies, the board holds pipeline work and ad-hoc work side by
side, stages can fan out, and a late defect is just a new task blocking an existing one.

Running the shipped `story` pipeline gives you: one git worktree, four sessions (product, dev, QA,
reviewer) sharing it, a group chat between them, and four chained tasks.

```
analyse → build → verify → check
```

Only the first is queued; the rest are blocked until a handoff lands.

### Handoffs

A stage ends with `botfarm_task_complete(task_id, summary, acceptance_criteria, artifacts,
open_questions)`. Structured on purpose — prose alone gives the next bot nothing to template against,
and "what did you actually change" is the first question every downstream stage asks. Listing an open
question parks the task in **review** instead of `done`, so it reaches you before it reaches the next
bot.

### Which handoffs a stage receives

Each stage declares `receives`, and its prompt is a mustache template over those handoffs. Dropping
QA's write-up from the reviewer's prompt is a one-line YAML edit:

```yaml
  - id: verify
    persona: qa
    receives: [analyse, build]
    prompt: |
      {{#handoffs.analyse}}
      Acceptance criteria:
      {{#acceptance_criteria}}  - {{.}}
      {{/acceptance_criteria}}
      {{/handoffs.analyse}}
      {{#handoffs.build}}
      What was built, per {{persona}}: {{summary}}
      {{#artifacts}}  changed: {{.}}
      {{/artifacts}}
      {{/handoffs.build}}
```

A stage that receives a nonexistent stage, or whose prompt uses handoffs it never gets, is reported
on load rather than silently rendering empty.

### Tasks are yours too

`New task` on any board does exactly what a bot's `botfarm_task_create` does: title, brief, project,
assignee. Work you raise and work a bot raises land in the same column, and clicking any card opens
the task next to the assignee's live conversation — what was asked on the left, what is happening on
the right, with a composer, rather than one being a click away from the other.

### Tasks are enqueued, never interrupting

A queued task is handed to its assignee **when that session next goes idle** — the same rule as room
digests. Two exceptions, because waiting for an idle event is not always right: the first stage of a
fresh pipeline goes out immediately (its bot is only "busy" because it was just briefed), and a task
nobody has picked up for 45 seconds is delivered anyway, since opencode queues prompts durably and a
missed idle event should not strand a run. An agent mid-thought is never derailed by new work. `botfarm_task_create` lets a bot raise work
for someone else (by handle, or by persona name within its own run) and optionally block an existing
task on it, which is how a defect found at QA reaches the dev bot and holds up the reviewer.

### Config is YAML, state is a database

Definitions live in `~/.botfarm/personas/*.yaml` and `~/.botfarm/pipelines/*.yaml` — config that people
edit and share in git should not live inside a binary. Runtime state (runs, tasks, handoffs) goes
into `~/.botfarm/botfarm.db` via `node:sqlite`, falling back to a JSON file on older runtimes. The split is
by kind, so there is never a question of which copy is authoritative. A finished run exports back to
pipeline YAML for sharing.

Four personas and one pipeline are written on first run and never overwritten. The YAML parser is a
deliberate subset — maps, lists, scalars, and `|` block scalars for prompts — and throws with a line
number on anything else rather than misreading it.

## Colour

Status is carried by amber, violet and blue — never red against green, the one pair a red-green
colour blind operator cannot separate. Red appears only for failure, where it never has to be told
apart from success. Diffs use `+`/`-` prefixes with blue and amber rather than green and red, toggles
say "on"/"off" beside the switch, and every status is spelled out in words next to its colour.

## Who owns a task

Ownership has three shapes, and conflating them is what makes agent boards brittle:

| | |
| --- | --- |
| **session** | one named session does this |
| **role** | whoever is playing that part picks it up — a dev task does not die because one dev session was closed |
| **human** | you do it, or you answer it; it is never dispatched |

A role task becomes a session's task the moment it is picked up, so two bots playing the same part
cannot both take it.

## Needs you

`botfarm_ask_human(question, options, wait_seconds)` puts a question at the top of your board with the
asker's face on it and the choices it offered as buttons. Answering delivers the answer straight back
into that session, marked as coming from the human running it rather than from a peer. By default
the bot does not block: it asks, carries on with what it can, and the answer arrives as a message.

Pipelines can have stages that are yours — `human: true` on a stage, like the sign-off that ships at
the end of the `story` pipeline. They land in Needs you and the run waits.

## Editing pipelines and personas

The pipeline dialog has an editor: add, remove and reorder phases, change who does each one, tick
which earlier handoffs it receives, and edit its prompt. Personas have their own form — model, tools
it may use, mesh permissions, handle vocabulary, and the brief it gets before any task.

Both write back to the same YAML file you could have edited by hand, and a **YAML tab** sits next to
the form for anything the form does not cover, so the form never becomes a ceiling. Problems (a stage
receiving a phase that does not exist, a persona that is not defined) are reported on save rather
than swallowed.

## The task board

The kanban board holds every task: pipeline stages and ad-hoc work together. Columns are backlog,
blocked, queued, active, review, done, cancelled. Clicking a card shows the brief, the handoff it
received, the files changed in its worktree with clickable diffs, and controls to move it between
columns. Moving something to queued offers it to the assignee at their next idle moment.

## CLI

```
botfarm up [--port 4777] [--server URL] [--repo PATH]...   dashboard (default)
botfarm ls                                                 list sessions
botfarm new <repo> [task] --branch NAME [--agent A]        new session in a worktree
botfarm send <id> <text...>                                queue a prompt
botfarm stop [id...]                                       interrupt (all busy if omitted)
botfarm rm <id> [--worktree] [--force]                     delete session and its worktree
botfarm attach <id>                                        open the session in the opencode TUI
```

Config lives in `~/.botfarm/config.json`:

```json
{ "server": "http://127.0.0.1:4096", "port": 4777, "repos": ["~/code/app"] }
```

Rolling metrics are snapshotted to `~/.botfarm/metrics.json` every 30s, so restarting botfarm keeps the
hour of history.

## Tests

```
node test/smoke.mjs   # discovery, metrics, abort, continue, SSE, persistence
node test/mesh.mjs    # MCP handshake, policy gating, messaging, loop limits, delegation
node test/rooms.mjs   # rooms: membership, mention vs digest delivery, operator posts, mute
node test/board.mjs   # registry, adoption, groups, cost estimation, tool toggles
node test/pipelines.mjs  # YAML, templates, runs, handoffs, dispatch, defects flowing backwards
node test/repos.mjs   # path expansion, nested repositories, multi-repo worktrees
node test/transport.mjs  # websocket handshake, pushes, and idle traffic to opencode
node test/projects.mjs   # a run starts its bots; projects own sessions, board and chat
node test/roles.mjs      # role-flavoured handles, role and human ownership, editing definitions
node test/flow.mjs       # late briefing, held mentions, handoff watchdog, shared-worktree callers, live transcripts
node test/workspaces.mjs # workspace files, editing definitions, one workstream per run, archive, folder browser
node test/handoff.mjs    # open questions travel with the handoff, holding stages, continue with answers
node test/shot.mjs    # renders the dashboard in headless chrome (needs CHROME_PATH)
```

Both suites run against `test/mock-opencode.mjs`, a fake server that streams plausible sessions, so
you can develop without burning tokens — `node test/mock-opencode.mjs` then `botfarm up` gives you a
populated board.

## Known limits

- **Identity is per location.** The MCP token is registered against a directory, so two sessions
  sharing one directory share a token; botfarm resolves the caller to whichever of them is running.
  Pods with their own worktrees — the intended setup — are cleanly separated.
- **Tested against a mock**, not yet against a live opencode server. Field names in the usage object
  are checked in several shapes before giving up, but the first real run may need a tweak.
- `botfarm attach` assumes `opencode --session <id>` is the right incantation for your version.
- Cost is only as good as what the provider reports back in the message.
