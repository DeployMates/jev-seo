/**
 * Per-question-set Jev state.
 *
 * The plan this implements is blunt about the shape of the input: *irrelevant
 * context measurably lowers accuracy*, and trimming the state to the fields a
 * question actually needs cuts cost and raises accuracy at the same time. So
 * the state is not one global object that every question shares — it is derived
 * from the question set that is about to be sent.
 *
 * How the trimming stays honest, rather than becoming a silent guess:
 *
 *  1. Every question id declares the state fields it reads, in
 *     `QUESTION_FIELDS`. That is the justification for each field.
 *  2. `fieldsFor` unions those declarations for the question set actually being
 *     sent, so a page with no meta description — which therefore gets no
 *     `meta_fit` question — never pays for the description.
 *  3. A question with no declaration falls back to its scope's minimum set and
 *     is reported as `unmapped`. A new question can never arrive with an empty
 *     state because nobody remembered to map it.
 *  4. Whatever survives is measured against a character budget, shrunk in a
 *     fixed order, and the state itself carries a `state_meta` block saying
 *     what was left out, what was shortened, and whether the page's own body
 *     text was already cut by the crawler. A judgement made over half a page
 *     must be able to see that it was made over half a page.
 *
 * Nothing here asks a question, and nothing here decides anything: this is
 * assembly and budgeting only.
 */
import { PAGE_TEXT_CHARS } from "./config.js"
import type { CrawlResult, LinkGraph, PageEvidence } from "./crawl.js"
import type { KeywordCandidate } from "./keywords.js"
import { cannibalizationQuestion, type Primitive, type Questions } from "./questions.js"

export type StateScope =
  | "page"
  | "site"
  | "keyword"
  | "competitor"
  | "cannibalization"
  | "internal_link"
  | "rival_gap"

/** The operator's own words about their business. Jev never sees a form value. */
export interface BusinessContext {
  name: string
  context: string
  market: string
}

export interface StateBudget {
  /** Soft cap on the serialised state. Section 6.2 sweeps this: 2k/6k/12k. */
  maxChars: number
  /** Cap on any body text field, crawler cap is PAGE_TEXT_CHARS. */
  textChars: number
  openingChars: number
  maxHeadings: number
  maxBreadcrumbs: number
  maxLinkPaths: number
  maxSitePages: number
  maxSchemaTypes: number
  maxAuthors: number
  maxParagraphs: number
  /** Set false to keep the state raw, e.g. when diffing two formats. */
  includeMeta: boolean
}

export const DEFAULT_STATE_BUDGET: StateBudget = {
  maxChars: 12_000,
  textChars: 4_000,
  openingChars: 500,
  maxHeadings: 24,
  maxBreadcrumbs: 8,
  maxLinkPaths: 8,
  maxSitePages: 20,
  maxSchemaTypes: 12,
  maxAuthors: 6,
  maxParagraphs: 8,
  includeMeta: true,
}

export interface StateMeta {
  scope: StateScope
  questions: number
  fields_included: number
  fields_omitted: number
  /** True when this builder shortened a field to fit the budget. */
  trimmed: string[]
  /** True when body text was cut here. */
  text_truncated: boolean
  /** True when the crawler had already cut the page's body text. */
  source_text_truncated: boolean
  chars: number
  max_chars: number
  /** True when trimming could not bring the state under budget. */
  over_budget: boolean
}

/** The object handed to `systemOne`. Never contains a field nobody asked for. */
export type StateObject = Record<string, unknown>

export interface StateTruncation {
  meta: StateMeta
  /** Every field this scope could emit but no question in the set read. */
  omitted: string[]
  /** Question ids with no field declaration, served from the fallback set. */
  unmapped: string[]
  /** Fields shortened, in the order they were shortened. */
  trimmed: string[]
}

export interface BuiltState {
  state: StateObject
  truncation: StateTruncation
}

// ───────────────────────────────────────────── what each question reads

type FieldMap = Readonly<Record<string, readonly string[]>>

