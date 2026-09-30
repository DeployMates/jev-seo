/**
 * Deterministic rule checks. These are the 30% of every score that is not a
 * model judgement: facts code can count, so the model is never asked for them.
 */
import type { PageEvidence } from "./crawl.js"

export type Severity = "critical" | "serious" | "moderate" | "minor"

export interface RuleFinding {
  id: string
  title: string
  detail: string
  severity: Severity
  pages: string[]
  fix: string
  source: "rule"
}

const MAX_PAGES_IN_FINDING = 12

function pagesLabel(paths: string[]): string {
  if (paths.length === 0) return "site-wide"
  if (paths.length <= 3) return paths.join(", ")
  return `${paths.slice(0, MAX_PAGES_IN_FINDING).join(", ")} +${paths.length - MAX_PAGES_IN_FINDING} more`
}

/** Run every deterministic check over the crawled evidence. */
export function runRules(pages: PageEvidence[], origin: string): RuleFinding[] {
  const findings: RuleFinding[] = []
  const add = (
    id: string,
    title: string,
    detail: string,
    severity: Severity,
    affected: string[],
    fix: string,
  ) => {
    if (affected.length === 0) return
    findings.push({ id, title, detail, severity, pages: affected.slice(0, MAX_PAGES_IN_FINDING), fix, source: "rule" })
  }

  const paths = pages.map((p) => p.path)
  const home = pages.find((p) => p.path === "/") ?? pages[0]

  add("https", "Site is not served over HTTPS", "Browsers mark the site as not secure, and Google treats it as a trust signal.", "critical", home && !home.hasHttps ? ["/"] : [], "Serve the whole site over HTTPS and redirect every HTTP URL.")

  add("viewport", "No mobile viewport declared", "Without a viewport meta tag the site renders at desktop width on phones.", "serious", pages.filter((p) => !p.hasViewport).map((p) => p.path), "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to every template.")

  add("noindex", "Pages blocked from search engines", "A noindex directive keeps these pages out of search results entirely.", "critical", pages.filter((p) => p.noindex).map((p) => p.path), "Remove the noindex where the page is meant to rank, and check it is not set site-wide by accident.")

  add("missing-title", "Pages with no title", "A search result with no title cannot be clicked intelligently and wastes the most valuable on-page space.", "serious", pages.filter((p) => !p.title).map((p) => p.path), "Give every indexable page a unique, descriptive <title>.")

  add("missing-h1", "Pages with no H1", "The H1 is the page's main label for both readers and machines.", "moderate", pages.filter((p) => !p.h1).map((p) => p.path), "Add exactly one H1 naming what the page is about.")

  add("missing-description", "Pages with no meta description", "Search engines will invent a snippet, and the invented one rarely sells the click.", "moderate", pages.filter((p) => !p.description).map((p) => p.path), "Write a 140 to 160 character description of what the page delivers.")

  add("thin-content", "Thin pages", "Under 200 words of body text rarely answers a search need on its own.", "moderate", pages.filter((p) => p.words > 0 && p.words < 200).map((p) => p.path), "Expand the page with specifics a visitor came for, or fold it into a stronger page.")

  add("empty-content", "Pages with almost no text", "No usable body text was extracted from these pages.", "serious", pages.filter((p) => p.words < 40).map((p) => p.path), "Check whether the page renders client-side only, or is effectively empty.")

  add("alt-missing", "Images without alt text", "Alt text is the accessibility contract and the only textual signal an image gives a crawler.", "minor", pages.filter((p) => p.imagesMissingAlt > 0).map((p) => p.path), "Write descriptive alt text, or an empty alt for purely decorative images.")

  add("no-schema", "No structured data anywhere on the site", "Structured data is how a machine learns what the organisation is.", "moderate", pages.some((p) => p.hasSchemaOrg) ? [] : paths, "Add Organization, WebSite and relevant per-page JSON-LD.")

  add("orphan-candidates", "Pages unreachable from the homepage's links", "These came from the sitemap but nothing on the crawled pages links to them.", "minor", [], "Link to them from a relevant hub page.")

  add("dupe-titles", "Duplicate page titles", "Two pages competing for the same title split the signal for both.", "serious", [], "Give each page a distinct title reflecting its own intent.")

  add("long-titles", "Titles too long to display", "Titles beyond roughly 60 characters get truncated in results.", "minor", pages.filter((p) => p.title.length > 60).map((p) => p.path), "Front-load the distinctive words and keep the title under 60 characters.")

  add("long-descriptions", "Meta descriptions too long to display", "Descriptions beyond roughly 160 characters get cut off in results.", "minor", pages.filter((p) => p.description.length > 160).map((p) => p.path), "Trim to under 160 characters and lead with the specific benefit.")

  add("no-lang", "No language declared", "Without lang on <html>, assistive technology guesses the pronunciation rules.", "minor", pages.filter((p) => !p.lang).map((p) => p.path), "Set the correct lang attribute on the html element.")

  add("no-canonical", "No canonical URL", "Duplicate URLs can split ranking signals across near-identical pages.", "minor", pages.filter((p) => !p.canonical && p.path !== "/").map((p) => p.path), "Add a self-referencing canonical to every indexable page.")

  if (findings.some((f) => f.id === "dupe-titles")) {
    // filled in below with real duplicates
  }

  // Duplicate titles: count, do not guess.
  const byTitle = new Map<string, string[]>()
  for (const page of pages) {
    if (!page.title) continue
    const key = page.title.trim().toLowerCase()
    byTitle.set(key, [...(byTitle.get(key) ?? []), page.path])
  }
  const dupeTitles = [...byTitle.entries()].filter(([, paths_]) => paths_.length > 1)
  if (dupeTitles.length > 0) {
    const affected = dupeTitles.flatMap(([, p]) => p)
    add("dupe-titles", "Duplicate page titles", `Found ${dupeTitles.length} titles used on more than one page: ${pagesLabel(affected)}`, "serious", affected, "Give each page a distinct title reflecting its own intent.")
  }

  return findings
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

export function ruleStats(pages: PageEvidence[]): RuleStats {
  const n = pages.length || 1
  return {
    pages: pages.length,
    avgWords: Math.round(pages.reduce((sum, p) => sum + p.words, 0) / n),
    withSchema: pages.filter((p) => p.hasSchemaOrg).length,
    withDescription: pages.filter((p) => p.description.length > 0).length,
    withH1: pages.filter((p) => p.h1.length > 0).length,
    https: pages.some((p) => p.hasHttps),
    titleLengthOk: pages.filter((p) => p.title.length > 0 && p.title.length <= 60).length,
    descriptionLengthOk: pages.filter((p) => p.description.length > 0 && p.description.length <= 160).length,
  }
}
