import type { PageDelta, RunDelta } from "./types"
import "./decisions.css"

type ColumnKind =
  | "regressed"
  | "not_longer_raised"
  | "newly_raised"
  | "still_open"
  | "changed"
  | "not_comparable"

const COLUMN_WORD: Record<ColumnKind, string> = {
  regressed: "regressed",
  not_longer_raised: "no longer raised",
  newly_raised: "newly raised",
  still_open: "still open",
  changed: "changed",
  not_comparable: "not comparable",
}

/** `regressed` is absent: its sentence is per-row, so it has no static body. */
const COLUMN_BODY: Record<Exclude<ColumnKind, "regressed">, string> = {
  not_longer_raised: "The earlier run raised a change here. This run did not raise one.",
  newly_raised: "This run raised it. The earlier run did not reach this page, so nothing is compared.",
  still_open: "Both runs raised the same change on this page. Nothing about it moved.",
  changed: "The earlier run raised one change here. This run raised another.",
  not_comparable: "One of the two runs did not reach this page, so nothing can be compared.",
}

const COLUMN_EMPTY: Record<ColumnKind, readonly [string, string?]> = {
  regressed: [
    "no page got worse between these two runs",
    "Nothing went from decided to undecided, and no page that was silent is now raising.",
  ],
  not_longer_raised: [
    "nothing closed since the last run",
    "Every page the earlier run raised is still on the list.",
  ],
  newly_raised: [
    "no page arrived that the last run did not reach",
    "Every page on this list was already in the earlier run's crawl.",
  ],
  still_open: ["every page the two runs share is unchanged"],
  changed: ["every page both runs raised still carries the same change"],
  not_comparable: ["no page raised earlier went out of reach this run"],
}

const BAND_RANK: Record<string, number> = {
  decisive: 0,
  "to verify": 1,
  "needs a human": 2,
}