/** Page questions, from `pageQuestions()` plus `REFRESH_QUESTIONS`. */
const PAGE_FIELDS: FieldMap = {
  page_type: ["page.url", "page.path", "page.title", "page.h1", "page.heading_outline", "page.breadcrumbs", "page.opening", "page.text", "page.words", "page.topic"],
  intent: ["business", "page.url", "page.title", "page.h1", "page.heading_outline", "page.breadcrumbs", "page.opening", "page.text", "page.topic"],
  importance: ["business", "page.words", "page.links", "page.position", "page.schema_types", "site.titles"],
  action: ["page.title", "page.h1", "page.text", "page.position", "page.links"],
  helpfulness: ["page.title", "page.h1", "page.opening", "page.text", "page.words"],
  specificity: ["page.text", "page.opening", "page.authors"],
  citable: ["page.text", "page.opening", "page.schema_types", "page.authors", "page.images"],
  // Judged one paragraph at a time, so it gets the paragraphs, not the blob.
  paragraph_citability: ["page.paragraphs", "page.text", "page.words"],
  entity_density: ["page.text", "page.schema_types", "page.authors"],
  title_question_answered: ["page.title", "page.h1", "page.text"],
  defines_key_terms: ["page.text", "page.opening", "page.heading_outline", "page.topic"],
  extractable_format: ["page.heading_outline", "page.headings", "page.text"],
  claims_substantiated: ["page.title", "page.h1", "page.opening", "page.text"],
  visual_evidence: ["page.images", "page.text", "page.heading_outline"],
  trust: ["page.text", "page.authors", "page.schema_types", "page.images", "page.breadcrumbs"],
  scan_path: ["page.headings", "page.heading_outline", "page.text", "page.words"],
  // `page.links` is declared here rather than inherited from the union: this
  // question's levels cite `page.links.to`, so it must not depend on some other
  // question happening to pull that field in.
  internal_link_adequacy: ["page.links", "page.text_to_links", "page.position", "page.breadcrumbs", "page.text"],
  primary_cta: ["page.text", "page.opening", "page.links", "page.title"],
  // The "one change you would make first" question is the only one that can
  // justify the whole page, so it is the one that gets the whole page.
  highest_impact_change: ["page.title", "page.h1", "page.heading_outline", "page.text", "page.words", "page.images", "page.links", "page.position", "page.schema_types", "page.authors"],
  h1_fit: ["page.title", "page.h1"],
  answer_first: ["page.h1", "page.opening"],
  above_fold_promise: ["page.title", "page.h1", "page.opening"],
  title_fit: ["page.title", "page.h1", "page.heading_outline"],
  meta_fit: ["page.title", "page.description"],
  clear_next_step: ["page.text", "page.links", "page.breadcrumbs", "page.position"],
  structure_ease: ["page.h1", "page.heading_outline", "page.opening", "page.words", "page.breadcrumbs", "page.text_to_links"],
  content_freshness: ["page.title", "page.heading_outline", "page.text", "page.breadcrumbs"],
  competitor_distinctiveness: ["page.text", "page.authors", "page.schema_types", "page.images"],
}

/** Site questions, from `siteQuestions()` plus `GEO_QUESTIONS`. */
const SITE_FIELDS: FieldMap = {
  business_model: ["business", "site.origin", "site.home", "site.pages"],
  value_prop: ["business", "site.home", "site.pages"],
  entity_clarity: ["business", "site.home", "site.pages", "site.entity"],
  topical_focus: ["site.pages", "site.titles"],
  topic_authority: ["site.pages", "site.titles", "site.home", "business"],
  topic_reach: ["site.pages", "site.titles", "site.home"],
  question_shaped_coverage: ["site.pages", "site.home", "site.titles"],
  content_type_gap: ["site.pages", "site.home", "site.entity"],
  site_freshness: ["site.home", "site.pages", "site.proof"],
  serves_local_area: ["business", "site.home", "site.pages"],
  ai_citation_ready: ["site.home", "site.pages", "site.entity", "site.proof"],
  brand_entity: ["business", "site.entity", "site.pages", "site.home"],
  entity_relations: ["site.entity", "site.home", "site.pages", "site.proof"],
  claim_support: ["site.home", "site.pages", "site.proof", "site.entity"],
  source_attribution: ["site.home", "site.pages", "site.proof", "site.entity"],
  first_party_data: ["site.home", "site.pages", "site.proof"],
  key_terms_defined: ["site.home", "site.pages", "site.entity"],
  author_evidence: ["site.pages", "site.titles", "site.entity", "site.home"],
  answer_engine_gaps: ["site.entity", "site.home", "site.pages", "site.proof"],
}

const KEYWORD_FIELDS: FieldMap = {
  is_real_query: ["keyword.term"],
  is_buyer_query: ["business", "keyword.term"],
  intent: ["business", "keyword.term"],
  cluster: ["business", "keyword.term", "site.titles"],
  coverage_gap: ["site.pages", "keyword.signals"],
  // The six deleted keyword questions took their field maps with them: an
  // unmapped id is a bug this file reports, not a silent no-op, so leaving the
  // rows would have failed every keyword request. `keyword.signals` still
  // carries the code-derived form flags (`namedEntityForm`, `broadForm`) that
  // order the pool, which is why the two questions left here need it.
  trust_bar: ["keyword.term", "keyword.signals"],
  difficulty_proxy: ["keyword.term", "keyword.signals", "site.pages"],
}

