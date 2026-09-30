/**
 * Thresholds, in one reviewable file.
 *
 * TypeSafe's guidance: three bands. High confidence acts, medium confirms or
 * flags for review, low does not act and routes to a person. Thresholds rise
 * with the cost of being wrong and start conservative.
 *
 * A Choice is decisive at confidence >= DECISIVE. A Score is decisive when
 * DECISIVE or more of its probability mass sits on one side of the midpoint
 * that the finding threshold uses — spread between two neighbouring levels on
 * the same side is not doubt. A Noul has no confidence field, so it is
 * decisive at P(yes) >= YES or <= NO. Everything else is "to verify".
 *
 * PER-QUESTION OVERRIDES. Confidence does not mean the same thing for every
 * question: the same 0.85 is a much stronger statement across three options
 * than across ten, because mass is split further. Every widened question is
 * therefore listed in one of the three tables below with the bar it actually
 * needs. Anything not listed uses the defaults, so the tables can grow one
 * entry at a time and an unlisted question is never silently stricter or
 * looser than before.
 *
 * Every number here is a reasoned starting point, not a tuned one. See
 * CALIBRATION at the foot of this file, and section 6 of the plan: these
 * become real only against a few hundred labelled pages.
 */

export const DECISIVE = 0.8
export const YES = 0.8
export const NO = 0.2

/** Normalised Score below this becomes a content finding. */
export const CONTENT_FLOOR = 0.45

/** Normalised Score at or above this counts as a healthy page. */
export const CONTENT_CEILING = 0.66

/** P(yes) below this on a gate question becomes a finding. */
export const GATE_FLOOR = 0.5

/** P(yes) at or above this on a pair question becomes cannibalization. */
export const CANNIBAL_YES = 0.6

/** Word count at or above this: never recommend merging the page away. */
export const NEVER_MERGE_WORDS = 600

/**
 * Choice confidence needed to act, per question id.
 *
 * The pattern throughout: more options means a higher bar, because a
 * confidence value is a share of the mass across all of them, and a question
 * with ten options can land on the right one with less apparent confidence
 * than the same question with three.
 */
export const DECISIVE_BY_QUESTION: Record<string, number> = {
  // Three options, and the options are far apart: a lower bar keeps the
  // decisive rate up without acting on a coin-flip.
  action: 0.75,
  // Nine page types, several of them near-neighbours.
  page_type: 0.85,
  // Ten options and this is the recommendation an owner acts on, so it carries
  // the highest bar in the file. A wrong "rewrite it all" costs a page.
  highest_impact_change: 0.88,
  // Seven gap types plus a no-gap escape. The escape competes with the seven
  // for mass, so a real gap has to win clearly rather than edge a neighbour.
  content_type_gap: 0.85,
  // Seven clusters, closely neighbouring.
  cluster: 0.84,
  // Six intents, and mislabelling intent propagates into opportunity scoring.
  intent: 0.82,
  // Four situations, all concretely checkable.
  primary_cta: 0.78,
  // Six fixes plus an escape. A wrong citation fix sends an owner chasing the
  // wrong gap, and the escape is a real answer rather than a default.
  answer_engine_gaps: 0.85,
  ai_gap: 0.85,
}

/**
 * Score side-mass needed to act, per question id. Same reasoning as the choice
 * table: the mass on one side of the midpoint is the confidence.
 */
export const SCORE_MASS_BY_QUESTION: Record<string, number> = {
  // The headline AI lever, and the one the plan is pointed at, so it is held
  // to a lower bar than the default: it must not sit in the grey zone.
  paragraph_citability: 0.75,
  // Two questions about route and structure, where a false finding sends an
  // owner rebuilding a page that was fine. Both lean on judgement about a
  // count rather than about text, so both want a firmer mass.
  internal_link_adequacy: 0.85,
  scan_path: 0.85,
  // Site-set judgements read 20 page titles at once, so mass is spread thin.
  topic_authority: 0.85,
  site_freshness: 0.85,
  author_evidence: 0.82,
  brand_entity: 0.85,
  // The three new site-set judgements are in the same position: they read the
  // whole page set, where a specific high level is one of four plausible
  // answers spread over twenty pages of noisy titles.
  entity_relations: 0.85,
  claim_support: 0.85,
  source_attribution: 0.85,
  // A page-only scale, and the one that most rewards a generous reading of
  // naming: "enough named things" is a matter of taste, so a finding here is
  // cheap to make and annoying to receive without a firmer mass.
  entity_density: 0.8,
  // Reads the same twenty-page set as the site questions above.
  topic_reach: 0.82,
  // A four-level contest scale judged from phrase wording with no live results
  // page behind it. The costly error is a confident top level: it removes a
  // term from the opportunity pool on a guess, so this one is held firm.
  difficulty_proxy: 0.85,
}

/**
 * P(yes) at or below which a gate question becomes a finding, per question id.
 * A higher number here means a stricter question: it takes a weaker no to
 * raise a flag.
 */
export const GATE_FLOOR_BY_QUESTION: Record<string, number> = {
  // Only flag a page whose top is clearly not carrying its own subject.
  above_fold_promise: 0.6,
  // The strongest available no, and about structure rather than about claims.
  competitor_distinctiveness: 0.45,
  // "This page has no extractable list of anything" is a common and harmless
  // state for a narrative page, so it takes a much clearer no to be raised.
  extractable_format: 0.4,
  // Absence of a definition is a real gap, but "absence" is hard to establish
  // from a text sample, so this one is deliberately lenient.
  defines_key_terms: 0.45,
  // The keyword-level trust bar. Raising a flag here says "this topic needs
  // expert content", which is a real recommendation, but a false positive
  // pushes the site to pad ordinary pages with credentials it does not need.
  trust_bar: 0.5,
}

