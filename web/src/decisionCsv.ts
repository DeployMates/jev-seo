import type { DecisionRow, PageDelta, RunDelta } from "./types"

const BAND_WORD: Record<string, string> = {
  act: "decisive",
  review: "to verify",
  escalate: "needs a human",
}

const MOVE_WORD: Record<string, string> = {
  still_open: "still open",
  changed: "changed",
  not_longer_raised: "no longer raised",
  regressed: "regressed",
  newly_raised: "newly raised",
  not_comparable: "not comparable",
}

/**
 * RFC 4180 quoting, plus a leading-apostrophe guard so a spreadsheet does not
 * evaluate a cell beginning `=`, `+`, `-` or `@` as a formula. A value quoted
 * out of crawled page text is attacker-controlled and this file lands in Excel.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** path -> the state word, so a row lifted out of the file still says `regressed`. */
function moveColumn(delta: RunDelta | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!delta) return map
  const buckets: Array<[PageDelta[], string]> = [
    [delta.regressed, "regressed"],
    [delta.notLongerRaised, "not_longer_raised"],
    [delta.newlyRaised, "newly_raised"],
    [delta.changed, "changed"],
    [delta.stillOpen, "still_open"],
    [delta.notComparable, "not_comparable"],
  ]
  for (const [rows, state] of buckets) {
    for (const row of rows) map.set(row.path, MOVE_WORD[state] ?? state)
  }
  return map
}

/**
 * The decision rows as CSV, in the column order the copy fixes: path, the
 * change raised, its band, its probability, and how it moved.
 *
 * Every column is a probability the judge returned or a band computed in code.
 * Nothing here is predicted, and no column names a position, a visit count or
 * an outcome.
 */
export function decisionsToCsv(
  rows: DecisionRow[],
  meta: { site: string; generatedAt: string; model: string; delta: RunDelta | null },
): string {
  const moves = moveColumn(meta.delta)
  const since = meta.delta?.baseline ? meta.delta.baseline.generatedAt.slice(0, 10) : null

  const lines = ["path,change raised,band,probability," + (since ? `moved since ${since}` : "moved since")]
  for (const row of rows) {
    const top = row.topChange
    lines.push(
      [
        cell(row.path),
        cell(top.instruction),
        cell(BAND_WORD[top.band] ?? top.band),
        cell(top.p.toFixed(3)),
        cell(moves.get(row.path) ?? null),
      ].join(","),
    )
  }
  return lines.join("\r\n")
}

function stampFor(iso: string): string {
  return iso.replace(/[:.]/g, "-")
}

export function downloadDecisionsCsv(
  rows: DecisionRow[],
  meta: { site: string; generatedAt: string; model: string; delta: RunDelta | null },
): void {
  const provenance = [
    "",
    `# site: ${meta.site}`,
    `# judge: ${meta.model}`,
    `# generated: ${meta.generatedAt}`,
    "# probability is the judge's. No column predicts a position or a number of visitors.",
    "# the moved column carries the chip word, so a row lifted out still reads as it does on screen.",
    "#",
    "# deliberately not in this file:",
    "# no search volume - no keyword positions - no backlink counts - no promised outcome",
    "# page text - anything a model inferred that no tool returned",
  ].join("\r\n")

  const blob = new Blob(["﻿", decisionsToCsv(rows, meta), provenance], {
    type: "text/csv;charset=utf-8",
  })
  const href = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = href
  link.download = `jev-decisions-${stampFor(meta.generatedAt)}-${meta.site.replace(/^https?:\/\//, "") || "site"}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(href)
}
