// Every session gets a stable handle and avatar derived from its id.
//
// The handle is not decoration: agents address each other by "@brisk-otter",
// never by "ses_01H9Z...". A model copies a three-syllable handle reliably and
// a 26-character ulid unreliably, and the operator can hold six of them in
// their head at once.

// The adjective carries the job. @prying-heron reads as a tester before you
// have looked at anything else on the card, and when four bots are talking in
// one room the handle is doing the work a job title would.
const ADJECTIVES = [
  "brisk", "amber", "quiet", "copper", "velvet", "nimble", "dusty", "hollow",
  "clever", "glassy", "rusty", "silver", "patient", "crisp", "wandering", "murmur",
  "pale", "swift", "tidal", "moss", "lantern", "gentle", "brave", "salty",
  "paper", "iron", "plum", "drifting", "candid", "humming", "cobalt", "mellow",
]

const ROLE_ADJECTIVES = {
  // Product: framing, scoping, drawing the shape of the thing.
  product: [
    "framing", "scoping", "sketching", "charting", "mapping", "shaping",
    "drafting", "defining", "aligning", "outlining", "plotting", "clarifying",
    "sifting", "naming", "tracing", "weighing",
  ],
  // Dev: making, joining, finishing.
  dev: [
    "stacking", "moulding", "polishing", "welding", "forging", "wiring",
    "threading", "bolting", "carving", "splicing", "tuning", "grafting",
    "patching", "sanding", "riveting", "kneading",
  ],
  // QA: the ones who do not believe you.
  qa: [
    "prying", "probing", "nervous", "doubting", "squinting", "prodding",
    "restless", "watchful", "snooping", "needling", "sceptical", "twitchy",
    "poking", "sniffing", "fretting", "inquisitive",
  ],
  // Review: weighing the whole chain against what was asked.
  reviewer: [
    "weighing", "tallying", "auditing", "squaring", "measuring", "exacting",
    "comparing", "reconciling", "scrupulous", "unblinking", "steady", "sifting",
    "checking", "thorough", "literal", "deliberate",
  ],
  // Ops: keeping it up.
  ops: [
    "steady", "vigilant", "hardy", "watchful", "ready", "unflappable",
    "tireless", "sturdy", "braced", "wakeful", "durable", "constant",
  ],
  // Research / docs.
  research: [
    "reading", "digging", "rummaging", "quoting", "indexing", "annotating",
    "citing", "leafing", "combing", "collating", "footnoting", "marginal",
  ],
  writer: [
    "lucid", "plain", "spare", "fluent", "eloquent", "pithy", "limpid",
    "unfussy", "measured", "readable", "concise", "clean",
  ],
}

/** Personas can supply their own list; otherwise the role's, otherwise generic. */
export function adjectivesFor(role, custom) {
  if (Array.isArray(custom) && custom.length) return custom
  if (!role) return ADJECTIVES
  const key = String(role).toLowerCase()
  return (
    ROLE_ADJECTIVES[key] ??
    ROLE_ADJECTIVES[Object.keys(ROLE_ADJECTIVES).find((k) => key.includes(k)) ?? ""] ??
    ADJECTIVES
  )
}

export { ROLE_ADJECTIVES }

// Every creature here has a distinct glyph, because the glyph *is* the avatar.
// A handle of "velvet-hedgehog" and a hedgehog face are the same fact twice,
// which is what makes a wall of 40 cards scannable.
const CREATURES = [
  ["otter", "\u{1F9A6}"], ["owl", "\u{1F989}"], ["fox", "\u{1F98A}"], ["hare", "\u{1F407}"],
  ["seal", "\u{1F9AD}"], ["beetle", "\u{1FAB2}"], ["badger", "\u{1F9A1}"], ["bison", "\u{1F9AC}"],
  ["gecko", "\u{1F98E}"], ["toad", "\u{1F438}"], ["koi", "\u{1F420}"], ["crab", "\u{1F980}"],
  ["squid", "\u{1F991}"], ["moth", "\u{1F98B}"], ["snail", "\u{1F40C}"], ["bat", "\u{1F987}"],
  ["boar", "\u{1F417}"], ["camel", "\u{1F42A}"], ["llama", "\u{1F999}"], ["sloth", "\u{1F9A5}"],
  ["skunk", "\u{1F9A8}"], ["raccoon", "\u{1F99D}"], ["swan", "\u{1F9A2}"], ["duck", "\u{1F986}"],
  ["peacock", "\u{1F99A}"], ["parrot", "\u{1F99C}"], ["dodo", "\u{1FAB6}"], ["flamingo", "\u{1F9A9}"],
  ["hedgehog", "\u{1F994}"], ["mouse", "\u{1F42D}"], ["hamster", "\u{1F439}"], ["wolf", "\u{1F43A}"],
  ["panda", "\u{1F43C}"], ["koala", "\u{1F428}"], ["tiger", "\u{1F42F}"], ["lion", "\u{1F981}"],
  ["monkey", "\u{1F435}"], ["penguin", "\u{1F427}"], ["eagle", "\u{1F985}"], ["rooster", "\u{1F413}"],
  ["horse", "\u{1F434}"], ["zebra", "\u{1F993}"], ["deer", "\u{1F98C}"], ["goat", "\u{1F410}"],
  ["chipmunk", "\u{1F43F}"], ["bear", "\u{1F43B}"], ["whale", "\u{1F433}"], ["shark", "\u{1F988}"],
  ["octopus", "\u{1F419}"], ["ladybug", "\u{1F41E}"], ["ant", "\u{1F41C}"], ["bee", "\u{1F41D}"],
  ["cricket", "\u{1F997}"], ["lobster", "\u{1F99E}"], ["turtle", "\u{1F422}"], ["snake", "\u{1F40D}"],
  ["elephant", "\u{1F418}"], ["rhino", "\u{1F98F}"], ["hippo", "\u{1F99B}"], ["giraffe", "\u{1F992}"],
  ["kangaroo", "\u{1F998}"], ["gorilla", "\u{1F98D}"], ["beaver", "\u{1F9AB}"], ["pufferfish", "\u{1F421}"],
]

