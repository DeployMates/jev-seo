import type {
  Band,
  CompetitorResult,
  GapBucket,
  GapRow,
  KeywordJudgement,
  PageJudgement,
} from "./types"

export type GapTone = "gap" | "thin" | "ok"
export type Priority = "P1" | "P2" | "P3"
export type Confidence = "high" | "medium" | "low"
export type DestinationKind = "new" | "extend"

/**
 * A rival page that reads as already serving this term. There is no live results
 * page in this state, so `page` and `shared` are the evidence: the match came
 * from the rival's own crawled titles, not from a ranking read.
 */
export interface RivalMatch {
  /** Null on server gap rows: the wire carries the page, not the domain. */
  domain: string | null
  score: number
  worthCopying: number
  page: string
  shared: string[]
}

export interface Opportunity {
  id: string
  term: string
  intent: string
  cluster: string
  ourState: string
  ourStateTone: GapTone
  rival: RivalMatch | null
  /** Every rival page the server saw for this term, not just the best match. */
  rivals: RivalMatch[]
  write: string
  destination: string
  destinationKind: DestinationKind
  priority: Priority
  priorityScore: number
  confidence: number
  confidenceLabel: Confidence
  /** The server's own band, absent on rows this browser derived itself. */
  band?: Band
  needsHuman: boolean
  greyZone: boolean
  reasons: string[]
  existingPaths: string[]
  opportunity: number
  coverageGap: number
  buyer: number
  pages: string[]
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from",
  "is", "are", "be", "my", "your", "our", "it", "this", "that", "you", "we", "i", "s", "vs",
])

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

function slug(value: string): string {
  return tokens(value).join("-") || value.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

function domainOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
}

/**
 * Which rival's own pages read as covering this term. Scored on shared content
 * words against that rival's crawled titles, so the strongest signal wins and a
 * one-word coincidence is reported as the weak match it is.
 */
export function matchRival(keyword: KeywordJudgement, rivals: CompetitorResult[]): RivalMatch | null {
  const term = tokens(keyword.term)
  if (term.length === 0) return null

  let best: RivalMatch | null = null
  for (const rival of rivals) {
    if (!rival.reachable) continue
    for (const title of rival.topics) {
      const titleTokens = new Set(tokens(title))
      const shared = term.filter((t) => titleTokens.has(t))
      if (shared.length === 0) continue
      const strength = shared.length / term.length
      if (strength < 0.34) continue
      const match: RivalMatch = {
        domain: domainOf(rival.url),
        score: rival.score,
        worthCopying: rival.worthCopying,
        page: title,
        shared,
      }
      if (!best || strength > best.shared.length / term.length) best = match
    }
  }
  return best
}

export function ourStateOf(keyword: KeywordJudgement): { text: string; tone: GapTone } {
  const carriers = keyword.pages.length
  const gap = keyword.coverageGap
  if (carriers === 0) {
    return gap >= 0.5
      ? { text: "nothing on the site", tone: "gap" }
      : { text: "mentioned, never served", tone: "gap" }
  }
  if (carriers === 1) return { text: "one page, no depth", tone: "thin" }
  if (gap < 0.4) return { text: `covered by ${carriers} pages`, tone: "ok" }
  return keyword.inHeadings >= 2
    ? { text: `has a section, split across ${carriers}`, tone: "thin" }
    : { text: `scattered across ${carriers}, never a section`, tone: "gap" }
}

