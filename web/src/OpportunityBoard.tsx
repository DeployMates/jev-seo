import { useMemo, useState } from "react"
import type {
  CompetitorResult,
  GapRow,
  KeywordJudgement,
  PageJudgement,
} from "./types"
import {
  buildOpportunities,
  fromGapRow,
  isActionable,
  summariseRejections,
  type Opportunity,
} from "./opportunity"
import "./opportunity.css"

type Filter = "gaps" | "all" | "grey"

const FILTERS: Array<{ id: Filter; label: string; note: string }> = [
  { id: "gaps", label: "gaps", note: "no page, or scattered" },
  { id: "all", label: "all terms", note: "everything Jev judged" },
  { id: "grey", label: "grey zone", note: "confidence too low to act" },
]

function filterRows(rows: Opportunity[], filter: Filter): Opportunity[] {
  if (filter === "all") return rows
  if (filter === "grey") return rows.filter((r) => r.greyZone)
  return rows.filter((r) => r.ourStateTone !== "ok")
}

function RivalCell({ row }: { row: Opportunity }) {
  if (!row.rival) {
    return <div className="opp-rival none">no rival page for this term</div>
  }
  return (
    <div className="opp-rival">
      {row.rival.domain ? <div className="dom">{row.rival.domain}</div> : null}
      <div className="via" title={row.rival.page}>
        on {row.rival.page}
      </div>
      {row.rival.shared.length > 0 ? (
        <div className="why">
          matched on {row.rival.shared.join(", ")}
          {row.rival.worthCopying >= 0.5 ? " · worth copying" : ""}
        </div>
      ) : null}
    </div>
  )
}

