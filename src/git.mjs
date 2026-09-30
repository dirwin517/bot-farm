// Git worktree plumbing. Each botfarm "pod" can own an isolated worktree so
// parallel sessions never fight over the same checkout.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, join, resolve, relative, dirname } from "node:path"
import { homedir } from "node:os"
import { stat, lstat, readdir, cp, realpath, symlink, unlink, mkdir as mkdirp, readFile as readF, writeFile as writeF } from "node:fs/promises"

const run = promisify(execFile)

/**
 * Paths arrive from text boxes and YAML, where "~/workspace/thing" is what a
 * person types. Node does not expand it — the shell does — so without this
 * every path with a tilde becomes a nonexistent relative directory and git
 * fails with something that looks nothing like the real problem.
 */
export function expandPath(input) {
  if (!input) return input
  let p = String(input).trim()
  if (p === "~") p = homedir()
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2))
  p = p.replace(/\$(\w+)|\$\{(\w+)\}/g, (m, a, b) => process.env[a ?? b] ?? m)
  return resolve(p)
}

/**
 * What is actually at this path — so the dashboard can say "no such directory"
 * or "not a git repository" rather than conflating the two.
 */
export async function inspect(input) {
  const path = expandPath(input)
  let info
  try {
    info = await stat(path)
  } catch {
    return { path, exists: false, isRepo: false, reason: "no such directory" }
  }
  if (!info.isDirectory()) return { path, exists: true, isRepo: false, reason: "not a directory" }
  const root = await repoRoot(path)
  if (!root) return { path, exists: true, isRepo: false, reason: "not a git repository — run git init, or point at the repo above it" }
  const nested = await nestedRepos(root)
  return { path, root, exists: true, isRepo: true, nested, branch: (await status(root))?.branch ?? null }
}

/**
 * Repositories checked out *inside* another repository — the common
 * "parent project with the services cloned into a gitignored folder" layout.
 * Found on the filesystem rather than via git, precisely because the parent
 * ignores them and so git will not mention them.
 */
export async function nestedRepos(root, { maxDepth = 3 } = {}) {
  const out = []
  const skip = new Set(["node_modules", ".git", "target", "build", "dist", "vendor", ".venv", "__pycache__"])
  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith(".")) continue
      const full = join(dir, e.name)
      let isRepo = false
      try {
        await stat(join(full, ".git"))
        isRepo = true
      } catch {}
      if (isRepo) {
        out.push({ path: full, rel: relative(root, full), name: e.name, branch: (await status(full))?.branch ?? null })
        continue // a repo inside a repo inside a repo is somebody else's problem
      }
      await walk(full, depth + 1)
    }
  }
  await walk(root, 1)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/**
 * In a worktree, `.git` is a file pointing elsewhere, so <dir>/.git/info/exclude
 * does not exist. Ask git where its directory actually is.
 */
export async function gitDir(dir) {
  try {
    // The *common* dir, not the per-worktree one: git reads info/exclude from
    // the shared directory, so writing to the worktree's own has no effect.
    return (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  } catch {
    return null
  }
}

export async function excludeLocally(dir, pattern) {
  const gd = await gitDir(dir)
  if (!gd) return false
  const { mkdir, readFile, appendFile } = await import("node:fs/promises")
  const file = join(gd, "info", "exclude")
  await mkdir(join(gd, "info"), { recursive: true })
  const current = await readFile(file, "utf8").catch(() => "")
  if (current.split("\n").includes(pattern)) return true
  await appendFile(file, (current.endsWith("\n") || !current ? "" : "\n") + pattern + "\n")
  return true
}

export async function repoRoot(dir) {
  try {
    return (await git(expandPath(dir), ["rev-parse", "--show-toplevel"])).trim()
  } catch {
    return null
  }
}

export async function commonDir(dir) {
  // For a worktree this resolves to the main repo's .git dir, which is how we
  // group worktrees back to their parent repository.
  try {
    const out = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    return out.replace(/\/\.git$/, "")
  } catch {
    return null
  }
}

export async function listWorktrees(repo) {
  const out = await git(repo, ["worktree", "list", "--porcelain"])
  const trees = []
  let cur = null
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9).trim(), branch: null, detached: false, locked: false }
      trees.push(cur)
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice(7).trim().replace("refs/heads/", "")
    } else if (line === "detached" && cur) {
      cur.detached = true
    } else if (line.startsWith("locked") && cur) {
      cur.locked = true
    }
  }
  return trees
}

