// A workstream's work as patches, applied to the real checkouts.
//
// Each repo in the workstream (the parent worktree, nested service worktrees,
// linked repos from elsewhere) gives one patch: everything its worktree has
// that the real repo does not yet — commits on the branch and uncommitted
// edits and new files — measured from where the two last met (merge-base).
// The worktree's own index is never touched: the working state is snapshotted
// through a throwaway index. BotFarm's own files (.opencode, opencode.json and
// friends it carried in, nested repos) are left out.
//
// Applying tries, per repo: a clean `git apply` (changes land unstaged, ready
// to review), then a 3-way apply (conflict markers, like a merge), then
// `--reject` (what fits is applied, the rest left in .rej files). Nothing is
// ever committed; a clean apply can be undone.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile, unlink, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import * as git from "./git.mjs"

const run = promisify(execFile)
const g = (cwd, args, env = null) => run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }).then((r) => r.stdout)
const gTry = (cwd, args) => run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }).then((r) => ({ ok: true, out: `${r.stdout}${r.stderr}` }), (e) => ({ ok: false, out: `${e.stdout ?? ""}${e.stderr ?? e.message}` }))

// Files BotFarm puts in a worktree that are not the work.
const ALWAYS_SKIP = [".opencode", "opencode.json", "opencode.jsonc", ".mcp.json", ".botfarm"]
const SKIP_IF_UNTRACKED = ["AGENTS.md", "CLAUDE.md"]

/** The repos of a workstream: { rel, worktree, real } — rel "" is the parent. */
export function workstreamRepos(project) {
  const root = project.repo
  const out = [{ rel: "", name: basename(root ?? ""), worktree: project.worktree, real: root }]
  for (const s of git.serviceSources(root, project.services ?? [])) out.push({ rel: s.rel, name: s.rel, worktree: join(project.worktree, s.rel), real: s.source, external: s.external })
  return out
}

async function tracked(dir, rev, path) {
  return g(dir, ["cat-file", "-e", `${rev}:${path}`]).then(() => true, () => false)
}

