/**
 * Rubric invariants, asserted rather than assumed.
 *
 * Every rule in the questions.ts header is a claim about the file. A comment
 * is not an assertion: the "state is untrusted" rule was written down in the
 * header and true of only 54 of 77 questions until this harness caught it. So
 * each rule is checked here instead, and a violation fails the run.
 *
 * Two things this file must not be:
 *
 *  1. Untypechecked. `tsx` transpiles without checking, so a mistyped property
 *     name is stripped and the harness runs on happily — which is how a
 *     coverage matrix once reported 8 combinations while testing 4, and
 *     reported 25 page questions when there are 26. Run it with tsc:
 *       npx tsc -p scripts/tsconfig.json --noEmit && npx tsx scripts/verify-rubric.ts
 *
 *  2. Hand-maintained. The page gate flags are harvested from the actual
 *     function signature below, so adding a fourth flag to pageQuestions grows
 *     the matrix automatically instead of silently going untested.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  GEO_QUESTIONS,
  HIGHEST_IMPACT_CHANGES,
  KEYWORD_QUESTIONS,
  REFRESH_QUESTIONS,
  cannibalizationQuestion,
  competitorQuestions,
  internalLinkQuestion,
  pageQuestions,
  siteQuestions,
  type Questions,
} from "../src/questions.js"
import { FALSIFIER, FALSIFIER_FALLBACK, NO_CHANGE } from "../src/decisions.js"
import { fieldsFor, type StateScope } from "../src/state.js"
import { thresholdCoverage } from "../src/thresholds.js"

const ESCAPE_KEY =
  /(^no_|^none$|_none$|^other$|^unclear|^undetermined|^nothing|shape_unclear|not_stated|_unknown$)/i
const DEGREE_WORD = /\b(slightly|a bit|somewhat|moderately|fairly|quite|reasonably|mostly|partly|decent|okay)\b/i
const MIN_LEVEL_CHARS = 25

let failures = 0
/** Reported, not failed: thresholds.ts documents "unlisted = global default" as valid. */
let unbandedTotal = 0
const fail = (message: string): void => {
  failures += 1
  console.log(`  FAIL  ${message}`)
}

// ───────────────────────────────────────────── build every question set

interface SetSpec {
  label: string
  scope: StateScope
  questions: Questions
}

/**
 * Gate flags are read out of the pageQuestions signature rather than listed
 * here, so a new flag cannot go untested. A hardcoded list is a second copy
 * of the truth and will drift.
 */
function pageGateFlags(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, "..", "src", "questions.ts"), "utf8")
  const signature = source.match(/export function pageQuestions\(\s*page:\s*\{([^}]*)\}/)
  if (!signature?.[1]) {
    throw new Error(
      "could not read the pageQuestions parameter block from questions.ts — the harness has drifted from the source and must be updated",
    )
  }
  const flags = [...signature[1].matchAll(/(\w+)\s*:\s*boolean/g)].map((m) => m[1] as string)
  if (flags.length === 0) throw new Error("pageQuestions signature exposes no boolean flags")
  return flags
}

function pageSets(): SetSpec[] {
  const flags = pageGateFlags()
  const sets: SetSpec[] = []
  for (let mask = 0; mask < 1 << flags.length; mask += 1) {
    const flagsOn = Object.fromEntries(flags.map((f, i) => [f, (mask & (1 << i)) !== 0])) as Record<
      string,
      boolean
    >
    const active = flags.filter((f) => flagsOn[f]).join("+") || "(none)"
    sets.push({
      label: `page[${active}]`,
      scope: "page",
      questions: { ...pageQuestions(flagsOn as Parameters<typeof pageQuestions>[0]), ...REFRESH_QUESTIONS },
    })
  }
  return sets
}

const sets: SetSpec[] = [
  ...pageSets(),
  { label: "site", scope: "site", questions: siteQuestions() },
  { label: "geo", scope: "site", questions: GEO_QUESTIONS },
  { label: "keyword", scope: "keyword", questions: KEYWORD_QUESTIONS },
  { label: "competitor", scope: "competitor", questions: competitorQuestions() },
  { label: "cannibalization", scope: "cannibalization", questions: { pair: cannibalizationQuestion() } },
  { label: "internal_link", scope: "internal_link", questions: { pair: internalLinkQuestion() } },
]

// ───────────────────────────────────────────── the invariants

console.log(`page gate flags harvested from source: ${pageGateFlags().join(", ")}`)
console.log(`question sets under test: ${sets.length}\n`)

let questionsChecked = 0

for (const set of sets) {
  const ids = Object.keys(set.questions)
  const problems: string[] = []

  for (const [id, question] of Object.entries(set.questions)) {
    questionsChecked += 1
    const where = `${set.label}.${id}`

    if (!/untrusted/i.test(question.instructions)) {
      problems.push(`${where}: instruction omits the untrusted-content clause`)
    }

    if (question.type === "choice") {
      const keys = Object.keys(question.criteria as Record<string, unknown>)
      if (keys.length < 2) problems.push(`${where}: choice has fewer than two options`)
      if (!keys.some((k) => ESCAPE_KEY.test(k))) {
        problems.push(`${where}: choice has no no-match escape — keys are ${keys.join(", ")}`)
      }
    } else if (question.type === "score") {
      const levels = question.criteria as string[]
      if (levels.length < 2) problems.push(`${where}: score has fewer than two levels`)
      levels.forEach((level, i) => {
        if (DEGREE_WORD.test(level)) {
          problems.push(`${where}[${i}]: level is phrased as a degree, not a situation — "${level}"`)
        }
        if (level.trim().length < MIN_LEVEL_CHARS) {
          problems.push(`${where}[${i}]: level is too vague to be distinguishable — "${level}"`)
        }
      })
    }
  }

  const { unmapped } = fieldsFor(set.scope, set.questions)
  if (unmapped.length > 0) {
    problems.push(`${set.label}: questions with no state field mapping — ${unmapped.join(", ")}`)
  }

  // Not a failure. thresholds.ts states that a question absent from its table
  // falls back to the global default, and that the tables grow one entry at a
  // time. Failing here would push someone to invent two dozen unmeasured
  // numbers to satisfy a checker, which is worse than the honest default. It
  // is counted so the report shows how much of the rubric is unbanded.
  unbandedTotal += thresholdCoverage(set.questions).choiceOnDefault.length
  unbandedTotal += thresholdCoverage(set.questions).scoreOnDefault.length
  unbandedTotal += thresholdCoverage(set.questions).noulOnDefault.length

  if (problems.length > 0) {
    console.log(`${set.label} (${ids.length} questions)`)
    for (const p of problems) fail(p)
  }
}

