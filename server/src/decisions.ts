/**
 * The decision layer: from a score to an instruction.
 *
 * `highest_impact_change` is asked on every page (threshold `0.88`,
 * `thresholds.ts`) and until this file existed it was read by zero lines of
 * `audit.ts` — a question paid for on every request and thrown away. It is the
 * one answer that converts a set of defects into a single "do this first", so
 * this is where it becomes a row somebody can act on.
 *
 * Three rules the whole file is built to keep:
 *
 * 1. **A decision is gated, not weighted.** A page produces a `DecisionRow`
 *    only when the answer is decisive (`act` band) and is not
 *    `nothing_missing`. Everything else goes to the grey zone with a reason.
 *    The temptation is to widen the band so the panel is fuller; that would
 *    turn the one signal an owner acts on into a suggestion, so the band stays
 *    where the threshold file put it.
 * 2. **A witness is a counted fact, never a prediction.** Every entry in
 *    `WITNESS` is a function of `PageEvidence` — numbers the crawler produced
 *    and prose the crawler extracted. None of them says what will happen if the
 *    change is made. There is no index, no SERP and no volume in this state, so
 *    a sentence like "this will improve rankings" is not a weak claim, it is an
 *    unsourceable one.
 * 3. **A falsifier names the question that has to move.** A recommendation
 *    nobody can disagree with is not a recommendation. Each change carries the
 *    page question whose answer, if it went the other way, would make the
 *    instruction wrong — so the panel can be argued with rather than obeyed.
 */
import type { Band } from "./thresholds.js"
import type { PageEvidence } from "./crawl.js"

export interface TopChange {
  /** Question option key, e.g. "answer_in_the_first_two_sentences". */
  key: string
  /** HIGHEST_IMPACT_CHANGES[key].what, verbatim. Already imperative. */
  instruction: string
  /** HIGHEST_IMPACT_CHANGES[key].examples, verbatim. */
  example: string
  /** P(this is the highest-impact change). */
  p: number
  runnerUp: { key: string; p: number } | null
  band: Band
  /** A code-counted fact quoted from PageEvidence. Never a prediction. */
  witness: string | null
  /** The question id that must move for this change to be wrong. */
  falsifier: string
}

export interface Reach {
  inbound: number
  inboundShare: number
  outbound: number
  deadEnd: boolean
  hops: number
}

export interface DecisionRow {
  path: string
  url: string
  /** PAGE_PRIORITY.importance * importance + PAGE_PRIORITY.reach * inboundShare */
  priority: number
  topChange: TopChange
  /** Findings on this page that are NOT the top change. */
  extraFindings: number
  pageType: string
  intent: string
  /** Crawler count, carried so the card's path chip needs no second lookup. */
  words: number
  /** Link-graph position, from `page.position`. */
  reach: Reach
}

/**
 * How much a page's own importance counts against how reachable it is.
 *
 * A gate and a weight, in that order: `topChange === null` means no row at all,
 * so these coefficients only ever *reorder* pages that already have a decisive
 * instruction. `importance` leads because the model's own read of what the page
 * is for beats the raw link count; `inboundShare` is a share, so it is already
 * normalised against the rest of the crawl and needs no rescaling.
 */
export const PAGE_PRIORITY = { importance: 0.55, reach: 0.45 } as const

/**
 * The option that means "there is nothing to do". It is a real answer rather
 * than an escape hatch, and it is the one option that never becomes a
 * `TopChange` — see rule 1.
 */
export const NO_CHANGE = "nothing_missing"

/**
 * The question that must move for each instruction to be wrong.
 *
 * These are the questions actually asked on a page, so a falsifier is never a
 * question the harness does not have an answer for. Where the closest thing is
 * a scale rather than a gate, the scale is named and the direction is stated in
 * the panel, because "this would improve" is not something this state can show.
 */
