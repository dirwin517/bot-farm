// PR packets: what a reviewer needs from a finished workstream, written from
// the handoffs and git — no model involved. Title, story, what each stage did,
// every acceptance criterion with the tests that back it, changed files,
// commits, how to test, what is still open, and what it cost.

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const git = (cwd, args) => run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout.trim(), () => "")

const TEST_FILE = /(^|\/)(test|tests|spec|__tests__|it|features?)(\/|$)|(Test|Tests|IT|Spec)\.(java|kt|groovy|scala)$|\.(test|spec)\.[jt]sx?$|\.feature$/

/** The branch this one will merge into: the first that exists of origin/HEAD, develop, main, master. */
async function baseOf(dir) {
  for (const ref of ["origin/HEAD", "origin/develop", "origin/main", "origin/master", "develop", "main", "master"]) {
    const sha = await git(dir, ["rev-parse", "--verify", "--quiet", ref])
    if (sha) {
      const mb = await git(dir, ["merge-base", "HEAD", ref])
      if (mb) return { ref, sha: mb }
    }
  }
  return null
}

function words(s) {
  // OrderDeleteIT → order delete it: file names are camelCase, criteria are prose.
  return new Set(String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])
}

/** Tests (by path) that look like they back a criterion: shared words between the two. */
function evidenceFor(criterion, tests) {
  const w = words(criterion)
  return tests
    .map((t) => ({ t, n: [...words(t.replace(/[/._-]/g, " "))].filter((x) => w.has(x)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.t)
}

const money = (v) => `$${(v ?? 0).toFixed(v && v < 1 ? 3 : 2)}`
const mins = (ms) => (ms < 3600_000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600_000).toFixed(1)} h`)

/**
 * Build the packet. `stages` are the run's stage cards in order (with
 * handoffs), `bots` the team with tokens/cost, `dir` the worktree.
 */
export async function buildPacket({ project, run, stages, bots, dir, totals }) {
  const base = dir ? await baseOf(dir) : null
  const range = base ? `${base.sha}..HEAD` : "HEAD~20..HEAD"
  const [commits, stat, status] = dir
    ? await Promise.all([
        git(dir, ["log", "--no-merges", "--pretty=%h %s", range]),
        git(dir, ["diff", "--stat", base?.sha ?? "HEAD"]),
        git(dir, ["status", "--short"]),
      ])
    : ["", "", ""]
  const handoffs = stages.filter((t) => t.handoff)
  const criteria = [...new Set(handoffs.flatMap((t) => t.handoff.acceptance_criteria ?? []))]
  const artifacts = [...new Set(handoffs.flatMap((t) => t.handoff.artifacts ?? []))]
  const changed = [...new Set([...artifacts, ...stat.split("\n").map((l) => l.split("|")[0].trim()).filter((l) => l && !/files? changed/.test(l))])]
  const tests = changed.filter((f) => TEST_FILE.test(f))
  const open = [...new Set(handoffs.flatMap((t) => t.handoff.open_questions ?? []))]
  const qa = handoffs.filter((t) => /qa|test|verify/i.test(`${t.persona} ${t.stage}`)).at(-1)
  const storyId = /\b(US|DE|TA|F)\d{2,}\b/i.exec(`${project.name} ${project.story ?? ""}`)?.[0]?.toUpperCase()
  const title = `${storyId && !project.name.toUpperCase().includes(storyId) ? storyId + ": " : ""}${project.name}`
  const firstPara = String(project.story ?? "").split(/\n\s*\n/)[0].trim().slice(0, 1200)

  const lines = [
    `# ${title}`,
    "",
    firstPara ? `> ${firstPara.replace(/\n/g, "\n> ")}` : "",
    "",
    "## What changed",
    ...handoffs.map((t) => `- **${t.stage ?? t.title}** (${t.persona ?? "bot"}): ${String(t.handoff.parts ? `${t.handoff.parts.length} pieces — ${t.handoff.parts.map((p) => p.title).join("; ")}` : t.handoff.summary).split("\n")[0].slice(0, 400)}`),
    "",
    criteria.length ? "## Acceptance criteria" : "",
    ...criteria.map((c) => {
      const ev = evidenceFor(c, tests)
      const flagged = open.some((q) => [...words(q)].filter((w) => words(c).has(w)).length >= 2)
      return `- [${flagged ? " " : "x"}] ${c}${ev.length ? `  \n  _tests:_ ${ev.map((e) => "`" + e + "`").join(", ")}` : ""}${flagged ? "  \n  _still open — see below_" : ""}`
    }),
    "",
    "## Files",
    stat ? "```\n" + stat.split("\n").slice(-40).join("\n") + "\n```" : changed.length ? changed.slice(0, 60).map((f) => `- \`${f}\``).join("\n") : "_No changes found in the worktree._",
    status ? `\nUncommitted in the worktree:\n\`\`\`\n${status.split("\n").slice(0, 30).join("\n")}\n\`\`\`` : "",
    "",
    commits ? "## Commits" : "",
    commits ? commits.split("\n").slice(0, 40).map((c) => `- ${c}`).join("\n") : "",
    "",
    "## How to test",
    qa ? String(qa.handoff.summary).slice(0, 1500) : tests.length ? `Run: ${tests.slice(0, 10).map((t) => "`" + t + "`").join(", ")}` : "_No QA handoff recorded._",
    "",
    open.length ? "## Open questions" : "",
    ...open.map((q) => `- ${q}`),
    "",
    "## Cost",
    "| bot | model | tokens | cost |",
    "|---|---|---:|---:|",
    ...bots.map((b) => `| @${b.handle} (${b.persona ?? "?"}) | ${String(b.model ?? "").split("/").pop()} | ${Math.round((b.tokens ?? 0) / 1000)}k | ${money(b.usd)} |`),
    `| **total** | | **${Math.round((totals?.tokens ?? 0) / 1000)}k** | **${money(totals?.usd)}** |`,
    "",
    `_Branch \`${project.branch ?? "?"}\`${base ? ` against \`${base.ref}\`` : ""} · ${run ? mins((run.finishedAt ?? Date.now()) - run.created) : ""} · written by BotFarm from the workstream's handoffs._`,
  ]
  const markdown = lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim() + "\n"
  return { title, markdown, base: base?.ref ?? null, tests, changed }
}

/** Push the branch and open the PR with gh, if gh is installed and signed in. */
export async function createPr({ dir, branch, title, bodyFile, base = null }) {
  const out = []
  try {
    await run("gh", ["--version"])
  } catch {
    throw new Error("the GitHub CLI (gh) is not installed on this machine — copy the packet instead")
  }
  const push = await run("git", ["push", "-u", "origin", branch], { cwd: dir }).catch((e) => ({ stderr: e.stderr ?? e.message, failed: true }))
  out.push(String(push.stderr ?? push.stdout ?? "").trim())
  if (push.failed) throw new Error(`git push failed: ${out.join("\n")}`)
  const args = ["pr", "create", "--title", title, "--body-file", bodyFile, "--head", branch]
  if (base) args.push("--base", base.replace(/^origin\//, ""))
  const pr = await run("gh", args, { cwd: dir }).catch((e) => { throw new Error(`gh pr create failed: ${e.stderr ?? e.message}`) })
  return { url: pr.stdout.trim().split("\n").at(-1), log: out.join("\n") }
}
