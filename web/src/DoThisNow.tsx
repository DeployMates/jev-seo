import { useMemo, useState } from "react"
import type { Band, DecisionRow } from "./types"
import { FALSIFIER_LABEL, falsifierIsGeneric, falsifierSentence } from "./decisionCopy"
import "./decisions.css"

const BAND_WORD: Record<Band, string> = {
  act: "decisive",
  review: "to verify",
  escalate: "needs a human",
}

/** Below this gap the runner-up is a real alternative, not a footnote. */
const CLOSE_GAP = 0.15

function pct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function DecisionCard({
  row,
  words,
  inbound,
  inboundShare,
  rank,
}: {
  row: DecisionRow
  words: number | null
  inbound: number | null
  inboundShare: number | null
  rank: number
}) {
  const [open, setOpen] = useState(false)
  const { topChange } = row
  const runnerUp = topChange.runnerUp
  const gap = runnerUp ? topChange.p - runnerUp.p : null
  const contested = gap !== null && gap < CLOSE_GAP

  return (
    <article className={`dcard band-${topChange.band}`}>
      <div className="dcard-rank" aria-hidden>
        {String(rank).padStart(2, "0")}
      </div>

      <div className="dcard-main">
        <h3 className="dinstr">{topChange.instruction}</h3>

        <div className="dchip">
          <span className="dpath" title={row.url}>
            {row.path}
          </span>
          <span className="dfact">{words === null ? "words not counted" : `${words} words`}</span>
          <span className="dfact">
            {inbound === null ? "inbound links not counted" : `${inbound} inbound links`}
          </span>
          {inboundShare !== null && (
            <span className="dfact">{pct(inboundShare)}% of all inbound links</span>
          )}
        </div>

        {topChange.witness && (
          <blockquote className="dwitness">
            <span className="wlabel">counted on this page</span>
            {topChange.witness}
          </blockquote>
        )}

        <div className="dbars">
          <div className="dbar">
            <div className="k">jev</div>
            <div className="track">
              <div
                className={`fill ${contested ? "hot" : ""}`}
                style={{ width: `${Math.max(topChange.p * 100, 1.5)}%` }}
              />
            </div>
            <div className="n">{pct(topChange.p)}</div>
          </div>
          {contested && runnerUp && (
            <div className="dbar rival">
              <div className="k">runner-up</div>
              <div className="track">
                <div className="fill" style={{ width: `${Math.max(runnerUp.p * 100, 1.5)}%` }} />
              </div>
              <div className="n">{pct(runnerUp.p)}</div>
            </div>
          )}
        </div>

        <p className="dcontest">
          {contested && gap !== null
            ? `these two are within ${gap.toFixed(2)} of each other, so treat them as one decision`
            : "only one change was on the table, so there is no second"}
        </p>

        <div className="dfoot">
          <span className={`tag ${topChange.band === "act" ? "ok" : "hot"}`}>
            {BAND_WORD[topChange.band]}
          </span>
          <span className="tag">{row.pageType.replace(/_/g, " ")}</span>
          <span className="tag">{row.intent.replace(/_/g, " ")}</span>
          <button
            type="button"
            className="dexp"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide the rest" : `${row.extraFindings} other findings on this page`}
          </button>
        </div>

        {open && (
          <div className="dmore">
            <div className="dmore-block">
              <div className="dk">{FALSIFIER_LABEL}</div>
              <div className="dv">
                {falsifierSentence(topChange.falsifier)}
                {falsifierIsGeneric(topChange.falsifier) && (
                  <span className="dfaint">
                    {" "}
                    No question in this run tested that, so no narrower claim is made.
                  </span>
                )}
              </div>
            </div>
            {topChange.example && (
              <div className="dmore-block">
                <div className="dk">what it looks like when it is done</div>
                <div className="dv">{topChange.example}</div>
              </div>
            )}
            <div className="dmore-block">
              <div className="dk">other findings on this page</div>
              <div className="dv muted">
                {row.extraFindings === 0
                  ? "This change was the only one that cleared the band, so nothing sits behind it."
                  : `${row.extraFindings} cleared the band but rank below this one, in the evidence drawer.`}
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

export interface DoThisNowProps {
  decisions: DecisionRow[]
  /** Word counts keyed by url, straight from the crawl. Fills the path chip. */
  wordsByUrl: Map<string, number>
  running: boolean
  /** Crawled pages, so "0 of N cleared the gate" has a denominator. */
  crawled: number
  /** Pages actually judged, which separates "gate refused" from "pass broke". */
  pagesJudged: number
  held: number
}

export function DoThisNow({
  decisions,
  wordsByUrl,
  running,
  crawled,
  pagesJudged,
  held,
}: DoThisNowProps) {
  const rows = useMemo(() => [...decisions].sort((a, b) => b.priority - a.priority), [decisions])

  if (rows.length === 0) {
    return (
      <div className="dempty">
        {running ? (
          <>
            <b>pages are arriving</b>
            <p>A page lands here the moment Jev picks a change for it.</p>
          </>
        ) : crawled === 0 ? (
          <>
            <b>no run yet</b>
            <p>
              Nothing has been crawled, so there is no page to change. Edits appear here as Jev picks
              them.
            </p>
          </>
        ) : pagesJudged === 0 ? (
          <>
            <b>0 of {crawled} pages cleared the gate</b>
            <p>
              Every crawled page landed in the grey zone or needs nothing. This is the gate refusing, not
              a clean site.
            </p>
            <p className="dsee">see 05 for what was held back, and why</p>
          </>
        ) : (
          <>
            <b>the decision pass produced no rows</b>
            <p>
              Pages were crawled and judged, so a top change should have been picked. None was. Treat
              this as incomplete.
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="dnow">
      <div className="dlist">
        {rows.map((row, i) => (
          <DecisionCard
            key={row.url}
            row={row}
            rank={i + 1}
            words={row.words ?? wordsByUrl.get(row.url) ?? null}
            inbound={row.reach?.inbound ?? null}
            inboundShare={row.reach?.inboundShare ?? null}
          />
        ))}
      </div>
      <p className="dnote">
        {rows.length} of {crawled || rows.length} crawled pages cleared the gate
        {held > 0 ? ` · ${held} held back in 05` : ""}
      </p>
    </div>
  )
}
