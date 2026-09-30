/**
 * Rival keyword gaps: from a term to a row somebody could act on.
 *
 * The division of labour here is the one the whole project runs on — code finds,
 * Jev judges. Jev is asked five narrow questions per term and returns
 * probabilities; the six buckets, the page to write and the order to write them
 * in are all computed here, in code, from those answers plus the signals the
 * crawler already counted.
 *
 * Why the buckets are composed rather than asked for: a model handed the label
 * list picks the plausible label, and "plausible" is not the same as "true".
 * The bucket is a function of five booleans and one four-level rubric, so it can
 * be derived, checked, and re-derived when a threshold moves. Ask for it and you
 * have replaced a computation with a guess that reads like one.
 *
 * No search volume, anywhere. There is no index in this state, so a monthly
 * search count cannot be computed and is not estimated. `priority` is a ranking
 * over signals the crawler and the model both actually observed, and every
 * coefficient that produces it is named below so it can be argued with.
 */
import type { Answers, ChoiceAnswer, NoulAnswer, ScoreAnswer } from "./jevClient.js"
import { bandForChoiceAt, bandForNoul, normalise, GATE_FLOOR, NO, type Band } from "./thresholds.js"
import { GAP_COVERAGE_LEVELS } from "./questions.js"

/**
 * The six buckets, and the only thing that decides one.
 *
 * Total and mutually exclusive, checked by `gapBucket`'s own tests:
 *
 *   rival has it | we have it | extra          -> bucket
 *   yes          | no         | -              -> missing
 *   no           | no         | -              -> untapped
 *   yes          | yes        | -              -> shared
 *   no           | yes        | our own offer -> unique
 *   no           | yes        | strong         -> strong
 *   no           | yes        | otherwise      -> weak
 *
 * `shared` deliberately carries no quality distinction: when both sites field a
 * page the actionable fact is that we are in the running, and the quality of
 * our page is already reported per page by the page judgements. Splitting it
 * would double-count one judgement across two buckets.
 */
export type GapBucket = "shared" | "missing" | "weak" | "strong" | "untapped" | "unique"

export const GAP_BUCKETS: readonly GapBucket[] = [
  "shared",
  "missing",
  "weak",
  "strong",
  "untapped",
  "unique",
]

/** What to actually build. `refresh` means fix the page we have, not add one. */
export type ContentType = "pillar" | "how-to" | "comparison" | "faq" | "product" | "refresh" | "none"

/** The model's `deliverable` choice, mapped onto our content types. */
const DELIVERABLE_MAP: Record<string, ContentType> = {
  pillar: "pillar",
  how_to: "how-to",
  comparison: "comparison",
  faq: "faq",
  product: "product",
  refresh_existing: "refresh",
  none: "none",
}

/**
 * `our_coverage` has four levels and the top one is the only "we are covered"
 * reading. A page that exists but is off-topic scores 1 and is a `weak` bucket,
 * not a `shared` one — that distinction is the reason the scale is four deep.
 */
const STRONG_AT_OR_ABOVE = 3

export interface GapSignals {
  /** Paths of our own pages the term already appears on. Code counted these. */
  onOurPages: readonly string[]
  /**
   * How many rival pages were actually crawled for this run.
   *
   * Zero is a real case, not an edge case: the gap pass now also runs over
   * presearch seeds when no rival was crawled, because "somebody typed this and
   * we have nothing on it" is a real gap that does not need a competitor to
   * exist. On such a row `rival_serves` is unanswerable, and the reasons below
   * have to say that rather than assert something nobody looked at.
   */
  rivalPagesCrawled?: number
  /** Ranks at which the rival was seen carrying the term, 1-based, if known. */
  rivalRank?: number | null
}

