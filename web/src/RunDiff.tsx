import type { PageDelta, RunDelta } from "./types"
import "./decisions.css"

const COLUMN_WORD: Record<string, string> = {
  fixed: "no longer raised",
  still_open: "still open",
  new: "newly raised",
  regressed: "regressed",
}

const COLUMN_BODY: Record<string, string> = {
  fixed: "The earlier run raised a change here. This run did not raise one.",
  still_open: "Both runs raised a change on this page. Nothing about it moved.",
  new: "This run raised it. The earlier run did not reach this page, so nothing is compared.",
  regressed:
    "Both runs judged this page. This one raised it, and the earlier run did not.",
}

function day(iso: string): string {
  return `${iso.slice(8, 10)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(iso.slice(5, 7)) - 1] ?? ""}`
}

function DeltaList({ rows, kind }: { rows: PageDelta[]; kind: string }) {
  if (rows.length === 0) {
    return <p className="dcol-empty">nothing in this column</p>
  }
  return (
    <ul className="dcol-list">
      {rows.map((row) => (
        <li key={row.url}>
          <span className="dp" title={row.url}>
            {row.path}
          </span>
          {kind === "regressed" && (
            <span className="dchipword">regressed — this run treats the page worse than the one before</span>
          )}
          {row.topChange && <span className="dc">{row.topChange}</span>}
        </li>
      ))}
    </ul>
  )
}

export interface RunDiffProps {
  delta: RunDelta | null
}

export function RunDiff({ delta }: RunDiffProps) {
  if (!delta) return null

  if (delta.baseline === null) {
    return (
      <div className="ddiff">
        <h3 className="ddiff-h">change since the first run</h3>
        <p className="ddiff-sub">One line per page, naming what the two runs said about it.</p>
        <div className="ddiff-none">
          <b>nothing to compare yet</b>
          <p>There is no earlier run for this site. Run the audit again on the same URL and this fills.</p>
        </div>
      </div>
    )
  }

  const baseline = delta.baseline
  const since = day(baseline.generatedAt)
  const moved = delta.fixed.length + delta.new.length + delta.regressed.length
  const crawledShrank = delta.pagesCrawledNow < delta.pagesCrawledBefore
  const columns = [
    { key: "regressed", rows: delta.regressed },
    { key: "fixed", rows: delta.fixed },
    { key: "new", rows: delta.new },
    { key: "still_open", rows: delta.stillOpen },
  ] as const

  return (
    <div className="ddiff">
      <h3 className="ddiff-h">change since {since}</h3>
      <p className="ddiff-sub">One line per page, naming what the two runs said about it.</p>

      {moved === 0 ? (
        <div className="ddiff-none">
          <b>nothing moved between these two runs</b>
          <p>Every page the two runs share has the same change raised on it.</p>
          <p>This is what a re-run looks like before the edits land.</p>
          <p>Every change in 02 came from the earlier run. Nothing was taken off the list.</p>
        </div>
      ) : (
        <>
          {crawledShrank && (
            <p className="ddiff-caveat">
              This run crawled {delta.pagesCrawledNow} of {delta.pagesCrawledBefore} pages the last
              one did. A page missing below was not crawled this time, not closed.
            </p>
          )}
          <div className="ddiff-grid">
            {columns.map((column) => (
              <section className={`dcol dcol-${column.key}`} key={column.key}>
                <h4 className="dcol-h">
                  {COLUMN_WORD[column.key]}
                  <span
                    className="dcol-n"
                    title={`Pages in the ${COLUMN_WORD[column.key]} column.`}
                  >
                    {column.rows.length}
                  </span>
                </h4>
                <p className="dcol-body">{COLUMN_BODY[column.key]}</p>
                <DeltaList rows={column.rows} kind={column.key} />
              </section>
            ))}
          </div>
        </>
      )}

      <p className="ddiff-note">
        A difference here is a difference between two judgements. It is not a measurement of the site.
      </p>
      <p className="ddiff-note">
        Two runs agreeing is normal. It is not a sign the pages are finished.
      </p>
    </div>
  )
}

/** The 02 half-head count. Never renders a breakdown without its denominator. */
export function RunDiffCount({ delta }: { delta: RunDelta | null }) {
  if (!delta) return <>no comparison yet</>
  if (delta.baseline === null) return <>nothing to compare yet</>
  const baseline = delta.baseline
  return (
    <>
      <span title="Pages that moved, out of the pages the earlier run raised a change on.">
        {delta.fixed.length + delta.new.length + delta.regressed.length} of {baseline.openPages} pages
        moved between these two runs
      </span>
      <span className="dcount-sub">
        {baseline.openPages} pages appeared in both runs, which is what can be compared
      </span>
      <span className="dcount-break">
        {delta.regressed.length} regressed · {delta.fixed.length} no longer raised · {delta.new.length}{" "}
        newly raised · {delta.stillOpen.length} still open
      </span>
    </>
  )
}
