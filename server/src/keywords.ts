/**
 * Keyword candidates, extracted in code.
 *
 * Jev has no index, no volume data and no backlink graph, so nothing here may
 * pretend to be a search volume. What code *can* do honestly is say how often a
 * term appears on the site, in which structural slots it appears, and how many
 * pages carry it. Those are the real inputs to opportunity; everything semantic
 * (is it a real query, is a buyer typing it, which cluster, does a page serve
 * it, how contested is it) is a Jev question.
 *
 * The demand-shaped flags below — questionForm, comparisonForm,
 * commercialForm — are the code-side half of the keyword demand signal. They
 * say what the WORDING of a mined phrase looks like, which is observable, and
 * they are deliberately not a stand-in for volume: a phrase can be perfectly
 * query-shaped and have no demand behind it, and only Jev can say which.
 */
import type { PageEvidence } from "./crawl.js"

/**
 * Words that carry no query meaning: grammar, pronouns, and the boilerplate
 * that every site repeats. Dropping these is what turns prose into phrases.
 *
 * The second group was added after a live run mined "ready to", "to declutter"
 * and "up log insell" from vinted.com — bigrams built entirely out of a
 * preposition and a navigation verb. A word in this set can never appear in any
 * candidate, so it is a recall cost as well as a precision win, which is why the
 * additions are restricted to words that cannot carry a search on their own and
 * that are absent from `QUERY_MARKERS`. Every word there ("how", "best", "price",
 * "vs") is deliberately kept: deleting an interrogative or a commercial word
 * turns a real query into a phrase nobody types.
 */
const NOISE = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "was", "were", "you",
  "your", "our", "their", "they", "will", "not", "but", "all", "into", "about", "over", "than",
  "then", "them", "these", "those", "such", "its", "it's", "his", "her", "she", "him", "out", "off",
  "own", "same", "too", "very", "just", "also", "any", "each", "few", "more", "most", "other",
  "some", "only", "now", "here", "get", "learn", "read", "see", "use", "used", "one", "two",
  "page", "site", "website", "home", "click", "new", "via", "www", "http", "https", "com", "html",
  "amp", "nbsp",
  // Bare function words. No query is *about* any of these on its own, but each
  // one survives into an n-gram and drags a neighbouring content word out with
  // it: "ready to" and "to declutter" are the same defect seen twice.
  //
  // "are", "can", "need" and "want" are deliberately ABSENT. They are also in
  // `QUERY_MARKERS`, and a word in both sets is stripped during tokenisation
  // before `hasMarker` ever runs — so listing them here would silently delete
  // the interrogative that makes "can I claim" a question at all. `are` and
  // `can` were in this set before that was noticed; `need` and `want` arrived
  // with this batch. A word may be in NOISE or in QUERY_MARKERS, never both.
  "to", "at", "by", "as", "up", "down", "us", "me", "my", "we", "it", "be", "am", "or", "if",
  "so", "an", "nor", "yet", "once", "again", "must", "may", "might", "shall", "let", "lets",
  "much", "many", "like",
])

/**
 * Words that mark a phrase as something a person TYPES rather than something
 * a writer happens to have said. They used to sit in the stopword list, which
 * was wrong in both directions: it deleted the interrogatives that make a
 * phrase a question ("how much does X cost" became "much does X cost"), and it
 * deleted the comparison and price words that make a phrase commercial
 * ("best", "vs", "price"). Filtering these out is what produces n-grams that
 * no one would ever search for, and it is why the mined pool needed a
 * real-query guard in the first place. They are kept, and used as signal.
 */
const QUERY_MARKERS = new Set([
  "how", "what", "when", "where", "who", "why", "which", "does", "do", "is", "are", "should",
  "can", "need", "want", "near", "vs", "versus", "best", "top", "cheap", "cheapest", "free",
  "price", "cost", "review", "reviews", "alternative", "alternatives", "compare",
])

/** Words that name a comparison, which is the strongest commercial signal. */
const COMPARISON_MARKERS = new Set([
  "best", "vs", "versus", "compare", "alternative", "alternatives", "top", "cheapest",
])

/** Words that name a decision, which is the buyer signal in the wording. */
const COMMERCIAL_MARKERS = new Set([
  "price", "cost", "cheap", "cheapest", "free", "quote", "buy", "hire", "book", "order",
  "near", "review", "reviews", "discount", "plan", "plans", "pricing",
])