/** One repo's patch: { rel, base, files: [{path, added, removed}], patch } or { error }. */
export async function repoPatch(repo, { skipDirs = [] } = {}) {
  const dir = repo.worktree
  if (!dir || !(await stat(dir).then(() => true, () => false))) return { ...repo, error: "its worktree is gone" }
  try {
    const head = (await g(dir, ["rev-parse", "HEAD"])).trim()
    const realHead = (await g(repo.real, ["rev-parse", "HEAD"]).catch(() => "")).trim()
    const base = realHead ? (await g(dir, ["merge-base", head, realHead]).catch(() => head)).trim() || head : head
    const skip = [...ALWAYS_SKIP]
    for (const f of SKIP_IF_UNTRACKED) if (!(await tracked(dir, base, f))) skip.push(f)
    // Nested repos (services, linked repos) are their own patches.
    const nested = (await git.nestedRepos(dir).catch(() => [])).map((n) => n.rel)
    const excl = [...new Set([...skip, ...skipDirs, ...nested])].map((p) => `:(exclude,top)${p}`)
    const index = join(tmpdir(), `botfarm-idx-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    let tree
    try {
      const env = { GIT_INDEX_FILE: index }
      await g(dir, ["read-tree", head], env)
      // Everything git would see (ignored files stay out), then take BotFarm's
      // own files and the nested repos back out of the throwaway index.
      await g(dir, ["add", "-A", "--", "."], env)
      const drop = [...new Set([...skip, ...skipDirs, ...nested])]
      if (drop.length) await g(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...drop], env)
      tree = (await g(dir, ["write-tree"], env)).trim()
    } finally {
      await unlink(index).catch(() => {})
    }
    const spec = ["--", ".", ...excl]
    const numstat = await g(dir, ["diff", "--numstat", base, tree, ...spec])
    const files = numstat.split("\n").filter(Boolean).map((l) => {
      const [a, r, ...p] = l.split("\t")
      return { path: p.join("\t"), added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) }
    })
    const patch = files.length ? await g(dir, ["diff", "--binary", "--full-index", "--no-color", base, tree, ...spec]) : ""
    const commits = Number((await g(dir, ["rev-list", "--count", `${base}..${head}`]).catch(() => "0")).trim()) || 0
    const realBranch = (await g(repo.real, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null
    const realDirty = (await g(repo.real, ["status", "--porcelain"]).catch(() => "")).split("\n").filter(Boolean).map((l) => l.slice(3))
    const overlap = files.filter((f) => realDirty.includes(f.path)).map((f) => f.path)
    return { ...repo, base, head, tree, commits, files, patch, realBranch, realDirty: realDirty.length, overlap }
  } catch (e) {
    return { ...repo, error: String(e.stderr ?? e.message).trim().slice(0, 500) }
  }
}

/** Every repo's patch, written to `dir` as <n>-<name>.patch. */
export async function buildPatches(project, dir) {
  const repos = workstreamRepos(project)
  const out = []
  await mkdir(dir, { recursive: true })
  for (const [i, r] of repos.entries()) {
    const p = await repoPatch(r)
    if (p.patch) {
      p.file = join(dir, `${String(i + 1).padStart(2, "0")}-${(p.rel || p.name || "repo").replace(/[^\w.-]+/g, "_")}.patch`)
      await writeFile(p.file, p.patch)
    }
    out.push(p)
  }
  return out
}

/** Would it go in cleanly? Without touching the real repo. */
export async function checkApply(p) {
  if (!p.file) return { how: "nothing" }
  const clean = await gTry(p.real, ["apply", "--check", "--whitespace=nowarn", p.file])
  if (clean.ok) return { how: "clean" }
  // Already there (applied before, or you made the same change): it would apply in reverse.
  const back = await gTry(p.real, ["apply", "-R", "--check", "--whitespace=nowarn", p.file])
  if (back.ok) return { how: "present" }
  const three = await gTry(p.real, ["apply", "--check", "--3way", "--whitespace=nowarn", p.file])
  return three.ok ? { how: "3way", why: firstLines(clean.out) } : { how: "conflict", why: firstLines(clean.out) }
}

/** Apply one repo's patch to its real checkout. Never commits. */
export async function applyPatch(p) {
  if (!p.file) return { rel: p.rel, how: "nothing" }
  const clean = await gTry(p.real, ["apply", "--whitespace=nowarn", p.file])
  if (clean.ok) return { rel: p.rel, how: "clean", files: p.files.length }
  // A 3-way apply uses the blobs both sides share, like a merge: conflicts get markers.
  const three = await gTry(p.real, ["apply", "--3way", "--whitespace=nowarn", p.file])
  if (three.ok || /with conflicts/i.test(three.out)) {
    const conflicts = [...three.out.matchAll(/^U (.+)$/gm)].map((m) => m[1].trim())
    return { rel: p.rel, how: conflicts.length ? "conflicts" : "3way", conflicts, note: firstLines(three.out), staged: true }
  }
  const rej = await gTry(p.real, ["apply", "--reject", "--whitespace=nowarn", p.file])
  const rejected = [...rej.out.matchAll(/Rejected hunk #\d+\.|Applying patch (.+?) with (\d+) reject/g)].length
  const files = [...new Set([...rej.out.matchAll(/^(?:Applying patch|Checking patch) (.+?)(?: with| \.\.\.)/gm)].map((m) => m[1]))]
  if (rejected || /Applied patch/.test(rej.out)) return { rel: p.rel, how: "partial", note: firstLines(rej.out), files: files.length, rejects: "look for *.rej files next to the files that did not fit" }
  return { rel: p.rel, how: "failed", note: firstLines(clean.out) }
}

/** Take a clean apply back out. */
export async function undoPatch(p) {
  const check = await gTry(p.real, ["apply", "-R", "--check", "--whitespace=nowarn", p.file])
  if (!check.ok) return { rel: p.rel, undone: false, note: `it has changed since — ${firstLines(check.out)}` }
  const r = await gTry(p.real, ["apply", "-R", "--whitespace=nowarn", p.file])
  return { rel: p.rel, undone: r.ok, note: r.ok ? null : firstLines(r.out) }
}

const firstLines = (s) => String(s ?? "").trim().split("\n").slice(0, 6).join("\n").slice(0, 600)
