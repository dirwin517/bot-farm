// Questions for the operator, in the shape Claude and opencode use for theirs:
// each question may offer choices (pick one, or several), and every question
// can also be answered in your own words. A question with no choices is just
// open-ended.

const clip = (s, n) => String(s ?? "").trim().slice(0, n)

/** Strings, { question, options, multiple }, or a mix — always the same shape out. */
export function normalizeQuestions(list) {
  return (Array.isArray(list) ? list : list ? [list] : [])
    .map((q) => {
      if (typeof q === "string") return { question: clip(q, 1000), options: [], multiple: false }
      if (!q || typeof q !== "object") return null
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => (typeof o === "string" ? { label: clip(o, 200) } : o?.label ? { label: clip(o.label, 200), description: o.description ? clip(o.description, 400) : undefined } : null))
        .filter((o) => o?.label)
        .slice(0, 8)
      return {
        question: clip(q.question ?? q.text ?? "", 1000),
        header: q.header ? clip(q.header, 40) : undefined,
        options,
        multiple: !!(q.multiple ?? q.multiSelect ?? q.multi_select),
      }
    })
    .filter((q) => q?.question)
    .slice(0, 12)
}

/** The questions as plain lines, for prompts and the chat. */
export function questionText(questions) {
  return questions.map((q) => q.question)
}

/**
 * Answers as text a bot can read. `answers[i]` is { picked: [labels], text }
 * for question i; unanswered questions are said to be unanswered rather than
 * silently dropped.
 */
export function formatAnswers(questions, answers = []) {
  return questions
    .map((q, i) => {
      const a = answers[i] ?? {}
      const picked = (a.picked ?? []).filter(Boolean)
      const own = clip(a.text, 4000)
      const said = [picked.length ? picked.join(", ") : "", own].filter(Boolean).join(" — ")
      return `${questions.length > 1 ? `${i + 1}. ` : ""}${q.question}\n   → ${said || "(no answer — use your judgement)"}`
    })
    .join("\n")
}

export const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "One thing, plainly, with enough context to answer without opening your session." },
    header: { type: "string", description: "Optional short label (a few words)." },
    options: {
      type: "array",
      description: "Concrete choices, when there are some. The operator can always answer in their own words too, so do not add an 'Other' option. Leave out for an open question.",
      items: {
        anyOf: [
          { type: "string" },
          { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
        ],
      },
    },
    multiple: { type: "boolean", description: "True if more than one option can be picked." },
  },
  required: ["question"],
}
