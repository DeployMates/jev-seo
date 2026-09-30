/**
 * The crawl, restated for the research agent.
 *
 * The agent prompt already promises the model that this block is already
 * established and needs no source. That promise is only honest if something
 * actually fills it, so the server runs the deterministic crawler first and
 * hands the result over rather than trusting the browser to summarise a crawl
 * it never performed.
 *
 * This is deliberately the crawler's own fields, not a judgement. The agent
 * researches what the crawler cannot see; anything the crawler counted is
 * already true and re-deriving it spends the run and weakens provenance.
 */
import { crawl, readRobots, type CrawlResult } from "./crawl.js"
import { ruleStats } from "./checks.js"
import { extractKeywords } from "./keywords.js"

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function pageLine(page: CrawlResult["pages"][number]): string {
  const bits = [
    `path=${page.path || "/"}`,
    `status=${page.status}`,
    `words=${page.words}`,
    `title=${clip(page.title, 90) || "(none)"}`,
    `h1=${clip(page.headings[0] ?? "", 70) || "(none)"}`,
    `description=${clip(page.description, 110) || "(none)"}`,
    `internal_links=${page.internalLinks}`,
    `external_links=${page.externalLinks}`,
    `images=${page.images}`,
    `images_missing_alt=${page.imagesMissingAlt}`,
    `structured_data=${page.schemaTypes.length > 0 ? page.schemaTypes.slice(0, 4).join(",") : "none"}`,
    `noindex=${page.noindex ? "yes" : "no"}`,
    `lang=${page.lang || "(none)"}`,
  ]
  const opening = clip(page.opening, 220)
  if (opening) bits.push(`opening=${JSON.stringify(opening)}`)
  return `- ${bits.join(" | ")}`
}

export interface CrawlDigest {
  summary: string
  result: CrawlResult
}

/**
 * Crawl once and describe it. `maxPages` is deliberately small: this exists to
 * tell the agent what the site already contains, not to audit it. The audit
 * runs its own crawl with its own budget.
 */
export interface CrawlEvent {
  kind: "start" | "page" | "error" | "done"
  url?: string
  path?: string
  status?: number
  words?: number
  title?: string
  done?: number
  target?: number
  message?: string
  pages?: number
}

export async function crawlForResearch(
  url: string,
  maxPages = 12,
  budgetMs = 30_000,
  onEvent?: (event: CrawlEvent) => void,
): Promise<CrawlDigest> {
  const result = await crawl(url, {
    maxPages,
    maxDepth: 2,
    budgetMs,
    concurrency: 8,
    onPage: (page, done, target) =>
      onEvent?.({
        kind: "page",
        url: page.url,
        path: page.path || "/",
        status: page.status,
        words: page.words,
        title: page.title,
        done,
        target,
      }),
    onError: (u, message) => onEvent?.({ kind: "error", url: u, message }),
  })
  onEvent?.({ kind: "done", pages: result.pages.length })

  const stats = ruleStats(result.pages)
  const seeds = extractKeywords(result.pages, 25)
  const robots = await readRobots(result.root)

  const lines: string[] = [
    `The deterministic crawler fetched ${result.pages.length} page(s) from ${result.root.host} in ${result.discovered} internal link(s) discovered.`,
  ]

  if (result.errors.length > 0) {
    lines.push(`Crawl errors (${result.errors.length}): ${result.errors.slice(0, 3).join(" ; ")}`)
  }
  if (robots.fetched) {
    lines.push(
      `robots.txt was fetched. ${
        robots.blockedPaths.length > 0
          ? `Disallowed paths: ${robots.blockedPaths.slice(0, 5).join(", ")}.`
          : "Nothing is disallowed for a wildcard agent."
      }`,
    )
  }

  lines.push("", "Pages, field by field:")
  for (const page of result.pages) lines.push(pageLine(page))

  lines.push(
    "",
    `Counts the checker already produced, per page averaged where relevant: ${stats.pages} page(s), ` +
      `${Math.round(stats.avgWords)} words/page, ${stats.withH1} with an H1, ` +
      `${stats.withDescription} with a meta description, ${stats.withSchema} with structured data, ` +
      `${stats.titleLengthOk}/${stats.pages} titles at a sane length, ` +
      `${stats.descriptionLengthOk}/${stats.pages} descriptions at a sane length, https=${stats.https}.`,
  )

  if (seeds.length > 0) {
    lines.push(
      "",
      "Terms mined from the site's own titles, headings and body. They are candidates a person typed-shaped, NOT validated queries — the agent's job is to decide which are real demand, and to add rivals' vocabulary the crawl of one site cannot supply:",
    )
    for (const seed of seeds) {
      lines.push(`- ${seed.term} (pages ${seed.pages.length}, in headings ${seed.inHeadings}, question-shaped ${seed.questionForm})`)
    }
  }

  return { summary: lines.join("\n"), result }
}