export interface KeywordCandidate {
  term: string
  words: number
  /** Pages whose text contains the term. */
  pages: string[]
  /** Raw frequency across the crawl. */
  frequency: number
  /** Appears in an H1, H2 or H3. */
  inHeadings: number
  /** Appears in a page title. */
  inTitle: number
  /** The phrase is phrased as a question. */
  questionForm: boolean
  /** The phrase implies a choice between things. */
  comparisonForm: boolean
  /** The phrase names a buying or pricing decision. */
  commercialForm: boolean
  /**
   * At least one word in the phrase is a proper name rather than a common
   * subject word: it appears in a page title or H1, and it is rare across the
   * corpus. That is the observable half of the `term_ownership` and
   * `long_tail_specific` questions, and it is derived from the crawl rather
   * than from a fixed vocabulary — a hardcoded list of brand names would
   * generalise to exactly one site.
   */
  namedEntityForm: boolean
  /**
   * The phrase is a head term: every word in it also appears in other places
   * across the site, so nothing narrows the subject and everyone in the field
   * competes for the same phrase. The structural counterpart of
   * `long_tail_specific` answering "no".
   */
  broadForm: boolean
  /** Code-side weight, used only to order the candidate pool. */
  weight: number
}

function normalise(term: string): string {
  return term.toLowerCase().replace(/\s+/g, " ").trim()
}

