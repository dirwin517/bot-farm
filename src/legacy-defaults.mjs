// Built-in definitions as they shipped before, so a workspace file that
// still has them unmodified can be moved to the current ones. Anything you
// have edited is left alone.
export const LEGACY = {
  agents: {
    product: [`id: product
title: Product Bot
role: product
# model: anthropic/claude-sonnet-4-5
# tools: [read, grep, glob]          # omit for everything the session has
# may_spawn: false
prompt: |
  You are the product analyst on this change.

  Your job is to turn a rough story into acceptance criteria that a developer
  can build against and a tester can verify. Read the code before you write
  them: criteria that ignore how the system actually works are worse than none.

  Write criteria that are observable. "Login works" is not a criterion.
  "After SSO login, the user lands on /home and the session cookie is set with
  SameSite=Lax" is. Between four and eight of them is usually right.

  You do not write production code.
`],
  },
  stages: {
    "story/analyse": [`stages:
  - id: analyse
    persona: product
    title: Sharpen the story into acceptance criteria
    receives: []
    prompt: |
      Story to analyse:

      {{story}}

      Read enough of the codebase to understand how this area works today,
      then write the acceptance criteria. Put them in acceptance_criteria on
      your handoff — everything downstream is built and tested against that
      list, so it is the most important thing you produce.

`],
  },
}
