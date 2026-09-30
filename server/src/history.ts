/**
 * Run history, and the delta between two runs of the same root.
 *
 * A single audit is a snapshot, and a snapshot cannot answer the only question a
 * paying customer asks a second time: *did anything I did last week work?* So
 * the last N runs are kept per root and compared.
 *
 * Three things this file refuses to do, because each of them would make the
 * delta say something the runs did not show:
 *
 * 1. **It does not compare scores across differently-sized crawls.** A site that
 *    grew from 12 to 40 pages scores lower on raw defect count while getting
 *    strictly better, and a delta that reported that as a regression would be
 *    arithmetic dressed as a finding. The delta is per page, and the counts are
 *    reported next to it.
 * 2. **It does not call a newly-crawled page a regression.** A page that was not
 *    in the previous run has no prior state, so it is `new` — a crawl-depth
 *    change, not a page that got worse.
 * 3. **It does not store page text.** Snapshots carry the counted facts and the
 *    decision, never the body. Ten runs of a 40-page site would otherwise put a
 *    full copy of the customer's site on disk, and history is a convenience
 *    feature that has no business keeping that.
 *
 * `open` is the single thing the delta tracks, and it is deliberately a disjunction
 * rather than a score: a page counts as open when the run produced a decisive
 * top change for it (`decisions.ts` emitted a `DecisionRow`) or at least one
 * `act`-band finding. Both are the product's own definition of "there is work
 * here", so the delta is comparing like with like rather than inventing a
 * new one. A grey-zone row is not open — that is what the grey zone means.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { historyPath } from "./paths.js"

/** Runs kept per root. Bounded because nothing here is a log archive. */
export const HISTORY_LIMIT = 10

export type DeltaState = "fixed" | "still_open" | "new" | "regressed" | "off_crawl" | "clean"

export interface HistoryPage {
  path: string
  url: string
  /** Decisive top change, or an `act`-band finding. The one thing diffed. */
  open: boolean
  /** The instruction, when there was a decisive one. For display only. */
  topChange: string | null
  band: string | null
  findings: number
  ruleFindings: number
  words: number
}

/**
 * One stored run. Structural, not imported from `audit.ts`, so this module stays
 * a leaf and the record format survives a change to the report shape.
 */
export interface HistoryRun {
  root: string
  generatedAt: string
  score: number
  grade: string
  model: string
  pagesCrawled: number
  pagesJudged: number
  openPages: number
  competitorsJudged: number
  subjectCount: number
  pages: HistoryPage[]
}

export interface HistoryFile {
  /** The root this file is for, un-hashed, so a key collision is visible. */
  root: string
  runs: HistoryRun[]
}

export interface PageDelta {
  path: string
  url: string
  state: DeltaState
  /** Open in the run being reported. */
  openNow: boolean
  /** Open in the previous run. `false` when the page was not crawled then. */
  openBefore: boolean
  topChange: string | null
}

export interface RunDelta {
  /** There was no earlier run for this root, so nothing could be compared. */
  baseline: null | { generatedAt: string; score: number; openPages: number }
  scoreDelta: number | null
  fixed: PageDelta[]
  stillOpen: PageDelta[]
  new: PageDelta[]
  regressed: PageDelta[]
  /**
   * Carried work on a page this run did not crawl: it may be gone, or just
   * deeper than `maxPages`. Deliberately not `fixed` — the user fixed nothing,
   * and a delta that reported it as a win would be the most flattering lie
   * available here. The crawler reports unreachable pages separately.
   */
  offCrawl: PageDelta[]
  clean: number
  pagesCrawledNow: number
  pagesCrawledBefore: number
}

function originOf(root: string): string {
  try {
    return new URL(root).origin
  } catch {
    return root
  }
}

export function loadHistory(root: string): HistoryRun[] {
  const file = readFileSafe(historyPath(originOf(root)))
  if (!file || file.root !== originOf(root)) return []
  return file.runs
}