export function defaultWorktreePath(repo, branch) {
  const root = process.env.BOT_FARM_WORKTREE_ROOT || join(homedir(), "worktrees")
  return join(root, basename(repo), branch.replace(/[^\w.-]+/g, "-"))
}

export async function addWorktree(repo, branch, { path, base } = {}) {
  const target = expandPath(path ?? defaultWorktreePath(repo, branch))
  const existing = await listWorktrees(repo)
  const hit = existing.find((w) => w.path === target || w.branch === branch)
  if (hit) return { path: hit.path, branch: hit.branch ?? branch, reused: true }

  const branches = (await git(repo, ["branch", "--list", branch])).trim()
  const args = branches
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target, base ?? (await defaultBase(repo))]
  await git(repo, args)
  return { path: target, branch, reused: false }
}

export async function removeWorktree(repo, path, { force = false } = {}) {
  await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path])
}

/** Delete a local branch (never a remote one). */
export async function deleteBranch(repo, branch) {
  await git(expandPath(repo), ["branch", "-D", branch])
}

/**
 * Commits on `branch` that no other branch or remote contains: the work that
 * would be lost for good if the branch went away. null if there is no branch.
 */
export async function unmergedCommits(repo, branch) {
  repo = expandPath(repo)
  try {
    await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])
  } catch {
    return null
  }
  const out = await git(repo, ["rev-list", "--count", branch, "--not", `--exclude=refs/heads/${branch}`, "--branches", "--remotes"]).catch(() => "0")
  return Number(out.trim()) || 0
}

async function defaultBase(repo) {
  for (const candidate of ["HEAD"]) {
    try {
      await git(repo, ["rev-parse", "--verify", candidate])
      return candidate
    } catch {}
  }
  return "HEAD"
}

/**
 * One worktree per repository, laid out exactly like the original tree.
 *
 * For a parent project whose services live in a gitignored folder, this is the
 * layout that actually works: a worktree of the parent, and a worktree of each
 * selected service placed at the same relative path inside it. Every repo ends
 * up on its own branch and the agent sees the directory structure it expects.
 */
export async function addWorktreeSet(repo, branch, { path, include = [], base } = {}) {
  const root = await repoRoot(repo)
  if (!root) throw new Error(`${expandPath(repo)} is not a git repository`)
  const parent = await addWorktree(root, branch, { path, base })
  const children = []
  for (const svc of serviceSources(root, include)) children.push(await addServiceWorktree(parent.path, svc, branch, { base }))
  return { ...parent, children }
}

const MOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

/**
 * A workspace's extra repositories, as { source, rel, external }. An entry is
 * a path relative to the workspace (a repo nested inside it), or an absolute
 * / ~ path to a repo anywhere else — mounted in the worktree under its folder
 * name, or under `as` with { path, as }.
 */
export function serviceSources(root, services = []) {
  const out = []
  for (const e of services ?? []) {
    const o = typeof e === "string" ? { path: e } : e ?? {}
    const p = String(o.path ?? "").trim()
    if (!p) continue
    const abs = p.startsWith("/") || p.startsWith("~")
    const source = abs ? expandPath(p) : join(root, p)
    const inside = root && (source === root || source.startsWith(root + "/"))
    if (inside && source === root) continue
    const rel = inside ? relative(root, source) : String(o.as || basename(source))
    out.push({ source, rel, external: !inside, entry: e })
  }
  return out
}

/** Check an extra repo before it is added: a repo, and a mount name that is free. */
export async function checkService(root, entry, { taken = [] } = {}) {
  const [svc] = serviceSources(root, [entry])
  if (!svc) throw new Error("give a folder: a path inside the workspace, or an absolute or ~ path to a repo")
  const top = await repoRoot(svc.source)
  if (!top) throw new Error(`${svc.source} is not a git repository`)
  if (svc.external && !MOUNT_RE.test(svc.rel)) throw new Error(`"${svc.rel}" cannot be a folder name in the worktree — pick another with "as"`)
  if (taken.includes(svc.rel)) throw new Error(`the worktree already has something at ${svc.rel}/ — pick another name with "as"`)
  return { ...svc, source: svc.external ? top : svc.source }
}

/**
 * One extra repo's worktree, placed inside the parent worktree at its mount,
 * on the same branch. A repo from outside the workspace is also hidden from
 * the parent's git status (info/exclude), as nested services usually are by
 * .gitignore.
 */