const COMPETITOR_FIELDS: FieldMap = {
  business_model: ["business", "site.origin", "site.home", "site.pages"],
  value_prop: ["site.home", "site.pages"],
  entity_clarity: ["business", "site.home", "site.pages", "site.entity"],
  topical_focus: ["site.pages", "site.titles"],
  topic_authority: ["site.pages", "site.titles", "site.home", "business"],
  site_freshness: ["site.home", "site.pages", "site.proof"],
  author_evidence: ["site.pages", "site.titles", "site.entity", "site.home"],
  brand_entity: ["business", "site.entity", "site.pages", "site.home"],
  entity_relations: ["site.entity", "site.home", "site.pages", "site.proof"],
  claim_support: ["site.home", "site.pages", "site.proof", "site.entity"],
  source_attribution: ["site.home", "site.pages", "site.proof", "site.entity"],
  first_party_data: ["site.home", "site.pages", "site.proof"],
  ai_citation_ready: ["site.home", "site.pages", "site.entity", "site.proof"],
  ai_gap: ["site.entity", "site.home", "site.pages", "site.proof"],
  proof_density: ["site.home", "site.entity", "site.proof"],
  worth_copying: ["site.home", "site.pages"],
}

/** Pair ids are generated per batch, so the whole set maps through `*`. */
const CANNIBALIZATION_FIELDS: FieldMap = { "*": ["pair_summaries"] }
const INTERNAL_LINK_FIELDS: FieldMap = { "*": ["link_pair"] }

/**
 * Rival gap. Both page sets travel together on every question here, because
 * each one is a comparison and a comparison answered from one side is a guess.
 * `our.pages` is deliberately trimmed harder than `rival.pages`: the questions
 * ask whether we are covered, and our own page list is the smaller, more
 * decision-relevant set.
 */
const RIVAL_GAP_FIELDS: FieldMap = {
  is_real_query: ["keyword"],
  is_buyer_query: ["business", "keyword"],
  rival_serves: ["keyword", "rival.pages"],
  our_serves: ["keyword", "our.pages"],
  our_coverage: ["keyword", "our.pages"],
  our_own_subject: ["business", "keyword", "our.pages"],
  deliverable: ["business", "keyword", "our.pages", "rival.pages"],
}

const QUESTION_FIELDS: Record<StateScope, FieldMap> = {
  page: PAGE_FIELDS,
  site: SITE_FIELDS,
  keyword: KEYWORD_FIELDS,
  competitor: COMPETITOR_FIELDS,
  cannibalization: CANNIBALIZATION_FIELDS,
  internal_link: INTERNAL_LINK_FIELDS,
  rival_gap: RIVAL_GAP_FIELDS,
}

/** Served to a question nobody mapped, so a new question is never left empty. */
const FALLBACK_FIELDS: Record<StateScope, readonly string[]> = {
  page: ["page.url", "page.title", "page.h1", "page.heading_outline", "page.opening", "page.text", "page.words"],
  site: ["site.origin", "site.home", "site.pages"],
  keyword: ["business", "keyword.term"],
  competitor: ["site.origin", "site.home", "site.pages"],
  cannibalization: ["pair_summaries"],
  internal_link: ["link_pair"],
  rival_gap: ["business", "keyword", "our.pages", "rival.pages"],
}

/**
 * Union of the fields the question set reads, plus the ids that had to be
 * served from the fallback. The caller can report the unmapped list, so the
 * registry and this file can be kept in step.
 */
export function fieldsFor(
  scope: StateScope,
  questions: Questions,
): { fields: string[]; unmapped: string[] } {
  const map = QUESTION_FIELDS[scope]
  const fields = new Set<string>()
  const unmapped: string[] = []
  for (const id of Object.keys(questions)) {
    const declared = map[id] ?? map["*"]
    if (!declared) {
      unmapped.push(id)
      for (const field of FALLBACK_FIELDS[scope]) fields.add(field)
      continue
    }
    for (const field of declared) fields.add(field)
  }
  if (fields.size === 0) for (const field of FALLBACK_FIELDS[scope]) fields.add(field)
  return { fields: [...fields], unmapped }
}

// ───────────────────────────────────────────── field values

interface PageSources {
  page: PageEvidence
  pages: PageEvidence[]
  graph: LinkGraph
  business: BusinessContext
}

interface SiteSources {
  pages: PageEvidence[]
  graph: LinkGraph
  business: BusinessContext
  origin: string
}

type Producer<S> = (sources: S, budget: StateBudget) => unknown

function businessBlock(context: BusinessContext): StateObject {
  return {
    name: context.name || "not stated by the site owner",
    what_they_do: context.context || "not stated by the site owner",
    market: context.market || "not stated by the site owner",
  }
}

