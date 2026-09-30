// A deliberately small YAML subset — enough for personas and pipelines, and
// nothing more. Supported: comments, nested maps by indentation, "- " lists
// (of scalars or maps), quoted and bare scalars, numbers, booleans, null, and
// the "|" / ">" block scalars that prompts need.
//
// Not supported: anchors, aliases, multiple documents, flow maps, tags. If a
// file uses them, parsing throws with a line number rather than silently
// producing something odd — these files are edited by hand, so a loud failure
// beats a quiet misreading.

export function parse(text) {
  const lines = String(text).split(/\r?\n/)
  const root = {}
  const stack = [{ indent: -1, value: root }]
  let i = 0

  const fail = (msg) => {
    throw new Error(`${msg} (line ${i + 1}: ${lines[i]?.trim()})`)
  }

  while (i < lines.length) {
    const raw = lines[i]
    const line = stripComment(raw)
    if (!line.trim()) { i++; continue }
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) { i++; continue }
    if (/[&*!]\S/.test(line.trim()) && /^\s*\w+:\s*[&*]/.test(line)) fail("anchors and aliases are not supported")

    const indent = line.match(/^ */)[0].length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].value
    const body = line.slice(indent)

    // list item
    if (body.startsWith("- ") || body === "-") {
      if (!Array.isArray(parent)) fail("list item outside a list")
      const rest = body.slice(2)
      if (!rest.trim()) {
        const obj = {}
        parent.push(obj)
        stack.push({ indent, value: obj })
        i++
        continue
      }
      const kv = splitKey(rest)
      if (kv) {
        const obj = {}
        parent.push(obj)
        stack.push({ indent, value: obj })
        // re-handle the inline "key: value" at a deeper virtual indent
        const [key, value] = kv
        const block = readBlock(value, indent + 2)
        if (block !== undefined) obj[key] = block
        else if (value === "") {
          const child = nextIsList(indent + 2) ? [] : {}
          obj[key] = child
          stack.push({ indent: indent + 1, value: child })
        } else obj[key] = scalar(value)
        i++
        continue
      }
      parent.push(scalar(rest))
      i++
      continue
    }

    // key: value
    const kv = splitKey(body)
    if (!kv) fail("expected 'key: value' or '- item'")
    const [key, value] = kv
    if (Array.isArray(parent)) fail("mapping inside a list needs '- ' on its first key")

    const block = readBlock(value, indent)
    if (block !== undefined) {
      parent[key] = block
      continue // readBlock advanced i
    }
    if (value === "") {
      const child = nextIsList(indent) ? [] : {}
      parent[key] = child
      stack.push({ indent, value: child })
      i++
      continue
    }
    parent[key] = scalar(value)
    i++
  }
  return root

  /** Look ahead past blanks for the next meaningful line's shape. */
  function nextIsList(indent) {
    for (let j = i + 1; j < lines.length; j++) {
      const l = stripComment(lines[j])
      if (!l.trim()) continue
      const ind = l.match(/^ */)[0].length
      if (ind <= indent) return false
      return l.slice(ind).startsWith("- ") || l.slice(ind) === "-"
    }
    return false
  }

  /** "|" and ">" block scalars; returns undefined when `value` isn't one. */
  function readBlock(value, indent) {
    const m = /^([|>])([-+]?)$/.exec(value.trim())
    if (!m) return undefined
    const fold = m[1] === ">"
    const chomp = m[2]
    const out = []
    let j = i + 1
    let blockIndent = null
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) { out.push(""); continue }
      const ind = l.match(/^ */)[0].length
      if (ind <= indent) break
      if (blockIndent === null) blockIndent = ind
      out.push(l.slice(blockIndent))
    }
    i = j
    while (out.length && out[out.length - 1] === "") out.pop()
    let text = fold ? foldLines(out) : out.join("\n")
    if (chomp !== "-") text += "\n"
    if (chomp === "-") text = text.replace(/\n+$/, "")
    return text
  }
}

function foldLines(lines) {
  const out = []
  for (const l of lines) {
    if (l === "") out.push("\n")
    else if (out.length && !out[out.length - 1].endsWith("\n")) out[out.length - 1] += " " + l
    else out.push(l)
  }
  return out.join("").replace(/\n(?!\n)/g, "\n")
}