export interface GapRow {
  term: string
  bucket: GapBucket
  /** What to build, or "none" when the term is not worth a page. */
  contentType: ContentType
  /** Where the page goes. A refresh targets the page we already have. */
  targetPath: string
  /** Our own path this is about, when the term is already partly covered. */
  existingPaths: readonly string[]
  /** Titles shown to the model, not titles it said serve the term. Gate on rivalServes. */
  rivalPaths: readonly string[]
  rivalServes: boolean
  /** 0..1, over observable signals only. Never a search volume. */
  priority: number
  band: Band
  needsHuman: boolean
  /** Why this scored what it did, in words a human can argue with. */
  reasons: string[]
  probabilities: Record<string, { label: string; value: number; kind: "choice" | "noul" | "score" }>
  model: string
  ms: number
  costUsd: number
  inputTokens: number
}

function asChoice(answers: Answers, id: string): ChoiceAnswer | null {
  const answer = answers[id]
  return answer?.type === "choice" ? answer : null
}

function asScore(answers: Answers, id: string): ScoreAnswer | null {
  const answer = answers[id]
  return answer?.type === "score" ? answer : null
}

function asNoul(answers: Answers, id: string): NoulAnswer | null {
  const answer = answers[id]
  return answer?.type === "noul" ? answer : null
}

function noulP(answers: Answers, id: string): number {
  return asNoul(answers, id)?.noul ?? 0.5
}

/**
 * The bucket, as a pure function of the answers.
 *
 * Undecided is decided toward the *actionable* side: a term we are unsure we
 * cover is treated as not covered, because the cost of wrongly writing a page
 * is an afternoon, while wrongly assuming coverage is a term that never gets
 * written at all. That asymmetry is a choice, and it is why a grey
 * `our_serves` lands in `missing` rather than `shared`.
 */
export function gapBucket(answers: Answers): GapBucket {
  const rivalServes = noulP(answers, "rival_serves") >= 0.5
  const ourServes = noulP(answers, "our_serves") >= 0.5

  if (rivalServes && !ourServes) return "missing"
  if (!rivalServes && !ourServes) return "untapped"
  if (rivalServes && ourServes) return "shared"

  const ownSubject = noulP(answers, "our_own_subject") >= 0.5
  if (ownSubject) return "unique"

  const coverage = asScore(answers, "our_coverage")?.score ?? 0
  return coverage >= STRONG_AT_OR_ABOVE ? "strong" : "weak"
}

export function contentTypeFor(answers: Answers): ContentType {
  const choice = asChoice(answers, "deliverable")
  if (!choice) return "none"
  return DELIVERABLE_MAP[choice.choice] ?? "none"
}

/**
 * The slug, from the term alone. Code owns this because a URL is a fact about
 * the site, not a judgement: the model is never asked where a page should live.
 */
export function slugFor(term: string): string {
  const slug = term
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, 72).replace(/-+$/, "")
}

/**
 * Comparison form of a path or term word. Only the trailing plural is folded:
 * "boiler" and "boilers" are the same word for the purpose of asking which page
 * a term belongs on, and leaving them distinct made `/services/boilers` look
 * unrelated to "boiler repair" — which is the single most common mismatch in
 * this domain, because service pages are named in the plural and searches are
 * not. Deliberately not a real stemmer: over-stemming merges genuinely different
 * words and picks the wrong page.
 */
function comparable(word: string): string {
  const lower = word.toLowerCase()
  if (lower.length > 3 && lower.endsWith("es") && /(?:s|x|z|ch|sh)es$/.test(lower)) {
    return lower.slice(0, -2)
  }
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1)
  return lower
}

function wordSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
      .map(comparable),
  )
}

/**
 * The existing page most likely to be the one this term belongs on, by shared
 * words. `existingPaths[0]` is not good enough: the list is in crawl order, so
 * that is usually the homepage, and a product term pointed at `/` is a URL no
 * one can act on. Zero overlap is a legitimate answer, not a failure — the
 * term may be new to the site.
 */
function bestExistingPath(term: string, existingPaths: readonly string[]): string | null {
  const wanted = wordSet(term)
  if (wanted.size === 0) return null

  let best: string | null = null
  let bestScore = 0
  for (const path of existingPaths) {
    const pathWords = wordSet(path)
    let score = 0
    for (const word of wanted) if (pathWords.has(word)) score += 1
    if (score > bestScore) {
      bestScore = score
      best = path
    }
  }
  return best
}