function outlineText(page: PageEvidence, budget: StateBudget): string[] {
  return page.headingOutline
    .slice(0, budget.maxHeadings)
    .map((node) => `h${node.level}: ${node.text}`)
}

function imageBlock(page: PageEvidence): StateObject {
  return {
    total: page.images,
    with_alt: page.imagesWithAlt,
    missing_alt: page.imagesMissingAlt,
    alt_coverage: page.altRatio,
  }
}

function linkBlock(page: PageEvidence, budget: StateBudget): StateObject {
  const position = page.position
  return {
    internal_out: position.outbound,
    internal_in: position.inbound,
    external_out: page.externalLinks,
    external_hosts: page.externalLinkHosts.slice(0, 6),
    orphan: position.orphan,
    dead_end: position.deadEnd,
    hops_from_home: position.hops,
    to: position.outboundPaths.slice(0, budget.maxLinkPaths),
  }
}

/**
 * How well connected the page is. `graph_coverage` below 1 means the crawl saw
 * less than the whole site, so these degrees are a floor, not a measurement.
 */
function positionBlock(sources: PageSources): StateObject {
  const { page, graph } = sources
  return {
    inbound_rank: page.position.inboundRank,
    inbound_share: page.position.inboundShare,
    pages_crawled: graph.pages,
    avg_internal_in: graph.avgInDegree,
    max_internal_in: graph.maxInDegree,
    graph_coverage: graph.inboundCoverage,
  }
}

const PAGE_PRODUCERS: Record<string, Producer<PageSources>> = {
  business: (s, b) => businessBlock(s.business),
  "page.url": (s) => s.page.url,
  "page.path": (s) => s.page.path,
  "page.title": (s) => s.page.title,
  "page.description": (s) => s.page.description,
  "page.h1": (s) => s.page.h1,
  "page.heading_outline": (s, b) => outlineText(s.page, b),
  "page.headings": (s, b) => s.page.headings.slice(0, b.maxHeadings),
  "page.paragraphs": (s, b) => s.page.paragraphs.slice(0, b.maxParagraphs),
  "page.breadcrumbs": (s, b) => s.page.breadcrumbs.slice(0, b.maxBreadcrumbs),
  "page.opening": (s, b) => s.page.opening.slice(0, b.openingChars),
  "page.text": (s, b) => s.page.text.slice(0, b.textChars),
  "page.words": (s) => s.page.words,
  "page.canonical": (s) => s.page.canonical,
  "page.language": (s) => s.page.lang,
  "page.schema_types": (s, b) => s.page.schemaTypes.slice(0, b.maxSchemaTypes),
  "page.authors": (s, b) => s.page.authors.slice(0, b.maxAuthors),
  "page.images": (s) => imageBlock(s.page),
  "page.text_to_links": (s) => ({
    words_per_link: s.page.textToLinkRatio,
    link_density: s.page.linkDensity,
    internal_links: s.page.internalLinks,
    external_links: s.page.externalLinks,
  }),
  "page.topic": (s) => s.page.topic,
  "page.links": (s, b) => linkBlock(s.page, b),
  "page.position": (s) => positionBlock(s),
  "site.titles": (s, b) =>
    s.pages.slice(0, b.maxSitePages).map((p) => p.title).filter((title) => title.length > 0),
}

function homeSummary(pages: PageEvidence[], budget: StateBudget): StateObject | undefined {
  const home = pages.find((p) => p.path === "/") ?? pages[0]
  if (!home) return undefined
  return {
    path: home.path,
    title: home.title,
    h1: home.h1,
    description: home.description,
    opening: home.opening.slice(0, budget.openingChars),
    text: home.text.slice(0, budget.textChars),
    words: home.words,
    heading_outline: outlineText(home, budget),
    breadcrumbs: home.breadcrumbs.slice(0, budget.maxBreadcrumbs),
    schema_types: home.schemaTypes.slice(0, budget.maxSchemaTypes),
    authors: home.authors.slice(0, budget.maxAuthors),
  }
}

function pageIndex(pages: PageEvidence[], budget: StateBudget): Array<StateObject> {
  return pages.slice(0, budget.maxSitePages).map((page) => ({
    path: page.path,
    title: page.title,
    h1: page.h1,
    words: page.words,
  }))
}

/**
 * One entity across the site: what a machine can read about who this is. Every
 * count here is deterministic, which is exactly why the model is not asked.
 */
