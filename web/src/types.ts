import type { CompetitorProposal, KeywordSeedProposal, MetricProposal } from "./researchTypes"

export type Band = "act" | "review" | "escalate"
export type Severity = "critical" | "serious" | "moderate" | "minor"

export interface Finding {
  id: string
  title: string
  detail: string
  severity: Severity
  source: "jev" | "rule"
  band: Band
  probability: number | null
  fix: string
  pages?: string[]
}

export interface PageJudgement {
  url: string
  path: string
  words: number
  pageType: string
  intent: string
  importance: number
  action: string
  band: Band
  needsHuman: boolean
  reasons: string[]
  probabilities: Record<string, { label: string; value: number; kind: "choice" | "noul" | "score" }>
  findings: Finding[]
  model: string
  ms: number
  costUsd: number
  inputTokens: number
}

export interface PatternCount {
  label: string
  count: number
  share: number
}

export interface AuditTotals {
  pagesCrawled: number
  pagesJudged: number
  keywordsJudged: number
  competitorsJudged: number
  judgements: number
  questionsAsked: number
  inputTokens: number
  costUsd: number
  elapsedMs: number
  medianMs: number
  p95Ms: number
  needsHuman: number
  decisiveShare: number
  errors: number
}

export interface KeywordJudgement {
  term: string
  words: number
  pages: string[]
  frequency: number
  inHeadings: number
  intent: string
  cluster: string
  isBuyerQuery: number
  isRealQuery: number
  coverageGap: number
  opportunity: number
  band: Band
  needsHuman: boolean
  reasons: string[]
  probabilities: Record<string, { label: string; value: number; kind: "choice" | "noul" | "score" }>
  model: string
  ms: number
  costUsd: number
  inputTokens: number
}

export interface CompetitorResult {
  url: string
  reachable: boolean
  pages: number
  score: number
  grade: string
  businessModel: string | null
  aiGap: string | null
  worthCopying: number
  proofDensity: number | null
  topics: string[]
  topFix: string
  ruleFindings: number
  error?: string
  model: string
  ms: number
  costUsd: number
  inputTokens: number
}

export interface LinkSuggestion {
  from: string
  to: string
  reason: string
  p: number
}

export interface KeywordCandidate {
  term: string
  words: number
  pages: string[]
  frequency: number
  inHeadings: number
  inTitle: number
  weight: number
}

export interface RuleStats {
  pages: number
  avgWords: number
  withSchema: number
  withDescription: number
  withH1: number
  https: boolean
  titleLengthOk: number
  descriptionLengthOk: number
}

export interface AuditReport {
  url: string
  root: string
  business: {
    name: string
    context: string
    market: string
    modelClassification: string | null
    modelProbabilities: Record<string, number>
  }
  model: string
  jevAssessed: boolean
  generatedAt: string
  totals: AuditTotals
  score: number
  grade: string
  stats: RuleStats
  findings: Finding[]
  ruleFindings: Finding[]
  pages: PageJudgement[]
  patterns: {
    pageType: PatternCount[]
    intent: PatternCount[]
    action: PatternCount[]
    aiGap: PatternCount[]
    keywordIntent: PatternCount[]
    keywordCluster: PatternCount[]
  }
  keywords: KeywordJudgement[]
  gaps: GapRow[]
  keywordPool: KeywordCandidate[]
  competitors: CompetitorResult[]
  linkSuggestions: LinkSuggestion[]
  siteJudgements: Record<string, unknown> | null
  needsHuman: Array<{ url: string; reasons: string[] }>
  crawled: CrawledPage[]
  crawl: { robotsFetched: boolean; sitemapFound: number; discovered: number; errors: string[] }
  ledger: Array<{ url: string; model: string; ms: number; inputTokens: number; costUsd: number; attempts: number }>
  decisions: DecisionRow[]
  subjects: SubjectRow[]
  /** Pages judged for which the gate produced no DecisionRow, with the reason. */
  notDecided: Array<{ path: string; url: string; reason: string }>
  presearch: { ran: boolean; degraded: boolean; reason: string | null }
  rivalsRequested: number
  rivalsJudged: number
  rivalCap: RivalCap
  /** This run against the previous one for the same root. */
  delta: RunDelta
}

/* ── the rival cap, stated rather than applied (mirrors server/src/audit.ts) ── */

export interface RivalCap {
  cap: number
  requested: number
  attempted: number
  judged: number
  unreachable: string[]
  pastTheCap: string[]
}

/* ── run diff (mirrors server/src/history.ts) ──
 * A page is `raised` when the run produced a decisive top change or an act-band
 * finding, and `reachable` only when it was crawled AND judged. Only reachable
 * in both runs is a basis for comparison; everything else is `not_comparable`.
 * It is never folded into a closed state. */

export type PageBandWord = "decisive" | "to verify" | "needs a human"

export type DeltaState =
  | "still_open"
  | "changed"
  | "not_longer_raised"
  | "regressed"
  | "newly_raised"
  | "not_comparable"
  | "clean"

export interface PageDelta {
  path: string
  url: string
  state: DeltaState
  comparable: boolean
  raisedNow: boolean
  raisedBefore: boolean
  /** The key, so "the same change" is decidable rather than a string match. */
  topChangeKey: string | null
  topChange: string | null
  bandNow: PageBandWord | null
  bandBefore: PageBandWord | null
}