/**
 * Where the page goes.
 *
 * A refresh targets the page we already have. A product term goes on the best
 * matching page we have, and only becomes a new slug when we have nothing that
 * shares a word with it. Everything else becomes its own slug at the root,
 * which is the one placement that is always valid: any deeper guess would have
 * to invent a section the crawl may never have seen, and a wrong deep link is
 * worse than a flat one.
 */
export function targetPathFor(
  term: string,
  contentType: ContentType,
  existingPaths: readonly string[],
): string {
  if (contentType === "none") return ""
  const existing = bestExistingPath(term, existingPaths)
  if (contentType === "refresh" && existingPaths.length > 0) {
    return existing ?? existingPaths[0]!
  }
  if (contentType === "product") {
    return existing ?? `/${slugFor(term)}`
  }
  return `/${slugFor(term)}`
}

/**
 * Priority, from signals that exist.
 *
 * Every term below is observable: a probability the model returned for a
 * question it was actually asked, or a count the crawler produced. There is no
 * volume coefficient here and there cannot be one — inventing it would put a
 * fabricated number at the top of a list a customer pays to act on.
 *
 * A gap the rival already serves outranks open ground, because a term a
 * competitor reaches for is the closest thing to proof of demand available
 * without a search index. `untapped` is therefore ranked last, not first: it is
 * the bucket most likely to be a phrase nobody types.
 */
const WEIGHTS = {
  /** Typed by someone choosing a provider. The commercial value of the term. */
  buyer: 0.26,
  /** Rival presence: the only demand evidence this state contains. */
  rivalServes: 0.20,
  /** We hold nothing here, so the work is additive. */
  uncovered: 0.14,
  /** A weak page we already have is cheaper to fix than to create. */
  weakExisting: 0.10,
  /** The term is about our own offer, so we can be the best answer. */
  ownSubject: 0.08,
} as const

