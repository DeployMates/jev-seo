/**
 * Gap rows to subjects: a term nobody owns yet, rolled up into a thing to build.
 *
 * The gap pass produces one row per term, and terms overlap. "boiler repair
 * cost", "boiler repair prices" and "emergency boiler repair" are three rows
 * and one decision, and a panel that listed all three would tell the owner to
 * write three pages about the same thing. This file clusters them and states
 * which single page the cluster means.
 *
 * The clustering key is deliberately crude and stated in the contract:
 * `contentType` + own-subject + the leading content word. A model asked to
 * group terms picks a plausible grouping; code asked to group by the first
 * content word and the deliverable already in the row is at least
 * re-derivable when a threshold moves.
 *
 * The rule this file exists to enforce:
 *
 *   **only `typed_and_returned` and `rival_published` justify a new page.**
 *
 * `our_own_pages` is what we found by mining our own body text. Recommending a
 * new page for a term we already have four pages on is the most expensive
 * mistake this product can make, and it is the one a "the gap is open" reading
 * invites. The tier is decided by evidence that somebody outside our own crawl
 * asked for the term — a presearch seed, which came back from a real search —
 * or a rival page that is written to answer it. Neither is a search volume and
 * neither is a ranking: a seed is a query that returned results, and a rival
 * page is topic overlap across pages we crawled from their own site.
 *
 * No volume, no demand, no difficulty. `priority` is the gap pass's own score
 * over observable signals, carried through unchanged.
 */
import type { Band } from "./thresholds.js"
import type { ContentType, GapBucket, GapRow } from "./gap.js"

export type DemandTier =
  /** Matched a presearch `keyword_seed` — a real search returned results. */
  | "typed_and_returned"
  /** Gap pass said `rival_serves` >= 0.5. */
  | "rival_published"
  /** Mined from our own body text. Coverage work, never a new page. */
  | "our_own_pages"

export interface SubjectRow {
  id: string
  /** Representative term, verbatim. NEVER a generated noun phrase. */
  label: string
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

/** Buckets that already hold a page we are in the running on. */
const COVERED_BUCKETS: readonly GapBucket[] = ["shared", "strong"]

/** Tiers that justify a page that does not exist yet. */
const NEW_PAGE_TIERS: readonly DemandTier[] = ["typed_and_returned", "rival_published"]

/**
 * Function words that can lead a mined phrase and carry no subject. Kept
 * minimal and separate from `keywords.ts` NOISE on purpose: this list decides
 * which word a cluster is *named* by, and deleting a commercial word here would
 * merge "boiler cost" with "boiler installation" because "cost" got dropped.
 */
const LEADING_NOISE = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from",
  "is", "are", "was", "were", "be", "my", "your", "our", "their", "we", "you", "it", "as",
  "that", "this", "these", "those", "how", "what", "when", "where", "who", "why", "which",
])

/**
 * The first word in a term that actually names something. Falls back to the
 * first word of any length when a term is all function words, because dropping
 * the whole key would merge every such term into one cluster named "".
 */
export function leadingContentWord(term: string): string {
  const words = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
  const content = words.find((word) => word.length > 2 && !LEADING_NOISE.has(word))
  return content ?? words[0] ?? term.toLowerCase()
}

/** A cluster id, derived from the same key as the clustering itself. */
function idFor(contentType: ContentType, ownSubject: boolean, lead: string): string {
  return `${contentType}:${ownSubject ? "own" : "theirs"}:${lead.replace(/[^a-z0-9]+/g, "-")}`
}

/**
 * The tier, in strict evidence order.
 *
 * A presearch seed is the strongest thing in this state, because it is the only
 * one that came back from a query somebody actually issued. A rival page is
 * next. Everything else is our own mined text, which proves the phrase occurs
 * in our corpus and nothing more.
 *
 * `is_real_query` is checked before anything else, because a term the model
 * called a sentence fragment is not a subject at all regardless of who typed
 * it — and a seed matched on a substring of a fragment would otherwise promote
 * it to a page.
 */
export function tierFor(
  gap: GapRow,
  isRealQuery: number | undefined,
  seeds: ReadonlySet<string>,
): DemandTier {
  if ((isRealQuery ?? 0) >= 0.5 && seeds.has(normalised(gap.term))) return "typed_and_returned"
  if (gap.rivalServes) return "rival_published"
  return "our_own_pages"
}

function normalised(term: string): string {
  return term.toLowerCase().replace(/\s+/g, " ").trim()
}

/** `our_own_subject` as a boolean, read off the probability block the row carries. */
function ownSubjectFor(gap: GapRow): boolean {
  const value = gap.probabilities["our_own_subject"]?.value
  return typeof value === "number" && value >= 0.5
}

/**
 * `strong` and `shared` already hold a page on the subject, so the deliverable
 * is `refresh` whatever the `deliverable` choice said. This mirrors `gap.ts`,
 * where the bucket is a function of the answers rather than a thing asked for.
 */
function contentTypeFor(gap: GapRow): ContentType {
  if (COVERED_BUCKETS.includes(gap.bucket)) return "refresh"
  return gap.contentType
}

/**
 * A refresh has to point at a page that exists. `gap.ts` already resolves the
 * target against `onOurPages`, but a row with no matching existing path can come
 * back with a fresh slug, and a "refresh /a-new-slug" row is a new page wearing
 * a refresh label.
 */
function targetFor(gap: GapRow, contentType: ContentType): string {
  if (contentType === "refresh" && gap.existingPaths.length > 0) {
    return gap.existingPaths[0]!
  }
  return gap.targetPath
}

