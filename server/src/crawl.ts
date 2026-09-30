/**
 * Deterministic crawling and extraction. Code finds, Jev judges — nothing here
 * asks a question the code can answer by counting.
 *
 * SSRF guard: the crawler refuses private, loopback and link-local addresses,
 * so a pasted URL cannot be used to reach an internal service.
 *
 * Two passes. The first is per-page: extract everything a single HTML document
 * can prove — the heading outline, breadcrumbs, structured-data types, alt
 * coverage, and which internal paths it points at. The second is site-wide, and
 * only possible once every page is in: the internal link graph, in and out
 * degree, and where each page sits in it. A page cannot know its own inbound
 * degree while it is being fetched, which is why position is stamped afterwards
 * and why the graph is a separate, rebuildable artefact.
 */
import * as cheerio from "cheerio"
import {
  CRAWL_RETRY_ATTEMPTS,
  CRAWL_RETRY_BASE_MS,
  CRAWL_RETRY_MAX_DELAY_MS,
  CRAWL_TIMEOUT_MS,
  PAGE_TEXT_CHARS,
} from "./config.js"

export interface PageEvidence {
  url: string
  path: string
  depth: number
  status: number
  title: string
  description: string
  h1: string
  headings: string[]
  /** Every h1..h6 with its level, in document order. Powers scannability. */
  headingOutline: HeadingNode[]
  /** Whole block-level text, kept paragraph-shaped: `text` is flattened. */
  paragraphs: string[]
  opening: string
  text: string
  /** `text` with nav, header, footer and aside removed. What language mining reads. */
  proseText: string
  truncated: boolean
  dates: PageDates
  words: number
  canonical: string
  lang: string
  images: number
  imagesWithAlt: number
  imagesMissingAlt: number
  /** WithAlt / images, 1 when the page has no images at all. */
  altRatio: number
  internalLinks: number
  externalLinks: number
  /** Body words per link. 0 when the page carries no links at all. */
  textToLinkRatio: number
  /** Links over words-plus-links, 0..1. The nav-heavy end reads near 1. */
  linkDensity: number
  /** Distinct internal paths this page links to, hash and query stripped. */
  internalLinkTargets: string[]
  /** Distinct external hosts this page cites, most linked first. */
  externalLinkHosts: string[]
  breadcrumbs: string[]
  /** Where the breadcrumb trail came from, or "none" when there is not one. */
  breadcrumbSource: BreadcrumbSource
  schemaTypes: string[]
  authors: string[]
  noindex: boolean
  hasSchemaOrg: boolean
  hasViewport: boolean
  hasHttps: boolean
  topic: PageTopic
  fetchedAt: string
  /** Filled by the second pass; the zero value until the graph is built. */
  position: PagePosition
}

export interface HeadingNode {
  /** 1..6, the real tag level, so a skipped level is visible. */
  level: number
  text: string
}

/** What a page says about its own age. `stated` is prose, the rest is machine-readable. */
export interface PageDates {
  /** Dates the visible text claims: "Updated 12 March 2026". */
  stated: string[]
  published: string
  modified: string
}

export type BreadcrumbSource = "json-ld" | "microdata" | "markup" | "none"

/**
 * What the page is about, counted rather than summarised. Phrases are weighted
 * by where they appear, so title and H1 outweigh a passing mention in the body.
 * These are counts, not a guess at meaning — Jev reads the text and judges.
 */
export interface PageTopic {
  /** The phrase the page leans on hardest. Empty when there is nothing to say. */
  primary: string
  /** The next strongest phrases, best first. */
  secondary: string[]
  /** `primary`'s share of all weighted phrase hits, 0..1. High means one subject. */
  concentration: number
  /** How much of the title's vocabulary the H1 repeats, 0..1. */
  titleH1Overlap: number
}

/**
 * Where one page sits in the site's internal link graph.
 *
 * `inbound` counts *crawled* pages that link here, not the whole site: a page
 * linked only from something the crawl never reached looks like an orphan. Read
 * `inbound` as a floor, never as proof, which is why `inboundCoverage` on the
 * graph states how much of the site was actually seen.
 */
export interface PagePosition {
  /** Distinct crawled pages linking here. 0 for the homepage. */
  inbound: number
  /** Distinct crawled paths this page links to. */
  outbound: number
  /** This page's inbound links as a share of all inbound links. */
  inboundShare: number
  /** 0 = most linked page in the crawl, -1 when the graph is empty. */
  inboundRank: number
  /** Nothing in the crawl links here. False for the homepage. */
  orphan: boolean
  /** This page links to no other crawled page. */
  deadEnd: boolean
  /** Shortest internal-link hops from the homepage; -1 when unreachable. */
  hops: number
  inboundPaths: string[]
  outboundPaths: string[]
}

export interface LinkEdge {
  from: string
  to: string
}

/**
 * The internal link graph over crawled pages. Nodes are paths, so two URLs that
 * differ only by query string collapse onto one node — the same identity the
 * rest of the codebase uses for a page.
 */