/** Bucket weight, applied after the signal scores so buckets stay comparable. */
const BUCKET_WEIGHT: Record<GapBucket, number> = {
  missing: 1,
  weak: 0.8,
  untapped: 0.35,
  shared: 0.2,
  unique: 0.5,
  strong: 0.15,
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * Whether the term is a phrase anyone would type is a gate, not a weight.
 *
 * A mined pool contains sentence fragments, and a fragment that scores 0.4 on
 * every other axis is still a fragment — ranking it above a real term would put
 * "the best way to" at the top of a list somebody pays to act on. So the gate
 * is 0 at or below the NO band and ramps to full weight at the midpoint: a
 * confidently fake phrase is not ranked at all, while a genuinely borderline
 * one still competes on the rest of its signals.
 */
function realQueryGate(answers: Answers): number {
  const p = noulP(answers, "is_real_query")
  if (p <= NO) return 0
  return clamp01((p - NO) / (GATE_FLOOR - NO))
}

export function priorityFor(bucket: GapBucket, answers: Answers, signals: GapSignals): number {
  const parts =
    WEIGHTS.buyer * noulP(answers, "is_buyer_query") +
    WEIGHTS.rivalServes * noulP(answers, "rival_serves") +
    WEIGHTS.uncovered * (noulP(answers, "our_serves") < 0.5 ? 1 : 0) +
    WEIGHTS.weakExisting * (bucket === "weak" ? 1 : 0) +
    WEIGHTS.ownSubject * noulP(answers, "our_own_subject")

  return clamp01(parts * BUCKET_WEIGHT[bucket] * realQueryGate(answers))
}

/**
 * The readable justification. Written from the same answers as the numbers, so
 * a row cannot claim a priority its reasons do not support.
 */
export function reasonsFor(bucket: GapBucket, answers: Answers, signals: GapSignals): string[] {
  const reasons: string[] = []
  const rivalServes = noulP(answers, "rival_serves") >= 0.5
  const ourServes = noulP(answers, "our_serves") >= 0.5
  const rivalsLooked = (signals.rivalPagesCrawled ?? 0) > 0

  // The distinction the whole row rests on: "we looked and found nothing" and
  // "we never looked" are different facts, and only the first is a finding.
  reasons.push(
    !rivalsLooked
      ? "No rival site was crawled for this run, so this row says nothing about rivals"
      : rivalServes
        ? "A rival page is written to answer this term"
        : "No rival page targets this term",
  )
  reasons.push(
    ourServes
      ? `We already have ${signals.onOurPages.length} page(s) on it`
      : "We have no page targeting it",
  )
  if (noulP(answers, "is_buyer_query") >= 0.5) {
    reasons.push("Someone typing this is choosing a provider")
  }
  if (signals.rivalRank != null) {
    reasons.push(`Rival seen at position ${signals.rivalRank}`)
  }
  reasons.push(`Bucket: ${bucket}`)
  return reasons
}

/**
 * Grey-zone detection, matching the rest of the harness. A bucket derived from
 * two nouls that both sat near 0.5 is a guess, and is reported as one rather
 * than acted on.
 */
function needsHumanFor(answers: Answers, bucket: GapBucket, signals: GapSignals): boolean {
  if (noulP(answers, "is_real_query") < 0.5) return true
  if (bucket === "missing" && noulP(answers, "our_serves") > 0.35) return true
  if (bucket === "untapped" && noulP(answers, "rival_serves") > 0.65) return true
  if (bandForNoul(noulP(answers, "our_serves")) === "review") return true
  // Half of a comparison was never made. The row is still published — a seed
  // with no page of ours is a real gap — but it is flagged, because the bucket
  // it landed in says nothing about rivals and everything about us.
  if ((signals.rivalPagesCrawled ?? 0) === 0) return true
  return false
}

export function bandForGap(bucket: GapBucket, answers: Answers): Band {
  const coverage = asScore(answers, "our_coverage")
  if (coverage && bucket !== "untapped") {
    const normalised = normalise(coverage.score, GAP_COVERAGE_LEVELS.length)
    if (normalised >= 0.99) return "act"
  }
  const deliverable = asChoice(answers, "deliverable")
  if (deliverable) {
    const band = bandForChoiceAt("deliverable", deliverable.confidence)
    if (band !== "act") return band
  }
  return bandForNoul(noulP(answers, "rival_serves"))
}

export interface GapMeta {
  term: string
  model: string
  ms: number
  costUsd: number
  inputTokens: number
  answers: Answers
  signals: GapSignals
}

/** One term, one row. Everything on it is either answered or counted. */
export function buildGapRow(meta: GapMeta): GapRow {
  const { answers, signals, term } = meta
  const bucket = gapBucket(answers)
  const contentType = contentTypeFor(answers)
  const probabilities: GapRow["probabilities"] = {}

  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "choice") {
      probabilities[id] = { label: answer.choice, value: answer.confidence, kind: "choice" }
    } else if (answer.type === "noul") {
      probabilities[id] = { label: "yes", value: answer.noul, kind: "noul" }
    } else {
      probabilities[id] = {
        label: `level ${answer.score}`,
        value: normalise(answer.score, GAP_COVERAGE_LEVELS.length),
        kind: "score",
      }
    }
  }

  return {
    term,
    bucket,
    contentType,
    targetPath: targetPathFor(term, contentType, signals.onOurPages),
    existingPaths: signals.onOurPages,
    rivalPaths: [],
    rivalServes: noulP(answers, "rival_serves") >= 0.5,
    priority: priorityFor(bucket, answers, signals),
    band: bandForGap(bucket, answers),
    needsHuman: needsHumanFor(answers, bucket, signals),
    reasons: reasonsFor(bucket, answers, signals),
    probabilities,
    model: meta.model,
    ms: meta.ms,
    costUsd: meta.costUsd,
    inputTokens: meta.inputTokens,
  }
}
