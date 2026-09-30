/**
 * Run history, and what changed between two runs of the same root.
 *
 * A single audit is a snapshot, and a snapshot cannot answer the only question a
 * returning customer asks: *did anything I did last week land?* So the last N
 * runs are kept per root and compared page by page.
 *
 * The contract this file implements, and the reason it is per page rather than a
 * score difference:
 *
 * - **`reachable` is the only basis for a comparison.** A page is reachable in a
 *   run when the crawler fetched it AND it was judged. `decisions[]` is NOT
 *   reachability evidence — a page can be reachable and raise nothing, which is
 *   what `notDecided[]` records. So a page that is merely absent from
 *   `decisions[]` is not evidence it was never looked at, and this file never
 *   treats it as such.
 * - **A page we could not see is never a good result.** Anything the two runs
 *   are not both able to speak about is `not_comparable`, never a closed state.
 *   This is the rule that stops a deeper or shallower crawl from manufacturing
 *   progress, in either direction.
 * - **A score delta is reported but never acted on.** Raw defect count falls as
 *   a site gets bigger, so a score comparison across two differently-sized
 *   crawls is arithmetic, not a finding. It is carried for context only.
 * - **No page text is stored.** Snapshots hold the counted facts and the
 *   decision. Ten runs of a 40-page site would otherwise leave a full copy of
 *   the customer's site on disk, and history is a convenience that has no
 *   business keeping that.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { historyPath } from "./paths.js"

/** Runs kept per root. Bounded because nothing here is a log archive. */
export const HISTORY_LIMIT = 10

/**
 * The panel words, deliberately not the internal band names. `act` / `review` /
 * `escalate` are threshold vocabulary; these are what a customer reads, and the
 * ordering below is the whole point of the mapping.
 */
export type PageBandWord = "decisive" | "to verify" | "needs a human"

/** Higher is worse. A rise in this number is a movement against the user. */
const BAND_RANK: Record<PageBandWord, number> = {
  decisive: 0,
  "to verify": 1,
  "needs a human": 2,
}

/**
 * The six outcomes. Five are columns; `not_comparable` is a column of its own
 * because a delta nobody can trust needs to be visible, and `clean` is the
 * absence of any of them and is counted rather than listed.
 */
export type DeltaState =
  | "still_open"
  | "changed"
  | "not_longer_raised"
  | "regressed"
  | "newly_raised"
  | "not_comparable"
  | "clean"

export interface HistoryPage {
  path: string
  url: string
  /** Crawled AND judged this run. The only basis for a comparison. */
  reachable: boolean
  /** The run produced a decisive top change, or an act-band finding. */
  raised: boolean
  /** `TopChange.key`, so "the same change" is decidable and not a string match. */
  topChangeKey: string | null
  /** The instruction, for display. Never compared. */
  topChange: string | null
  band: PageBandWord | null
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
  /** Reachable in both runs. False wherever the state is `not_comparable`. */
  comparable: boolean
  raisedNow: boolean
  raisedBefore: boolean
  topChangeKey: string | null
  topChange: string | null
  bandNow: PageBandWord | null
  bandBefore: PageBandWord | null
}

