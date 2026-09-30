import type { PageDelta, RunDelta } from "./types"
import "./decisions.css"

const COLUMN_WORD: Record<string, string> = {
  fixed: "fixed",
  still_open: "still open",
  new: "new",
  regressed: "regressed",
}

function DeltaList({ rows, emptyWord }: { rows: PageDelta[]; emptyWord: string }) {
  if (rows.length === 0) {
    return <p className="dcol-empty">{emptyWord}</p>
  }
  return (
    <ul className="dcol-list">
      {rows.map((row) => (
        <li key={row.url}>
          <span className="dp" title={row.url}>
            {row.path}
          </span>
          {row.topChange && <span className="dc">{row.topChange}</span>}
        </li>
      ))}
    </ul>
  )
}

export interface RunDiffProps {
  delta: RunDelta | null
  running: boolean
}

export function RunDiff({ delta, running }: RunDiffProps) {
  if (!delta) {
    return (
      <div className="dempty">
        <b>no run yet</b>
        <p>Nothing has been compared. Run the audit twice on one site to fill this panel.</p>
      </div>
    )
  }

  if (delta.baseline === null) {
    return (
      <div className="dempty">
        <b>first run on this site</b>
        <p>
          There is no earlier run to compare against, so nothing here moved. The next run on this site
          is compared to this one.
        </p>
      </div>
    )
  }

  const baseline = delta.baseline
  const openNow = delta.stillOpen.length + delta.new.length
  const moved = delta.fixed.length + delta.new.length + delta.regressed.length
  const crawledShrank = delta.pagesCrawledNow < delta.pagesCrawledBefore

  if (moved === 0) {
    return (
      <div className="dempty">
        <b>nothing moved</b>
        <p>
          {delta.stillOpen.length} of {baseline.openPages} pages open last run are still open. The
          same pages, the same instruction.
        </p>
        <p className="dsee">this run compared against the run of {baseline.generatedAt.slice(0, 10)}</p>
      </div>
    )
  }

  const columns = [
    { key: "fixed", rows: delta.fixed, empty: "nothing was closed" },
    { key: "still_open", rows: delta.stillOpen, empty: "nothing stayed open" },
    { key: "new", rows: delta.new, empty: "nothing new was opened" },
    { key: "regressed", rows: delta.regressed, empty: "nothing regressed" },
  ] as const

  return (
    <div className="ddiff">
      <div className="ddiff-top">
        <span
          className="ddiff-count"
          title="Pages that had a decisive change last run and have none this run."
        >
          {delta.fixed.length} of {baseline.openPages} pages open last run are fixed
        </span>
        {delta.scoreDelta !== null && (
          <span
            className={`ddiff-score ${delta.scoreDelta < 0 ? "down" : ""}`}
            title="Site score, both runs on the same rubric."
          >
            score {delta.scoreDelta > 0 ? "+" : ""}
            {delta.scoreDelta}
          </span>
        )}
        <span className="ddiff-base" title="The run this one is compared against.">
          compared against {baseline.generatedAt.slice(0, 10)} · {baseline.openPages} open ·{" "}
          {delta.clean} closed in both
        </span>
      </div>

      {crawledShrank && (
        <p className="ddiff-caveat">
          This run crawled {delta.pagesCrawledNow} of {delta.pagesCrawledBefore} pages the last one
          did. A page missing below was not crawled this time, not fixed.
        </p>
      )}

      <div className="ddiff-grid">
        {columns.map((column) => (
          <section className={`dcol dcol-${column.key}`} key={column.key}>
            <h4 className="dcol-h">
              {COLUMN_WORD[column.key]}
              <span
                className="dcol-n"
                title={`Pages the ${COLUMN_WORD[column.key]} column is reporting on.`}
              >
                {column.rows.length}
              </span>
            </h4>
            <DeltaList rows={column.rows} emptyWord={column.empty} />
          </section>
        ))}
      </div>

      <p className="dnote faint">
        {openNow} of {baseline.openPages} pages open last run are open now. A page is open when the
        judge committed to a change on it, or a rule check cleared the decisive band.
      </p>
    </div>
  )
}
