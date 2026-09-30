// Per-model quotas for routing: "up to $5 a day on Opus, then Sonnet".
//
// Spend is kept per workspace, per model and per period in the db, in four
// buckets at once — day, week, month and workstream — so any quota can be
// answered with one read. Money is BotFarm's own estimate (the same pricing as
// everywhere else); tokens are what opencode reports; minutes are time a bot
// spent busy on that model.

export const PERIODS = ["day", "week", "month", "workstream"]

/** "amazon-bedrock/us.anthropic.claude-opus-5" and "claude-opus-5" are the same model for a quota. */
export function modelKey(m) {
  return String(m ?? "").split("/").pop().replace(/^(us|eu|apac|global)\./i, "").replace(/^anthropic\./i, "").replace(/-\d{8}(-v\d+(:\d+)?)?$/, "").toLowerCase()
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const year = t.getUTCFullYear()
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, "0")}`
}

export function bucketOf(per, at = Date.now(), projectId = null) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, "0")
  if (per === "workstream") return `p:${projectId ?? "none"}`
  if (per === "week") return `w:${isoWeek(d)}`
  if (per === "month") return `m:${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  return `d:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The first quota a spend has reached, or null. */
export function overQuota(quota, spent) {
  if (!quota) return null
  for (const kind of ["usd", "tokens", "minutes"]) {
    if (Number(quota[kind]) > 0 && (spent?.[kind] ?? 0) >= Number(quota[kind])) return { kind, limit: Number(quota[kind]), used: spent[kind] }
  }
  return null
}

export class ModelLedger {
  constructor(db) {
    this.db = db
  }

  id(wsId, model, bucket) {
    return `${wsId ?? "none"}|${modelKey(model)}|${bucket}`
  }

  /** Also counted under `model@persona`, so an agent's own quota counts only that agent's spend. */
  add(wsId, model, projectId, amounts = {}, at = Date.now(), persona = null) {
    this.addOne(wsId, model, projectId, amounts, at)
    if (persona) this.addOne(wsId, `${modelKey(model)}@${persona}`, projectId, amounts, at)
  }

  addOne(wsId, model, projectId, { usd = 0, tokens = 0, minutes = 0 } = {}, at = Date.now()) {
    if (!model || (!usd && !tokens && !minutes)) return
    for (const per of PERIODS) {
      if (per === "workstream" && !projectId) continue
      const id = this.id(wsId, model, bucketOf(per, at, projectId))
      const row = this.db.get("modelspend", id) ?? { id, ws: wsId ?? null, model: modelKey(model), bucket: bucketOf(per, at, projectId), usd: 0, tokens: 0, minutes: 0 }
      row.usd += usd
      row.tokens += tokens
      row.minutes += minutes
      row.updated = at
      this.db.put("modelspend", row)
    }
  }

  spent(wsId, model, per = "day", projectId = null, at = Date.now()) {
    const row = this.db.get("modelspend", this.id(wsId, model, bucketOf(per, at, projectId)))
    return { usd: row?.usd ?? 0, tokens: row?.tokens ?? 0, minutes: row?.minutes ?? 0 }
  }
}