function entityBlock(sources: SiteSources, budget: StateBudget): StateObject {
  const types = new Set<string>()
  const authors = new Set<string>()
  const languages = new Set<string>()
  for (const page of sources.pages) {
    for (const type of page.schemaTypes) if (types.size < budget.maxSchemaTypes * 2) types.add(type)
    for (const author of page.authors) if (authors.size < budget.maxAuthors * 2) authors.add(author)
    if (page.lang) languages.add(page.lang)
  }
  return {
    schema_types: [...types].slice(0, budget.maxSchemaTypes),
    named_authors: [...authors].slice(0, budget.maxAuthors),
    languages: [...languages],
    pages_with_schema: sources.pages.filter((p) => p.hasSchemaOrg).length,
    pages_with_h1: sources.pages.filter((p) => p.h1.length > 0).length,
    https: sources.pages.some((p) => p.hasHttps),
  }
}

/** Verifiable-proof signals, counted rather than judged. */
function proofBlock(sources: SiteSources, budget: StateBudget): StateObject {
  const pages = sources.pages
  const withDate = pages.filter((p) => /\b(19|20)\d{2}\b/.test(p.text))
  const externalHosts = new Set<string>()
  for (const page of pages) for (const host of page.externalLinkHosts) externalHosts.add(host)
  return {
    pages: pages.length,
    pages_with_named_author: pages.filter((p) => p.authors.length > 0).length,
    pages_with_a_date: withDate.length,
    pages_with_schema: pages.filter((p) => p.hasSchemaOrg).length,
    avg_words: pages.length === 0 ? 0 : Math.round(pages.reduce((sum, p) => sum + p.words, 0) / pages.length),
    distinct_external_sources: externalHosts.size,
    orphan_pages: sources.graph.orphans.length,
    dead_end_pages: sources.graph.deadEnds.length,
    words_by_page: pages.slice(0, budget.maxSitePages).map((p) => p.words),
  }
}

const SITE_PRODUCERS: Record<string, Producer<SiteSources>> = {
  business: (s) => businessBlock(s.business),
  "site.origin": (s) => s.origin,
  "site.home": (s, b) => homeSummary(s.pages, b),
  "site.pages": (s, b) => pageIndex(s.pages, b),
  "site.titles": (s, b) => s.pages.slice(0, b.maxSitePages).map((p) => p.title).filter((t) => t.length > 0),
  "site.entity": (s, b) => entityBlock(s, b),
  "site.proof": (s, b) => proofBlock(s, b),
  "site.links": (s) => ({
    pages_crawled: s.graph.pages,
    orphans: s.graph.orphans.slice(0, 20),
    dead_ends: s.graph.deadEnds.slice(0, 20),
    avg_internal_in: s.graph.avgInDegree,
    graph_coverage: s.graph.inboundCoverage,
  }),
}

interface KeywordSources {
  candidate: KeywordCandidate
  anchor: string
  pages: PageEvidence[]
  business: BusinessContext
}

const KEYWORD_PRODUCERS: Record<string, Producer<KeywordSources>> = {
  business: (s) => businessBlock(s.business),
  "keyword.term": (s) => s.candidate.term,
  "keyword.cluster_anchor": (s) => s.anchor,
  "site.titles": (s, b) => s.pages.slice(0, b.maxSitePages).map((p) => p.title).filter((t) => t.length > 0),
  "site.pages": (s, b) => pageIndex(s.pages, b),
  "keyword.signals": (s, b) => ({
    frequency: s.candidate.frequency,
    in_headings: s.candidate.inHeadings,
    in_title: s.candidate.inTitle,
    pages_carrying_it: s.candidate.pages.length,
    // Booleans amid counters: these are what the form, ownership and difficulty
    // questions actually judge, as opposed to the frequency figures above.
    question_form: s.candidate.questionForm,
    comparison_form: s.candidate.comparisonForm,
    commercial_form: s.candidate.commercialForm,
    named_entity_form: s.candidate.namedEntityForm,
    broad_form: s.candidate.broadForm,
    on_pages: s.candidate.pages.slice(0, Math.max(2, b.maxLinkPaths)),
  }),
}

export interface RivalGapSources {
  term: string
  /** Our own pages that could plausibly serve this term. */
  ourPages: PageEvidence[]
  /** The rival's pages that carry it, as crawled. */
  rivalPages: GapPage[]
  /** Terms we mined that the term overlaps, for the form flags. */
  onOurPages: readonly string[]
  business: BusinessContext
}

/**
 * The minimum a page needs to be judged against a search need. A full
 * `PageEvidence` satisfies it structurally, so `ourPages` can stay typed as-is;
 * the rival side is built from titles only, because the competitor pass
 * discards the rival's pages once it has scored them and re-crawling to recover
 * a title would cost a request per term per rival.
 */
export interface GapPage {
  path: string
  title: string
  h1?: string
  words?: number
  heading_outline?: readonly { level: number; text: string }[]
  opening?: string
  truncated?: boolean
}