export async function addServiceWorktree(parentPath, svc, branch, { base } = {}) {
  const target = join(parentPath, svc.rel)
  try {
    await mkdirp(dirname(target), { recursive: true })
    const wt = await addWorktree(svc.source, branch, { path: target, base })
    if (svc.external) await excludeInRepo(parentPath, svc.rel).catch(() => {})
    const out = { ...wt, rel: svc.rel, source: svc.source, external: svc.external }
    if (wt.path !== target) out.error = `${branch} is already checked out in ${svc.source} at ${wt.path}, so it is not in this worktree`
    return out
  } catch (err) {
    return { rel: svc.rel, source: svc.source, external: svc.external, path: target, error: err.message }
  }
}

async function excludeInRepo(dir, rel) {
  const common = (await git(dir, ["rev-parse", "--git-common-dir"])).trim()
  const file = join(resolve(dir, common), "info", "exclude")
  const line = `/${rel}/`
  const text = await readF(file, "utf8").catch(() => "")
  if (text.split("\n").includes(line)) return
  await mkdirp(dirname(file), { recursive: true })
  await writeF(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# a repo BotFarm mounts in its worktrees\n${line}\n`)
}

export async function removeWorktreeSet(worktreePath, { force = false } = {}) {
  const removed = []
  const nested = await nestedRepos(worktreePath).catch(() => [])
  for (const child of nested) {
    const common = await commonDir(child.path)
    if (common && common !== child.path) {
      await removeWorktree(common, child.path, { force }).catch(() => {})
      removed.push(child.rel)
    }
  }
  const common = await commonDir(worktreePath)
  if (common && common !== worktreePath) await removeWorktree(common, worktreePath, { force })
  return removed
}

/** Cheap status summary used on the session cards. */
export async function status(dir) {
  dir = expandPath(dir)
  try {
    const [porcelain, shortstat] = await Promise.all([
      git(dir, ["status", "--porcelain=v1", "-b"]),
      git(dir, ["diff", "--shortstat", "HEAD"]).catch(() => ""),
    ])
    const lines = porcelain.split("\n").filter(Boolean)
    const head = lines.find((l) => l.startsWith("##")) ?? ""
    const files = lines.filter((l) => !l.startsWith("##"))
    const m = /## (?<branch>[^.\s]+)(\.\.\.\S+)?( \[(?<track>[^\]]+)\])?/.exec(head)
    const ss = /(\d+) insertion[^\d]*(\d+)? ?/.exec(shortstat)
    const del = /(\d+) deletion/.exec(shortstat)
    return {
      branch: m?.groups?.branch ?? null,
      tracking: m?.groups?.track ?? null,
      dirty: files.length,
      staged: files.filter((l) => l[0] !== " " && l[0] !== "?").length,
      untracked: files.filter((l) => l.startsWith("??")).length,
      insertions: ss ? Number(ss[1]) : 0,
      deletions: del ? Number(del[1]) : 0,
      files: files.slice(0, 40).map((l) => ({ code: l.slice(0, 2).trim(), path: l.slice(3) })),
    }
  } catch {
    return null
  }
}

export async function lastCommit(dir) {
  try {
    const out = await git(dir, ["log", "-1", "--pretty=%h %s"])
    return out.trim()
  } catch {
    return null
  }
}

/**
 * Files changed against HEAD, for the task's diff view. Walks nested
 * repositories as well: in a parent-plus-services layout the parent's git
 * knows nothing about the changes that matter most.
 */
export async function changedFiles(dir, { includeNested = true } = {}) {
  if (!dir) return []
  const own = await changedIn(dir)
  if (!includeNested) return own
  const nested = await nestedRepos(expandPath(dir)).catch(() => [])
  for (const child of nested) {
    for (const row of await changedIn(child.path)) {
      own.push({ ...row, repo: child.rel, path: join(child.rel, row.path) })
    }
  }
  return own
}

async function changedIn(dir) {
  dir = expandPath(dir)
  try {
    const [tracked, untracked] = await Promise.all([
      git(dir, ["diff", "--numstat", "HEAD"]).catch(() => ""),
      git(dir, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
    ])
    const rows = tracked
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [add, del, path] = l.split("\t")
        return { path, added: Number(add) || 0, removed: Number(del) || 0, untracked: false }
      })
    for (const path of untracked.split("\n").filter(Boolean)) {
      rows.push({ path, added: 0, removed: 0, untracked: true })
    }
    return rows
  } catch {
    return []
  }
}