export interface LinkGraph {
  pages: number
  edges: LinkEdge[]
  inDegree: Record<string, number>
  outDegree: Record<string, number>
  /** Crawled pages nothing in the crawl links to, homepage excluded. */
  orphans: string[]
  /** Crawled pages that link to no other crawled page, homepage excluded. */
  deadEnds: string[]
  avgInDegree: number
  maxInDegree: number
  /** Paths reachable from the homepage, homepage included. */
  reachableFromHome: number
  /**
   * How much of the site the graph actually saw: crawled pages over pages the
   * crawl discovered but could not fetch. Below 1 the degrees are a lower bound.
   */
  inboundCoverage: number
}

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i

const MAX_HEADINGS = 60
const MAX_LINK_TARGETS = 150
const MAX_EXTERNAL_HOSTS = 15
const MAX_BREADCRUMBS = 10
const MAX_AUTHORS = 8

/**
 * Elements that imply a whitespace boundary in the rendered page. Used to
 * re-insert the separator that minified markup omits and cheerio's `.text()`
 * does not supply.
 *
 * `a` is here despite being inline: a link is a discrete unit of navigation,
 * and every menu, breadcrumb and nav bar on the web is built from them, so
 * `<a>Content</a><a>Catalog</a><a>Sign up</a>` is the single most common source
 * of a glued word. Padding it cannot split a word, because nothing sane wraps
 * half a word in an anchor. Genuinely inline elements — `span`, `em`, `strong`,
 * `b`, `i` — stay out, because `<em>` inside a word is exactly how "unbelievable"
 * would come apart as "un bel ievable" and inflate the count the other way.
 */
const BLOCK_BOUNDARY_SELECTOR =
  "a, address, article, aside, blockquote, br, button, dd, div, dl, dt, fieldset, figcaption, " +
  "figure, footer, form, h1, h2, h3, h4, h5, h6, header, hr, label, legend, li, main, nav, " +
  "ol, option, p, pre, section, table, tbody, td, tfoot, th, thead, tr, ul"
const MAX_PATH_LIST = 25
/** A breadcrumb item longer than this is page chrome, not a trail. */
const MAX_BREADCRUMB_ITEM = 80
const MAX_PARAGRAPHS = 12
const MAX_STATED_DATES = 6
const MIN_PARAGRAPH_CHARS = 120
const MAX_PARAGRAPH_CHARS = 900
const MAX_TOPIC_SECONDARY = 3
const MIN_TOPIC_TOKEN = 3
const MAX_TOPIC_TOKEN = 28

/**
 * Function words carry no subject, so counting them buries the topic in grammar.
 * Deliberately short — growing this list silently rescores every page.
 */
const STOP_WORDS = new Set([
  "about", "above", "after", "again", "against", "all", "also", "and", "any",
  "are", "because", "been", "before", "being", "below", "between", "both", "but",
  "can", "could", "did", "does", "doing", "done", "down", "during", "each",
  "few", "for", "from", "further", "had", "has", "have", "having", "her", "here",
  "hers", "him", "his", "how", "its", "itself", "just", "may", "might", "more",
  "most", "much", "must", "not", "now", "off", "once", "only", "other", "our",
  "ours", "out", "over", "own", "per", "same", "she", "should", "since", "some",
  "such", "than", "that", "the", "their", "theirs", "them", "then", "there",
  "these", "they", "this", "those", "through", "too", "under", "until", "up",
  "use", "used", "using", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "would", "you",
  "your", "yours",
])

function topicTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= MIN_TOPIC_TOKEN &&
        token.length <= MAX_TOPIC_TOKEN &&
        !STOP_WORDS.has(token) &&
        !/^\d+$/.test(token),
    )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : Number((shared / union).toFixed(3))
}

function emptyTopic(): PageTopic {
  return { primary: "", secondary: [], concentration: 0, titleH1Overlap: 0 }
}

/**
 * Weight a phrase by where it appears: in the title the page is asserting its
 * own subject, in a paragraph the same phrase is passing mention. A lone word
 * scores only from a heading, since in body copy it can mean something different
 * each time — which is why the unigram branch is gated on `weight > 1`.
 */
function scorePhrases(tokens: string[], weight: number, into: Map<string, number>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const first = tokens[index]!
    if (index + 1 < tokens.length) {
      const pair = `${first} ${tokens[index + 1]!}`
      into.set(pair, (into.get(pair) ?? 0) + weight)
    }
    if (weight > 1) into.set(first, (into.get(first) ?? 0) + weight)
  }
}

export function extractTopic(
  title: string,
  h1: string,
  headings: HeadingNode[],
  body: string,
): PageTopic {
  const scores = new Map<string, number>()
  scorePhrases(topicTokens(title), 5, scores)
  scorePhrases(topicTokens(h1), 5, scores)
  for (const node of headings) {
    const weight = node.level <= 2 ? 4 : 2
    scorePhrases(topicTokens(node.text), weight, scores)
  }
  scorePhrases(topicTokens(body), 1, scores)

  const ranked = [...scores.entries()].sort((a, b) => {
    const delta = b[1] - a[1]
    return delta !== 0 ? delta : a[0].localeCompare(b[0])
  })
  if (ranked.length === 0) return emptyTopic()

  const total = ranked.reduce((sum, [, score]) => sum + score, 0)
  const [primary, primaryScore] = ranked[0]!
  // A phrase already inside the primary adds nothing to "what else is this about".
  const secondary = ranked
    .slice(1)
    .filter(([phrase]) => !primary.includes(phrase) && !phrase.includes(primary))
    .slice(0, MAX_TOPIC_SECONDARY)
    .map(([phrase]) => phrase)

  return {
    primary,
    secondary,
    concentration: total === 0 ? 0 : Number((primaryScore / total).toFixed(3)),
    titleH1Overlap: jaccard(new Set(topicTokens(title)), new Set(topicTokens(h1))),
  }
}
/** Full dates only. A bare year is too common in body text to be a signal. */
const STATED_DATE = /\b(?:\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(?:19|20)\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(?:19|20)\d{2})\b/gi