/** The shape of page that would serve this term, read off intent and cluster. */
export function contentTypeOf(keyword: KeywordJudgement): string {
  const byCluster: Record<string, Record<string, string>> = {
    products_or_services: {
      transactional: "product or service page",
      commercial: "product comparison page",
      informational: "product explainer",
    },
    pricing_or_commercial: {
      transactional: "pricing page",
      commercial: "comparison page",
      informational: "cost breakdown page",
    },
    trust_and_proof: {
      transactional: "proof page: reviews, guarantees, credentials",
      commercial: "proof-led comparison page",
      informational: "trust explainer with evidence",
    },
    how_to_and_support: {
      transactional: "support and how-to hub",
      commercial: "which-to-choose guide",
      informational: "step-by-step guide",
    },
    location_and_local: {
      transactional: "location page with contact route",
      commercial: "area coverage page",
      informational: "local explainer",
    },
    brand: {
      transactional: "brand landing page",
      commercial: "brand comparison page",
      informational: "about page",
    },
  }
  const byIntent: Record<string, string> = {
    transactional: "landing page built to convert",
    commercial: "comparison page",
    navigational: "hub page",
    local: "location page",
    informational: "guide",
    unclear: "guide",
  }
  return byCluster[keyword.cluster]?.[keyword.intent] ?? byIntent[keyword.intent] ?? "guide page"
}

export function destinationOf(
  keyword: KeywordJudgement,
  pages: PageJudgement[],
): { path: string; kind: DestinationKind } {
  if (keyword.pages.length > 0) {
    const carry = keyword.pages
      .map((ref) => pages.find((p) => p.url === ref || p.path === ref || `crawl:${p.url}` === ref))
      .filter((p): p is PageJudgement => Boolean(p))
      .sort((a, b) => b.importance - a.importance)[0]
    if (carry) return { path: carry.path, kind: "extend" }
  }
  const folder =
    keyword.cluster === "other" || keyword.cluster === "unknown"
      ? "guides"
      : keyword.cluster.replace(/_/g, "-")
  return { path: `/${folder}/${slug(keyword.term)}`, kind: "new" }
}

/**
 * Mean of each question's own top probability. Averaged rather than maximised so
 * a single confident answer cannot carry a whole row past the grey zone.
 */
export function confidenceOf(keyword: KeywordJudgement): number {
  const top = new Map<string, number>()
  for (const [key, entry] of Object.entries(keyword.probabilities ?? {})) {
    const id = key.split(":")[0] ?? key
    top.set(id, Math.max(top.get(id) ?? 0, entry.value))
  }
  const values = [...top.values()]
  if (values.length === 0) return 0
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3))
}

function confidenceLabel(value: number): Confidence {
  if (value >= 0.8) return "high"
  if (value >= 0.6) return "medium"
  return "low"
}

function priorityOf(score: number): Priority {
  if (score >= 0.55) return "P1"
  if (score >= 0.3) return "P2"
  return "P3"
}

/**
 * Mirrors the server's `actionableKeywords` filter in server/src/audit.ts.
 * Applied to the live stream so rows don't appear during the run and then
 * vanish when the filtered report replaces them. Idempotent on report keywords,
 * which arrive already filtered, so both paths converge on the same set.
 */
export function isActionable(keyword: KeywordJudgement): boolean {
  return keyword.isRealQuery >= 0.5 && keyword.isBuyerQuery >= 0.2 && keyword.band !== "escalate"
}

export interface RejectionSummary {
  /** Mined phrases that do not read like searches at all — nav labels, chrome. */
  chrome: string[]
  /** Real enough, but held back because an answer sat in the grey zone. */
  greyZone: string[]
  /** Real searches, but nobody is buying, so there is nothing to rank for. */
  notBuyer: string[]
}

export function summariseRejections(judged: KeywordJudgement[]): RejectionSummary {
  const summary: RejectionSummary = { chrome: [], greyZone: [], notBuyer: [] }
  for (const keyword of judged) {
    if (isActionable(keyword)) continue
    if (keyword.isRealQuery < 0.5) summary.chrome.push(keyword.term)
    else if (keyword.band === "escalate") summary.greyZone.push(keyword.term)
    else summary.notBuyer.push(keyword.term)
  }
  return summary
}

/**
 * Server gap rows are the source of truth: no client-side derivation can
 * reconstruct which rival titles Jev was shown. Returns null for a term that is
 * not worth a page, so it never reaches the board as advice.
 */
