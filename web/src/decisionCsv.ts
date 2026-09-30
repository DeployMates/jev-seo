import { falsifierSentence } from "./decisionCopy"
import type { DecisionRow } from "./types"

const BAND_WORD: Record<string, string> = {
  act: "decisive",
  review: "to verify",
  escalate: "needs a human",
}

/**
 * RFC 4180 quoting. Only quotes when it must, so a deck pasted from this file
 * does not carry a wall of doubled quotes. The leading-apostrophe guard keeps
 * a spreadsheet from evaluating a cell that begins `=`, `+`, `-` or `@` as a
 * formula — a value quoted out of a crawled page is attacker-controlled text,
 * and this file lands in Excel.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const COLUMNS = [
  "path",
  "url",
  "priority",
  "instruction",
  "change_key",
  "p_this_change",
  "runner_up_key",
  "p_runner_up",
  "band",
  "counted_fact",
  "we_would_be_wrong_if",
  "other_findings",
  "page_type",
  "intent",
  "words",
  "inbound_links_found",
  "share_of_inbound_links_found",
] as const

/**
 * The decision rows as CSV.
 *
 * Every column is either a code count or a probability the judge returned.
 * Nothing here is predicted, and `we_would_be_wrong_if` ships as the rendered
 * sentence rather than the raw question id, for the same reason the card does:
 * a machine artefact is not a claim a practitioner can defend in a room.
 */
export function decisionsToCsv(rows: DecisionRow[]): string {
  const lines = [COLUMNS.join(",")]
  for (const row of rows) {
    const top = row.topChange
    lines.push(
      [
        cell(row.path),
        cell(row.url),
        cell(row.priority.toFixed(3)),
        cell(top.instruction),
        cell(top.key),
        cell(top.p.toFixed(3)),
        cell(top.runnerUp?.key ?? null),
        cell(top.runnerUp ? top.runnerUp.p.toFixed(3) : null),
        cell(BAND_WORD[top.band] ?? top.band),
        cell(top.witness),
        cell(falsifierSentence(top.falsifier)),
        cell(row.extraFindings),
        cell(row.pageType),
        cell(row.intent),
        cell(row.words ?? null),
        cell(row.reach?.inbound ?? null),
        cell(row.reach ? `${Math.round(row.reach.inboundShare * 100)}%` : null),
      ].join(","),
    )
  }
  return lines.join("\r\n")
}

/** `2026-09-30T11-04-07-000Z` — colons are legal in a filename but read badly. */
function stampFor(iso: string): string {
  return iso.replace(/[:.]/g, "-")
}

export function downloadDecisionsCsv(
  rows: DecisionRow[],
  meta: { site: string; generatedAt: string; model: string },
): void {
  const provenance = [
    "",
    `# site: ${meta.site}`,
    `# judge: ${meta.model}`,
    `# generated: ${meta.generatedAt}`,
    "# words, inbound links and their share are counted from the pages this run crawled, not from the whole site.",
    "# inbound counts are a floor: the crawl is bounded, so a page can show 0",
    "# because the crawl stopped, not because the page is orphaned.",
    "# p_this_change and p_runner_up are the judge's probabilities. No column predicts a position or a number of visitors.",
    "#",
    "# deliberately not in this file:",
    "# no search volume - no keyword positions - no backlink counts - no promised outcome",
    "# page text - anything a model inferred that no tool returned",
  ].join("\r\n")

  const blob = new Blob(["﻿", decisionsToCsv(rows), provenance], {
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
