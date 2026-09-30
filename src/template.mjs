// Mustache subset, dependency-free. Supports {{var}} (HTML-safe is pointless
// here, so nothing is escaped), {{#section}}...{{/section}} for truthy values,
// lists and objects, {{^inverted}}, dotted paths, and {{.}} inside a list of
// scalars. Comments are {{! like this }}.
//
// This is how a pipeline step decides which earlier handoffs it receives: the
// template names them, so dropping a stage's output from a later prompt is an
// edit to one line of YAML rather than a code change.

const TAG = /\{\{([#^/!&]?)\s*([^}]*?)\s*\}\}/g

export function render(template, context = {}) {
  const { out } = section(String(template ?? ""), 0, [context], true)
  return out
}

function section(tpl, from, stack, emit) {
  let out = ""
  let i = from
  TAG.lastIndex = from
  let m
  while ((m = TAG.exec(tpl))) {
    if (emit) out += tpl.slice(i, m.index)
    i = TAG.lastIndex
    const [, sigil, name] = m

    if (sigil === "!") continue
    if (sigil === "/") return { out, next: i, closed: name }

    if (sigil === "#" || sigil === "^") {
      const value = lookup(stack, name)
      const truthy = Array.isArray(value) ? value.length > 0 : !!value
      const wanted = sigil === "#" ? truthy : !truthy

      if (sigil === "#" && Array.isArray(value) && value.length) {
        // Re-render the body once per item, then skip past it.
        let last = null
        for (const item of value) {
          last = section(tpl, i, [...stack, item], true)
          out += last.out
        }
        i = last.next
      } else {
        const body = section(tpl, i, sigil === "#" && isObject(value) ? [...stack, value] : stack, emit && wanted)
        out += body.out
        i = body.next
      }
      TAG.lastIndex = i
      continue
    }

    if (emit) {
      const v = lookup(stack, name)
      out += v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v)
    }
  }
  if (emit) out += tpl.slice(i)
  return { out, next: tpl.length }
}

function lookup(stack, name) {
  if (name === ".") return stack[stack.length - 1]
  const path = name.split(".")
  for (let i = stack.length - 1; i >= 0; i--) {
    let v = stack[i]
    let ok = true
    for (const key of path) {
      if (v && typeof v === "object" && key in v) v = v[key]
      else { ok = false; break }
    }
    if (ok) return v
  }
  return undefined
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v)

/** Names a template refers to — used to warn about typos in pipeline YAML. */
export function variables(template) {
  const names = new Set()
  for (const m of String(template ?? "").matchAll(TAG)) {
    if (m[1] === "!" || m[1] === "/") continue
    names.add(m[2].split(".")[0])
  }
  return [...names]
}