export async function diffFile(dir, file) {
  dir = expandPath(dir)
  // The path may belong to a nested repo, in which case ask that repo.
  const nested = await nestedRepos(dir).catch(() => [])
  const owner = nested.find((c) => file.startsWith(c.rel + "/"))
  if (owner) return diffIn(owner.path, file.slice(owner.rel.length + 1))
  return diffIn(dir, file)
}

async function diffIn(dir, file) {
  try {
    const out = await git(dir, ["diff", "HEAD", "--", file])
    if (out.trim()) return out
    // untracked files have no diff, so show the file as added
    const body = await git(dir, ["show", `:${file}`]).catch(() => null)
    return body ?? (await import("node:fs/promises")).readFile(join(dir, file), "utf8").catch(() => "")
  } catch {
    return ""
  }
}


/**
 * A worktree only has what git tracks. opencode's project config — the MCP
 * servers, agents, commands and rules a repository is set up with — is often
 * untracked or ignored, so a bot in a fresh worktree would start without any
 * of it. Copy whatever the checkout has and the worktree lacks; never
 * overwrite something already there.
 */
export const CONFIG_FILES = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md", "CLAUDE.md", ".mcp.json"]
const OWN_FILES = new Set(["opencode.json", "opencode.jsonc"]) // the ones botfarm may write to

export async function carryConfig(from, to) {
  const carried = []
  if (!from || !to || resolve(from) === resolve(to)) return carried
  for (const name of CONFIG_FILES) {
    const src = join(from, name)
    let info
    try { info = await stat(src) } catch { continue }
    if (name === ".opencode" && info.isDirectory()) {
      if (await linkOpencodeDir(src, join(to, name))) carried.push(name)
      continue
    }
    await cp(src, join(to, name), { recursive: true, force: false, errorOnExist: false }).then(
      () => carried.push(name),
      () => {},
    )
  }
  return carried
}

/**
 * A worktree's .opencode must be a real folder botfarm can write its own MCP
 * entry into — never a link to the checkout's folder, or the write lands in
 * the user's shared config. Everything in it is linked back to the original
 * (plugins, instructions, node_modules stay shared and current); only
 * opencode.json(c), the file botfarm edits, is a real copy.
 */
export async function linkOpencodeDir(src, dest) {
  const real = await realpath(src).catch(() => null)
  if (!real) return false
  try {
    const l = await lstat(dest)
    if (l.isSymbolicLink()) await unlink(dest) // an older botfarm linked the whole folder
    else if (!l.isDirectory()) return false
  } catch {}
  await mkdirp(dest, { recursive: true })
  for (const name of await readdir(real)) {
    const target = join(dest, name)
    const exists = await lstat(target).then(() => true, () => false)
    if (exists) continue
    if (OWN_FILES.has(name)) await writeF(target, await readF(join(real, name)))
    else await symlink(join(real, name), target).catch(() => {})
  }
  return true
}

/** Make sure <dir>/.opencode is a real folder before anything is written to it. */
export async function ensureOwnOpencodeDir(dir) {
  const dest = join(dir, ".opencode")
  const l = await lstat(dest).catch(() => null)
  if (l?.isSymbolicLink()) return linkOpencodeDir(dest, dest + ".__tmp").then(async () => {
    // Swap the link for the real folder built next to it.
    const { rename } = await import("node:fs/promises")
    await unlink(dest)
    await rename(dest + ".__tmp", dest)
    return true
  })
  await mkdirp(dest, { recursive: true })
  const f = join(dest, "opencode.json")
  const fl = await lstat(f).catch(() => null)
  if (fl?.isSymbolicLink()) { const body = await readF(f); await unlink(f); await writeF(f, body) }
  return true
}

// --- what a card changed, however it changed it ------------------------------
//
// Bots change files through opencode's own tools, through MCP servers (which
// write straight to disk), or by running scripts. None of that is visible in
// one place — but all of it is visible to git. So at the start of a card we
// record the content of every file that already differs from HEAD (as blobs in
// the repo's object store), and at the end we compare: any file whose content
// moved is a file this card changed, and the diff is from where it stood when
// the card began, not from HEAD.

const SNAP_MAX = 800

async function statusPaths(dir) {
  const out = await git(dir, ["status", "--porcelain=v1", "-uall", "-z"]).catch(() => "")
  const paths = []
  const parts = out.split("\0").filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2)
    paths.push(parts[i].slice(3))
    if (code.startsWith("R") || code.startsWith("C")) i++ // renames carry the old path next
  }
  return paths
}