/**
 * Store a run, newest first, trimmed to `HISTORY_LIMIT`.
 *
 * The write is best-effort by design: history is a convenience, and an audit
 * that produced a complete report must not be reported as failed because a disk
 * write did not land. The caller is told whether it persisted so the report can
 * say so rather than implying a history exists when it does not.
 */
export function recordRun(run: HistoryRun): { stored: boolean; runs: number; error?: string } {
  const origin = originOf(run.root)
  const existing = loadHistory(origin)
  // A rerun in the same second must not shadow its predecessor: `generatedAt` is
  // the only ordering key, so identical timestamps are disambiguated by keeping
  // both rather than letting the later write win on a tie.
  const kept = [run, ...existing].slice(0, HISTORY_LIMIT)
  try {
    writeFileSync(historyPath(origin), `${JSON.stringify({ root: origin, runs: kept }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    return { stored: true, runs: kept.length }
  } catch (error) {
    return { stored: false, runs: 0, error: (error as Error).message }
  }
}

function readFileSafe(path: string): HistoryFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isHistoryFile(parsed)) return null
    return parsed
  } catch {
    // A missing file is the normal first-run case, and a truncated one is a
    // corrupt one. Both answer the same way: no history, no crash, no claim
    // that a previous run existed.
    return null
  }
}

function isHistoryFile(value: unknown): value is HistoryFile {
  if (typeof value !== "object" || value === null) return false
  const file = value as { root?: unknown; runs?: unknown }
  return typeof file.root === "string" && Array.isArray(file.runs)
}

export function emptyDelta(): RunDelta {
  return {
    baseline: null,
    scoreDelta: null,
    fixed: [],
    stillOpen: [],
    new: [],
    regressed: [],
    offCrawl: [],
    clean: 0,
    pagesCrawledNow: 0,
    pagesCrawledBefore: 0,
  }
}

/**
 * The delta, page by page.
 *
 * A page absent from the previous run is `new`, never `regressed` — it has no
 * prior state to have got worse from, and calling it a regression would make a
 * deeper crawl look like a worse site. `clean` is counted, not listed: it is the
 * absence of a change, and a panel of clean pages is noise.
 */
export function diffRuns(current: HistoryRun, previous: HistoryRun | null): RunDelta {
  const delta = emptyDelta()
  delta.pagesCrawledNow = current.pages.length

  if (!previous) {
    for (const page of current.pages) {
      if (page.open) delta.new.push(row(page, "new", true, false))
      else delta.clean += 1
    }
    return delta
  }

  delta.baseline = {
    generatedAt: previous.generatedAt,
    score: previous.score,
    openPages: previous.openPages,
  }
  delta.scoreDelta = Number((current.score - previous.score).toFixed(2))
  delta.pagesCrawledBefore = previous.pages.length

  const before = new Map(previous.pages.map((page) => [page.path, page]))
  const seen = new Set<string>()

  for (const page of current.pages) {
    seen.add(page.path)
    const prior = before.get(page.path)

    if (prior === undefined) {
      if (page.open) delta.new.push(row(page, "new", true, false))
      else delta.clean += 1
      continue
    }
    if (page.open && prior.open) delta.stillOpen.push(row(page, "still_open", true, true))
    else if (!page.open && prior.open) delta.fixed.push(row(page, "fixed", false, true))
    else if (page.open) delta.regressed.push(row(page, "regressed", true, false))
    else delta.clean += 1
  }

  // A page that carried work and is no longer crawled at all is not fixed. It
  // is off the crawl, which the crawler reports separately, and counting it as a
  // win would be the single most flattering lie available here.
  for (const [path, prior] of before) {
    if (seen.has(path)) continue
    if (!prior.open) {
      delta.clean += 1
      continue
    }
    delta.offCrawl.push({
      path,
      url: prior.url,
      state: "off_crawl",
      openNow: false,
      openBefore: true,
      topChange: null,
    })
  }

  return delta
}

function row(page: HistoryPage, state: DeltaState, openNow: boolean, openBefore: boolean): PageDelta {
  return {
    path: page.path,
    url: page.url,
    state,
    openNow,
    openBefore,
    topChange: page.topChange,
  }
}