function tokenise(text: string): string[] {
  return normalise(text)
    .split(/[^a-z0-9\s'-]+/)
    .flatMap((chunk) => chunk.split(/\s+/))
    .filter((token) => token.length > 1 && !NOISE.has(token) && !/^\d+$/.test(token))
}

function hasMarker(term: string, markers: Set<string>): boolean {
  return term.split(" ").some((word) => markers.has(word))
}

/** Bigrams and trigrams only: single words are almost never a search intent. */
function ngrams(tokens: string[], maxWords: number): string[] {
  const out: string[] = []
  for (let n = 2; n <= maxWords; n += 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      out.push(tokens.slice(i, i + n).join(" "))
    }
  }
  return out
}

/**
 * Links-over-(words+links) above which a page reads as navigation rather than
 * prose. The crawler already computes `linkDensity` for exactly this and the
 * miner was ignoring it.
 *
 * A stopword list cannot do this job. "help center" is a nav label on one site
 * and the subject of a whole page on another, so deleting the words either
 * throws away a real query or leaves the chrome in. Link density separates them
 * structurally: a page that is mostly links is mostly menu, whatever it calls
 * itself.
 *
 * Calibrated on measured page densities rather than guessed: a prose page with
 * six links in 84 words sits at 0.067, a page with no links at 0, and a nav
 * block of sixteen links in 33 words at 0.327. The threshold sits between the
 * prose end and the nav end, closer to the prose end, because the cost of being
 * wrong is asymmetric — a wrongly trusted nav page costs one junk term, while a
 * wrongly distrusted content page loses a real query forever. A link-rich blog
 * index (thirty links in two hundred words, about 0.13) stays well clear of it,
 * and its titles are trusted regardless.
 */
const CHROME_LINK_DENSITY = 0.25

/**
 * Build the candidate pool from every page's title, headings and body.
 *
 * A term survives if it appears in a heading, or on more than one page, or
 * often in body prose — OR if its wording is shaped like something a person
 * types. That last clause is the one that matters: a pricing question usually
 * appears exactly once, on the one page that answers it, so a frequency test
 * alone throws away the most commercial terms the site has.
 *
 * Nav chrome is excluded structurally rather than lexically. A title and an H1
 * are the page's own name and are trusted everywhere, including on a link-heavy
 * index page whose titles are the only real content it has. Everything below the
 * H1 — H2s and body prose — is trusted only on pages that read as prose. A term
 * that lives solely in the prose of nav-dense pages is then dropped, which is
 * what removes "sign log in" and "how works" without touching "help center" on a
 * site whose help page is genuinely about help.
 */
export function extractKeywords(pages: PageEvidence[], limit = 40): KeywordCandidate[] {
  const freq = new Map<string, number>()
  const byPage = new Map<string, Set<string>>()
  const headingHits = new Map<string, number>()
  const titleHits = new Map<string, number>()
  /** Pages carrying the term in prose, excluding nav-dense ones. */
  const proseHits = new Map<string, number>()

  /**
   * Per-word corpus statistics, used to tell a proper name from a common
   * subject word without a fixed vocabulary. `titleVocab` is the set of words
   * that appear in some page's title or H1 — a brand, a product or a place is
   * named at the top of a page, a common noun is not. `docFreq` is how many
   * pages contain each word, so a word that only ever appears in titles on one
   * page is a name, while a word on every page is part of the subject.
   */
  const titleVocab = new Set<string>()
  const docFreq = new Map<string, number>()

  const bump = (term: string) => freq.set(term, (freq.get(term) ?? 0) + 1)
  const addPage = (term: string, path: string) => {
    const set = byPage.get(term) ?? new Set<string>()
    set.add(path)
    byPage.set(term, set)
  }

  for (const page of pages) {
    for (const token of tokenise(`${page.title} ${page.h1}`)) titleVocab.add(token)
    for (const token of tokenise(page.text)) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
    }
  }

  /**
   * A word is treated as a proper name when it is named at the top of a page
   * and is not common vocabulary across the crawl. The document-frequency
   * ceiling is deliberately loose: a product named on four pages is still a
   * name, and the point is only to exclude the shared subject words that make
   * up the head of every term.
   */
  const isProperName = (word: string): boolean => {
    if (word.length < 3) return false
    if (/\d/.test(word)) return true
    if (!titleVocab.has(word)) return false
    return (docFreq.get(word) ?? 0) <= Math.max(3, pages.length * 0.25)
  }

  for (const page of pages) {
    const path = page.path
    const isChrome = page.linkDensity >= CHROME_LINK_DENSITY

    // Title is its own slot: it is the strongest on-page signal a term can
    // have, and conflating it with the H2s made every heading look like a
    // title. Trusted even on a link-heavy page, because a category index's
    // titles are the only real content it has.
    for (const term of new Set(ngrams(tokenise(page.title), 3))) {
      titleHits.set(term, (titleHits.get(term) ?? 0) + 1)
      bump(term)
      addPage(term, path)
    }

    // page.headings already contains the H1, so it is not added again here.
    // The H1 is page identity and is always trusted; the H2s below it are prose,
    // and on a nav-dense page they are menu items wearing heading tags.
    for (const heading of [page.h1, ...page.headings]) {
      if (!heading) continue
      const trusted = heading === page.h1 || !isChrome
      for (const term of new Set(ngrams(tokenise(heading), 3))) {
        if (trusted) headingHits.set(term, (headingHits.get(term) ?? 0) + 1)
        bump(term)
        addPage(term, path)
      }
    }

    if (isChrome) continue

    for (const term of ngrams(tokenise(page.proseText), 3)) {
      bump(term)
      addPage(term, path)
      proseHits.set(term, (proseHits.get(term) ?? 0) + 1)
    }
  }

  const candidates: KeywordCandidate[] = []
  for (const [term, count] of freq) {
    if (term.length < 6) continue
    const inHeadings = headingHits.get(term) ?? 0
    const inTitle = titleHits.get(term) ?? 0

    // No trusted evidence anywhere: the term was only ever seen in the prose or
    // the H2s of nav-dense pages, which is what a menu label looks like. This is
    // the whole point of the density filter — a term that a page names after
    // itself, or a heading on a real page, has already passed.
    if (inTitle === 0 && inHeadings === 0 && (proseHits.get(term) ?? 0) === 0) continue

    const pages_ = [...(byPage.get(term) ?? [])]

    const words = term.split(" ")
    const questionForm = hasMarker(term, QUERY_MARKERS)
    const comparisonForm = hasMarker(term, COMPARISON_MARKERS)
    const commercialForm = hasMarker(term, COMMERCIAL_MARKERS)
    const queryShaped = questionForm || comparisonForm || commercialForm
    const namedEntityForm = words.some(isProperName)
    // A head term is one where every word is shared vocabulary: no proper name
    // and no rare structural word, so nothing in the phrase narrows the
    // subject beyond the whole field.
    const broadForm = !namedEntityForm && !queryShaped && words.every((w) => !isProperName(w))

    // Must appear in a heading somewhere, or on at least two pages, or repeat,
    // or be phrased like a search rather than like a sentence. A phrase
    // carrying a proper name survives regardless: those are exactly the terms
    // a buyer types, and they are rare on a site that does not sell by name.
    if (
      inHeadings === 0 &&
      inTitle === 0 &&
      pages_.length < 2 &&
      count < 3 &&
      !queryShaped &&
      !namedEntityForm
    ) {
      continue
    }

    const weight =
      count +
      pages_.length * 2 +
      inHeadings * 4 +
      inTitle * 5 +
      (questionForm ? 3 : 0) +
      (comparisonForm ? 3 : 0) +
      (commercialForm ? 2 : 0) +
      (namedEntityForm ? 2 : 0) +
      words.length * 1.5

    candidates.push({
      term,
      words: words.length,
      pages: pages_,
      frequency: count,
      inHeadings,
      inTitle,
      questionForm,
      comparisonForm,
      commercialForm,
      namedEntityForm,
      broadForm,
      weight: Number(weight.toFixed(2)),
    })
  }

  return candidates.sort((a, b) => b.weight - a.weight).slice(0, limit)
}

/**
 * Cluster the candidate pool in code, by shared vocabulary, to keep states
 * small. The anchor is the leading noun: the modifier words are exactly what
 * should be dropped here, because the job of a cluster is to group by subject
 * rather than by phrasing.
 */
export function seedClusters(candidates: KeywordCandidate[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()

  for (const candidate of candidates) {
    const anchors = candidate.term
      .split(" ")
      .filter((word) => word.length > 3 && !QUERY_MARKERS.has(word))
    const key = anchors[0] ?? candidate.term
    groups.set(key, [...(groups.get(key) ?? []), candidate.term])
  }
  return groups
}
