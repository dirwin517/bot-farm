// Small, model-free helpers that keep bots cheap and on track:
//
//   difficulty()   how hard a card looks, from its text — for model routing
//   trimHandoff()  a handoff squeezed to what the next bot needs (rules, or a
//                  local model when one is configured)
//   stuckReason()  a bot going round in circles, from its recent tool calls
//
// None of these call a paid model. They run on every dispatch / tick, so they
// have to be fast and they must never throw.

// --- difficulty -------------------------------------------------------------

const HARD = /\b(architect|architecture|redesign|refactor|migrat|concurren|race condition|deadlock|security|auth[nz]?|encrypt|performance|optimi[sz]|distributed|transaction|schema change|breaking change|rewrite|multi-?tenant|cache invalidation|design)\w*/gi
const EASY = /\b(typo|rename|docs?|documentation|readme|comment|log(ging)? line|bump|version|lint|format|copy change|label|text change|config value|flag|toggle|small|trivial|one-?line)\b/gi

/**
 * easy | normal | hard for a card. Explicit wins: a split item or a stage can
 * say `difficulty:`. Otherwise a score from the words in it, its length and
 * how many criteria it has to satisfy.
 */
export function difficulty({ explicit = null, title = "", detail = "", story = "", criteria = [], files = [] } = {}) {
  if (["easy", "normal", "hard"].includes(explicit)) return { level: explicit, why: "set explicitly" }
  const text = `${title}\n${detail || story}`.slice(0, 20000)
  const hard = new Set((text.match(HARD) ?? []).map((w) => w.toLowerCase().slice(0, 10)))
  const easy = new Set((text.match(EASY) ?? []).map((w) => w.toLowerCase()))
  let score = 0
  const why = []
  if (hard.size) { score += Math.min(2, hard.size); why.push(`mentions ${[...hard].slice(0, 3).join(", ")}`) }
  if (easy.size && !hard.size) { score -= 1; why.push(`looks small (${[...easy].slice(0, 3).join(", ")})`) }
  if (text.length > 2500) { score += 1; why.push("long description") }
  else if (text.length < 120 && !hard.size) { score -= 1; why.push("short description") }
  if (criteria.length > 8) { score += 1; why.push(`${criteria.length} criteria`) }
  if (files.length > 12) { score += 1; why.push(`${files.length} files`) }
  const level = score >= 2 ? "hard" : score <= -1 ? "easy" : "normal"
  return { level, why: why.join("; ") || "nothing stands out" }
}

/**
 * The model and reasoning level for a card of this difficulty, from the
 * agent's `tiers:` or the workspace routing file. null when routing is off
 * or has nothing for this level.
 */
export function routeFor(level, { agentTiers = null, routing = null } = {}) {
  // Per level: the agent's own rule when it has one for this size, otherwise the
  // workspace's (when workspace routing is on). An agent can override just "hard".
  const set = (t) => t && typeof t === "object" && (t.model || t.variant)
  const own = agentTiers?.[level]
  const t = set(own) ? own : routing?.enabled ? routing.tiers?.[level] : null
  if (!set(t)) return null
  const out = { source: set(own) ? "agent" : "workspace" }
  if (t.model) out.model = String(t.model)
  if (t.variant) out.variant = String(t.variant)
  // A quota on the tier's model, and where to go when it is used up.
  if (t.model && t.quota && typeof t.quota === "object") {
    out.quota = { ...t.quota, per: ["day", "week", "month", "workstream"].includes(t.quota.per) ? t.quota.per : "day" }
    out.fallback = t.fallback && typeof t.fallback === "object" ? { ...(t.fallback.model ? { model: String(t.fallback.model) } : {}), ...(t.fallback.variant ? { variant: String(t.fallback.variant) } : {}) } : {}
  }
  return Object.keys(out).length ? out : null
}

// --- trimming handoffs -------------------------------------------------------

/**
 * Squeeze text by rules alone: long code blocks become a one-line pointer,
 * blank runs and repeated lines go, and it is cut at a sentence near `max`.
 * Roughly 4 characters per token, so the default is ~450 tokens.
 */