export const FALSIFIER: Record<string, string> = {
  answer_in_the_first_two_sentences: "answer_first",
  add_self_contained_facts: "citable",
  add_proof_and_sources: "claims_substantiated",
  name_an_author: "trust",
  link_onward: "internal_link_adequacy",
  // `extractable_format` is the defensible alternative here — it is a noul on
  // whether enumerable material sits in a liftable form. `scan_path` is kept
  // because "break it into sections" is about a reader being able to take the
  // page in pieces, which is what scan_path measures, whereas
  // extractable_format also fires on a well-sectioned page that is all prose.
  break_it_into_sections: "scan_path",
  name_one_action: "clear_next_step",
  retitle_for_the_searcher: "title_fit",
  narrow_or_split_the_page: "intent",
  // Deliberately no `nothing_missing` row. `topChangeFor` returns null on
  // NO_CHANGE, so no TopChange can ever carry that key, and the no-change case
  // reaches the panel as prose on `notDecided.reason` instead. An unreachable
  // row invites a reader to assume it is live, and is the same trap as a
  // falsifier naming a question this run never asked.
  //
  // If one is ever needed, it must not be `nothing_missing` itself (a
  // tautology) and its polarity inverts: for every other key the falsifier is
  // the POSITIVE result, but "nothing is missing" is already the positive
  // claim, so it takes the NEGATIVE one.
}

/**
 * Used when the primary falsifier was not asked on this page.
 *
 * `pageQuestions` gates four questions on presence flags: `h1_fit`,
 * `answer_first` and `above_fold_promise` need an H1, `title_fit` needs a
 * title, `meta_fit` needs a description. A falsifier names the question that
 * must MOVE — so naming one that was never asked is a dead reference, and a
 * panel rendering it invites a reader to check an answer that does not exist.
 *
 * Each fallback below is asked on every page, and is the nearest honest
 * question to the instruction it stands in for.
 */
export const FALSIFIER_FALLBACK: Record<string, string> = {
  answer_in_the_first_two_sentences: "structure_ease",
  retitle_for_the_searcher: "intent",
}

/** Figures a number can hide inside ordinary prose. */
const FIGURE = /(?:\d[\d,.]*\s?(?:%|£|\$|€|kw|kg|mm|cm|m|l|hrs?|hours?|minutes?|days?|weeks?|months?|years?)?)|\b(?:nineteen|eighty|one|two|three|four|five|six|seven|eight|nine|ten)[\s-](?:hundred|thousand|million)\b/gi

function countFigures(text: string): number {
  return (text.match(FIGURE) ?? []).length
}

/**
 * The witness for each instruction, as a function of the crawled page.
 *
 * Every one of these returns a sentence describing a measurement or an
 * absence, and none returns a sentence about consequences. `null` is allowed
 * and is passed through: a witness is a bonus on the card, never a
 * requirement, and inventing one to fill the slot would be worse than leaving
 * it empty.
 */