export interface SubjectInput {
  gaps: readonly GapRow[]
  /** Presearch terms, already lowercased and trimmed. */
  seeds: ReadonlySet<string>
  /** `is_real_query` per term, from the keyword pass. Absent = not judged. */
  realQueryByTerm?: ReadonlyMap<string, number>
  /** Rival title -> origin, so a row can name whose page it saw. */
  rivalDirectory?: ReadonlyMap<string, string | null>
}

interface Cluster {
  key: string
  lead: string
  ownSubject: boolean
  contentType: ContentType
  members: GapRow[]
  tiers: DemandTier[]
  rivals: Array<{ title: string; domain: string | null }>
}

/**
 * One subject per cluster, most promising first.
 *
 * The label is the highest-priority term in the cluster, verbatim. It is never
 * assembled from the leading word, because a generated noun phrase reads as a
 * recommendation the user never made: "Boiler repair" synthesised from three
 * mined fragments is a claim about what the site should be about, and nobody
 * asked for it. If the cluster has no real term in it, there is no subject.
 *
 * A cluster whose best member is `contentType: "none"` produces no row. The gap
 * pass already said the term is not worth a page, and a panel that re-includes
 * it would undo that decision with no new evidence.
 */
export function buildSubjects(input: SubjectInput): SubjectRow[] {
  const clusters = new Map<string, Cluster>()

  for (const gap of input.gaps) {
    if (gap.contentType === "none") continue

    const ownSubject = ownSubjectFor(gap)
    const contentType = contentTypeFor(gap)
    const lead = leadingContentWord(gap.term)
    const key = idFor(contentType, ownSubject, lead)

    const tier = tierFor(gap, input.realQueryByTerm?.get(normalised(gap.term)), input.seeds)

    const existing = clusters.get(key)
    if (existing) {
      existing.members.push(gap)
      if (!existing.tiers.includes(tier)) existing.tiers.push(tier)
      for (const title of gap.rivalPaths) {
        if (existing.rivals.some((rival) => rival.title === title)) continue
        existing.rivals.push({ title, domain: input.rivalDirectory?.get(title) ?? null })
      }
      continue
    }

    clusters.set(key, {
      key,
      lead,
      ownSubject,
      contentType,
      members: [gap],
      tiers: [tier],
      rivals: gap.rivalPaths.map((title) => ({
        title,
        domain: input.rivalDirectory?.get(title) ?? null,
      })),
    })
  }

  const rows: SubjectRow[] = []
  for (const cluster of clusters.values()) {
    const members = [...cluster.members].sort((a, b) => b.priority - a.priority)
    const best = members[0]!
    const tier = bestTier(cluster.tiers)
    const contentType = contentTypeFor(best)
    const isNewPage = clusterNewPage(cluster, tier)

    const reasons = reasonsFor(cluster, best, tier, isNewPage)

    rows.push({
      id: cluster.key,
      label: best.term,
      phrases: members.slice(0, 4).map((gap) => gap.term),
      contentType,
      targetPath: targetFor(best, contentType),
      isNewPage,
      tier,
      ourState: best.bucket,
      rivals: cluster.rivals.slice(0, 4),
      priority: Number(best.priority.toFixed(4)),
      band: best.band,
      reasons,
    })
  }

  return rows.sort((a, b) => b.priority - a.priority)
}

/**
 * The strongest tier present, not the best member's. A cluster where one term
 * came back from a real search and three were mined from our own text is
 * `typed_and_returned`, because the evidence for the subject is what decides
 * the tier — not which row happened to win the priority sort.
 */
function bestTier(tiers: DemandTier[]): DemandTier {
  for (const candidate of ["typed_and_returned", "rival_published", "our_own_pages"] as const) {
    if (tiers.includes(candidate)) return candidate
  }
  return "our_own_pages"
}

/**
 * The rule, as code.
 *
 * A new page needs evidence from outside our own crawl. `our_own_pages` never
 * gets one, no matter how high its priority, because the priority came from
 * signals we produced about ourselves.
 *
 * The second guard is the one a cluster makes necessary: ANY member already
 * sitting on one of our pages vetoes the new page, not just the member that
 * won the priority sort. Without it, "boiler repair cost" (a real search, no
 * page) would drag "boiler installation guide" (we already own `/boilers`)
 * into a single "write a new page" card, and the panel would recommend the
 * second page the site already has.
 */
function clusterNewPage(cluster: Cluster, tier: DemandTier): boolean {
  if (cluster.contentType === "none") return false
  if (!NEW_PAGE_TIERS.includes(tier)) return false
  if (cluster.contentType === "refresh") return false
  if (cluster.members.some((gap) => gap.existingPaths.length > 0)) return false
  return true
}

function reasonsFor(
  cluster: Cluster,
  best: GapRow,
  tier: DemandTier,
  isNewPage: boolean,
): string[] {
  const reasons: string[] = []

  if (cluster.members.length > 1) {
    reasons.push(`${cluster.members.length} terms share "${cluster.lead}" and the same page type`)
  }

  switch (tier) {
    case "typed_and_returned":
      reasons.push("Matched a keyword seed that came back from a real search")
      break
    case "rival_published":
      reasons.push("A rival page is written to answer this subject")
      break
    case "our_own_pages":
      reasons.push("Mined from our own text; no search or rival evidence behind it")
      break
  }

  reasons.push(`Our state: ${best.bucket}`)

  if (!isNewPage && tier === "our_own_pages") {
    reasons.push("Coverage work, not a new page")
  }
  if (cluster.contentType === "refresh") {
    reasons.push("We already hold a page on this subject")
  }

  return reasons
}

/** Seeds from an AuditRequest, lowercased once, for the tier check. */
export function seedSet(
  seeds: ReadonlyArray<{ term: string }> | undefined,
): Set<string> {
  return new Set((seeds ?? []).map((seed) => normalised(seed.term)).filter((term) => term.length > 0))
}