function day(iso: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${Number(iso.slice(8, 10))} ${months[Number(iso.slice(5, 7)) - 1] ?? ""}`
}

function bandMoved(row: PageDelta): string | null {
  if (!row.bandNow || !row.bandBefore || row.bandNow === row.bandBefore) return null
  return `the band moved ${row.bandBefore} to ${row.bandNow}`
}

/** `regressed` has two causes, so one sentence would be false half the time. */
function regressedBody(row: PageDelta): string {
  if (!row.raisedBefore) {
    return "Both runs judged this page. The earlier one raised nothing on it, and this one does."
  }
  const moved = bandMoved(row)
  return moved
    ? `The change is the same, but ${moved}.`
    : "Both runs raised a change here, at a worse band than before."
}

function DeltaRow({ row, kind }: { row: PageDelta; kind: ColumnKind }) {
  return (
    <li>
      <span className="dp" title={row.url}>
        {row.path}
      </span>
      {kind === "regressed" && (
        <span className="dchipword">regressed — this run treats the page worse than the one before</span>
      )}
      {kind === "regressed" ? (
        <span className="dc">{regressedBody(row)}</span>
      ) : (
        row.topChange && <span className="dc">{row.topChange}</span>
      )}
    </li>
  )
}

function DeltaList({ rows, kind }: { rows: PageDelta[]; kind: ColumnKind }) {
  if (rows.length === 0) {
    const [head, body] = COLUMN_EMPTY[kind]
    return (
      <div className="dcol-none">
        <b>{head}</b>
        {body && <span>{body}</span>}
      </div>
    )
  }
  return (
    <ul className="dcol-list">
      {rows.map((row) => (
        <DeltaRow key={row.path} row={row} kind={kind} />
      ))}
    </ul>
  )
}

function Column({
  kind,
  rows,
  rank,
}: {
  kind: ColumnKind
  rows: PageDelta[]
  rank: number
}) {
  return (
    <section className={`dcol dcol-${kind}`} style={{ order: rank }}>
      <h4 className="dcol-h">
        {COLUMN_WORD[kind]}
        <span className="dcol-n" title={`Pages in the ${COLUMN_WORD[kind]} column.`}>
          {rows.length}
        </span>
      </h4>
      {kind !== "regressed" && <p className="dcol-body">{COLUMN_BODY[kind]}</p>}
      <DeltaList rows={rows} kind={kind} />
    </section>
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

  const since = day(delta.baseline.generatedAt)
  const moved = delta.notLongerRaised.length + delta.newlyRaised.length + delta.regressed.length
  const inEitherRun =
    delta.stillOpen.length +
    delta.changed.length +
    delta.notLongerRaised.length +
    delta.regressed.length +
    delta.newlyRaised.length
  const crawledShrank = delta.pagesCrawledNow < delta.pagesCrawledBefore

  // All six render, including empty ones. A column that only appears when it
  // has rows makes its own empty state unreachable, and a visible `0` is what
  // the standing note about skipped columns is describing.
  const ordered: Array<{ kind: ColumnKind; rows: PageDelta[] }> = [
    { kind: "regressed", rows: delta.regressed },
    { kind: "not_longer_raised", rows: delta.notLongerRaised },
    { kind: "newly_raised", rows: delta.newlyRaised },
    { kind: "still_open", rows: delta.stillOpen },
    { kind: "changed", rows: delta.changed },
    { kind: "not_comparable", rows: delta.notComparable },
  ]

  return (
    <div className="ddiff">
      <h3 className="ddiff-h">change since {since}</h3>
      <p className="ddiff-sub">One line per page, naming what the two runs said about it.</p>

      {moved === 0 && delta.notComparable.length > 0 ? (
        <div className="ddiff-none">
          <b>nothing here can be compared</b>
          <p>The two runs reached no page in common that either of them raised, so every row is marked not comparable.</p>
        </div>
      ) : moved === 0 ? (
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
              one did.
              <br />
              A page missing below was not crawled this time, not closed.
            </p>
          )}
          <div className="ddiff-grid" data-cols={ordered.length}>
            {ordered.map((column, i) => (
              <Column key={column.kind} kind={column.kind} rows={column.rows} rank={i} />
            ))}
          </div>
        </>
      )}

      <p className="ddiff-note">
        Regressed means this run treated the page worse. A threshold change or a new rival reads the
        same way.
      </p>
      <p className="ddiff-note">
        A column is empty because that case did not occur, not because it was skipped.
      </p>
      <p className="ddiff-note">
        A difference here is a difference between two judgements. It is not a measurement of the site.
      </p>
      {delta.notComparable.length > 0 && (
        <p className="ddiff-note">
          Pages one run did not reach are marked not comparable, never as closed.
        </p>
      )}
      <p className="ddiff-note">
        A band also moves when a threshold is retuned, or a rival joins the comparison.
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

  // The denominator and its label are one matched pair; swapping one without
  // the other states a ratio against a population the sentence does not name.
  const denom = delta.stillOpen.length + delta.notLongerRaised.length
  const since = day(delta.baseline.generatedAt)

  return (
    <>
      {delta.regressed.length > 0 && (
        <span className="dcount-hot" title="Pages this run treats worse than the run before.">
          {delta.regressed.length} pages regressed since {since} — take these first
        </span>
      )}
      <span title="Pages the earlier run raised that this run no longer raises, out of the pages the earlier run raised.">
        {delta.notLongerRaised.length} of {denom} pages the earlier run raised are no longer raised
      </span>
      <span className="dcount-sub">
        {denom} pages the earlier run raised a change on, and this run could reach
      </span>
      <span className="dcount-break">
        {delta.regressed.length} regressed · {delta.notLongerRaised.length} no longer raised ·{" "}
        {delta.newlyRaised.length} newly raised · {delta.stillOpen.length} still open ·{" "}
        {delta.changed.length} changed
      </span>
      {delta.notComparable.length > 0 && (
        <span className="dcount-break">
          {delta.notComparable.length} not comparable · {delta.unreachableBefore} carried work not
          crawled this run
        </span>
      )}
    </>
  )
}