export function assertPublicUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`)
  } catch {
    throw new Error(`Not a valid URL: ${input}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https are supported, got ${url.protocol}`)
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new Error(`Refusing to crawl a private or local address: ${url.hostname}`)
  }
  return url
}

function hostMatches(a: URL, b: URL): boolean {
  return a.hostname.replace(/^www\./i, "").toLowerCase() === b.hostname.replace(/^www\./i, "").toLowerCase()
}

/**
 * The current Googlebot desktop string, Chrome-token form, per Google's own
 * crawler documentation. Many sites serve a bot-detected client a stripped
 * page, a challenge, or nothing at all — which would make the audit measure a
 * page no visitor ever sees. Overridable, because some sites block Googlebot
 * outright and then want a browser string instead.
 */
export const CRAWL_USER_AGENT =
  process.env.CRAWL_USER_AGENT ??
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/151.0.0.0 Safari/537.36"

async function fetchWithTimeout(url: string, timeoutMs = CRAWL_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 429 is the rate limiter asking us to slow down, 408/5xx are the origin
 * failing. Every other 4xx is the request itself being wrong — a retry sends
 * the identical wrong request and only burns budget.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date, and an origin that
 * rate-limits us may ask for longer than the whole crawl budget. It is a hint
 * about how long to wait, never a licence to overrun the deadline.
 */
function retryAfterMs(response: Response, now: number): number {
  const header = response.headers.get("retry-after")
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, CRAWL_RETRY_MAX_DELAY_MS)
  }
  const at = Date.parse(header)
  if (Number.isFinite(at)) {
    return Math.min(Math.max(at - now, 0), CRAWL_RETRY_MAX_DELAY_MS)
  }
  return 0
}

/**
 * Exponential, then jittered. The jitter is not decoration: eight workers that
 * all back off by the same amount retry in lockstep, which is the exact
 * behaviour that keeps a rate limiter saturated.
 */
function backoffMs(attempt: number): number {
  const capped = Math.min(CRAWL_RETRY_BASE_MS * 2 ** (attempt - 1), CRAWL_RETRY_MAX_DELAY_MS)
  return Math.round(capped * (0.5 + Math.random() * 0.5))
}

export interface FetchOutcome {
  response?: Response
  error?: string
  attempts: number
  retries: number
}

/**
 * One page fetch, retried while the budget allows.
 *
 * The deadline is passed in rather than read from a clock here because the crawl
 * budget is the only authority on when to stop: a retry is only worth spending
 * budget on if the page can still land afterwards. So the per-attempt timeout is
 * clamped to the time remaining, and a backoff sleep that would run past the
 * deadline is not taken at all — a retry that cannot start in time is budget
 * spent for nothing.
 */
async function fetchPage(
  url: string,
  deadline: number,
  onRetry?: (url: string, reason: string, attempt: number, waitMs: number) => void,
): Promise<FetchOutcome> {
  let lastError = "fetch failed"
  let attempts = 0
  let retries = 0

  for (let attempt = 1; attempt <= Math.max(1, CRAWL_RETRY_ATTEMPTS); attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { error: `${lastError} (crawl budget exhausted)`, attempts, retries }
    }

    attempts = attempt
    let waitHintMs = 0
    let reason = ""

    try {
      const response = await fetchWithTimeout(url, Math.min(CRAWL_TIMEOUT_MS, remaining))
      if (!isRetryableStatus(response.status)) {
        return { response, attempts, retries }
      }
      reason = `HTTP ${response.status}`
      waitHintMs = retryAfterMs(response, Date.now())
      // A retryable error still holds its body. Release it so the connection
      // can go back to the pool instead of being torn down per attempt.
      await response.body?.cancel().catch(() => {})
    } catch (error) {
      // Abort, DNS failure, connection reset: the request never produced a
      // status, so there is nothing to inspect and everything is retryable.
      reason = (error as Error).name === "AbortError" ? "timeout" : (error as Error).message
    }

    lastError = reason
    if (attempt >= CRAWL_RETRY_ATTEMPTS) break

    const wait = Math.max(backoffMs(attempt), waitHintMs)
    if (Date.now() + wait >= deadline) break

    retries += 1
    onRetry?.(url, reason, attempt, wait)
    await sleep(wait)
  }

  return { error: lastError, attempts, retries }
}

function normaliseText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `@type` is a string, an array, or absent; a graph can nest further. */
function schemaTypeNames(value: unknown): string[] {
  const record = asRecord(value)
  if (!record) return []
  const raw = record["@type"]
  if (typeof raw === "string") return [raw]
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string")
  return []
}

function flattenSchemaNodes(nodes: unknown[], depth = 0): Record<string, unknown>[] {
  if (depth > 4) return []
  const out: Record<string, unknown>[] = []
  for (const node of nodes) {
    const record = asRecord(node)
    if (!record) continue
    out.push(record)
    const graph = record["@graph"]
    if (Array.isArray(graph)) out.push(...flattenSchemaNodes(graph, depth + 1))
  }
  return out
}

/** Malformed JSON-LD is common in the wild, so a bad block is skipped, not fatal. */
function readJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const raw: unknown[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const body = $(el).html() ?? $(el).text()
    if (!body || !body.trim()) return
    try {
      const parsed: unknown = JSON.parse(body)
      if (Array.isArray(parsed)) raw.push(...parsed)
      else raw.push(parsed)
    } catch {
      /* invalid JSON-LD: the page still has a usable DOM */
    }
  })
  return flattenSchemaNodes(raw)
}

function breadcrumbTrailFromSchema(node: Record<string, unknown>): string[] {
  const list = node["itemListElement"]
  const items = Array.isArray(list) ? list : list === undefined ? [] : [list]
  const trail: string[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (!record) continue
    const nested = asRecord(record["item"])
    const raw = record["name"] ?? nested?.["name"]
    const label = typeof raw === "string" ? normaliseText(raw) : ""
    if (label && label.length <= MAX_BREADCRUMB_ITEM) trail.push(label)
  }
  return trail
}

function readSchemaBreadcrumbs(nodes: Record<string, unknown>[]): { trail: string[]; source: BreadcrumbSource } {
  for (const node of nodes) {
    if (!schemaTypeNames(node).includes("BreadcrumbList")) continue
    const trail = breadcrumbTrailFromSchema(node)
    if (trail.length >= 2) return { trail: trail.slice(0, MAX_BREADCRUMBS), source: "json-ld" }
  }
  // A breadcrumb can be declared on a nested entity rather than the list itself.
  for (const node of nodes) {
    const trail = breadcrumbTrailFromSchema(node)
    if (trail.length >= 2) return { trail: trail.slice(0, MAX_BREADCRUMBS), source: "json-ld" }
  }
  return { trail: [], source: "none" }
}

/** `https://schema.org/Article` -> `Article` */
function microdataTypeName(itemtype: string): string {
  const tail = itemtype.split(/[/#]/).filter(Boolean).pop() ?? ""
  return normaliseText(tail)
}

function readMarkupBreadcrumbs($: cheerio.CheerioAPI): string[] {
  const selectors = [
    'nav[aria-label*="readcrumb"]',
    'nav[aria-label*="Readcrumb"]',
    '[aria-label*="readcrumb"]',
    '[aria-label*="Readcrumb"]',
    "ol.breadcrumb",
    '[class*="readcrumb"]',
    '[class*="Breadcrumb"]',
  ]
  for (const selector of selectors) {
    const matches = $(selector).toArray()
    for (const el of matches) {
      const scope = $(el)
      const trail: string[] = []
      scope.find("li, [itemprop='name']").each((_, item) => {
        const text = normaliseText($(item).text())
        if (!text || text.length > MAX_BREADCRUMB_ITEM) return
        if (trail[trail.length - 1] === text) return
        trail.push(text)
      })
      // A single item is a label, not a trail, so it is not evidence of anything.
      if (trail.length >= 2) return trail.slice(0, MAX_BREADCRUMBS)
    }
  }
  return []
}

function readAuthorNames(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const name = normaliseText(value)
    if (name && name.length <= 120) into.add(name)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) readAuthorNames(entry, into)
    return
  }
  const record = asRecord(value)
  if (!record) return
  const raw = record["name"]
  if (typeof raw === "string") {
    const name = normaliseText(raw)
    if (name && name.length <= 120) into.add(name)
  }
}