export function fromGapRow(gap: GapRow): Opportunity | null {
  if (gap.contentType === "none") return null
  const confidence = confidenceFromProbabilities(gap.probabilities)
  const rivals = (gap.rivalServes ? gap.rivalPaths : []).map((page) => ({
    domain: null,
    score: 0,
    worthCopying: 0,
    page,
    shared: [] as string[],
  }))
  return {
    id: gap.term,
    term: gap.term,
    intent: gap.bucket,
    cluster: gap.contentType,
    ourState: bucketState(gap.bucket),
    ourStateTone: bucketTone(gap.bucket),
    rival: rivals[0] ?? null,
    rivals,
    write: CONTENT_TYPE_WORD[gap.contentType] ?? gap.contentType,
    destination: gap.targetPath,
    destinationKind: gap.existingPaths.length > 0 ? "extend" : "new",
    priority: gap.priority >= 0.55 ? "P1" : gap.priority >= 0.3 ? "P2" : "P3",
    priorityScore: gap.priority,
    confidence,
    confidenceLabel: confidence >= 0.8 ? "high" : confidence >= 0.6 ? "medium" : "low",
    band: gap.band,
    needsHuman: gap.needsHuman,
    greyZone: gap.band === "escalate" || gap.needsHuman,
    reasons: gap.reasons,
    existingPaths: [...gap.existingPaths],
    opportunity: gap.priority,
    coverageGap: 0,
    buyer: 0,
    pages: [...gap.existingPaths],
  }
}

const CONTENT_TYPE_WORD: Record<string, string> = {
  pillar: "pillar page",
  "how-to": "step-by-step guide",
  comparison: "comparison page",
  faq: "FAQ page",
  product: "product or service page",
  refresh: "refresh the page we already have",
}

function bucketState(bucket: GapBucket): string {
  switch (bucket) {
    case "shared":
      return "we and a rival both rank"
    case "missing":
      return "a rival covers it, we do not"
    case "weak":
      return "our page is thin here"
    case "strong":
      return "we already cover it"
    case "untapped":
      return "nobody covers it"
    case "unique":
      return "only we have it"
  }
}

function bucketTone(bucket: GapBucket): GapTone {
  if (bucket === "strong" || bucket === "shared") return "ok"
  if (bucket === "weak") return "thin"
  return "gap"
}

function confidenceFromProbabilities(
  probabilities: Record<string, { label: string; value: number }>,
): number {
  const top = new Map<string, number>()
  for (const [key, entry] of Object.entries(probabilities ?? {})) {
    const id = key.split(":")[0] ?? key
    top.set(id, Math.max(top.get(id) ?? 0, entry.value))
  }
  const values = [...top.values()]
  if (values.length === 0) return 0
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3))
}

export function buildOpportunities(
  keywords: KeywordJudgement[],
  rivals: CompetitorResult[],
  pages: PageJudgement[],
): Opportunity[] {
  return keywords
    .map((keyword) => {
      const state = ourStateOf(keyword)
      const destination = destinationOf(keyword, pages)
      const buyer = keyword.isBuyerQuery >= 0.5 ? 1 : 0
      const priorityScore = Number(
        (0.5 * keyword.opportunity + 0.3 * keyword.coverageGap + 0.2 * buyer).toFixed(3),
      )
      const confidence = confidenceOf(keyword)
      const rival = matchRival(keyword, rivals)
      return {
        id: keyword.term,
        term: keyword.term,
        intent: keyword.intent,
        cluster: keyword.cluster,
        ourState: state.text,
        ourStateTone: state.tone,
        rival,
        rivals: rival ? [rival] : [],
        write: contentTypeOf(keyword),
        destination: destination.path,
        destinationKind: destination.kind,
        priority: priorityOf(priorityScore),
        priorityScore,
        confidence,
        confidenceLabel: confidenceLabel(confidence),
        band: keyword.band,
        needsHuman: keyword.needsHuman,
        greyZone: keyword.needsHuman,
        reasons: keyword.reasons,
        existingPaths: [],
        opportunity: keyword.opportunity,
        coverageGap: keyword.coverageGap,
        buyer,
        pages: keyword.pages,
      }
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || b.opportunity - a.opportunity)
}