export interface RunDelta {
  /** `null` is the first run for this root, not a degenerate case. */
  baseline: null | { generatedAt: string; score: number; openPages: number }
  scoreDelta: number | null
  /** Both runs judged by the same model. False withholds `scoreDelta`. */
  judgedBothRuns: boolean
  stillOpen: PageDelta[]
  changed: PageDelta[]
  notLongerRaised: PageDelta[]
  regressed: PageDelta[]
  newlyRaised: PageDelta[]
  notComparable: PageDelta[]
  /**
   * A count, never a list. Note it is a mixture: it absorbs pages reachable in
   * both that neither run raised, and pages discovered this run that it did not
   * raise. It is therefore not a denominator for anything.
   */
  clean: number
  unreachableBefore: number
  /**
   * Pages both runs could speak about: crawled AND judged in each. A different
   * number from `baseline.openPages`, which counts what the earlier run raised —
   * the two leak, so a numerator summed over the moved buckets is not a subset
   * of `openPages`.
   */
  comparableCount: number
  pagesCrawledNow: number
  pagesCrawledBefore: number
}

/** One page as the crawler measured it. Countable in code — no model wrote a field of this shape. */
export interface CrawledPage {
  url: string
  path: string
  status: number
  words: number
  title?: string
  depth?: number
  headings?: number
  ruleFindings?: number
  internalLinks?: number
  externalLinks?: number
  imagesMissingAlt?: number
  noindex?: boolean
}

/**
 * Per-page crawl event, emitted from `crawl({ onPage })` so the SCRAPED table
 * fills during the run. `ruleFindings` is absent until `done`: the rules run
 * over the finished crawl, so a live row carries a dash there, never a zero.
 */
export type GapBucket = "shared" | "missing" | "weak" | "strong" | "untapped" | "unique"

export type ContentType = "pillar" | "how-to" | "comparison" | "faq" | "product" | "refresh" | "none"

/**
 * A keyword gap as the server measured it. Mirrors `GapRow` in
 * server/src/gap.ts field for field; the two drift together or typecheck fails.
 */
export interface GapRow {
  term: string
  bucket: GapBucket
  contentType: ContentType
  targetPath: string
  existingPaths: readonly string[]
  rivalPaths: readonly string[]
  rivalServes: boolean
  priority: number
  band: Band
  needsHuman: boolean
  reasons: string[]
  probabilities: Record<string, { label: string; value: number; kind: "choice" | "noul" | "score" }>
  model: string
  ms: number
  costUsd: number
  inputTokens: number
}

/* ── the decision layer (docs/UI-CONTRACT.md) ──
 * Mirrors server/src/decisions.ts and server/src/subjects.ts field for field.
 * `words` and `reach` are the one deliberate divergence: the contract's card
 * needs them, but the crawler already has words and the UI counts them, so a
 * card renders correctly whether or not a row carries them. */

/** The highest-impact change for one page, with the evidence for it. */
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

/** Link-graph position of a page. Every field is counted in code. */
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
 * Why a subject is on the list. Only the first two justify a new page;
 * `our_own_pages` is refresh work and the producer must set `isNewPage = false`.
 */
export type DemandTier = "typed_and_returned" | "rival_published" | "our_own_pages"

export interface SubjectRow {
  id: string
  /** Representative term, verbatim. NEVER a generated noun phrase. */
  label: string
  /** The cluster, max 4. */
  phrases: string[]
  contentType: ContentType
  targetPath: string
  isNewPage: boolean
  tier: DemandTier
  ourState: string
  rivals: Array<{ title: string; domain: string | null }>
  priority: number
  band: Band
  reasons: string[]
}

export type CrawlPageEvent = { type: "page-crawled"; page: CrawledPage }

export type AuditEvent =
  | { type: "start"; total: number; model: string; jevEnabled: boolean; concurrency: number }
  | { type: "crawl"; pages: number; discovered: number; errors: number; robotsFetched: boolean; sitemapUrls: number }
  | CrawlPageEvent
  | { type: "gap-done"; gap: GapRow }
  | { type: "decision"; decision: DecisionRow }
  | { type: "subject"; subject: SubjectRow }
  | { type: "stage"; stage: string; detail: string }
  | { type: "page-start"; url: string; path: string; index: number }
  | { type: "page-done"; page: PageJudgement }
  | { type: "keyword-start"; term: string; index: number; total: number }
  | { type: "keyword-done"; keyword: KeywordJudgement }
  | { type: "competitor-start"; url: string; index: number }
  | { type: "competitor-done"; competitor: CompetitorResult }
  | { type: "retry"; url: string; attempt: number; waitMs: number }
  | { type: "error"; url: string; message: string }
  | { type: "summary"; totals: AuditTotals; score: number; grade: string; stats: RuleStats; needsHuman: number }
  | { type: "done"; report: AuditReport }

export interface AuditForm {
  url: string
  businessName: string
  businessContext: string
  market: string
  /** One per line in the form; split into an array before it goes on the wire. */
  competitors: string
  maxPages: number
  maxKeywords: number
  /**
   * How many rivals this run may judge. The server already honours this
   * (`audit.ts:1314`); the client simply never sent the field, so the cap was
   * unchangeable from the form.
   */
  maxCompetitors: number
  concurrency: number
  runJev: boolean
}

export interface AuditRequestBody extends Omit<AuditForm, "competitors"> {
  competitors: string[]
  /** Presearch output the client holds and the audit boundary used to drop. */
  keywordSeeds?: KeywordSeedProposal[]
  metrics?: MetricProposal[]
  rivalProposals?: CompetitorProposal[]
}