export function trimText(text, max = 1800) {
  let s = String(text ?? "").replace(/\r/g, "")
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (m, body) => {
    const n = body.split("\n").length
    return n > 12 ? `[code block, ${n} lines — in the full handoff (botfarm_handoff)]` : m
  })
  const seen = new Set()
  s = s.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => {
    const k = l.trim().toLowerCase()
    if (k.length > 30 && seen.has(k)) return false
    if (k.length > 30) seen.add(k)
    return true
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("\n- "), cut.lastIndexOf("\n\n"))
  return (end > max * 0.6 ? cut.slice(0, end + 1) : cut).trimEnd() + ` … [${s.length - (end > max * 0.6 ? end + 1 : max)} more characters in the full handoff — botfarm_handoff]`
}

/**
 * A handoff as the next bot will read it: the summary trimmed, long lists
 * capped. The full handoff stays on the card and behind botfarm_handoff.
 */
export function trimHandoff(h, { maxChars = 1800, partChars = 500 } = {}) {
  if (!h) return h
  const cap = (list, n, label) => (list?.length > n ? [...list.slice(0, n), `… and ${list.length - n} more ${label}`] : list ?? [])
  const summary = h.parts?.length
    ? h.parts.map((p, i) => `[${i + 1}/${h.parts.length}] ${p.title}: ${trimText(p.summary, partChars)}`).join("\n\n")
    : h.brief ?? trimText(h.summary, maxChars)
  return {
    ...h,
    summary,
    acceptance_criteria: (h.acceptance_criteria ?? []).map((a) => trimText(a, 300)),
    artifacts: cap(h.artifacts, 40, "files"),
    open_questions: cap(h.open_questions, 12, "questions"),
  }
}

/**
 * Optional: have a local model (Ollama-compatible /api/generate) write the
 * brief. Falls back to the rules on any error or after `timeoutMs`.
 */
export async function localBrief(text, { url, model, maxChars = 1800, timeoutMs = 20_000 } = {}) {
  if (!url || !model || String(text ?? "").length <= maxChars) return trimText(text, maxChars)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(new URL("/api/generate", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.1, num_predict: Math.ceil(maxChars / 3) },
        prompt: `Rewrite this developer handoff for the next engineer in at most ${Math.round(maxChars / 5)} words. Keep every file path, identifier, decision, open problem and number exactly. Drop pleasantries and narration. Plain text, no preamble.\n\n---\n${String(text).slice(0, 24000)}`,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const out = String((await res.json()).response ?? "").trim()
    return out ? trimText(out, maxChars) : trimText(text, maxChars)
  } catch {
    return trimText(text, maxChars)
  } finally {
    clearTimeout(timer)
  }
}

// --- loops -------------------------------------------------------------------

// Only used to tell a legitimate repeated call (editing the same file twice) from a loop.
// Whether files actually changed is asked of git, not guessed from tool names.
const EDITS = /edit|write|patch|replace/i

/**
 * Why a bot looks stuck on its card, or null. Only its calls since the card
 * started count. Three signals, all cheap:
 *   - the same call (tool + input) three times in the last six
 *   - its last five calls all failed
 *   - a lot of tokens with no file changed, for a bot that is meant to edit
 */
export function stuckReason(calls, { tokens = 0, canEdit = true, tokenCeiling = 250_000, edited = undefined } = {}) {
  const recent = calls.slice(-6)
  const counts = new Map()
  for (const c of recent) {
    // The same call means the same tool with exactly the same arguments: a
    // grep for three different things is work, not a loop. A file changing in
    // between (build, edit, build) starts the count again.
    if (EDITS.test(c.name)) { counts.clear(); continue }
    const args = c.sig ?? (c.summary ? `s:${c.summary}` : null)
    if (args === null) continue // arguments unknown: cannot tell, so do not guess
    const k = `${c.name}\u0000${args}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
    if (counts.get(k) >= 3 && !EDITS.test(c.name)) return { kind: "loop", why: `repeated ${c.name}${c.summary ? ` "${String(c.summary).slice(0, 60)}"` : ""} ${counts.get(k)} times` }
  }
  const last5 = calls.slice(-5)
  if (last5.length === 5 && last5.every((c) => c.status === "error")) return { kind: "loop", why: `its last 5 tool calls failed (${[...new Set(last5.map((c) => c.name))].join(", ")})` }
  // "edited" comes from git (did any file change since the card started, by any
  // tool or MCP server); without it, fall back to the tool names.
  const changedFiles = edited ?? calls.some((c) => EDITS.test(c.name))
  if (canEdit && tokens > tokenCeiling && calls.length >= 15 && !changedFiles) {
    return { kind: "loop", why: `${Math.round(tokens / 1000)}k tokens and ${calls.length} tool calls without changing a file` }
  }
  return null
}
