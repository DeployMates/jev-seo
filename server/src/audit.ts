/**
 * The harness. Five jobs, in a loop: build the state and the answer menu, call
 * Jev, apply the thresholds, act or escalate, and write a log row with tokens,
 * cost, latency and the model version.
 *
 * One item per request, fired concurrently behind a bounded pool. Questions
 * are packed into that single request per page, including the speculative
 * branches the code will simply ignore when they do not apply.
 */
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_PAGES,
  MAX_CONCURRENCY,
  MAX_PAGES_CEILING,
} from "./config.js"
import { crawl, type CrawlResult, type PageEvidence } from "./crawl.js"
import { ruleStats, runRules, type RuleFinding, type RuleStats, type Severity } from "./checks.js"
import {
  isConfigured,
  judgeModel,
  JevAuthError,
  systemOne,
  type Answers,
  type ChoiceAnswer,
  type JevResult,
  type NoulAnswer,
  type ScoreAnswer,
} from "./judge.js"
import {
  CANNIBAL_YES,
  CONTENT_FLOOR,
  GATE_FLOOR,
  NEVER_MERGE_WORDS,
  bandForChoice,
  bandForChoiceAt,
  bandForNoul,
  gateFloorFor,
  normalise,
  scoreSideMass,
  scoreSideMassAt,
} from "./thresholds.js"
import {
  GEO_QUESTIONS,
  KEYWORD_QUESTIONS,
  REFRESH_QUESTIONS,
  cannibalizationQuestion,
  competitorQuestions,
  pageQuestions,
  rivalGapQuestions,
  siteQuestions,
} from "./questions.js"
import { buildGapRow, type GapRow } from "./gap.js"
import { buildRivalGapState, type GapPage } from "./state.js"
import { extractKeywords, mergeSeedCandidates, type KeywordCandidate } from "./keywords.js"
import {
  decisionPriority,
  reachOf,
  topChangeFor,
  type DecisionRow,
  type Reach,
  type TopChange,
} from "./decisions.js"
import { buildSubjects, seedSet, type SubjectRow } from "./subjects.js"
import { diffRuns, loadHistory, recordRun, type HistoryRun, type RunDelta } from "./history.js"
import { HIGHEST_IMPACT_CHANGES } from "./questions.js"

/** Rivals past this cap are reported as uncrawled rather than silently dropped. */
const MAX_COMPETITORS = 5

/**
 * Gap rows allowed when no rival was crawled at all.
 *
 * Mined terms keep the rival gate unchanged — a comparison needs two sides. A
 * presearch seed does not: "this was typed, and we have nothing on it" is a gap
 * that holds with no competitor in existence, and gating it on a rival is what
 * left panel 03 empty on every bare audit. Bounded because each row is a Jev
 * request.
 */
const MAX_RIVAL_LESS_GAP_ROWS = 8

export interface RivalCap {
  /** The cap that was actually applied, after clamping. */
  cap: number
  /** Rivals named in the request, after trimming. */
  requested: number
  /** Rivals actually crawled. */
  attempted: number
  /** Rivals that came back reachable and were judged. */
  judged: number
  /** Sent but not judged: the origin refused us. */
  unreachable: string[]
  /** Never sent, because they were past the cap. */
  pastTheCap: string[]
}

export type Band = "act" | "review" | "escalate"

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
  /** The decisive single change, or null when the answer was grey or "nothing". */
  topChange: TopChange | null
  /** Why there is no top change, so the grey zone is explainable not silent. */
  topChangeReason: string | null
  /** Link-graph position, counted by the crawl. */
  reach: Reach
  model: string
  ms: number
  costUsd: number
  inputTokens: number
}


export interface Finding {
  id: string
  title: string
  detail: string
  severity: Severity
  source: "jev" | "rule"
  band: Band
  probability: number | null
  fix: string
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
  /** P(this subject carries real consequences for the searcher). */
  trustBar: number
  /** 0..1 over the phrase wording and our own pages. Never a difficulty number. */
  difficultyProxy: number
  opportunity: number
  band: Band
  needsHuman: boolean
  reasons: string[]
  probabilities: PageJudgement["probabilities"]
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

export interface AuditRequest {
  url: string
  businessName?: string
  businessContext?: string
  market?: string
  maxPages?: number
  concurrency?: number
  model?: string
  runJev?: boolean
  competitors?: string[]
  maxKeywords?: number
  maxCompetitors?: number
  /** Ceiling on rival gap rows. Each one is a Jev request. */
  maxGaps?: number
  /**
   * Presearch passthrough. The research agent already produced all three and
   * the client already holds them; they were being dropped at the audit
   * boundary. They are passed through verbatim — no merging, no enrichment, no
   * second opinion — so a number that arrived with a tool behind it is still a
   * number with a tool behind it on the other side.
   */
  keywordSeeds?: AuditKeywordSeed[]
  metrics?: AuditMetric[]
  rivalProposals?: AuditRivalProposal[]
}

/** A presearch keyword seed. `evidence_tool` is what makes the term real. */
export interface AuditKeywordSeed {
  term: string
  intent: string
  evidence_tool: string
}

/** A named figure, carried with the tool that produced it. Never restated. */
export interface AuditMetric {
  key: string
  label: string
  number: { value: number; source_tool: string; raw: string }
}

/** A rival the research pass surfaced, with the query that surfaced it. */
export interface AuditRivalProposal {
  name: string
  url: string
  why: string
  evidence_tool: string
  evidence_query: string
  angle: string
}

/** Whether the presearch half of the run happened, and whether it degraded. */
export interface PresearchState {
  ran: boolean
  degraded: boolean
  reason: string | null
}

export type AuditEvent =
  | { type: "start"; total: number; model: string; jevEnabled: boolean; concurrency: number }
  | { type: "crawl"; pages: number; discovered: number; errors: number; robotsFetched: boolean; sitemapUrls: number }
  | {
      type: "page-crawled"
      page: {
        url: string
        path: string
        status: number
        words: number
        title: string
        depth: number
        headings: number
        internalLinks: number
        externalLinks: number
        imagesMissingAlt: number
        noindex: boolean
      }
    }
  | { type: "stage"; stage: string; detail: string }
  | { type: "page-start"; url: string; path: string; index: number }
  | { type: "page-done"; page: PageJudgement }
  | { type: "keyword-start"; term: string; index: number; total: number }
  | { type: "keyword-done"; keyword: KeywordJudgement }
  | { type: "gap-done"; gap: GapRow }
  | { type: "decision"; decision: DecisionRow }
  | { type: "subject"; subject: SubjectRow }
  | { type: "competitor-start"; url: string; index: number }
  | { type: "competitor-done"; competitor: CompetitorResult }
  | { type: "retry"; url: string; attempt: number; waitMs: number }
  | { type: "error"; url: string; message: string }
  | { type: "summary"; totals: AuditTotals; score: number; grade: string; stats: RuleStats; needsHuman: number }
  | { type: "done"; report: AuditReport }

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
  ruleFindings: RuleFinding[]
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
  /** Rival gap rows, one per term that reached the gap pass. See `gap.ts`. */
  gaps: GapRow[]
  /** One row per page with a decisive top change. See `decisions.ts`. */
  decisions: DecisionRow[]
  /** Gap rows rolled up into things to build. See `subjects.ts`. */
  subjects: SubjectRow[]
  /** Pages with no decisive top change, and why. The grey zone, published. */
  notDecided: Array<{ path: string; url: string; reason: string }>
  /** Whether the research pass ran before this one, and whether it degraded. */
  presearch: PresearchState
  /** Presearch passthrough, verbatim. Never merged into the judged sets. */
  keywordSeeds: AuditKeywordSeed[]
  metrics: AuditMetric[]
  rivalProposals: AuditRivalProposal[]
  keywordPool: KeywordCandidate[]
  competitors: CompetitorResult[]
  /**
   * How many rivals were named, and how many were judged. Two numbers, because
   * a cap that only appears in the code is a cap nobody can see: a user who sent
   * nine rivals and got four rivals back has been silently truncated, and the
   * report is the only place that can say so. See `RivalCap` for the detail.
   */
  rivalsRequested: number
  rivalsJudged: number
  rivalCap: RivalCap
  /** This run against the previous one for the same root. See `history.ts`. */
  delta: RunDelta
  linkSuggestions: LinkSuggestion[]
  siteJudgements: Record<string, unknown> | null
  needsHuman: Array<{ url: string; reasons: string[] }>
  crawled: Array<{ url: string; path: string; words: number; status: number; ruleFindings: number }>
  crawl: { robotsFetched: boolean; sitemapFound: number; discovered: number; errors: string[] }
  ledger: Array<{ url: string; model: string; ms: number; inputTokens: number; costUsd: number; attempts: number }>
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * The terms worth a gap request, most promising first.
 *
 * Named `gapCandidates`, not `actionableGapCandidates`, and the rename is
 * load-bearing. "Actionable" means one specific thing in this codebase: a term
 * that passed the strict filter and belongs in `report.keywords`, the advice
 * list. This function applies a deliberately looser gate — see below — so
 * calling it "actionable" gave the same word two meanings in the same file and
 * invited someone to relax the advice list to match.
 *
 * The gate is the junk guard and nothing else. It deliberately does NOT exclude
 * the `escalate` band, because excluding it makes this pass unreachable in
 * practice: on a real site most judged terms land in the grey zone, so an
 * escalate filter here silently produced zero rows every run — which is the
 * dead-code problem this pass was written to end.
 *
 * Excluding them is not what protects anyone. A gap row carries its own `band`
 * and `needsHuman`, exactly as a page or keyword judgement does, so a grey-zone
 * row is published *labelled as uncertain* and stays that way in the payload.
 * What the escalate band governs is what becomes advice, and the advice list is
 * `report.keywords`, which is filtered separately and is untouched by this.
 * Publishing a labelled row is not recommending it.
 */
function gapCandidates(keywords: KeywordJudgement[], max: number): KeywordJudgement[] {
  return keywords
    .filter((k) => k.isRealQuery >= 0.5)
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, Math.max(0, max))
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

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]!
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 18,
  serious: 9,
  moderate: 4,
  minor: 1,
}