function readAuthors($: cheerio.CheerioAPI, nodes: Record<string, unknown>[]): string[] {
  const names = new Set<string>()
  for (const node of nodes) {
    readAuthorNames(node["author"], names)
    readAuthorNames(node["creator"], names)
  }
  $('meta[name="author"], meta[property="article:author"]').each((_, el) => {
    const content = normaliseText($(el).attr("content") ?? "")
    if (content && content.length <= 120) names.add(content)
  })
  $('[rel="author"], [itemprop="author"]').each((_, el) => {
    const text = normaliseText($(el).text())
    if (text && text.length <= 120) names.add(text)
  })
  return [...names].slice(0, MAX_AUTHORS)
}

function readSchemaTypes($: cheerio.CheerioAPI, nodes: Record<string, unknown>[]): string[] {
  const types = new Set<string>()
  for (const node of nodes) for (const name of schemaTypeNames(node)) if (name) types.add(name)
  $("[itemtype]").each((_, el) => {
    const name = microdataTypeName($(el).attr("itemtype") ?? "")
    if (name) types.add(name)
  })
  return [...types]
}

/** Node identity for the link graph: path, with hash and query removed. */
function linkKey(target: URL): string {
  const clone = new URL(target.toString())
  clone.hash = ""
  clone.search = ""
  return clone.pathname || "/"
}