async function blobOf(dir, file) {
  const out = await git(dir, ["hash-object", "-w", "--", file]).catch(() => null)
  return out ? out.trim() : null
}

async function headBlob(dir, file) {
  const out = await git(dir, ["rev-parse", "--verify", "--quiet", `HEAD:${file}`]).catch(() => null)
  return out ? out.trim() : null
}

/** { repos: { rel: { head, files: { path: blob|null } } } } for the worktree and its nested service repos. */
export async function snapshot(dir) {
  dir = expandPath(dir)
  if (!dir) return null
  const repos = [{ rel: "", path: dir }, ...(await nestedRepos(dir).catch(() => [])).map((c) => ({ rel: c.rel, path: c.path }))]
  const snap = { at: Date.now(), repos: {} }
  let n = 0
  for (const r of repos) {
    const head = (await git(r.path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null
    const files = {}
    for (const f of await statusPaths(r.path)) {
      if (n++ >= SNAP_MAX) break
      files[f] = await blobOf(r.path, f)
    }
    snap.repos[r.rel] = { head, files }
  }
  return snap
}

/**
 * Files whose content changed since `snap`, with a diff from then to now.
 * Tool-agnostic: it only looks at the files on disk.
 */
export async function changesSince(dir, snap, { maxFiles = 40, maxBytes = 160_000, perFile = 24_000 } = {}) {
  dir = expandPath(dir)
  if (!dir || !snap?.repos) return []
  const out = []
  let budget = maxBytes
  for (const [rel, base] of Object.entries(snap.repos)) {
    const repo = rel ? join(dir, rel) : dir
    const head = (await git(repo, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null
    // Everything dirty now, plus everything that was dirty then (it may have been reverted),
    // plus whatever a commit made during the card touched.
    const paths = new Set([...(await statusPaths(repo)), ...Object.keys(base.files ?? {})])
    if (head && base.head && head !== base.head) {
      for (const f of (await git(repo, ["diff", "--name-only", base.head, head]).catch(() => "")).split("\n").filter(Boolean)) paths.add(f)
    }
    for (const f of paths) {
      if (out.length >= maxFiles) break
      const before = f in (base.files ?? {}) ? base.files[f] : base.head ? await git(repo, ["rev-parse", "--verify", "--quiet", `${base.head}:${f}`]).then((s) => s.trim() || null, () => null) : null
      const exists = await stat(join(repo, f)).then((s) => s.isFile(), () => false)
      const after = exists ? await blobOf(repo, f) : null
      if (before === after) continue
      let diff = ""
      if (before && after) diff = await git(repo, ["diff", "--no-color", before, after]).catch(() => "")
      else if (after) diff = (await git(repo, ["cat-file", "-p", after]).catch(() => "")).replace(/\n$/, "").split("\n").map((l) => "+" + l).join("\n")
      else if (before) diff = (await git(repo, ["cat-file", "-p", before]).catch(() => "")).replace(/\n$/, "").split("\n").map((l) => "-" + l).join("\n")
      const path = rel ? `${rel}/${f}` : f
      // Blob diffs are headed with object ids; put the file name back.
      diff = diff.replace(/^diff --git a\/\S+ b\/\S+\n/, "").replace(/^index [0-9a-f.]+\n/m, "").replace(/^--- .*\n\+\+\+ .*\n/m, "")
      diff = `--- ${before ? "a/" + path : "/dev/null"}\n+++ ${after ? "b/" + path : "/dev/null"}\n${before && after ? "" : before ? "@@ deleted @@\n" : "@@ new file @@\n"}${diff}`
      const lines = diff.split("\n")
      const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
      const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length
      const binary = /\0/.test(diff.slice(0, 8000)) || /\.(png|jpe?g|gif|webp|jar|class|zip|pdf)$/i.test(f)
      const cap = Math.min(perFile, Math.max(0, budget))
      const truncated = binary || diff.length > cap
      const text = binary ? "" : diff.slice(0, cap)
      budget -= text.length
      out.push({ file: path, added: binary ? 0 : added, removed: binary ? 0 : removed, truncated, binary, created: !before, deleted: !after, diff: text })
    }
  }
  return out
}

/** Did anything in the worktree change since `snap`? (Cheap: stops at the first change.) */
export async function changedSince(dir, snap) {
  const c = await changesSince(dir, snap, { maxFiles: 1, maxBytes: 0, perFile: 0 }).catch(() => [])
  return c.length > 0
}