export const WITNESS: Record<string, (page: PageEvidence) => string | null> = {
  answer_in_the_first_two_sentences: (page) => {
    const sentences = page.opening.match(/[^.!?]+[.!?]*/g) ?? []
    const firstTwo = sentences.slice(0, 2).join(" ").trim()
    const words = firstTwo.length === 0 ? 0 : firstTwo.split(/\s+/).filter(Boolean).length
    if (words === 0) {
      return `No text sits between the H1 and the next heading — the extractor read ${page.words} words on this page, so this is where the answer should be stated`
    }
    return `The first two sentences run ${words} word${words === 1 ? "" : "s"}; the opening as a whole runs ${page.opening.split(/\s+/).filter(Boolean).length}`
  },
  add_self_contained_facts: (page) =>
    `${countFigures(page.text)} figure${countFigures(page.text) === 1 ? "" : "s"} or measurements in ${page.words} words`,
  add_proof_and_sources: (page) =>
    `${page.authors.length} named author${page.authors.length === 1 ? "" : "s"} and ${page.externalLinks} outbound link${page.externalLinks === 1 ? "" : "s"} to anything outside the site`,
  name_an_author: (page) =>
    page.authors.length === 0
      ? `No author is named anywhere in the ${page.words} words`
      : `${page.authors.length} author${page.authors.length === 1 ? "" : "s"} named: ${page.authors.slice(0, 2).join(", ")}`,
  link_onward: (page) =>
    `The page links to ${page.position.outbound} other page${page.position.outbound === 1 ? "" : "s"} we crawled, and ${page.position.inbound} page${page.position.inbound === 1 ? "" : "s"} link to it`,
  break_it_into_sections: (page) => {
    const subheadings = page.headingOutline.filter((node) => node.level >= 2).length
    return `${subheadings} subheading${subheadings === 1 ? "" : "s"} below the H1 across ${page.words} words`
  },
  name_one_action: (page) =>
    page.internalLinks === 0
      ? "The page carries no internal link at all, so nothing on it leads anywhere"
      : `${page.internalLinks} internal link${page.internalLinks === 1 ? "" : "s"} on the page, ${page.position.outbound} of them to another crawled page`,
  retitle_for_the_searcher: (page) => {
    const titleWords = page.title.trim().length === 0 ? 0 : page.title.trim().split(/\s+/).length
    const overlap = Math.round(page.topic.titleH1Overlap * 100)
    return `Title runs ${titleWords} word${titleWords === 1 ? "" : "s"}; the H1 repeats ${overlap}% of the title's words`
  },
  narrow_or_split_the_page: (page) =>
    page.topic.secondary.length === 0
      ? `One subject phrase across ${page.words} words: "${page.topic.primary || "none detected"}"`
      : `${page.words} words carrying ${page.topic.secondary.length + 1} subject phrases, led by "${page.topic.primary || "none detected"}"`,
  [NO_CHANGE]: (page) => `${page.words} words, ${page.position.inbound} inbound link${page.position.inbound === 1 ? "" : "s"} from the pages we crawled`,
}

/** Reach, copied from the crawl's link graph. Never recomputed, never predicted. */
export function reachOf(page: PageEvidence): Reach {
  return {
    inbound: page.position.inbound,
    inboundShare: page.position.inboundShare,
    outbound: page.position.outbound,
    deadEnd: page.position.deadEnd,
    hops: page.position.hops,
  }
}

/**
 * `PAGE_PRIORITY` as a function, kept here so the formula and its constants
 * cannot drift apart. Both inputs are already 0..1: `importance` is the
 * normalised score from the page pass, `inboundShare` is the crawler's own
 * share of all inbound links in the crawl.
 */
export function decisionPriority(importance: number, reach: Reach): number {
  const value =
    PAGE_PRIORITY.importance * importance + PAGE_PRIORITY.reach * reach.inboundShare
  return Number(value.toFixed(4))
}

/** The `what` text of a HIGHEST_IMPACT_CHANGES option, verbatim. */
export interface ChangeCopy {
  what: string
  examples: string
}

function copyFor(key: string, options: Record<string, unknown>): ChangeCopy | null {
  const option = options[key]
  if (!option || typeof option !== "object") return null
  const record = option as Record<string, unknown>
  const what = record.what
  const examples = record.examples
  if (typeof what !== "string" || typeof examples !== "string") return null
  return { what, examples }
}

/**
 * The second-best option, so the panel can show how close the call was.
 *
 * `nothing_missing` is kept in the runner-up slot rather than filtered out: on
 * a real page "the model nearly said there is nothing to do here" is the single
 * most useful thing to show next to a recommendation, and the panel only renders
 * it when the gap is under 0.15.
 */
function runnerUpFor(
  probabilities: Record<string, number>,
  chosen: string,
): { key: string; p: number } | null {
  let best: { key: string; p: number } | null = null
  for (const [key, value] of Object.entries(probabilities)) {
    if (key === chosen) continue
    if (!Number.isFinite(value)) continue
    if (best === null || value > best.p) best = { key, p: value }
  }
  return best
}