/** Grade from the weighted defect load, not from a count of items. */
function gradeFrom(score: number): string {
  if (score >= 85) return "A"
  if (score >= 72) return "B"
  if (score >= 58) return "C"
  if (score >= 42) return "D"
  return "E"
}

function buildState(page: PageEvidence, context: { name: string; context: string; market: string }) {
  return {
    business: {
      name: context.name || "not stated by the site owner",
      what_they_do: context.context || "not stated by the site owner",
      market: context.market || "not stated by the site owner",
    },
    site: {
      origin: page.url,
      // 80 page titles is enough for topical coherence without paying for more.
      titles: [page.title].filter(Boolean),
    },
    page: {
      url: page.url,
      title: page.title,
      description: page.description,
      h1: page.h1,
      headings: page.headings,
      opening: page.opening,
      text: page.text,
      words: page.words,
      internal_links: page.internalLinks,
      external_links: page.externalLinks,
      images: page.images,
      has_schema_org: page.hasSchemaOrg,
      language: page.lang,
    },
  }
}

function siteState(result: CrawlResult, context: { name: string; context: string; market: string }) {
  return {
    business: {
      name: context.name || "not stated by the site owner",
      what_they_do: context.context || "not stated by the site owner",
      market: context.market || "not stated by the site owner",
    },
    site: {
      origin: result.root.toString(),
      pages: result.pages.slice(0, 20).map((p) => ({
        path: p.path,
        title: p.title,
        h1: p.h1,
        words: p.words,
      })),
      has_schema_org: result.pages.some((p) => p.hasSchemaOrg),
      https: result.root.protocol === "https:",
    },
  }
}

