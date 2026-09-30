// Cost, computed here rather than taken from the session.
//
// opencode reports a cost only when the provider hands one back. Bedrock does
// not: it returns usage and bills you out of band, so every Bedrock session
// shows $0.00. We price the tokens ourselves from a table, and say plainly
// that the number is an estimate.
//
// Prices are USD per million tokens and go stale. Override or extend them in
// ~/.botfarm/config.json:
//
//   "pricing": { "claude-sonnet-4-5": { "input": 3, "output": 15 } }
//
// Bedrock and Vertex list their own prices per region and are often a little
// above the first-party rate, so treat these as a floor on those providers.

const M = 1_000_000

// Matched longest-pattern-first against a normalised model id.
export const TABLE = {
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-opus-3": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-haiku-4": { input: 1, output: 5 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "llama": { input: 0.3, output: 0.6 },
  "mistral": { input: 0.3, output: 0.9 },
  "deepseek": { input: 0.3, output: 1.1 },
  "qwen": { input: 0.3, output: 0.9 },
}

// Anthropic-style cache pricing: reads are a tenth of input, five-minute
// writes are a quarter more. Providers that do not price cache separately
// simply report zero cached tokens, so this costs nothing.
const CACHE_READ = 0.1
const CACHE_WRITE = 1.25

/**
 * Bedrock ids carry a region prefix and a version suffix
 * ("us.anthropic.claude-sonnet-4-20250514-v1:0"), Vertex uses "@" versions,
 * and opencode prefixes the provider. Strip all of it down to the family.
 */
export function normalise(model) {
  if (!model) return ""
  let id = String(model).toLowerCase()
  if (id.includes("arn:aws:bedrock")) id = id.split("/").pop() ?? id
  id = id.split("/").pop() ?? id // provider/model
  id = id.replace(/^(us|eu|apac|global)\./, "") // bedrock region prefix
  id = id.replace(/^(anthropic|amazon|meta|mistral|openai|deepseek|qwen)\./, "")
  // Only strip real version suffixes: "-v1:0", "@001", ":0". A bare trailing
  // number is part of the model name ("claude-opus-5"), not a version.
  id = id.replace(/[-@]v\d+(:\d+)?$/, "")
  id = id.replace(/@\d{3}$/, "")
  id = id.replace(/:\d+$/, "")
  id = id.replace(/-\d{8}$/, "") // date stamps
  return id
}

export function rateFor(model, overrides = {}) {
  const id = normalise(model)
  if (!id) return null
  const table = { ...TABLE, ...overrides }
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const k of keys) if (id.includes(k)) return { ...table[k], matched: k }
  return null
}

/**
 * @returns {{ usd: number, estimated: boolean, rate: object|null }}
 * `estimated: false` means the provider told us the number and we believed it.
 */
export function estimate({ model, totals, reported = 0, overrides = {} }) {
  if (reported > 0) return { usd: reported, estimated: false, rate: null }
  const rate = rateFor(model, overrides)
  if (!rate) return { usd: 0, estimated: true, rate: null, unknownModel: normalise(model) || null }
  const usd =
    ((totals.input ?? 0) * rate.input +
      (totals.output ?? 0) * rate.output +
      (totals.reasoning ?? 0) * rate.output +
      (totals.cacheRead ?? 0) * rate.input * CACHE_READ +
      (totals.cacheWrite ?? 0) * rate.input * CACHE_WRITE) /
    M
  return { usd, estimated: true, rate }
}