export interface RunDelta {
  /**
   * `null` is the first run for this root, not a degenerate case. It is
   * deliberately not a diff against itself, which would report every raised page
   * as `newly_raised` and imply progress the site has not made.
   */
  baseline: null | { generatedAt: string; score: number; openPages: number }
  /** Context only. Never a finding — see the file header. */
  scoreDelta: number | null
  stillOpen: PageDelta[]
  changed: PageDelta[]
  notLongerRaised: PageDelta[]
  regressed: PageDelta[]
  newlyRaised: PageDelta[]
  notComparable: PageDelta[]
  /** Reachable in both, raised in neither. Counted, never listed. */
  clean: number
  /** Reachable in both, reachable in neither, raised in neither. */
  unreachableBefore: number
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
 * Best-effort by design: history is a convenience, and an audit that produced a
 * complete report must not be reported as failed because a disk write missed.
 * The caller is told whether it persisted, so the report can say so instead of
 * implying a history exists when it does not.
 */
export function recordRun(run: HistoryRun): { stored: boolean; runs: number; error?: string } {
  const origin = originOf(run.root)
  const existing = loadHistory(origin)
  const kept = [run, ...existing].slice(0, HISTORY_LIMIT)
  try {
    writeFileSync(
      historyPath(origin),
      `${JSON.stringify({ root: origin, runs: kept }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
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
    // A missing file is the normal first run and a truncated one is a corrupt
    // one. Both answer the same way: no history, no crash, and no claim that a
    // previous run existed.
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
    stillOpen: [],
    changed: [],
    notLongerRaised: [],
    regressed: [],
    newlyRaised: [],
    notComparable: [],
    clean: 0,
    unreachableBefore: 0,
    pagesCrawledNow: 0,
    pagesCrawledBefore: 0,
  }
}

/**
 * The state machine, in the only order that cannot flatter anyone.
 *
 * The three gates come first because a comparison the two runs cannot both make
 * has to be refused before anything is claimed about it:
 *
 * 1. Raised now but never reachable before -> `newly_raised`. We had no view of
 *    it, so its appearance is new information, not a regression.
 * 2. Raised before but not reachable now -> `not_comparable`. It may well be
 *    fixed; we did not look, and "we did not look" is never a good result.
 * 3. Otherwise if either run could not see it -> counted, listed nowhere. No
 *    column claims it, because no column is asking a question about it.
 *
 * Then, over pages both runs could speak about:
 *
 * - raised now, not raised before -> `regressed`. It was reachable, it was
 *   judged, it raised nothing, and now it does. Work appeared.
 * - raised in both, band moved against the user -> `regressed` ahead of
 *   `changed`, because a decision that got less certain is the more actionable
 *   fact and must not be softened into "the change is different".
 * - raised in both, different `topChange.key` -> `changed`.
 * - raised in both, same key -> `still_open`.
 * - not raised now, was raised before -> `not_longer_raised`.
 */
export function diffRuns(current: HistoryRun, previous: HistoryRun | null): RunDelta {
  const delta = emptyDelta()
  delta.pagesCrawledNow = current.pages.length

  if (!previous) {
    for (const page of current.pages) {
      if (page.raised) delta.newlyRaised.push(row(page, null, "newly_raised", false))
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
      if (page.raised) delta.newlyRaised.push(row(page, null, "newly_raised", false))
      else delta.clean += 1
      continue
    }

    if (page.raised && !prior.reachable) {
      delta.newlyRaised.push(row(page, prior, "newly_raised", false))
      continue
    }
    if (prior.raised && !page.reachable) {
      delta.notComparable.push(row(page, prior, "not_comparable", false))
      continue
    }
    if (!page.reachable || !prior.reachable) {
      delta.unreachableBefore += 1
      continue
    }

    const comparable = true
    if (!page.raised) {
      if (prior.raised) delta.notLongerRaised.push(row(page, prior, "not_longer_raised", comparable))
      else delta.clean += 1
      continue
    }

    if (!prior.raised || bandWorsened(page.band, prior.band)) {
      delta.regressed.push(row(page, prior, "regressed", comparable))
      continue
    }
    if (page.topChangeKey !== prior.topChangeKey) {
      delta.changed.push(row(page, prior, "changed", comparable))
      continue
    }
    delta.stillOpen.push(row(page, prior, "still_open", comparable))
  }

  // Carried work on a page this run did not crawl. Never `not_longer_raised`:
  // the user closed nothing, and reporting it as closed is the most flattering
  // lie available here.
  for (const [path, prior] of before) {
    if (seen.has(path)) continue
    if (!prior.raised) {
      delta.unreachableBefore += 1
      continue
    }
    delta.notComparable.push({
      path,
      url: prior.url,
      state: "not_comparable",
      comparable: false,
      raisedNow: false,
      raisedBefore: true,
      topChangeKey: null,
      topChange: null,
      bandNow: null,
      bandBefore: prior.band,
    })
  }

  return delta
}

function bandWorsened(now: PageBandWord | null, before: PageBandWord | null): boolean {
  if (!now || !before) return false
  return BAND_RANK[now] > BAND_RANK[before]
}

function row(
  page: HistoryPage,
  prior: HistoryPage | null,
  state: DeltaState,
  comparable: boolean,
): PageDelta {
  return {
    path: page.path,
    url: page.url,
    state,
    comparable,
    raisedNow: page.raised,
    raisedBefore: prior?.raised ?? false,
    topChangeKey: page.topChangeKey,
    topChange: page.topChange,
    bandNow: page.band,
    bandBefore: prior?.band ?? null,
  }
}