// ───────────────────────────────────────────── falsifier resolvability

/**
 * Every falsifier must name a question this run could actually have asked.
 *
 * Two failure modes this catches, both of which reached a human review before
 * they reached a compiler:
 *
 *  1. An id that names no question at all. Note that checking this with a
 *     source regex silently passes: `pageQuestions` gates `h1_fit`,
 *     `answer_first`, `above_fold_promise`, `title_fit` and `meta_fit` behind
 *     presence flags and assigns them AFTER the object literal, so `^\s+<id>:`
 *     finds nothing even though the question exists. That is why the check
 *     resolves ids against the built question set instead.
 *  2. An id that is valid but presence-gated, so on a page missing the title or
 *     the H1 it names a question that was never asked. A falsifier the run
 *     cannot settle is a test that cannot fail. The full presence-flag matrix
 *     is walked for exactly this.
 */
function assertFalsifiersResolvable(): void {
  const flags = pageGateFlags()
  const shapes: Array<Record<string, boolean>> = []
  for (let bits = 0; bits < 1 << flags.length; bits += 1) {
    const shape: Record<string, boolean> = {}
    flags.forEach((flag, i) => {
      shape[flag] = (bits >> i) % 2 === 1
    })
    shapes.push(shape)
  }

  const askedIn = (shape: Record<string, boolean>): Set<string> =>
    new Set(
      Object.keys({
        ...pageQuestions({
          hasTitle: shape.hasTitle === true,
          hasDescription: shape.hasDescription === true,
          hasH1: shape.hasH1 === true,
          hasCanonical: shape.hasCanonical === true,
        }),
        ...REFRESH_QUESTIONS,
      }),
    )

  for (const shape of shapes) {
    const asked = askedIn(shape)
    for (const [key, falsifier] of Object.entries(FALSIFIER)) {
      if (key !== NO_CHANGE && !(key in HIGHEST_IMPACT_CHANGES)) {
        fail(`FALSIFIER key "${key}" is not a HIGHEST_IMPACT_CHANGES option`)
      }
      if (falsifier === "highest_impact_change") {
        fail(`FALSIFIER[${key}] is the question that produced the change — a tautology, not a test`)
      }
      if (asked.has(falsifier)) continue
      const fallback = FALSIFIER_FALLBACK[key]
      if (fallback && asked.has(fallback)) continue
      const where = `FALSIFIER[${key}] = "${falsifier}" is never asked (no page shape) and has no usable fallback`
      if (falsifier === fallback) fail(`${where} — the fallback names the same unasked question`)
      else fail(where)
    }
  }

  for (const [key, fallback] of Object.entries(FALSIFIER_FALLBACK)) {
    if (!(key in FALSIFIER)) {
      fail(`FALSIFIER_FALLBACK has "${key}", which is not in FALSIFIER`)
    }
    if (fallback === "highest_impact_change") {
      fail(`FALSIFIER_FALLBACK[${key}] is the question that produced the change`)
    }
    // A fallback for a key whose primary is asked unconditionally can never be
    // reached. It is not wrong, but it is dead, and a dead entry is how a
    // retired value survives a revert unnoticed.
    const alwaysAsked = askedIn({ hasTitle: false, hasDescription: false, hasH1: false, hasCanonical: false })
    if (alwaysAsked.has(FALSIFIER[key] ?? "")) {
      fail(`FALSIFIER_FALLBACK[${key}] = "${fallback}" is unreachable — its primary is asked on every page`)
    }
  }

  // `nothing_missing` must stay out of both maps. `topChangeFor` returns null
  // on it, so such a row could never be read, and the no-change case reaches
  // the panel as prose on `notDecided.reason`. A row that looks live but is
  // not is how a reader ends up auditing a code path that does not exist.
  if (NO_CHANGE in FALSIFIER) {
    fail(`FALSIFIER has a "${NO_CHANGE}" row, but no TopChange can ever carry that key`)
  }
  if (NO_CHANGE in FALSIFIER_FALLBACK) {
    fail(`FALSIFIER_FALLBACK has a "${NO_CHANGE}" row, unreachable by the same argument`)
  }
}

assertFalsifiersResolvable()

// ───────────────────────────────────────────── report

const pageIds = Object.keys(pageSets()[pageSets().length - 1]?.questions ?? {})
console.log(`\nquestions checked: ${questionsChecked}`)
console.log(`max page questions (pageQuestions + REFRESH): ${pageIds.length}`)
console.log(`questions with no per-question threshold band: ${unbandedTotal} (global default applies by design)`)

if (failures > 0) {
  console.log(`\n${failures} INVARIANT FAILURE(S)`)
  process.exit(1)
}
console.log("\nALL RUBRIC INVARIANTS PASS")