export type Band = "act" | "review" | "escalate"

export interface ThresholdCoverage {
  /** Choice question ids with no explicit bar, so they use DECISIVE. */
  choiceOnDefault: string[]
  /** Score question ids with no explicit mass bar, so they use DECISIVE. */
  scoreOnDefault: string[]
  /** Noul question ids with no explicit floor, so they use GATE_FLOOR. */
  noulOnDefault: string[]
}

/**
 * Which questions in a registry fall back to the global defaults. Nothing
 * forces an entry into the tables above, and an unlisted question is not
 * silently wrong — it is simply un-reasoned, which is a different thing and
 * worth being able to see. Exported so a caller can report the list rather
 * than leave it to be discovered by noticing a question never produces a
 * finding.
 *
 * `questions` is a registry keyed by question id whose values carry a `type`,
 * not a bare id list: the three tables only apply to their own primitive, and
 * checking a score against the choice bar would report every score in the file
 * as un-reasoned and make the whole report useless. The parameter is
 * structural so this file keeps no import of the question registry.
 */
export function thresholdCoverage(
  questions: Readonly<Record<string, { type: string }>>,
): ThresholdCoverage {
  const choiceOnDefault: string[] = []
  const scoreOnDefault: string[] = []
  const noulOnDefault: string[] = []
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "choice" && DECISIVE_BY_QUESTION[id] === undefined) choiceOnDefault.push(id)
    if (question.type === "score" && SCORE_MASS_BY_QUESTION[id] === undefined) scoreOnDefault.push(id)
    if (question.type === "noul" && GATE_FLOOR_BY_QUESTION[id] === undefined) noulOnDefault.push(id)
  }
  return { choiceOnDefault, scoreOnDefault, noulOnDefault }
}

export function bandForChoice(confidence: number): Band {
  if (confidence >= DECISIVE) return "act"
  if (confidence >= NO) return "review"
  return "escalate"
}

/**
 * The per-question form. Identical to bandForChoice when the id is not in
 * DECISIVE_BY_QUESTION, so an unlisted question behaves exactly as it did
 * before the tables existed.
 */
export function bandForChoiceAt(questionId: string, confidence: number): Band {
  const bar = DECISIVE_BY_QUESTION[questionId]
  if (bar === undefined) return bandForChoice(confidence)
  if (confidence >= bar) return "act"
  if (confidence >= NO) return "review"
  return "escalate"
}

/**
 * A Noul carries no separate confidence, so the probability itself is both the
 * answer and its confidence. Decisive in EITHER direction: P(yes) at or above
 * YES is a confident yes, P(yes) at or below NO is a confident no, and only the
 * grey zone between them is genuine doubt.
 */
export function bandForNoul(p: number): Band {
  if (p >= YES || p <= NO) return "act"
  return "review"
}

/** The finding floor for a gate question, per question id. */
export function gateFloorFor(questionId: string): number {
  return GATE_FLOOR_BY_QUESTION[questionId] ?? GATE_FLOOR
}

/** Normalise a Score onto 0..1 by dividing by its top level number. */
export function normalise(score: number, levels: number): number {
  const top = Math.max(levels - 1, 1)
  return score / top
}

/**
 * How much of a Score's probability mass sits on the "good" side of its
 * midpoint. A 4-level scale midpoints between level 1 and level 2, so a page
 * that splits 0.55/0.45 across levels 2 and 3 is on the same side and is not
 * treated as doubt.
 */
export function scoreSideMass(
  probabilities: Record<string, number>,
  levels: number,
): { good: number; bad: number; decisive: boolean } {
  return sideMassAt(probabilities, levels, DECISIVE)
}

/** The per-question form of scoreSideMass. Unlisted ids use DECISIVE. */
export function scoreSideMassAt(
  probabilities: Record<string, number>,
  levels: number,
  questionId: string,
): { good: number; bad: number; decisive: boolean } {
  return sideMassAt(probabilities, levels, SCORE_MASS_BY_QUESTION[questionId] ?? DECISIVE)
}

function sideMassAt(
  probabilities: Record<string, number>,
  levels: number,
  bar: number,
): { good: number; bad: number; decisive: boolean } {
  let good = 0
  let bad = 0
  for (const [key, value] of Object.entries(probabilities)) {
    const index = Number(key)
    if (!Number.isFinite(index)) continue
    const midpoint = (levels - 1) / 2
    if (index > midpoint) good += value
    else bad += value
  }
  const dominant = Math.max(good, bad)
  return { good, bad, decisive: dominant >= bar }
}

/**
 * Calibration status, exported so the UI can say out loud that these bands are
 * starting points. Section 6 of the plan is the work that would change this to
 * "tuned"; until then, no threshold here has been tested against labelled
 * pages, and `questionsAsked` decisions are as provisional as the numbers.
 *
 * The widened rubric has made one thing materially more important: every table
 * is per-question, and a question with no entry is not governed by any of the
 * reasoning in this file. `thresholdCoverage` exists to make that visible.
 */
export const CALIBRATION = {
  status: "untuned-defaults" as const,
  /** Questions with a per-question band, out of the total asked per item. */
  tunedQuestionIds: [
    ...Object.keys(DECISIVE_BY_QUESTION),
    ...Object.keys(SCORE_MASS_BY_QUESTION),
    ...Object.keys(GATE_FLOOR_BY_QUESTION),
  ],
  labelledPagesUsed: 0,
  note:
    "Bands are reasoned defaults, not tuned values. They become real only after a labelled set is measured against them — see section 6 of the plan.",
} as const