export interface TopChangeInput {
  /** The chosen option key from `highest_impact_change`. */
  key: string
  /** The full probability distribution the judge returned. */
  probabilities: Record<string, number>
  /** Band already computed by the caller from the per-question threshold. */
  band: Band
  /** The crawled page, for the counted witness. */
  page: PageEvidence
  /** `HIGHEST_IMPACT_CHANGES`, so this file stays a consumer and not a copy. */
  options: Record<string, unknown>
  /**
   * Question ids actually asked on this page. Gates the falsifier: a
   * presence-gated question that was skipped cannot be the one that has to
   * move. Omit it and the primary falsifier is used unconditionally.
   */
  askedIds?: ReadonlySet<string>
}

/**
 * The question that must move, preferring one that was actually asked.
 *
 * Polarity is the panel's job, not this map's: a falsifier here is an id, and
 * "if this moved, the instruction would be wrong" is rendered around it. For
 * the `nothing_missing` row the honest reading is the NEGATIVE direction — a
 * high `citable` would mean facts are quotable and so something is missing,
 * contradicting the card. Rendering that inversion is UX copy and belongs with
 * the copy; what matters here is only that the id is a real, independent
 * question and never the question that produced the answer.
 */
function falsifierFor(key: string, askedIds?: ReadonlySet<string>): string {
  const primary = FALSIFIER[key] ?? "page_type"
  if (!askedIds || askedIds.has(primary)) return primary
  const fallback = FALSIFIER_FALLBACK[key]
  if (fallback && askedIds.has(fallback)) return fallback
  return LAST_RESORT_QUESTION
}

/**
 * Last resort, and deliberately NOT `highest_impact_change`: a falsifier that
 * is the question which produced the change is not a falsifier, it is a
 * tautology. `page_type` is asked on every page, is independent of the
 * instruction, and is genuinely able to contradict it — a page decisively typed
 * `legal_or_policy` is not improved by most of the changes above.
 */
const LAST_RESORT_QUESTION = "page_type"

/**
 * Build the `TopChange` for a decisive, actionable answer, or `null`.
 *
 * `null` is returned — never a fabricated row — when the answer is absent, the
 * band is not `act`, the option is `nothing_missing`, or the option is not in
 * the question registry. The caller pushes a reason for each; the grey zone is
 * published, not hidden and not widened.
 */
/**
 * A second, relative route to `act`, because "decisive" is a statement about the
 * shape of the distribution and not only about its height.
 *
 * `highest_impact_change` returns one option at a time out of ten, so its
 * absolute confidence stays low even when the winner is not remotely in doubt —
 * a page measured at 0.68 with the runner-up on 0.18 is a four-to-one answer and
 * is actionable. Requiring that one to clear the 0.88 absolute bar emptied the
 * DO THIS NOW queue on a site where the model had in fact picked a winner on
 * every page.
 *
 * Lowering the absolute bar instead would be the easy fix and the wrong one: it
 * would also admit flat distributions like 0.37 / 0.30 / 0.17, where the model has
 * genuinely not decided. The margin keeps those out, so the grey zone still means
 * what it says.
 *
 * Both coefficients are exported because they are arguments, not magic.
 */
export const DECISIVE_MARGIN = 0.2
export const DECISIVE_FLOOR = 0.5

export function topChangeFor(input: TopChangeInput): TopChange | null {
  const { key, probabilities, band, page, options } = input
  if (key === NO_CHANGE) return null

  const copy = copyFor(key, options)
  if (!copy) return null

  const p = probabilities[key]
  if (typeof p !== "number" || !Number.isFinite(p)) return null

  const runnerUp = runnerUpFor(probabilities, key)
  const decisiveByMargin =
    runnerUp !== null && p - runnerUp.p >= DECISIVE_MARGIN && p >= DECISIVE_FLOOR

  if (band !== "act" && !decisiveByMargin) return null

  return {
    key,
    instruction: copy.what,
    example: copy.examples,
    p: Number(p.toFixed(3)),
    runnerUp,
    band,
    witness: witnessFor(key, page),
    falsifier: falsifierFor(key, input.askedIds),
  }
}

/** The witness on its own. A witness that cannot be computed is absent, not a crash. */
export function witnessFor(key: string, page: PageEvidence): string | null {
  const fn = WITNESS[key]
  if (!fn) return null
  try {
    return fn(page)
  } catch {
    return null
  }
}