function firstStringProperty(nodes: Record<string, unknown>[], key: string): string {
  for (const node of nodes) {
    const raw = node[key]
    if (typeof raw === "string" && raw.trim()) return raw.trim()
    if (Array.isArray(raw)) {
      for (const entry of raw) if (typeof entry === "string" && entry.trim()) return entry.trim()
    }
    const wrapped = asRecord(raw)
    const value = wrapped?.["@value"]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function collectDates(
  $: cheerio.CheerioAPI,
  nodes: Record<string, unknown>[],
  text: string,
): PageDates {
  const stated: string[] = []
  const add = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed || stated.includes(trimmed)) return
    if (stated.length < MAX_STATED_DATES) stated.push(trimmed)
  }

  $("time[datetime]").each((_, el) => add($(el).attr("datetime") ?? ""))
  for (const match of text.matchAll(STATED_DATE)) {
    add(match[0])
    if (stated.length >= MAX_STATED_DATES) break
  }

  const metaValue = (selectors: string[]): string => {
    for (const selector of selectors) {
      const value = normaliseText($(selector).attr("content") ?? "")
      if (value) return value
    }
    return ""
  }

  return {
    stated,
    published:
      firstStringProperty(nodes, "datePublished") ||
      metaValue(['meta[property="article:published_time"]', 'meta[name="publish_date"]']),
    modified:
      firstStringProperty(nodes, "dateModified") ||
      metaValue([
        'meta[property="article:modified_time"]',
        'meta[name="lastmod"]',
        'meta[name="revised"]',
      ]),
  }
}

export function emptyPosition(): PagePosition {
  return {
    inbound: 0,
    outbound: 0,
    inboundShare: 0,
    inboundRank: -1,
    orphan: false,
    deadEnd: false,
    hops: 0,
    inboundPaths: [],
    outboundPaths: [],
  }
}

/** Extract the evidence a page contributes. Nothing here is a judgement. */
export function extractPage(
  url: string,
  root: URL,
  html: string,
  status: number,
  depth: number,
): PageEvidence {
  const $ = cheerio.load(html)
  // Must precede the strip below: a JSON-LD block is a <script>, so counting
  // after `remove()` always answers 0. Moving this line down reintroduces that.
  const jsonLdBlocks = $('script[type="application/ld+json"]').length
  const jsonLd = readJsonLd($)
  $("script, style, noscript, svg, template").remove()

  // Restore the boundaries minified markup drops. Cheerio's `.text()`
  // concatenates every descendant with no separator at all, so a nav bar
  // written as `<a>Content</a><a>Catalog</a><a>Sign up</a>` reads as
  // "ContentCatalogSign up" — one invented word that then gets mined as a
  // keyword. Block-level elements are padded with a space; inline runs are left
  // alone, because a separator there would split "un<em>bel</em>ievable" into
  // three words and inflate the count the other way.
  $("br, hr").replaceWith(" ")
  $(BLOCK_BOUNDARY_SELECTOR).each((_, el) => {
    $(el).prepend(" ").append(" ")
  })

  const title = normaliseText($("title").first().text())
  const description = normaliseText(
    $('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content") ?? "",
  )
  const h1Raw = $("h1").first()
  const h1 = normaliseText(h1Raw.text())
  const opening = normaliseText(
    h1Raw.length > 0
      ? h1Raw.nextUntil("h1, h2").text()
      : $("main, article, body").first().text(),
  ).slice(0, 600)

  const bodyText = normaliseText($("body").text())
  const truncated = bodyText.length > PAGE_TEXT_CHARS
  const words = bodyText.split(/\s+/).filter(Boolean).length

  /**
   * The same page with its chrome removed, for anything that mines language.
   *
   * `bodyText` is the right input for measuring a page and the wrong input for
   * finding out what it is about: every page carries a nav, and on a
   * content-heavy page that nav is a small enough fraction that the page's link
   * density still reads as prose — so "Sign Log In" mined cleanly out of a
   * genuine article. Link density cannot fix that case, because the chrome is
   * diluted; only removing the regions that are *marked* as chrome can.
   *
   * `<nav>`, `<header>`, `<footer>` and `<aside>` are excluded by their markup
   * meaning rather than by a word list, so a page genuinely about help centres
   * keeps every word of it: that content lives in `<main>`, not `<nav>`. The
   * fallback matters too — a page with no `<main>` at all still yields its prose
   * rather than an empty string.
   */
  const proseCopy = $("body").clone()
  proseCopy.find("nav, header, footer, aside").remove()
  const proseText = normaliseText(proseCopy.text()) || bodyText

  const headings: string[] = []
  const headingOutline: HeadingNode[] = []
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = normaliseText($(el).text())
    if (!text) return
    if (headings.length < 40 && /^h[123]$/i.test(el.tagName)) headings.push(text)
    if (headingOutline.length >= MAX_HEADINGS) return false
    const level = Number(/^h([1-6])$/i.exec(el.tagName)?.[1] ?? 2)
    headingOutline.push({ level, text })
    return true
  })

  const linkTargets = new Set<string>()
  const externalHosts = new Map<string, number>()
  let internalLinks = 0
  let externalLinks = 0
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return
    let target: URL
    try {
      target = new URL(href, url)
    } catch {
      return
    }
    if (hostMatches(target, root)) {
      internalLinks += 1
      if (linkTargets.size < MAX_LINK_TARGETS) linkTargets.add(linkKey(target))
    } else {
      externalLinks += 1
      const host = target.hostname.replace(/^www\./i, "").toLowerCase()
      if (host) externalHosts.set(host, (externalHosts.get(host) ?? 0) + 1)
    }
  })

  const totalLinks = internalLinks + externalLinks

  const paragraphs: string[] = []
  const seenParagraph = new Set<string>()
  $("p, li").each((_, el) => {
    if (paragraphs.length >= MAX_PARAGRAPHS) return false
    const text = normaliseText($(el).text())
    if (text.length < MIN_PARAGRAPH_CHARS || text.length > MAX_PARAGRAPH_CHARS) return
    const fingerprint = text.slice(0, 80)
    if (seenParagraph.has(fingerprint)) return
    seenParagraph.add(fingerprint)
    paragraphs.push(text)
    return true
  })

  const images = $("img").toArray()
  const imagesWithAlt = images.filter((el) => {
    const alt = $(el).attr("alt")
    return alt !== undefined && alt.trim() !== ""
  }).length

  const schemaBreadcrumbs = readSchemaBreadcrumbs(jsonLd)
  const microdataIsBreadcrumb = $('[itemtype*="BreadcrumbList"]').length > 0
  const breadcrumbs = schemaBreadcrumbs.trail.length >= 2
    ? schemaBreadcrumbs
    : (() => {
        const markup = readMarkupBreadcrumbs($)
        if (markup.length >= 2) return { trail: markup, source: "markup" as BreadcrumbSource }
        if (microdataIsBreadcrumb) return { trail: [], source: "microdata" as BreadcrumbSource }
        return { trail: [], source: "none" as BreadcrumbSource }
      })()

  const metaRobots = ($('meta[name="robots"]').attr("content") ?? "").toLowerCase()

  return {
    url,
    path: new URL(url).pathname,
    depth,
    status,
    title,
    description,
    h1,
    headings,
    headingOutline,
    paragraphs,
    opening,
    text: bodyText.slice(0, PAGE_TEXT_CHARS),
    proseText: proseText.slice(0, PAGE_TEXT_CHARS),
    truncated,
    dates: collectDates($, jsonLd, bodyText),
    words,
    canonical: $('link[rel="canonical"]').attr("href") ?? "",
    lang: $("html").attr("lang") ?? "",
    images: images.length,
    imagesWithAlt,
    imagesMissingAlt: images.length - imagesWithAlt,
    altRatio: images.length === 0 ? 1 : Number((imagesWithAlt / images.length).toFixed(3)),
    internalLinks,
    externalLinks,
    textToLinkRatio: totalLinks === 0 ? 0 : Number((words / totalLinks).toFixed(1)),
    linkDensity: words + totalLinks === 0
      ? 0
      : Number((totalLinks / (words + totalLinks)).toFixed(3)),
    internalLinkTargets: [...linkTargets],
    externalLinkHosts: [...externalHosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_EXTERNAL_HOSTS)
      .map(([host]) => host),
    breadcrumbs: breadcrumbs.trail,
    breadcrumbSource: breadcrumbs.source,
    schemaTypes: readSchemaTypes($, jsonLd),
    authors: readAuthors($, jsonLd),
    noindex: metaRobots.includes("noindex"),
    hasSchemaOrg: jsonLdBlocks > 0,
    hasViewport: $('meta[name="viewport"]').length > 0,
    hasHttps: url.startsWith("https://"),
    topic: extractTopic(title, h1, headingOutline, bodyText),
    fetchedAt: new Date().toISOString(),
    position: emptyPosition(),
  }
}