/**
 * A page as the gap questions see it. Narrower than `pairSummary` on purpose:
 * these questions ask whether a page serves a search need, which the title,
 * H1, outline and opening answer. The body text of a rival's page is the single
 * most expensive thing that could go in here, and the least load-bearing.
 */
function gapPageSummary(page: GapPage, budget: StateBudget): StateObject {
  return {
    path: page.path,
    title: page.title,
    h1: page.h1 ?? "",
    words: page.words ?? 0,
    heading_outline: (page.heading_outline ?? [])
      .slice(0, 8)
      .map((node) => `h${node.level}: ${node.text}`),
    opening: (page.opening ?? "").slice(0, budget.openingChars),
  }
}

const RIVAL_GAP_PRODUCERS: Record<string, Producer<RivalGapSources>> = {
  business: (s) => businessBlock(s.business),
  keyword: (s) => s.term,
  "our.pages": (s, b) => s.ourPages.slice(0, 6).map((p) => gapPageSummary(p, b)),
  "rival.pages": (s, b) => s.rivalPages.slice(0, 6).map((p) => gapPageSummary(p, b)),
  "keyword.signals": (s) => ({
    // Observable only: which of our own paths the term already occurs on. No
    // frequency, volume or difficulty, because none of those are knowable here.
    occurs_on_our_pages: s.onOurPages.slice(0, 8),
  }),
}

// ───────────────────────────────────────────── assembly and budgeting
function nestInto(target: StateObject, path: string, value: unknown): void {
  const parts = path.split(".")
  let node = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]!
    const existing = node[key]
    if (existing === undefined || existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      const created: StateObject = {}
      node[key] = created
      node = created
    } else {
      node = existing as StateObject
    }
  }
  node[parts[parts.length - 1]!] = value
}

/** Drop containers that never received a value, so empty objects cost nothing. */
function pruneEmpty(node: StateObject): void {
  for (const key of [...Object.keys(node)]) {
    const value = node[key]
    if (value === undefined) {
      delete node[key]
      continue
    }
    if (isPlainObject(value)) {
      pruneEmpty(value)
      if (Object.keys(value).length === 0) delete node[key]
    }
  }
}

function isPlainObject(value: unknown): value is StateObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readPath(state: StateObject, path: string): unknown {
  const parts = path.split(".")
  let node: unknown = state
  for (const part of parts) {
    if (!isPlainObject(node)) return undefined
    node = node[part]
  }
  return node
}

function writePath(state: StateObject, path: string, value: unknown): void {
  nestInto(state, path, value)
}

function measure(state: StateObject): number {
  return JSON.stringify(state).length
}

/**
 * Shrink order, least useful first. Body text is the biggest field and the one
 * a question about the *shape* of a page can do without, so it goes first and
 * goes furthest; the headline, path and H1 never move, because a trimmed state
 * that lost the thing being judged is worse than one that is over budget.
 */
/** A text descent fine enough to land near the budget instead of overshooting it. */
const TEXT_CAPS = [4_000, 2_000, 1_000, 600, 400, 250, 150, 80, 0]

const SHRINK_ORDER: Array<{ path: string; caps: number[] }> = [
  { path: "page.text", caps: TEXT_CAPS },
  { path: "site.home.text", caps: TEXT_CAPS },
  { path: "page.paragraphs", caps: [8, 4, 2, 1] },
  { path: "page.heading_outline", caps: [24, 12, 6, 3] },
  { path: "site.home.heading_outline", caps: [16, 8, 4, 2] },
  { path: "site.pages", caps: [20, 12, 6, 3, 1] },
  { path: "site.titles", caps: [40, 20, 10, 5, 2] },
  { path: "site.proof.words_by_page", caps: [10, 5, 2] },
  { path: "page.links.to", caps: [8, 4, 2, 1] },
  { path: "site.links.orphans", caps: [10, 5, 2] },
  { path: "site.links.dead_ends", caps: [10, 5, 2] },
  { path: "page.opening", caps: [400, 200, 100, 50] },
  { path: "site.home.opening", caps: [400, 200, 100, 50] },
]

/**
 * Walk the shrink order until the state fits.
 *
 * `caps` descend, so a field already shorter than the current cap must fall
 * through to the next, smaller one rather than abandoning the field. Breaking
 * there leaves the state over budget and reports nothing trimmed, which is the
 * one outcome worse than being over budget: a silent lie about what was cut.
 */