const GLYPH = new Map(CREATURES)

// FNV-1a: stable across processes, unlike anything built on Math.random.
export function hash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function rng(seed) {
  let s = seed || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

/**
 * Handles must be unique among live sessions or addressing breaks, so a
 * collision walks to the next free pair rather than appending a number.
 */
export function handleFor(id, taken = new Set(), { role = null, adjectives = null } = {}) {
  const h = hash(id)
  const pool = adjectivesFor(role, adjectives)
  for (let i = 0; i < pool.length * CREATURES.length; i++) {
    const a = pool[(h + i * 7) % pool.length]
    const c = CREATURES[(Math.floor(h / 32) + i * 3) % CREATURES.length][0]
    const name = `${a}-${c}`
    if (!taken.has(name)) return name
  }
  return `agent-${id.slice(-4)}`
}

// [glyph-side accent, background]. Sixteen backgrounds against sixty-four
// creatures is a thousand faces before two of them look alike, and the pairs
// are picked for contrast against the panel rather than for variety alone.
const PALETTE = [
  ["#ffab2e", "#6b4310"], ["#4cc3ff", "#134a63"], ["#b494ff", "#3c2d70"],
  ["#5fd0d6", "#14484b"], ["#ff8f6b", "#6b2d19"], ["#e6c14a", "#584613"],
  ["#7fd17f", "#1e4a24"], ["#ff8fb8", "#66253f"], ["#8fb3ff", "#22386e"],
  ["#d1a0ff", "#4a2a63"], ["#ffd166", "#5f4611"], ["#66e0c0", "#134c3f"],
  ["#ff9ed8", "#5e2450"], ["#9be36b", "#33531b"], ["#6fc0ff", "#173f61"],
  ["#ffbf7a", "#61401b"],
]

/**
 * The avatar is the creature in the handle, on a colour drawn from the
 * adjective. Two axes a person can actually name ("the orange otter") beat a
 * random bit-grid, which is why this is a glyph and not an identicon: at 26px
 * a 5x5 noise square is indistinguishable from the next 5x5 noise square, and
 * forty of them on one screen is noise by definition.
 *
 * Identicon bits are kept as the fallback for anything without a handle.
 */
/** The avatar's colours, so the rest of the UI can match a bot to its face. */
export function colorFor(id) {
  const [fg, bg] = PALETTE[hash("avatar:" + id) % PALETTE.length]
  return { fg, bg }
}

export function avatarFor(id, { size = 56, handle = null } = {}) {
  const h = hash("avatar:" + id)
  const [fg, bg] = PALETTE[h % PALETTE.length]
  const creature = handle?.split("-").slice(1).join("-")
  const glyph = creature && GLYPH.get(creature)
  if (glyph) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="${handle}">` +
      `<rect width="32" height="32" rx="7" fill="${bg}"/>` +
      `<rect x="0.6" y="0.6" width="30.8" height="30.8" rx="6.6" fill="none" stroke="${fg}" stroke-opacity=".55"/>` +
      `<text x="16" y="17.5" font-size="21" text-anchor="middle" dominant-baseline="central">${glyph}</text>` +
      `</svg>`
    )
  }
  const rand = rng(h)
  const cells = []
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) if (rand() > 0.45) cells.push([x, y], [4 - x, y])
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-hidden="true">` +
    `<rect width="5" height="5" fill="${bg}"/>` +
    cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fg}"/>`).join("") +
    `</svg>`
  )
}

export { GLYPH }

export function avatarDataUri(id, opts) {
  return "data:image/svg+xml;base64," + Buffer.from(avatarFor(id, opts)).toString("base64")
}

/** Tokens authenticate an MCP caller back to one session. */
export function mintToken() {
  const b = Buffer.alloc(18)
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256)
  return b.toString("base64url")
}