export interface RobotsInfo {
  fetched: boolean
  disallowAll: boolean
  blockedPaths: string[]
  sitemap: string[]
}

export async function readRobots(root: URL): Promise<RobotsInfo> {
  const empty: RobotsInfo = { fetched: false, disallowAll: false, blockedPaths: [], sitemap: [] }
  try {
    const response = await fetchWithTimeout(new URL("/robots.txt", root).toString())
    if (!response.ok) return empty
    const text = await response.text()
    const blockedPaths: string[] = []
    const sitemap: string[] = []
    let appliesToUs = false
    for (const rawLine of text.split("\n")) {
      const line = (rawLine.split("#")[0] ?? "").trim()
      if (!line) continue
      const [rawKey = "", ...rest] = line.split(":")
      const key = rawKey.trim().toLowerCase()
      const value = rest.join(":").trim()
      if (key === "user-agent") appliesToUs = value === "*"
      if (key === "sitemap") sitemap.push(value)
      if (key === "disallow" && appliesToUs && value !== "") blockedPaths.push(value)
      if (key === "disallow" && appliesToUs && value === "" && blockedPaths.length === 0) {
        // explicit empty Disallow means allow-all
      }
    }
    return { fetched: true, disallowAll: false, blockedPaths, sitemap }
  } catch {
    return empty
  }
}

export function isBlocked(path: string, robots: RobotsInfo): boolean {
  return robots.blockedPaths.some((rule) => rule !== "/" && path.startsWith(rule))
}

export interface SitemapUrls {
  urls: string[]
  truncated: boolean
}