function enforceBudget(
  state: StateObject,
  budget: StateBudget,
  trimmed: string[],
): { chars: number; overBudget: boolean } {
  let chars = measure(state)
  for (const step of SHRINK_ORDER) {
    for (const cap of step.caps) {
      if (chars <= budget.maxChars) break
      const current = readPath(state, step.path)
      if (current === undefined) break
      const isList = Array.isArray(current)
      const size = isList ? current.length : typeof current === "string" ? current.length : -1
      if (size >= 0 && size <= cap) continue
      writePath(state, step.path, isList ? current.slice(0, cap) : String(current).slice(0, cap))
      if (!trimmed.includes(step.path)) trimmed.push(step.path)
      chars = measure(state)
    }
    if (chars <= budget.maxChars) break
  }
  return { chars, overBudget: chars > budget.maxChars }
}

interface FinaliseInput {
  scope: StateScope
  questions: Questions
  fields: string[]
  unmapped: string[]
  available: readonly string[]
  sourceTextTruncated: boolean
}

function finalise(state: StateObject, budget: StateBudget, input: FinaliseInput): BuiltState {
  pruneEmpty(state)

  const meta: StateMeta = {
    scope: input.scope,
    questions: Object.keys(input.questions).length,
    fields_included: 0,
    fields_omitted: 0,
    trimmed: [],
    text_truncated: false,
    source_text_truncated: input.sourceTextTruncated,
    chars: 0,
    max_chars: budget.maxChars,
    over_budget: false,
  }
  // Seated before the budget runs, not after: state_meta is part of the payload
  // sent to the model, so it has to be inside the number being enforced. Added
  // last it silently pushed the real request past the ceiling it reports on.
  if (budget.includeMeta) state["state_meta"] = meta

  const trimmed: string[] = []
  enforceBudget(state, budget, trimmed)

  const included = input.fields.filter((field) => readPath(state, field) !== undefined)
  const omitted = input.available.filter((field) => !included.includes(field))

  meta.fields_included = included.length
  meta.fields_omitted = omitted.length
  meta.trimmed = trimmed.slice(0, 6)
  meta.text_truncated = trimmed.some((field) => field.endsWith(".text"))
  meta.chars = measure(state)
  meta.over_budget = meta.chars > budget.maxChars

  return { state, truncation: { meta, omitted, unmapped: input.unmapped, trimmed } }
}

function emit<S>(
  producers: Record<string, Producer<S>>,
  sources: S,
  fields: string[],
  budget: StateBudget,
): StateObject {
  const state: StateObject = {}
  for (const field of fields) {
    const producer = producers[field]
    if (!producer) continue
    nestInto(state, field, producer(sources, budget))
  }
  return state
}

// ───────────────────────────────────────────── builders

export interface StateOptions {
  budget?: Partial<StateBudget>
}

function resolveBudget(options?: StateOptions): StateBudget {
  return options?.budget ? { ...DEFAULT_STATE_BUDGET, ...options.budget } : DEFAULT_STATE_BUDGET
}

const PAGE_AVAILABLE: readonly string[] = Object.keys(PAGE_PRODUCERS)
const SITE_AVAILABLE: readonly string[] = Object.keys(SITE_PRODUCERS)
const KEYWORD_AVAILABLE: readonly string[] = Object.keys(KEYWORD_PRODUCERS)

/** The question set is the input, not an afterthought: it decides the state. */
export function buildPageState(
  page: PageEvidence,
  pages: PageEvidence[],
  graph: LinkGraph,
  business: BusinessContext,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  const budget = resolveBudget(options)
  const { fields, unmapped } = fieldsFor("page", questions)
  const sources: PageSources = { page, pages, graph, business }
  const state = emit(PAGE_PRODUCERS, sources, fields, budget)
  return finalise(state, budget, {
    scope: "page",
    questions,
    fields,
    unmapped,
    available: PAGE_AVAILABLE,
    sourceTextTruncated: page.truncated,
  })
}

/** Site-wide judgement: the whole crawled set, trimmed to what is asked. */
export function buildSiteState(
  result: Pick<CrawlResult, "pages" | "graph" | "root">,
  business: BusinessContext,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  const budget = resolveBudget(options)
  const { fields, unmapped } = fieldsFor("site", questions)
  const sources: SiteSources = {
    pages: result.pages,
    graph: result.graph,
    business,
    origin: result.root.toString(),
  }
  const state = emit(SITE_PRODUCERS, sources, fields, budget)
  return finalise(state, budget, {
    scope: "site",
    questions,
    fields,
    unmapped,
    available: SITE_AVAILABLE,
    sourceTextTruncated: result.pages.some((page) => page.truncated),
  })
}

/**
 * Keyword questions. The on-page signals travel with the term because they are
 * the only honest substitute for volume: frequency, heading placement and page
 * spread, all counted by code.
 */