function Detail({ row }: { row: Opportunity }) {
  return (
    <div className="opp-detail">
      <div className="od">
        <div className="odk">intent</div>
        <div className="odv">{row.intent.replace(/_/g, " ")}</div>
      </div>
      <div className="od">
        <div className="odk">cluster</div>
        <div className="odv">{row.cluster.replace(/_/g, " ")}</div>
      </div>
      <div className="od">
        <div className="odk">opportunity</div>
        <div className="odv">{Math.round(row.opportunity * 100)}</div>
      </div>
      <div className="od">
        <div className="odk">coverage gap</div>
        <div className="odv">{Math.round(row.coverageGap * 100)}%</div>
      </div>
      <div className="od">
        <div className="odk">buyer query</div>
        <div className="odv">{row.buyer ? "yes" : "no"}</div>
      </div>
      <div className="od wide">
        <div className="odk">pages already carrying it</div>
        <div className="odv mono">
          {row.pages.length > 0 ? row.pages.map((p) => p.replace(/^https?:\/\//, "")).join(" · ") : "none"}
        </div>
      </div>
      <div className="od wide tail">
        <div className="odk">why this confidence</div>
        <div className="odv">
          {row.reasons.length > 0 ? row.reasons.join(" · ") : "every answer landed inside the decisive band"}
        </div>
      </div>
    </div>
  )
}

interface EmptyInput {
  rows: Opportunity[]
  actionableCount: number
  judgedTotal: number
  judgedAll: KeywordJudgement[]
  gaps: GapRow[] | undefined
  keywords: KeywordJudgement[]
  competitors: CompetitorResult[]
  keywordsEnabled: boolean
  hasRun: boolean
  running: boolean
  filter: Filter
}

interface EmptyState {
  tag: string
  body: string
}

function list(terms: string[], max = 5): string {
  const shown = terms.slice(0, max).map((t) => `“${t}”`)
  return shown.join(", ") + (terms.length > max ? ` and ${terms.length - max} more` : "")
}

interface GateInput {
  gaps: GapRow[] | undefined
  keywords: KeywordJudgement[]
  competitors: CompetitorResult[]
  running: boolean
}

/**
 * `gaps: []` has four indistinguishable causes, and reporting the wrong one
 * repeats the dishonesty this board exists to avoid. Mirrors the gate at
 * server/src/audit.ts:1173 — the pass is skipped when no term is a real query
 * OR no rival is reachable. `.every` is never used unguarded: on an empty array
 * it is vacuously true, which would send a user with no rivals configured off
 * to find a rival they never asked for.
 */
function gateState({ gaps, keywords, competitors, running }: GateInput): EmptyState | null {
  if (gaps === undefined) return null
  if (gaps.length > 0) return null
  if (running) return null
  if (keywords.length === 0) return null
  if (competitors.length === 0) {
    return {
      tag: "no rivals to compare against",
      body: "Terms were judged, but this run had no rivals, so the gap comparison never ran. There is nothing here to compare against yet — give the audit one or more competitors and run it again.",
    }
  }
  if (competitors.every((c) => !c.reachable)) {
    return {
      tag: "no rival was reachable",
      body: `All ${competitors.length} rival${competitors.length === 1 ? " was" : "s were"} crawled without a usable result, so the gap comparison could not run. This is a reachability problem, not a content one — fix the rivals and re-run rather than writing pages off this evidence.`,
    }
  }
  if (competitors.some((c) => c.reachable)) {
    return {
      tag: "gaps were switched off",
      body: "A rival was reachable and terms were judged, so the gap pass should have run. It produced nothing, which usually means gaps were capped at zero for this request. There is no control for that in this dashboard, so this run's gap evidence is simply absent.",
    }
  }
  return {
    tag: "the gap pass produced nothing",
    body: "Terms were judged and a rival was reachable, so the comparison should have run and returned rows. It did not, and this dashboard cannot say why. Treat the board as incomplete rather than as proof there are no gaps.",
  }
}

function emptyState({
  rows,
  actionableCount,
  judgedTotal,
  judgedAll,
  gaps,
  keywords,
  competitors,
  keywordsEnabled,
  hasRun,
  running,
  filter,
}: EmptyInput): EmptyState {
  if (!hasRun && !running) {
    return {
      tag: "no audit run yet",
      body: "Nothing has been crawled, so there is no evidence and no gap. Enter a site above and run an audit; terms appear here as Jev judges them.",
    }
  }
  if (running && judgedTotal === 0) {
    return { tag: "waiting for terms", body: "Terms arrive here the moment Jev judges them." }
  }
  if (!keywordsEnabled) {
    return {
      tag: "keywords were off",
      body: "This run had keyword mining switched off, so no term was judged and no gap could be measured. Turn Keywords up and run again to fill this board.",
    }
  }
  if (judgedTotal === 0) {
    return {
      tag: "no terms judged",
      body: running
        ? "Jev is judging terms now."
        : "The crawler found no term worth asking Jev about. That usually means the site has very little text, or every mined phrase was an artefact of sentence structure.",
    }
  }
  if (actionableCount === 0 || rows.length === 0) {
    const gate = gateState({ gaps, keywords, competitors, running })
    if (gate) return gate
    const rejected = summariseRejections(judgedAll)
    if (rejected.chrome.length > 0) {
      return {
        tag: `${judgedTotal} judged · 0 actionable`,
        body: `The miner lifted ${rejected.chrome.length} phrase${rejected.chrome.length === 1 ? "" : "s"} off the page, but they are navigation text, not searches: ${list(rejected.chrome)}. Jev was asked whether anyone types those, and said no, so none of them reaches this board. The site may still have real gaps — the miner has nothing left to offer. Widen the crawl, or fix the miner's noise filter in server/src/keywords.ts so it stops feeding nav labels in.`,
      }
    }
    if (rejected.notBuyer.length > 0) {
      return {
        tag: `${judgedTotal} judged · 0 actionable`,
        body: `All ${judgedTotal} phrase${judgedTotal === 1 ? "" : "s"} read as real searches but none is a buying query: ${list(rejected.notBuyer)}. There is nothing here worth a new page — the reader would be reading, not buying, and a page written for them would sit unused.`,
      }
    }
    return {
      tag: `${judgedTotal} judged · all grey zone`,
      body: `Jev judged ${judgedTotal} term${judgedTotal === 1 ? "" : "s"} and every one landed in the grey zone, where the answers were too uncertain to act on. Nothing is recommended rather than something wrong recommended. Loosen the thresholds in server/src/thresholds.ts, or judge more terms, to widen the actionable set.`,
    }
  }
  if (filter === "gaps") {
    return {
      tag: `${actionableCount} terms · no gaps`,
      body: `${actionableCount} term${actionableCount === 1 ? " is" : "s are"} already served by a page, so there is no gap to write against. Switch to All terms to see them.`,
    }
  }
  if (filter === "grey") {
    return {
      tag: "no grey-zone terms",
      body: "Every actionable term landed inside the decisive band, so none is held back for a human to check.",
    }
  }
  return { tag: "nothing to show", body: `No rows for the current filter. ${rows.length} built.` }
}

interface Props {
  keywords: KeywordJudgement[]
  /**
   * Server gap rows. `undefined` means the report predates the gap pass and the
   * client-side derivation stands in; an empty array means the server ran the
   * pass and found nothing, which is a diagnosis, never a fallback trigger.
   */
  gaps: GapRow[] | undefined
  /** Used only to explain an empty board: which gate stopped the gap pass. */
  competitors: CompetitorResult[]
  /** Every term Jev judged, including the ones filtered out of `keywords`. */
  judgedTotal: number
  /** The unfiltered judged set, so rejections can be explained by cause. */
  judgedAll: KeywordJudgement[]
  /** False when the run had keywords switched off, which is not a failure. */
  keywordsEnabled: boolean
  /** True once a run has completed, so "no terms" is never confused with "no run". */
  hasRun: boolean
  rivals: CompetitorResult[]
  pages: PageJudgement[]
  running: boolean
}

export function OpportunityBoard({
  keywords,
  gaps,
  competitors,
  judgedTotal,
  judgedAll,
  keywordsEnabled,
  hasRun,
  rivals,
  pages,
  running,
}: Props) {
  const [filter, setFilter] = useState<Filter>("gaps")
  const [selected, setSelected] = useState<string | null>(null)
  const reportKeywords = keywords
  const actionable = useMemo(() => keywords.filter(isActionable), [keywords])
  const judgedCount = judgedAll.length || judgedTotal

  const rows = useMemo(() => {
    // Fallback is for reports predating the gap pass, and ONLY then. A `gaps`
    // array that came back empty means the server ran the pass and found
    // nothing, which the empty state has to explain — silently deriving rows
    // there would hide the failure and reintroduce a second source of truth.
    if (gaps === undefined) return buildOpportunities(actionable, rivals, pages)
    return gaps
      .map(fromGapRow)
      .filter((r): r is Opportunity => r !== null)
      .sort((a, b) => b.priorityScore - a.priorityScore)
  }, [gaps, actionable, rivals, pages])
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter])
  const selectedRow = rows.find((r) => r.id === selected) ?? null
  const gapCount = rows.filter((r) => r.ourStateTone === "gap").length
  const p1 = rows.filter((r) => r.priority === "P1").length

  const empty = emptyState({
    rows,
    actionableCount: actionable.length,
    judgedTotal: judgedCount,
    judgedAll,
    gaps,
    keywords: reportKeywords,
    competitors,
    keywordsEnabled,
    hasRun,
    running,
    filter,
  })
  const status = rows.length > 0 ? `${gapCount} gaps · ${p1} at P1` : empty.tag

  return (
    <div className="panel tight opp">
      <h2 className="hed">
        the opportunity board
        <span className="tag">
          {running && rows.length === 0 ? <i className="crawl-live" /> : null}
          {status}
        </span>
      </h2>

      <div className="opp-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`opp-filter ${filter === f.id ? "on" : ""}`}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
          >
            {f.label}
            <span>{f.note}</span>
          </button>
        ))}
        <span className="opp-honest">
          no live results page is ever read · a rival match is topic overlap across pages crawled from
          their site, never a ranking
        </span>
      </div>

      <div className="opp-cols" aria-hidden>
        <span>keyword</span>
        <span>who covers it today</span>
        <span>our state</span>
        <span>write</span>
        <span>goes to</span>
        <span>pri</span>
        <span>jev</span>
      </div>

      {shown.length === 0 ? (
        <div className="empty opp-empty">
          <b>{empty.tag}</b>
          <span>{empty.body}</span>
        </div>
      ) : (
        <div className="opp-rows">
          {shown.slice(0, 60).map((row) => (
            <button
              type="button"
              className={`opp-row pri-${row.priority.toLowerCase()} ${
                row.greyZone ? "grey" : ""
              } ${selected === row.id ? "sel" : ""}`}
              key={row.id}
              onClick={() => setSelected(selected === row.id ? null : row.id)}
              aria-expanded={selected === row.id}
            >
              <span className="opp-term">
                {row.term}
                {row.greyZone ? (
                  <b className="opp-unverified" title="held back — a human should look before acting">
                    {row.band === "escalate" ? "needs a human" : "to verify"}
                  </b>
                ) : null}
              </span>
              <RivalCell row={row} />
              <span className={`opp-state ${row.ourStateTone}`}>{row.ourState}</span>
              <span className="opp-write">{row.write}</span>
              <span className="opp-dest">
                <i className={row.destinationKind}>{row.destinationKind === "new" ? "new" : "extend"}</i>
                {row.destination}
              </span>
              <span className="opp-pri">
                <b>{row.priority}</b>
                {Math.round(row.priorityScore * 100)}
              </span>
              <span className="opp-conf">
                <span className="track">
                  <span
                    className={`fill ${row.confidenceLabel}`}
                    style={{ width: `${Math.max(Math.min(row.confidence * 100, 100), 2)}%` }}
                  />
                </span>
                {row.confidenceLabel}
              </span>
            </button>
          ))}
          {shown.length > 60 && (
            <div className="opp-more">+{shown.length - 60} more terms below the fold</div>
          )}
        </div>
      )}

      {selectedRow && <Detail row={selectedRow} />}
    </div>
  )
}