/** Read up to `cap` URLs from any sitemap or sitemap index, one level deep. */
export async function readSitemaps(sitemap: string[], cap: number): Promise<SitemapUrls> {
  const urls: string[] = []
  const seen = new Set<string>()

  const collectFrom = async (xml: string, budget: number): Promise<void> => {
    if (budget <= 0) return
    let body: string
    try {
      const response = await fetchWithTimeout(xml)
      if (!response.ok) return
      body = await response.text()
    } catch {
      return
    }
    const locs = body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) ?? []
    const isIndex = /<sitemapindex/i.test(body)
    for (const match of locs) {
      const loc = match.replace(/<\/?loc>/gi, "").trim()
      if (!loc || seen.has(loc)) continue
      seen.add(loc)
      if (isIndex) {
        await collectFrom(loc, budget)
      } else {
        urls.push(loc)
        budget -= 1
      }
      if (budget <= 0) return
    }
  }

  let budget = cap
  for (const xml of sitemap) {
    if (budget <= 0) break
    await collectFrom(xml, budget)
  }
  return { urls, truncated: budget <= 0 }
}

/**
 * Build the internal link graph over the crawled pages and stamp each page's
 * position from it.
 *
 * Degrees count crawled pages only, so they are a floor rather than the truth:
 * a page linked from something the crawl never reached is indistinguishable
 * from an orphan. `inboundCoverage` records that gap so callers can say so
 * rather than presenting a guess as a measurement.
 */
export function buildLinkGraph(pages: PageEvidence[], discovered = pages.length): {
  graph: LinkGraph
  positions: Map<string, PagePosition>
} {
  const byPath = new Map<string, PageEvidence>()
  for (const page of pages) if (!byPath.has(page.path)) byPath.set(page.path, page)

  const nodes = [...byPath.keys()]
  const known = new Set(nodes)
  const edges: LinkEdge[] = []
  const inDegree: Record<string, number> = {}
  const outDegree: Record<string, number> = {}
  const inboundPaths: Record<string, string[]> = {}
  for (const path of nodes) {
    inDegree[path] = 0
    outDegree[path] = 0
    inboundPaths[path] = []
  }

  for (const [from, page] of byPath) {
    const targets = page.internalLinkTargets.filter((to) => known.has(to) && to !== from)
    const seen = new Set<string>()
    for (const to of targets) {
      if (seen.has(to)) continue
      seen.add(to)
      edges.push({ from, to })
      outDegree[from] = (outDegree[from] ?? 0) + 1
      inDegree[to] = (inDegree[to] ?? 0) + 1
      const list = inboundPaths[to]
      if (list && list.length < MAX_PATH_LIST) list.push(from)
    }
  }

  // Shortest hops from the homepage: the graph is a DAG of URLs, not pages, so
  // a plain BFS is safe even when two pages link to each other.
  const home = nodes.includes("/") ? "/" : nodes[0]
  const hops: Record<string, number> = {}
  if (home !== undefined) {
    const adjacency = new Map<string, string[]>()
    for (const edge of edges) {
      const list = adjacency.get(edge.from)
      if (list) list.push(edge.to)
      else adjacency.set(edge.from, [edge.to])
    }
    hops[home] = 0
    let frontier = [home]
    let depth = 0
    while (frontier.length > 0) {
      depth += 1
      const next: string[] = []
      for (const node of frontier) {
        for (const to of adjacency.get(node) ?? []) {
          if (hops[to] !== undefined) continue
          hops[to] = depth
          next.push(to)
        }
      }
      frontier = next
    }
  }

  const totalIn = Object.values(inDegree).reduce((sum, value) => sum + value, 0)
  const ranking = [...nodes].sort((a, b) => {
    const delta = (inDegree[b] ?? 0) - (inDegree[a] ?? 0)
    return delta !== 0 ? delta : a.localeCompare(b)
  })
  const rank = new Map<string, number>(ranking.map((path, index) => [path, index]))

  const positions = new Map<string, PagePosition>()
  const orphans: string[] = []
  const deadEnds: string[] = []
  for (const path of nodes) {
    const inbound = inDegree[path] ?? 0
    const outbound = outDegree[path] ?? 0
    const isHome = path === home
    const orphan = !isHome && inbound === 0
    const deadEnd = !isHome && outbound === 0
    if (orphan) orphans.push(path)
    if (deadEnd) deadEnds.push(path)
    positions.set(path, {
      inbound,
      outbound,
      inboundShare: totalIn === 0 ? 0 : Number((inbound / totalIn).toFixed(4)),
      inboundRank: nodes.length === 0 ? -1 : (rank.get(path) ?? 0),
      orphan,
      deadEnd,
      hops: hops[path] ?? -1,
      inboundPaths: (inboundPaths[path] ?? []).slice(0, MAX_PATH_LIST),
      outboundPaths: (byPath.get(path)?.internalLinkTargets ?? []).filter((to) => to !== path).slice(0, MAX_PATH_LIST),
    })
  }

  const maxInDegree = Math.max(0, ...Object.values(inDegree))
  const graph: LinkGraph = {
    pages: nodes.length,
    edges,
    inDegree,
    outDegree,
    orphans,
    deadEnds,
    avgInDegree: nodes.length === 0 ? 0 : Number((totalIn / nodes.length).toFixed(2)),
    maxInDegree,
    reachableFromHome: Object.keys(hops).length,
    inboundCoverage: discovered === 0 ? 1 : Number(Math.min(1, nodes.length / discovered).toFixed(3)),
  }

  return { graph, positions }
}