export function buildKeywordState(
  candidate: KeywordCandidate,
  pages: PageEvidence[],
  business: BusinessContext,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  const budget = resolveBudget(options)
  const { fields, unmapped } = fieldsFor("keyword", questions)
  const sources: KeywordSources = {
    candidate,
    anchor: candidate.term.split(" ").slice(0, -1).join(" ") || candidate.term,
    pages,
    business,
  }
  const state = emit(KEYWORD_PRODUCERS, sources, fields, budget)
  return finalise(state, budget, {
    scope: "keyword",
    questions,
    fields,
    unmapped,
    available: KEYWORD_AVAILABLE,
    sourceTextTruncated: false,
  })
}

/** A rival, judged on the same shape as the subject site so scores compare. */
export function buildCompetitorState(
  result: Pick<CrawlResult, "pages" | "graph" | "root">,
  business: BusinessContext,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  return buildSiteState(result, business, questions, options)
}

const RIVAL_GAP_AVAILABLE: readonly string[] = Object.keys(RIVAL_GAP_PRODUCERS)

/**
 * One term, one call, both sides in view. The state carries the two page sets
 * under distinct keys because the whole bucket decision is a comparison, and a
 * state that merged them would let the model answer "is this covered" from the
 * rival's pages without noticing.
 */
export function buildRivalGapState(
  sources: RivalGapSources,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  const budget = resolveBudget(options)
  const { fields, unmapped } = fieldsFor("rival_gap", questions)
  const state = emit(RIVAL_GAP_PRODUCERS, sources, fields, budget)
  return finalise(state, budget, {
    scope: "rival_gap",
    questions,
    fields,
    unmapped,
    available: RIVAL_GAP_AVAILABLE,
    sourceTextTruncated: [...sources.ourPages, ...sources.rivalPages].some((page) => page.truncated),
  })
}

export function pairQuestionIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `pair_${index}`)
}

/** The question ids and the state keys are generated together, so they match. */
export function cannibalizationQuestionSet(count: number): Questions {
  const questions: Questions = {}
  for (const id of pairQuestionIds(count)) questions[id] = cannibalizationQuestion()
  return questions
}

function pairSummary(page: PageEvidence, budget: StateBudget): StateObject {
  return {
    path: page.path,
    title: page.title,
    h1: page.h1,
    words: page.words,
    heading_outline: outlineText(page, budget).slice(0, 10),
    opening: page.opening.slice(0, budget.openingChars),
  }
}

/**
 * Cannibalization, batched. Two trimmed summaries per question id, never the
 * bodies: the question is whether two pages look like the same page, which the
 * title, H1, outline and opening answer.
 */
export function buildCannibalizationState(
  pairs: Array<[PageEvidence, PageEvidence]>,
  business: BusinessContext,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  const budget = resolveBudget(options)
  const { unmapped } = fieldsFor("cannibalization", questions)
  const state: StateObject = { business: businessBlock(business) }

  let textTruncated = false
  for (const id of pairQuestionIds(pairs.length)) {
    const pair = pairs[Number(id.slice("pair_".length))]
    if (!pair) continue
    state[id] = { a: pairSummary(pair[0], budget), b: pairSummary(pair[1], budget) }
    if (pair[0].truncated || pair[1].truncated) textTruncated = true
  }

  return finalise(state, budget, {
    scope: "cannibalization",
    questions,
    fields: [...Object.keys(state)],
    unmapped,
    available: [],
    sourceTextTruncated: textTruncated,
  })
}

/** Would a reader on `source` genuinely need `target` next? */
export function buildInternalLinkState(
  source: PageEvidence,
  target: PageEvidence,
  questions: Questions,
  options?: StateOptions,
): BuiltState {
  const budget = resolveBudget(options)
  const { unmapped } = fieldsFor("internal_link", questions)
  const state: StateObject = {
    source: {
      path: source.path,
      title: source.title,
      h1: source.h1,
      heading_outline: outlineText(source, budget).slice(0, 10),
      opening: source.opening.slice(0, budget.openingChars),
      words: source.words,
      links_to: source.position.outboundPaths.slice(0, budget.maxLinkPaths),
    },
    target: {
      path: target.path,
      title: target.title,
      h1: target.h1,
      heading_outline: outlineText(target, budget).slice(0, 10),
      opening: target.opening.slice(0, budget.openingChars),
      words: target.words,
    },
  }

  return finalise(state, budget, {
    scope: "internal_link",
    questions,
    fields: ["source", "target"],
    unmapped,
    available: [],
    sourceTextTruncated: source.truncated || target.truncated,
  })
}

/** `page.text` is already capped by the crawler; this is the state-level cap. */
export const CRAWL_TEXT_CAP = PAGE_TEXT_CHARS

export type { Primitive }
