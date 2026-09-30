// Levels, hats and harvests. Light on purpose: XP comes from work that landed
// cleanly and cheaply — a handoff, no pause for a limit or a loop, well under
// budget — never from tokens spent or tools called, so levelling up and saving
// money point the same way.
//
// XP belongs to a kind of bot in a workspace ("dev" in one workspace),
// not to one session: sessions come and go, the Dev Bot keeps its hat.

export const LEVELS = [0, 30, 80, 160, 280, 450, 700, 1000, 1400, 1900]
export const HATS = [null, "🧢", "🎩", "👒", "⛑️", "🎓", "👑", "🪖", "🎀", "🌟"]
export const TITLES = ["Seedling", "Sprout", "Farmhand", "Grower", "Harvester", "Foreman", "Rancher", "Steward", "Legend", "Mythic"]

/** What each level unlocks. Functional perks are small and only ever make a bot a little more trusted. */
export const PERKS = [
  { level: 2, id: "hat", label: "A cap on the farm", kind: "cosmetic" },
  { level: 3, id: "seasoned", label: "Seasoned: card limits +10%", kind: "budget", bonus: 0.1 },
  { level: 4, id: "hat2", label: "A sun hat", kind: "cosmetic" },
  { level: 5, id: "trusted", label: "Trusted: the first limit hit on a card extends itself once (+25%) instead of stopping", kind: "autoextend" },
  { level: 6, id: "crown", label: "The crown, and a gold name on the farm", kind: "cosmetic" },
  { level: 8, id: "veteran", label: "Veteran: card limits +20%", kind: "budget", bonus: 0.2 },
]

export function levelOf(xp) {
  let level = 1
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i]) level = i + 1
  const next = LEVELS[level] ?? null
  const prev = LEVELS[level - 1] ?? 0
  return { level, xp, next, progress: next ? (xp - prev) / (next - prev) : 1, hat: HATS[level - 1] ?? "🌟", title: TITLES[level - 1] ?? "Mythic" }
}

export function perksAt(level) {
  return PERKS.filter((p) => p.level <= level)
}

/** How much a card's limits grow for this level (Seasoned, Veteran). */
export function budgetBonus(level) {
  return perksAt(level).filter((p) => p.kind === "budget").reduce((a, p) => Math.max(a, p.bonus), 0)
}

/**
 * XP for one finished card, with the reasons. `usage` and `limits` are the
 * card's; `paused` says whether it ever stopped for a limit or a loop.
 */
export function xpForCard({ task, usage = null, paused = false, openQuestions = 0 }) {
  const parts = [["handed off", 10]]
  if (!paused) parts.push(["no pauses", 5])
  const lim = task.limits
  if (lim && usage) {
    const frac = Math.max(0, ...Object.entries(lim).map(([k, v]) => (usage[k] ?? 0) / v))
    if (frac <= 0.5) parts.push(["under half its limit", 5])
  }
  if (!openQuestions) parts.push(["nothing left open", 3])
  if (task.item) parts.push(["one piece of a split", 2])
  return { xp: parts.reduce((a, [, n]) => a + n, 0), reasons: parts }
}

export class Farmhands {
  constructor({ db }) {
    this.db = db
  }

  key(wsId, persona) { return `${wsId ?? "none"}:${persona}` }

  get(wsId, persona) {
    const row = this.db.get("xp", this.key(wsId, persona)) ?? { id: this.key(wsId, persona), ws: wsId ?? null, persona, xp: 0, cards: 0, clean: 0, history: [] }
    return { ...row, ...levelOf(row.xp) }
  }

  all(wsId) {
    return this.db.all("xp").filter((r) => !wsId || r.ws === wsId).map((r) => ({ ...r, ...levelOf(r.xp), perks: perksAt(levelOf(r.xp).level) }))
  }

  /** Add XP; returns { before, after, gained, levelUp }. */
  award(wsId, persona, gained, { reasons = [], card = null } = {}) {
    const row = this.db.get("xp", this.key(wsId, persona)) ?? { id: this.key(wsId, persona), ws: wsId ?? null, persona, xp: 0, cards: 0, clean: 0, history: [] }
    const before = levelOf(row.xp)
    row.xp += gained
    row.cards += 1
    if (reasons.some(([r]) => r === "no pauses")) row.clean += 1
    row.history = [...(row.history ?? []), { at: Date.now(), xp: gained, card, reasons: reasons.map(([r, n]) => `${r} +${n}`) }].slice(-40)
    this.db.put("xp", row)
    const after = levelOf(row.xp)
    return { before, after, gained, levelUp: after.level > before.level ? after : null }
  }

  // --- harvests -------------------------------------------------------------

  saveHarvest(h) {
    this.db.put("harvests", h)
    return h
  }

  harvests(wsId, sinceMs = 0) {
    return this.db.all("harvests").filter((h) => (!wsId || h.ws === wsId) && h.at >= sinceMs).sort((a, b) => b.at - a.at)
  }

  /** This week and all time, for the harvest log. */
  totals(wsId) {
    const week = Date.now() - 7 * 86400_000
    const sum = (list) => list.reduce((a, h) => ({
      stories: a.stories + 1,
      cards: a.cards + (h.cards ?? 0),
      usd: a.usd + (h.usd ?? 0),
      saved: a.saved + Math.max(0, h.saved ?? 0),
      botMinutes: a.botMinutes + (h.botMinutes ?? 0),
      xp: a.xp + (h.xp ?? 0),
    }), { stories: 0, cards: 0, usd: 0, saved: 0, botMinutes: 0, xp: 0 })
    const all = this.harvests(wsId)
    return { week: sum(all.filter((h) => h.at >= week)), all: sum(all), recent: all.slice(0, 12) }
  }
}