/** Stamp the graph position onto every page. Mutates and returns the pages. */
export function applyLinkGraph(
  pages: PageEvidence[],
  discovered = pages.length,
): { graph: LinkGraph; pages: PageEvidence[] } {
  const { graph, positions } = buildLinkGraph(pages, discovered)
  for (const page of pages) {
    const position = positions.get(page.path)
    page.position = position ?? emptyPosition()
  }
  return { graph, pages }
}

export interface CrawlResult {
  root: URL
  pages: PageEvidence[]
  graph: LinkGraph
  robots: RobotsInfo
  sitemap: SitemapUrls
  discovered: number
  errors: string[]
  /** Retries spent on 429/5xx/network faults. Zero means a clean run. */
  retries: number
}

/**
 * Breadth-first crawl bounded by page count, depth and a wall-clock budget.
 * Sitemap URLs seed the queue when one exists, otherwise the homepage's
 * internal links do.
 */
export async function crawl(
  input: string,
  opts: {
    maxPages: number
    maxDepth: number
    budgetMs?: number
    /** Called as each page lands, so a crawl can be watched rather than awaited. */
    onPage?: (page: PageEvidence, done: number, target: number) => void
    /** Requests kept in flight. Sequential is the old default; 8 is a sane floor. */
    concurrency?: number
    /** Called before each backoff sleep, so a retrying crawl is visible. */
    onRetry?: (url: string, reason: string, attempt: number, waitMs: number) => void
    onError?: (url: string, message: string) => void
  },
): Promise<CrawlResult> {
  const root = assertPublicUrl(input)
  const deadline = Date.now() + (opts.budgetMs ?? 60_000)
  const errors: string[] = []

  const robots = await readRobots(root)
  const sitemap = robots.sitemap.length > 0
    ? await readSitemaps(robots.sitemap, opts.maxPages * 2)
    : { urls: [], truncated: false }

  const queue: Array<{ url: string; depth: number }> = [
    { url: root.toString(), depth: 0 },
  ]
  const seen = new Set<string>([root.toString()])
  const pages: PageEvidence[] = []
  let discovered = 0

  // A streaming worker pool: `concurrency` requests stay in flight and the next
  // URL is pulled the moment one finishes. A batch-per-level loop instead waits
  // for the slowest page in each level, which on a site with one 8-second page
  // costs 8 seconds per level for no reason.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 12))
  let cursor = 0
  let retries = 0

  const noteRetry = (url: string, reason: string, attempt: number, waitMs: number): void => {
    retries += 1
    opts.onRetry?.(url, reason, attempt, waitMs)
  }

  const takeNext = (): { url: string; depth: number } | null => {
    while (cursor < queue.length) {
      const candidate = queue[cursor++]
      if (!candidate) return null
      if (!isBlocked(new URL(candidate.url).pathname, robots)) return candidate
    }
    return null
  }

  const handle = async (next: { url: string; depth: number }): Promise<void> => {
    const outcome = await fetchPage(next.url, deadline, noteRetry)
    if (!outcome.response) {
      const message = outcome.retries > 0
        ? `${outcome.error} (after ${outcome.attempts} attempts, ${outcome.retries} retried)`
        : outcome.error ?? "fetch failed"
      errors.push(`${next.url}: ${message}`)
      opts.onError?.(next.url, message)
      return
    }
    const response = outcome.response
    try {
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.includes("html")) return
      const html = await response.text()
      const page = extractPage(next.url, root, html, response.status, next.depth)
      pages.push(page)
      opts.onPage?.(page, pages.length, opts.maxPages)

      if (next.depth >= opts.maxDepth) return
      const linkTargets = new Set<string>()
      const $ = cheerio.load(html)
      for (const el of $("a[href]").toArray()) {
        const href = $(el).attr("href")
        if (!href) continue
        try {
          const target = new URL(href, next.url)
          if (!hostMatches(target, root)) continue
          target.hash = ""
          const key = target.toString()
          if (seen.has(key)) continue
          if (isBlocked(target.pathname, robots)) continue
          linkTargets.add(key)
        } catch {
          /* ignore */
        }
      }
      discovered += linkTargets.size
      for (const key of linkTargets) {
        if (seen.size >= opts.maxPages * 12) break
        seen.add(key)
        queue.push({ url: key, depth: next.depth + 1 })
      }
    } catch (error) {
      const message = (error as Error).message
      errors.push(`${next.url}: ${message}`)
      opts.onError?.(next.url, message)
    }
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline || pages.length >= opts.maxPages) return
      const next = takeNext()
      if (!next) return
      await handle(next)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  if (pages.length < opts.maxPages) {
    for (const candidate of sitemap.urls) {
      if (pages.length >= opts.maxPages) break
      if (Date.now() >= deadline) break
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const outcome = await fetchPage(candidate, deadline, noteRetry)
      if (!outcome.response) {
        errors.push(`${candidate}: ${outcome.error ?? "fetch failed"}`)
        continue
      }
      const response = outcome.response
      if (!response.ok) continue
      if (!(response.headers.get("content-type") ?? "").includes("html")) continue
      const page = extractPage(candidate, root, await response.text(), response.status, 1)
      pages.push(page)
      opts.onPage?.(page, pages.length, opts.maxPages)
    }
  }

  // Second pass: a page cannot know its inbound degree until every page is in.
  const { graph, pages: stamped } = applyLinkGraph(pages, Math.max(discovered, pages.length))

  return { root, pages: stamped, graph, robots, sitemap, discovered, errors, retries }
}