function stripComment(line) {
  let out = ""
  let quote = null
  for (let k = 0; k < line.length; k++) {
    const c = line[k]
    if (quote) {
      out += c
      if (c === quote && line[k - 1] !== "\\") quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue }
    if (c === "#" && (k === 0 || /\s/.test(line[k - 1]))) break
    out += c
  }
  return out.replace(/\s+$/, "")
}

function splitKey(body) {
  let quote = null
  for (let k = 0; k < body.length; k++) {
    const c = body[k]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === ":" && (k + 1 === body.length || /\s/.test(body[k + 1]))) {
      return [unquote(body.slice(0, k).trim()), body.slice(k + 1).trim()]
    }
  }
  return null
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"')
  }
  return s
}

function scalar(v) {
  const s = v.trim()
  if (s === "" || s === "~" || s === "null") return null
  if (s === "true" || s === "yes") return true
  if (s === "false" || s === "no") return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim()
    return inner ? splitFlow(inner).map((x) => scalar(x)) : []
  }
  // One-line maps: { usd: 5, per: day }. Not "{{story}}" — that is a template.
  if (s.startsWith("{") && s.endsWith("}") && s[1] !== "{") {
    const inner = s.slice(1, -1).trim()
    if (!inner) return {}
    const pairs = splitFlow(inner).map((x) => splitKey(x.trim()) ?? (/^[\w-]+:$/.test(x.trim()) ? [x.trim().slice(0, -1), ""] : null))
    if (pairs.every(Boolean)) return Object.fromEntries(pairs.map(([k, v]) => [k, scalar(v)]))
  }
  return unquote(s)
}

/** Split on top-level commas, leaving nested [], {} and quotes alone. */
function splitFlow(s) {
  const out = []
  let depth = 0, quote = null, start = 0
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (quote) { if (c === quote && s[k - 1] !== "\\") quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") depth--
    else if (c === "," && depth === 0) { out.push(s.slice(start, k)); start = k + 1 }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter((x) => x !== "")
}

// --------------------------------------------------------------------------

export function stringify(value, indent = 0) {
  const pad = " ".repeat(indent)
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    return value
      .map((v) =>
        isPlainObject(v)
          ? listItem(v, indent, pad)
          : `${pad}- ${scalarOut(v)}`,
      )
      .join("\n")
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([k, v]) => {
        if (isPlainObject(v)) {
          return Object.keys(v).length ? `${pad}${k}:\n${stringify(v, indent + 2)}` : `${pad}${k}: {}`
        }
        if (Array.isArray(v)) {
          return v.length ? `${pad}${k}:\n${stringify(v, indent + 2)}` : `${pad}${k}: []`
        }
        if (typeof v === "string" && v.includes("\n")) {
          const body = v.replace(/\n$/, "").split("\n").map((l) => " ".repeat(indent + 2) + l).join("\n")
          return `${pad}${k}: |\n${body}`
        }
        return `${pad}${k}: ${scalarOut(v)}`
      })
      .join("\n")
  }
  return `${pad}${scalarOut(value)}`
}

// "- key: value" with the rest of the map under it. The first key must be a
// scalar, so move one to the front; a map with none uses a bare "-" line.
function listItem(v, indent, pad) {
  const keys = Object.keys(v)
  const scalar = keys.find((k) => !isPlainObject(v[k]) && !Array.isArray(v[k]) && !(typeof v[k] === "string" && v[k].includes("\n")))
  if (scalar === undefined) return `${pad}-\n${stringify(v, indent + 2)}`
  const ordered = { [scalar]: v[scalar], ...v }
  return `${pad}- ${stringify(ordered, indent + 2).slice(indent + 2)}`
}

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v)

function scalarOut(v) {
  if (v === null || v === undefined) return "null"
  if (typeof v === "boolean" || typeof v === "number") return String(v)
  const s = String(v)
  if (s === "" || /^[\s#&*!|>%@`]/.test(s) || /:\s/.test(s) || /^(true|false|null|yes|no|~|-?\d+(\.\d+)?)$/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}