/** Shortlist cannibalization candidates by title/H1 word overlap, in code. */
function shortlistPairs(pages: PageEvidence[]): Array<[PageEvidence, PageEvidence]> {
  const tokens = (page: PageEvidence) =>
    new Set(
      `${page.title} ${page.h1}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    )

  const pairs: Array<[PageEvidence, PageEvidence]> = []
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const a = tokens(pages[i]!)
      const b = tokens(pages[j]!)
      if (a.size === 0 || b.size === 0) continue
      let overlap = 0
      for (const token of a) if (b.has(token)) overlap += 1
      const jaccard = overlap / (a.size + b.size - overlap)
      if (jaccard >= 0.4) pairs.push([pages[i]!, pages[j]!])
      if (pairs.length >= 40) return pairs
    }
  }
  return pairs
}

function summarisePage(
  page: PageEvidence,
  result: JevResult,
  questions: Record<string, { levels?: number }>,
): {
  judgement: Omit<PageJudgement, "findings" | "model" | "ms" | "costUsd" | "inputTokens">
  findings: Finding[]
  decision: DecisionRow | null
} {
  const { answers, receipt } = result
  const reasons: string[] = []
  const probabilities: PageJudgement["probabilities"] = {}
  const findings: Finding[] = []

  const pageType = asChoice(answers, "page_type")
  const intent = asChoice(answers, "intent")
  const importance = asScore(answers, "importance")
  const action = asChoice(answers, "action")

  if (pageType) {
    for (const [label, value] of Object.entries(pageType.probabilities)) {
      probabilities[`page_type:${label}`] = { label, value, kind: "choice" }
    }
    if (bandForChoiceAt("page_type", pageType.confidence) !== "act") {
      reasons.push(`page type confidence ${pageType.confidence.toFixed(2)}`)
    }
  }
  if (intent) {
    for (const [label, value] of Object.entries(intent.probabilities)) {
      probabilities[`intent:${label}`] = { label, value, kind: "choice" }
    }
    if (bandForChoiceAt("intent", intent.confidence) !== "act") {
      reasons.push(`search intent confidence ${intent.confidence.toFixed(2)}`)
    }
  }
  if (action) {
    for (const [label, value] of Object.entries(action.probabilities)) {
      probabilities[`action:${label}`] = { label, value, kind: "choice" }
    }
    if (bandForChoiceAt("action", action.confidence) !== "act") {
      reasons.push(`recommended action confidence ${action.confidence.toFixed(2)}`)
    }
  }

  // The single highest-impact change. Read on every page and, until the
  // decision layer existed, discarded here. Three outcomes, and the third is
  // the one that matters: a decisive change becomes a DecisionRow, a grey
  // answer becomes a reason, and `nothing_missing` is a real answer that means
  // there is nothing to recommend — neither of which is a reason to widen the
  // band and pretend the panel is fuller than it is.
  const impact = asChoice(answers, "highest_impact_change")
  const reach = reachOf(page)
  let topChange: TopChange | null = null
  let topChangeReason: string | null = null

  if (!impact) {
    topChangeReason = "no highest-impact answer"
  } else {
    for (const [label, value] of Object.entries(impact.probabilities)) {
      probabilities[`highest_impact_change:${label}`] = { label, value, kind: "choice" }
    }
    const impactBand = bandForChoiceAt("highest_impact_change", impact.confidence)
    topChange = topChangeFor({
      key: impact.choice,
      probabilities: impact.probabilities,
      band: impactBand,
      page,
      options: HIGHEST_IMPACT_CHANGES,
      askedIds: new Set(Object.keys(questions)),
    })
    if (topChange) {
      // Deliberately no push into `reasons`: a decisive answer is the opposite
      // of needing a human, and `reasons` is what sets `needsHuman`.
    } else if (impact.choice === "nothing_missing") {
      topChangeReason = "nothing missing that a rewrite would fix"
    } else {
      topChangeReason = `highest impact change uncertain (confidence ${impact.confidence.toFixed(2)})`
    }
  }

  const importanceNorm = importance
    ? normalise(importance.score, questions.importance?.levels ?? 4)
    : 0.5

  // Content quality: only judged on pages that matter, and never on policy pages.
  const isPolicy = pageType?.choice === "legal_or_policy"
  const pageTypeBand = pageType ? bandForChoiceAt("page_type", pageType.confidence) : "review"
  const skipContent = isPolicy && pageTypeBand === "act"

  const scoreChecks: Array<{ id: string; title: string; detail: string; fix: string; threshold: number }> = [
    {
      id: "helpfulness",
      title: "Page does not satisfy the visitor",
      detail: "The main text does not fully answer what a visitor who landed on this page came for.",
      fix: "Rewrite the body around the question the page targets, answering it in the opening and anticipating the follow-ups.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "specificity",
      title: "Content is generic",
      detail: "The page says things a competitor could say word for word.",
      fix: "Replace generic claims with first-hand specifics: named features, numbers, places, processes or your own results.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "citable",
      title: "Nothing on the page can be quoted by an AI answer engine",
      detail: "The page is slogans and navigation rather than self-contained, citable facts.",
      fix: "State facts, figures and definitions as complete sentences that stand alone without the surrounding page.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "trust",
      title: "Trust signals are weak",
      detail: "The page shows little evidence of real expertise or accountability.",
      fix: "Add named people, credentials, reviews, cited sources, verifiable results and a clear way to be held responsible.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "title_fit",
      title: "Title does not sell the page",
      detail: "The title is inaccurate, vague, or does not give a searcher a reason to click.",
      fix: "Rewrite the title in the searcher's own words and put the concrete reason to click in it.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "meta_fit",
      title: "Meta description undersells the page",
      detail: "The description restates the title or promises something the page does not deliver.",
      fix: "Rewrite the description to state the specific benefit in one sentence, under 160 characters.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "structure_ease",
      title: "Hard to scan",
      detail: "A first-time visitor cannot find what they came for without hunting.",
      fix: "Give the page one clear entry point, group content under descriptive subheadings, and front-load the answer.",
      threshold: CONTENT_FLOOR,
    },
    {
      id: "content_freshness",
      title: "Content looks abandoned",
      detail: "The page carries no date or update signal and reads as out of date.",
      fix: "Add a visible last-updated date and review the details that age quickly.",
      threshold: CONTENT_FLOOR,
    },
  ]

  for (const check of scoreChecks) {
    const answer = asScore(answers, check.id)
    if (!answer) continue
    const levels = questions[check.id]?.levels ?? 4
    for (const [key, value] of Object.entries(answer.probabilities)) {
      probabilities[`${check.id}:${key}`] = { label: key, value, kind: "score" }
    }
    const value = normalise(answer.score, levels)
    const side = scoreSideMassAt(answer.probabilities, levels, check.id)
    const isStructural = check.id === "title_fit" || check.id === "meta_fit" || check.id === "structure_ease"

    // On a policy page, only the on-page basics are actionable.
    if (skipContent && !isStructural) continue

    const decisive = side.decisive
    if (!decisive) {
      reasons.push(`${check.id} spread across levels`)
      continue
    }
    if (value >= check.threshold) continue

    // A weak page nobody lands on is not worth a finding.
    if (importanceNorm < 0.34 && (check.id === "helpfulness" || check.id === "trust")) continue

    findings.push({
      id: check.id,
      title: check.title,
      detail: check.detail,
      severity: check.id === "title_fit" || check.id === "meta_fit" ? "serious" : "moderate",
      source: "jev",
      band: "act",
      probability: Number(value.toFixed(2)),
      fix: check.fix,
    })
  }

  const gateChecks: Array<{ id: string; title: string; detail: string; fix: string }> = [
    {
      id: "h1_fit",
      title: "H1 does not name the topic",
      detail: "The main heading is a brand, a slogan or a phrase no searcher would type.",
      fix: "Rewrite the H1 as the plain-language name of what the page is about.",
    },
    {
      id: "answer_first",
      title: "Page does not answer immediately",
      detail: "The opening after the heading is a slogan, a tease or preamble before the point.",
      fix: "State the answer, the offer or the scope in the first two sentences after the H1.",
    },
    {
      id: "clear_next_step",
      title: "No clear next step",
      detail: "The page never tells the visitor what to do next on this topic.",
      fix: "End the flow with one obvious action: sign up, buy, book, download, contact, or read the natural next page.",
    },
    {
      id: "competitor_distinctiveness",
      title: "A competitor could publish this page unchanged",
      detail: "Nothing distinguishes the page from a rival's version of the same topic.",
      fix: "Add what only you can say: your own data, process, opinion, results or photographs.",
    },
  ]

  for (const check of gateChecks) {
    const answer = asNoul(answers, check.id)
    if (!answer) continue
    probabilities[`${check.id}:yes`] = { label: "yes", value: answer.noul, kind: "noul" }
    const band = bandForNoul(answer.noul)

    // The grey zone is doubt: route it to a person rather than acting on it.
    if (band === "review") {
      reasons.push(`${check.id} uncertain (P(yes) ${answer.noul.toFixed(2)})`)
      continue
    }
    if (answer.noul >= gateFloorFor(check.id)) continue

    if (check.id === "clear_next_step" && intent?.choice && intent.choice !== "commercial" && intent.choice !== "transactional") {
      continue
    }
    findings.push({
      id: check.id,
      title: check.title,
      detail: check.detail,
      severity: check.id === "clear_next_step" ? "moderate" : "serious",
      source: "jev",
      band: "act",
      probability: Number(answer.noul.toFixed(2)),
      fix: check.fix,
    })
  }

  // The action question becomes a finding only when it is decisive.
  if (action && bandForChoiceAt("action", action.confidence) === "act") {
    if (action.choice === "rewrite") {
      findings.push({
        id: "rewrite",
        title: "Page needs a rewrite",
        detail: "The page's purpose is valid but the current text does not achieve it.",
        severity: importanceNorm >= 0.66 ? "serious" : "moderate",
        source: "jev",
        band: "act",
        probability: Number(action.probabilities[action.choice]?.toFixed(2) ?? 0),
        fix: "Draft a new version that answers the page's question directly, with the specifics a competitor cannot copy.",
      })
    }
    if (action.choice === "merge_or_remove" && page.words < NEVER_MERGE_WORDS) {
      findings.push({
        id: "merge_or_remove",
        title: "Page duplicates or lacks a reason to exist",
        detail: "The page competes with another page or serves no distinct search need.",
        severity: "moderate",
        source: "jev",
        band: "act",
        probability: Number(action.probabilities[action.choice]?.toFixed(2) ?? 0),
        fix: "Fold this page into the stronger page that covers the same need, and redirect it.",
      })
    }
  }

  const decision: DecisionRow | null = topChange
    ? {
        path: page.path,
        url: page.url,
        priority: decisionPriority(importanceNorm, reach),
        topChange,
        extraFindings: findings.length,
        pageType: pageType?.choice ?? "unknown",
        intent: intent?.choice ?? "unknown",
        words: page.words,
        reach,
      }
    : null

  return {
    judgement: {
      url: page.url,
      path: page.path,
      words: page.words,
      pageType: pageType?.choice ?? "unknown",
      intent: intent?.choice ?? "unknown",
      importance: Number(importanceNorm.toFixed(2)),
      action: action?.choice ?? "unknown",
      band: reasons.length === 0 ? "act" : reasons.length > 2 ? "escalate" : "review",
      needsHuman: reasons.length > 0,
      reasons,
      probabilities,
      topChange,
      topChangeReason,
      reach,
    },
    findings,
    decision,
  }
}

/** Turn page-level scores into a 0..100 site score, weighted by importance. */
function scorePages(pages: PageJudgement[], ruleFindings: RuleFinding[]): number {
  if (pages.length === 0) return 0
  let weighted = 0
  let weightTotal = 0
  for (const page of pages) {
    const weight = 0.35 + page.importance // importance 0..1 lifts the page's influence
    weightTotal += weight
    weighted += weight * clamp01(1 - page.findings.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity] / 100, 0))
  }
  const jevScore = weightTotal === 0 ? 0 : (weighted / weightTotal) * 100
  const rulePenalty = ruleFindings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0)
  return Math.round(Math.max(0, Math.min(100, jevScore - rulePenalty)))
}

function countPatterns(pages: PageJudgement[], aiGap: PatternCount[]): {
  pageType: PatternCount[]
  intent: PatternCount[]
  action: PatternCount[]
  aiGap: PatternCount[]
} {
  const tally = (values: string[]) => {
    const counts = new Map<string, number>()
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
    const total = values.length || 1
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count, share: Number((count / total).toFixed(3)) }))
      .sort((a, b) => b.count - a.count)
  }
  return {
    pageType: tally(pages.map((p) => p.pageType)),
    intent: tally(pages.map((p) => p.intent)),
    action: tally(pages.map((p) => p.action)),
    aiGap,
  }
}


function keywordPatterns(keywords: KeywordJudgement[]): {
  keywordIntent: PatternCount[]
  keywordCluster: PatternCount[]
} {
  const tally = (values: string[]) => {
    const counts = new Map<string, number>()
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
    const total = values.length || 1
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count, share: Number((count / total).toFixed(3)) }))
      .sort((a, b) => b.count - a.count)
  }
  return {
    keywordIntent: tally(keywords.map((k) => k.intent)),
    keywordCluster: tally(keywords.map((k) => k.cluster)),
  }
}

/**
 * Opportunity is computed in code, not asked. The weights are the point: a term
 * a buyer types, that no page serves, that already appears in headings, beats a
 * term nobody converts on. Change a coefficient here rather than a prompt.
 */
function opportunityOf(
  keyword: KeywordJudgement,
  candidate: KeywordCandidate,
): number {
  const buyer = keyword.isBuyerQuery >= 0.5 ? 1 : 0
  const real = keyword.isRealQuery >= 0.5 ? 1 : 0
  const gap = keyword.coverageGap
  const structural = Math.min(candidate.inHeadings / 3, 1)
  const spread = Math.min(candidate.pages.length / 4, 1)
  return Number((0.4 * buyer * real + 0.35 * gap + 0.15 * structural + 0.1 * spread).toFixed(3))
}

function summariseKeyword(
  candidate: KeywordCandidate,
  result: JevResult,
  site: { pages: Array<{ path: string; title: string }> },
  questions: Record<string, { levels?: number }>,
): KeywordJudgement {
  const { answers, receipt } = result
  const reasons: string[] = []
  const probabilities: PageJudgement["probabilities"] = {}

  const intent = asChoice(answers, "intent")
  const cluster = asChoice(answers, "cluster")
  const buyer = asNoul(answers, "is_buyer_query")
  const real = asNoul(answers, "is_real_query")
  const gap = asNoul(answers, "coverage_gap")
  const trust = asNoul(answers, "trust_bar")
  const difficulty = asScore(answers, "difficulty_proxy")

  for (const [id, answer] of [
    ["intent", intent],
    ["cluster", cluster],
  ] as const) {
    if (!answer) continue
    for (const [label, value] of Object.entries(answer.probabilities)) {
      probabilities[`${id}:${label}`] = { label, value, kind: "choice" }
    }
    if (bandForChoice(answer.confidence) !== "act") {
      reasons.push(`${id.replace("_", " ")} confidence ${answer.confidence.toFixed(2)}`)
    }
  }

  for (const [id, answer] of [
    ["is_buyer_query", buyer],
    ["is_real_query", real],
    ["coverage_gap", gap],
    ["trust_bar", trust],
  ] as const) {
    if (!answer) continue
    probabilities[`${id}:yes`] = { label: "yes", value: answer.noul, kind: "noul" }
    if (bandForNoul(answer.noul) === "review") {
      reasons.push(`${id.replace(/_/g, " ")} uncertain (P(yes) ${answer.noul.toFixed(2)})`)
    }
  }

  // The one keyword question that is a scale rather than a gate. Its bar is
  // 0.85 (`thresholds.ts`) because the costly error is a confident top level:
  // a term removed from the opportunity pool on a guess. Spread mass therefore
  // lands in `reasons` rather than silently becoming a number.
  if (difficulty) {
    const levels = questions.difficulty_proxy?.levels ?? 4
    for (const [key, value] of Object.entries(difficulty.probabilities)) {
      probabilities[`difficulty_proxy:${key}`] = { label: key, value, kind: "score" }
    }
    if (!scoreSideMassAt(difficulty.probabilities, levels, "difficulty_proxy").decisive) {
      reasons.push("difficulty proxy spread across levels")
    }
  }

  const partial: KeywordJudgement = {
    term: candidate.term,
    words: candidate.words,
    pages: candidate.pages,
    frequency: candidate.frequency,
    inHeadings: candidate.inHeadings,
    intent: intent?.choice ?? "unknown",
    cluster: cluster?.choice ?? "unknown",
    isBuyerQuery: buyer?.noul ?? 0,
    isRealQuery: real?.noul ?? 0,
    coverageGap: gap?.noul ?? 0,
    trustBar: trust?.noul ?? 0.5,
    difficultyProxy: difficulty
      ? Number(
          normalise(difficulty.score, questions.difficulty_proxy?.levels ?? 4).toFixed(3),
        )
      : 0.5,
    opportunity: 0,
    band: reasons.length === 0 ? "act" : reasons.length > 1 ? "escalate" : "review",
    needsHuman: reasons.length > 0,
    reasons,
    probabilities,
    model: receipt.model,
    ms: receipt.ms,
    costUsd: receipt.costUsd,
    inputTokens: receipt.inputTokens,
  }
  partial.opportunity = opportunityOf(partial, candidate)
  void site
  return partial
}

async function judgeCompetitor(
  url: string,
  context: { name: string; context: string; market: string },
  model: string,
  maxPages: number,
): Promise<CompetitorResult> {
  const empty: Omit<CompetitorResult, "url" | "reachable" | "error"> = {
    pages: 0,
    score: 0,
    grade: "E",
    businessModel: null,
    aiGap: null,
    worthCopying: 0,
    proofDensity: null,
    topics: [],
    topFix: "",
    ruleFindings: 0,
    model,
    ms: 0,
    costUsd: 0,
    inputTokens: 0,
  }

  try {
    const result = await crawl(url, { maxPages: Math.min(maxPages, 8), maxDepth: 2, budgetMs: 45_000 })
    if (result.pages.length === 0) {
      return { url, reachable: false, error: "No pages could be fetched.", ...empty }
    }

    const rules = runRules(result.pages, result.root.toString())
    const stats = ruleStats(result.pages)

    const state = {
      business: {
        name: context.name || "not stated",
        what_they_do: context.context || "not stated",
        market: context.market || "not stated",
      },
      site: {
        origin: result.root.toString(),
        pages: result.pages.slice(0, 20).map((p) => ({ path: p.path, title: p.title, h1: p.h1, words: p.words })),
        has_schema_org: result.pages.some((p) => p.hasSchemaOrg),
        https: result.root.protocol === "https:",
      },
    }

    const answer = await systemOne(state, competitorQuestions(), { model })
    const businessModel = asChoice(answer.answers, "business_model")
    const aiGap = asChoice(answer.answers, "ai_gap")
    const worth = asNoul(answer.answers, "worth_copying")
    const valueProp = asScore(answer.answers, "value_prop")
    const focus = asScore(answer.answers, "topical_focus")

    const modelScore =
      valueProp && focus
        ? (normalise(valueProp.score, 4) + normalise(focus.score, 4)) / 2
        : 0.5
    const penalty = rules.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0)
    const score = Math.round(Math.max(0, Math.min(100, modelScore * 100 - penalty + (stats.https ? 6 : 0))))

    return {
      url: result.root.toString(),
      reachable: true,
      pages: result.pages.length,
      score,
      grade: gradeFrom(score),
      businessModel: businessModel?.choice ?? null,
      aiGap: aiGap?.choice ?? null,
      worthCopying: worth?.noul ?? 0,
      proofDensity: null,
      topics: result.pages.slice(0, 12).map((p) => p.title).filter(Boolean),
      topFix: aiGap?.choice ?? "",
      ruleFindings: rules.length,
      model: answer.receipt.model,
      ms: answer.receipt.ms,
      costUsd: answer.receipt.costUsd,
      inputTokens: answer.receipt.inputTokens,
    }
  } catch (error) {
    return {
      url,
      reachable: false,
      error: (error as Error).message,
      ...empty,
    }
  }
}
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(runners)
  return results
}

export async function runAudit(request: AuditRequest, emit: (event: AuditEvent) => void): Promise<AuditReport> {
  const started = Date.now()
  const maxPages = Math.max(1, Math.min(request.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES_CEILING))
  const concurrency = Math.max(1, Math.min(request.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY))
  const runJev = request.runJev !== false && isConfigured()
  const model = request.model ?? judgeModel()
  const context = {
    name: request.businessName?.trim() ?? "",
    context: request.businessContext?.trim() ?? "",
    market: request.market?.trim() ?? "",
  }

  emit({ type: "start", total: maxPages, model, jevEnabled: runJev, concurrency })

  emit({ type: "stage", stage: "Crawl", detail: `Fetching ${request.url} live` })
  // Streamed per page: the dashboard table fills as pages land rather than
  // after the whole crawl, which on a slow origin is the difference between a
  // live run and a blank screen. `ruleFindings` is absent here because the rule
  // pass is site-wide — a page cannot know the graph's verdict while the graph is
  // still being fetched. The `crawl` summary below carries the totals.
  const crawlResult = await crawl(request.url, {
    maxPages,
    maxDepth: 4,
    budgetMs: 90_000,
    onPage: (page) =>
      emit({
        type: "page-crawled",
        page: {
          url: page.url,
          path: page.path,
          status: page.status,
          words: page.words,
          title: page.title,
          depth: page.depth,
          headings: page.headings.length,
          internalLinks: page.internalLinks,
          externalLinks: page.externalLinks,
          imagesMissingAlt: page.imagesMissingAlt,
          noindex: page.noindex,
        },
      }),
    onRetry: (url, reason, attempt, waitMs) =>
      emit({ type: "retry", url: `${url} (${reason})`, attempt, waitMs }),
    onError: (url, message) => emit({ type: "error", url, message }),
  })
  emit({
    type: "crawl",
    pages: crawlResult.pages.length,
    discovered: crawlResult.discovered,
    errors: crawlResult.errors.length,
    robotsFetched: crawlResult.robots.fetched,
    sitemapUrls: crawlResult.sitemap.urls.length,
  })

  const ruleFindings = runRules(crawlResult.pages, crawlResult.root.toString())
  const stats = ruleStats(crawlResult.pages)

  let siteJudgements: Record<string, unknown> | null = null
  const aiGap: PatternCount[] = []
  const judgedPages: PageJudgement[] = []
  const keywordBudget = Math.max(0, Math.min(request.maxKeywords ?? 30, MAX_PAGES_CEILING))
  // Two sources, one pool. The miner can only ever return a term we already say
  // something about, so a pool built from it alone can report weak copy but
  // never silence. Presearch seeds are the terms somebody else typed, which is
  // the only way a gap gets found. On-page counts for a seed are measured or
  // zero — `mergeSeedCandidates` never estimates one.
  const keywordPool = mergeSeedCandidates(
    crawlResult.pages,
    extractKeywords(crawlResult.pages, keywordBudget),
    request.keywordSeeds,
  )
  const judgedKeywords: KeywordJudgement[] = []
  const competitors: CompetitorResult[] = []
  const gaps: GapRow[] = []
  const decisions: DecisionRow[] = []
  const notDecided: AuditReport["notDecided"] = []
  const rivalDirectory = new Map<string, string | null>()
  const ledger: AuditReport["ledger"] = []
  const latencies: number[] = []
  let questionsAsked = 0
  let judgementCount = 0
  let authFailed = false

  // Rival bookkeeping sits outside the `runJev` branch on purpose: a run that
  // judged no rivals because the judge was switched off must still report that
  // four were asked for, or the cap reads as a clean zero rather than a stop.
  const requestedRivals = (request.competitors ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  // Clamped, not just defaulted. `maxCompetitors` arrives from a request body, so
  // `null`, a string, `NaN` and a negative all reach it, and each used to reach
  // `slice(0, cap)` unchanged: `NaN` silently judged every rival and `-1` judged
  // none, both without saying a word.
  const rivalCapApplied = Math.max(
    0,
    Math.min(
      typeof request.maxCompetitors === "number" && Number.isFinite(request.maxCompetitors)
        ? request.maxCompetitors
        : MAX_COMPETITORS,
      MAX_COMPETITORS,
    ),
  )
  const rivalUrls = requestedRivals.slice(0, rivalCapApplied)
  const pastTheCap = requestedRivals.slice(rivalCapApplied)
  // Normalised the same way `subjects.ts` normalises, so the gap pass and the
  // tier check agree on which terms are seeds.
  const seedTermKeys = new Set(
    (request.keywordSeeds ?? [])
      .map((seed) => seed.term.toLowerCase().replace(/\s+/g, " ").trim())
      .filter((term) => term.length > 0),
  )

  if (runJev) {
    // Site-level judgement: one call over the whole crawled set.
    emit({ type: "stage", stage: "Jev", detail: "Asking site-level questions" })
    try {
      const siteResult = await systemOne(siteState(crawlResult, context), siteQuestions(), { model })
      siteJudgements = siteResult.answers as unknown as Record<string, unknown>
      questionsAsked += Object.keys(siteQuestions()).length
      judgementCount += 1
      latencies.push(siteResult.receipt.ms)
      ledger.push({ url: crawlResult.root.toString(), ...siteResult.receipt })

      const gap = asChoice(siteResult.answers, "answer_engine_gaps")
      if (gap) {
        aiGap.push({
          label: gap.choice,
          count: 1,
          share: Number((gap.probabilities[gap.choice] ?? 0).toFixed(3)),
        })
      }

      const geoResult = await systemOne(siteState(crawlResult, context), GEO_QUESTIONS, { model })
      siteJudgements = { ...(siteJudgements ?? {}), ...geoResult.answers }
      questionsAsked += Object.keys(GEO_QUESTIONS).length
      judgementCount += 1
      latencies.push(geoResult.receipt.ms)
      ledger.push({ url: `${crawlResult.root.toString()}#geo`, ...geoResult.receipt })
    } catch (error) {
      if (error instanceof JevAuthError) authFailed = true
      else emit({ type: "error", url: crawlResult.root.toString(), message: (error as Error).message })
    }

    if (!authFailed) {
      // Page-level judgements: one item per request, all questions packed in.
      emit({
        type: "stage",
        stage: "Jev",
        detail: `Judging ${crawlResult.pages.length} pages, ${concurrency} at a time`,
      })

      let index = 0
      await pool(crawlResult.pages, concurrency, async (page) => {
        const current = index++
        emit({ type: "page-start", url: page.url, path: page.path, index: current })

        const questions = {
          ...pageQuestions({
            hasTitle: page.title.length > 0,
            hasDescription: page.description.length > 0,
            hasH1: page.h1.length > 0,
            hasCanonical: page.canonical.length > 0,
          }),
          ...REFRESH_QUESTIONS,
        }
        try {
          const result = await systemOne(buildState(page, context), questions, { model })
          const levelCounts: Record<string, { levels: number }> = {}
          for (const [id, primitive] of Object.entries(questions)) {
            if (primitive.type === "score") levelCounts[id] = { levels: primitive.criteria.length }
          }

          const { judgement, findings, decision } = summarisePage(page, result, levelCounts)
          const full: PageJudgement = {
            ...judgement,
            findings,
            model: result.receipt.model,
            ms: result.receipt.ms,
            costUsd: result.receipt.costUsd,
            inputTokens: result.receipt.inputTokens,
          }
          judgedPages.push(full)
          if (decision) {
            decisions.push(decision)
            emit({ type: "decision", decision })
          } else {
            notDecided.push({ path: page.path, url: page.url, reason: full.topChangeReason ?? "not decided" })
          }
          judgementCount += 1
          questionsAsked += Object.keys(questions).length
          latencies.push(result.receipt.ms)
          ledger.push({ url: page.url, ...result.receipt })
          emit({ type: "page-done", page: full })
        } catch (error) {
          if (error instanceof JevAuthError) {
            authFailed = true
            return
          }
          emit({ type: "error", url: page.url, message: (error as Error).message })
        }
      })

      // Cannibalization: only the shortlisted pairs, ten per request.
      const pairs = shortlistPairs(crawlResult.pages)
      if (pairs.length > 0) {
        emit({ type: "stage", stage: "Jev", detail: `Checking ${pairs.length} overlapping page pairs` })
        const batches: Array<Array<[PageEvidence, PageEvidence]>> = []
        for (let i = 0; i < pairs.length; i += 10) batches.push(pairs.slice(i, i + 10))

        await pool(batches, Math.max(1, Math.floor(concurrency / 2)), async (batch) => {
          const state: Record<string, unknown> = { business: context }
          const questions: Record<string, ReturnType<typeof cannibalizationQuestion>> = {}
          batch.forEach(([a, b], i) => {
            state[`page_a`] = { title: a.title, h1: a.h1, opening: a.opening }
            state[`page_b`] = { title: b.title, h1: b.h1, opening: b.opening }
            // One shared question id per pair keeps the answers addressable.
            state[`pair_${i}`] = { a: { title: a.title, h1: a.h1 }, b: { title: b.title, h1: b.h1 } }
            questions[`pair_${i}`] = {
              type: "noul",
              instructions: `Would a searcher treat \`pair_${i}.a\` and \`pair_${i}.b\` as two versions of the same page, so that only one should rank?`,
              criteria: {
                true: "The two pages target the same search need, and one could be dropped or merged into the other",
                false: "The two pages cover genuinely different needs, or differ enough in scope that both can rank",
              },
            }
          })
          try {
            const result = await systemOne(state, questions, { model })
            questionsAsked += batch.length
            judgementCount += 1
            latencies.push(result.receipt.ms)
            ledger.push({ url: `${crawlResult.root.toString()}#pairs`, ...result.receipt })
            batch.forEach(([a, b], i) => {
              const answer = asNoul(result.answers, `pair_${i}`)
              if (!answer || answer.noul < CANNIBAL_YES) return
              const target = judgedPages.find((p) => p.url === a.url)
              const finding: Finding = {
                id: "cannibalization",
                title: "Two pages compete for the same search need",
                detail: `\`${a.path}\` and \`${b.path}\` look like substitutes to a searcher.`,
                severity: "serious",
                source: "jev",
                band: "act",
                probability: Number(answer.noul.toFixed(2)),
                fix: `Keep the stronger page, fold the unique content of the other into it, and 301 the rest.`,
              }
              if (target) target.findings.push(finding)
            })
          } catch (error) {
            if (!(error instanceof JevAuthError)) {
              emit({ type: "error", url: `${crawlResult.root.toString()}#pairs`, message: (error as Error).message })
            }
          }
        })
      }

      // Keyword pass: one candidate per request, every keyword question packed
      // in. The reject-junk questions run first so the aggregates below are
      // built on terms that survived, not on raw n-grams.
      if (keywordPool.length > 0) {
        emit({
          type: "stage",
          stage: "Keywords",
          detail: `Judging ${keywordPool.length} candidate terms`,
        })
        const siteTitles = crawlResult.pages.slice(0, 30).map((p) => ({ path: p.path, title: p.title }))
        const keywordLevels: Record<string, { levels: number }> = {}
        for (const [id, primitive] of Object.entries(KEYWORD_QUESTIONS)) {
          if (primitive.type === "score") keywordLevels[id] = { levels: primitive.criteria.length }
        }
        let keywordIndex = 0

        await pool(keywordPool, concurrency, async (candidate) => {
          const current = keywordIndex++
          emit({ type: "keyword-start", term: candidate.term, index: current, total: keywordPool.length })
          const anchor = candidate.term.split(" ").slice(0, -1).join(" ") || candidate.term
          try {
            const result = await systemOne(
              { keyword: candidate.term, cluster_anchor: anchor, site: { pages: siteTitles } },
              KEYWORD_QUESTIONS,
              { model },
            )
            const keyword = summariseKeyword(candidate, result, { pages: siteTitles }, keywordLevels)
            judgedKeywords.push(keyword)
            judgementCount += 1
            questionsAsked += Object.keys(KEYWORD_QUESTIONS).length
            latencies.push(result.receipt.ms)
            ledger.push({ url: `keyword:${candidate.term}`, ...result.receipt })
            emit({ type: "keyword-done", keyword })
          } catch (error) {
            if (error instanceof JevAuthError) return
            emit({ type: "error", url: `keyword:${candidate.term}`, message: (error as Error).message })
          }
        })
      }

      // Competitor pass: same rubric on each rival so the scorecards compare.
      if (pastTheCap.length > 0) {
        emit({
          type: "stage",
          stage: "Competitors",
          detail: `Judging the first ${rivalUrls.length} of ${requestedRivals.length} rivals — the rest are past the ${rivalCapApplied}-rival cap and are never crawled`,
        })
      }

      if (rivalUrls.length > 0) {
        emit({ type: "stage", stage: "Competitors", detail: `Comparing against ${rivalUrls.length} rivals` })
        let rivalIndex = 0
        await pool(rivalUrls, Math.max(1, Math.floor(concurrency / 2)), async (rival) => {
          const current = rivalIndex++
          emit({ type: "competitor-start", url: rival, index: current })
          const competitor = await judgeCompetitor(rival, context, model, maxPages)
          competitors.push(competitor)
          if (competitor.reachable) {
            judgementCount += 1
            latencies.push(competitor.ms)
            ledger.push({
              url: competitor.url,
              model: competitor.model,
              ms: competitor.ms,
              inputTokens: competitor.inputTokens,
              costUsd: competitor.costUsd,
              attempts: 1,
            })
          }
          emit({ type: "competitor-done", competitor })
        })
      }

      // Gap pass. Runs last, and only over terms that survived the keyword
      // pass, because a gap is a comparison and a comparison against a rival is
      // only worth a request once we know the term is real and a buyer types it.
      // Skipping the rest is what keeps this from doubling the run's cost.
      const gapTerms = gapCandidates(judgedKeywords, request.maxGaps ?? 8)
      const rivalPageTotal = competitors.filter((c) => c.reachable).length
      // Mined terms still need a rival: a comparison is two-sided. A presearch
      // seed does not — "this was typed and we hold nothing on it" is a gap
      // whether or not a competitor exists, and requiring one is what kept
      // panel 03 empty on every bare audit.
      const gapRun = rivalPageTotal
        ? gapTerms
        : gapTerms
            .filter((term) => seedTermKeys.has(term.term))
            .slice(0, MAX_RIVAL_LESS_GAP_ROWS)

      if (gapRun.length > 0) {
        emit({
          type: "stage",
          stage: "Gaps",
          detail: rivalPageTotal
            ? `Comparing ${gapRun.length} term(s) against the rivals`
            : `Checking ${gapRun.length} presearch term(s) — no rival was crawled, so these rows say nothing about competitors`,
        })

        // The rival side of the state is built from the titles the competitor
        // pass already collected, not a second crawl: those pages are gone by
        // now, and a re-crawl per term per rival is not affordable.
        const rivalPages: GapPage[] = competitors
          .filter((c) => c.reachable)
          .flatMap((c) =>
            c.topics.map((title) => ({ path: title, title, opening: "" })),
          )

        // Rival title -> origin, so a subject can name whose page was seen.
        // Topic overlap across pages crawled from their own site, never a rank.
        for (const rival of competitors) {
          if (!rival.reachable) continue
          let host: string | null = null
          try {
            host = new URL(rival.url).host
          } catch {
            host = null
          }
          for (const title of rival.topics) rivalDirectory.set(title, host)
        }

        const GAP_QUESTIONS = rivalGapQuestions()
        const rivalPagesInView = rivalPages.slice(0, 8)
        await pool(gapRun, concurrency, async (keyword) => {
          const term = keyword.term
          try {
            const ourPages = crawlResult.pages.filter((p) =>
              keyword.pages.some((ref) => ref === p.path || ref === p.url || `crawl:${p.url}` === ref),
            )
            const built = buildRivalGapState(
              {
                term,
                ourPages,
                rivalPages: rivalPagesInView,
                onOurPages: keyword.pages.map((p) => p.replace(/^crawl:/, "")),
                business: context,
              },
              GAP_QUESTIONS,
            )
            const result = await systemOne(built.state, GAP_QUESTIONS, { model })
            const gap = buildGapRow({
              term,
              answers: result.answers,
              signals: {
                onOurPages: keyword.pages.map((p) => p.replace(/^crawl:/, "")),
                rivalPagesCrawled: rivalPagesInView.length,
              },
              model,
              ms: result.receipt.ms,
              costUsd: result.receipt.costUsd,
              inputTokens: result.receipt.inputTokens,
            })
            if (gap.rivalServes) {
              gap.rivalPaths = rivalPagesInView.map((p) => p.title)
            }
            gaps.push(gap)
            judgementCount += 1
            questionsAsked += Object.keys(GAP_QUESTIONS).length
            latencies.push(result.receipt.ms)
            ledger.push({ url: `gap:${term}`, ...result.receipt })
            emit({ type: "gap-done", gap })
          } catch (error) {
            if (error instanceof JevAuthError) return
            emit({ type: "error", url: `gap:${term}`, message: (error as Error).message })
          }
        })
      }
    }
  }

  // Subjects: gap rows rolled up into one decision per subject. Runs on
  // whatever gaps exist, so a run with no rivals still reports the coverage
  // work it found rather than an empty panel with no explanation. Emitted as
  // they are produced so the panel fills live.
  const realQueryByTerm = new Map(
    judgedKeywords.map((keyword) => [keyword.term.toLowerCase().trim(), keyword.isRealQuery]),
  )
  const subjects = buildSubjects({
    gaps,
    seeds: seedSet(request.keywordSeeds),
    realQueryByTerm,
    rivalDirectory,
  })
  for (const subject of subjects) emit({ type: "subject", subject })

  // Presearch state. This layer did not run the research, so it cannot report
  // the agent's own `degraded` flag — claiming either value would be a fact
  // this code cannot see. What it CAN see is the consequence: with no seeds
  // every subject falls to `our_own_pages`, so no term can justify a new page.
  // That is a real degradation of what the panel can justify, it is computed
  // here rather than asserted, and the reason says so out loud.
  const seedsIn = request.keywordSeeds ?? []
  const metricsIn = request.metrics ?? []
  const proposalsIn = request.rivalProposals ?? []
  const presearch: PresearchState = {
    ran: seedsIn.length > 0 || metricsIn.length > 0 || proposalsIn.length > 0,
    degraded: seedsIn.length === 0 && metricsIn.length === 0 && proposalsIn.length === 0,
    reason:
      seedsIn.length > 0 || metricsIn.length > 0 || proposalsIn.length > 0
        ? null
        : "no presearch data was sent with this request; every subject below is mined from our own text and none of them can justify a new page",
  }

  // Only terms the model accepted as real, buyer-typed queries carry an
  // opportunity. Anything it rejected or could not decide stays out of the
  // market picture rather than quietly diluting it.
  //
  // THIS is the strict gate, and this list is the only thing "actionable" names
  // anywhere in the server. The gap pass uses a looser one on purpose
  // (`gapCandidates`); see the note there. Keep the two gates from drifting into
  // each other: relaxing this one to make the board fuller is the one change
  // that would turn uncertain output into advice.
  const actionableKeywords = judgedKeywords.filter(
    (k) => k.isRealQuery >= 0.5 && k.isBuyerQuery >= 0.2 && k.band !== "escalate",
  )
  const topKeywords = [...actionableKeywords].sort((a, b) => b.opportunity - a.opportunity).slice(0, 12)

  const linkSuggestions: LinkSuggestion[] = []
  for (const page of judgedPages) {
    for (const finding of page.findings) {
      if (finding.id !== "clear_next_step" && finding.id !== "rewrite") continue
      const candidates = judgedPages.filter((other) => other.url !== page.url).slice(0, 5)
      if (candidates.length > 0) {
        linkSuggestions.push({
          from: page.path,
          to: candidates[0]!.path,
          reason: `This page has no next step, and ${candidates[0]!.path} shares its intent (${candidates[0]!.intent}).`,
          p: 0.5,
        })
      }
    }
  }

  const totals: AuditTotals = {
    pagesCrawled: crawlResult.pages.length,
    pagesJudged: judgedPages.length,
    keywordsJudged: judgedKeywords.length,
    competitorsJudged: competitors.filter((c) => c.reachable).length,
    judgements: judgementCount,
    questionsAsked,
    inputTokens: ledger.reduce((sum, row) => sum + row.inputTokens, 0),
    costUsd: Number(ledger.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)),
    elapsedMs: Date.now() - started,
    medianMs: median(latencies),
    p95Ms: percentile(latencies, 95),
    needsHuman: judgedPages.filter((p) => p.needsHuman).length,
    decisiveShare: judgedPages.length
      ? Number((judgedPages.filter((p) => !p.needsHuman).length / judgedPages.length).toFixed(3))
      : 0,
    errors: crawlResult.errors.length,
  }

  const findings: Finding[] = [
    ...ruleFindings,
    ...judgedPages.flatMap((p) => p.findings.map((f) => ({ ...f, pages: [p.path] }))),
  ].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) as Finding[]

  // Rule-only run: score from deterministic checks alone, and say so.
  const score = runJev ? scorePages(judgedPages, ruleFindings) : ruleOnlyScore(ruleFindings, stats, crawlResult.pages.length)

  const classification = asChoice(
    (siteJudgements ?? {}) as Answers,
    "business_model",
  )

  // The cap, stated rather than applied. `rivalsRequested` is what the user sent
  // and `rivalsJudged` is what came back, so a truncated run is legible without
  // reading the code. `pastTheCap` names exactly which rivals were never looked
  // at — a rival that is silently absent is indistinguishable from one that was
  // judged and found wanting.
  const judgedRivals = competitors.filter((c) => c.reachable)
  const rivalCap: RivalCap = {
    cap: rivalCapApplied,
    requested: requestedRivals.length,
    attempted: competitors.length,
    judged: judgedRivals.length,
    unreachable: competitors.filter((c) => !c.reachable).map((c) => c.url),
    pastTheCap,
  }

  const snapshot: HistoryRun = {
    root: crawlResult.root.toString(),
    generatedAt: new Date().toISOString(),
    score,
    grade: gradeFrom(score),
    model,
    pagesCrawled: crawlResult.pages.length,
    pagesJudged: judgedPages.length,
    openPages: 0,
    competitorsJudged: judgedRivals.length,
    subjectCount: subjects.length,
    pages: crawlResult.pages.map((page) => {
      const judged = judgedPages.find((p) => p.path === page.path)
      const decision = decisions.find((d) => d.path === page.path)
      const actFinding = judged?.findings.some((f) => f.band === "act") ?? false
      return {
        path: page.path,
        url: page.url,
        open: decision != null || actFinding,
        topChange: decision?.topChange.instruction ?? null,
        band: decision?.topChange.band ?? judged?.band ?? null,
        findings: judged?.findings.length ?? 0,
        ruleFindings: ruleFindings.filter((f) => f.pages.includes(page.path)).length,
        words: page.words,
      }
    }),
  }
  snapshot.openPages = snapshot.pages.filter((page) => page.open).length

  // Read the previous run BEFORE recording this one, or every run is its own
  // baseline and the delta is always empty.
  const previousRun = loadHistory(crawlResult.root.toString())[0] ?? null
  const delta = diffRuns(snapshot, previousRun)
  const stored = recordRun(snapshot)
  if (!stored.stored) {
    // History is a convenience, so a failed write never fails the audit — but
    // it is reported rather than swallowed, because a silent history is a
    // history the user will trust and find empty.
    emit({
      type: "error",
      url: crawlResult.root.toString(),
      message: `this run's history could not be saved: ${stored.error ?? "unknown reason"}`,
    })
  }

  const report: AuditReport = {
    url: request.url,
    root: crawlResult.root.toString(),
    business: {
      name: context.name,
      context: context.context,
      market: context.market,
      modelClassification: classification?.choice ?? null,
      modelProbabilities: classification?.probabilities ?? {},
    },
    model,
    jevAssessed: runJev && judgedPages.length > 0,
    generatedAt: snapshot.generatedAt,
    totals,
    score,
    grade: gradeFrom(score),
    stats,
    findings,
    ruleFindings,
    pages: judgedPages,
    patterns: { ...countPatterns(judgedPages, aiGap), ...keywordPatterns(judgedKeywords) },
    keywords: topKeywords,
    gaps: gaps.sort((a, b) => b.priority - a.priority),
    decisions: decisions.sort((a, b) => b.priority - a.priority),
    subjects,
    notDecided,
    presearch,
    keywordSeeds: seedsIn,
    metrics: metricsIn,
    rivalProposals: proposalsIn,
    keywordPool,
    competitors,
    rivalsRequested: rivalCap.requested,
    rivalsJudged: rivalCap.judged,
    rivalCap,
    delta,
    linkSuggestions: linkSuggestions.slice(0, 20),
    siteJudgements,
    needsHuman: judgedPages
      .filter((p) => p.needsHuman)
      .map((p) => ({ url: p.url, reasons: p.reasons })),
    crawled: crawlResult.pages.map((page) => ({
      url: page.url,
      path: page.path,
      words: page.words,
      status: page.status,
      ruleFindings: ruleFindings.filter((f) => f.pages.includes(page.path)).length,
    })),
    crawl: {
      robotsFetched: crawlResult.robots.fetched,
      sitemapFound: crawlResult.sitemap.urls.length,
      discovered: crawlResult.discovered,
      errors: crawlResult.errors,
    },
    ledger,
  }

  emit({
    type: "summary",
    totals,
    score,
    grade: report.grade,
    stats,
    needsHuman: totals.needsHuman,
  })
  emit({ type: "done", report })
  return report
}

function ruleOnlyScore(
  ruleFindings: RuleFinding[],
  stats: RuleStats,
  pageCount: number,
): number {
  if (pageCount === 0) return 0
  const penalty = ruleFindings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0)
  const bonuses =
    (stats.withSchema / pageCount) * 10 +
    (stats.withDescription / pageCount) * 8 +
    (stats.withH1 / pageCount) * 8 +
    (stats.https ? 8 : 0)
  return Math.round(Math.max(0, Math.min(100, 80 - penalty + bonuses)))
}
