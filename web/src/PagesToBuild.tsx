import { useMemo, useState } from "react"
import type { DemandTier, SubjectRow } from "./types"
import "./decisions.css"

/** The tier names are internal. The row states the evidence, not the enum. */
const TIER_WORD: Record<DemandTier, string> = {
  typed_and_returned: "typed and returned",
  rival_published: "rival published",
  our_own_pages: "our own pages",
}

function pct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function SubjectCard({ row, rank }: { row: SubjectRow; rank: number }) {
  const [open, setOpen] = useState(false)
  // Both are contract violations the producer must never emit. They are stated
  // rather than filtered, because a silent drop is indistinguishable from
  // "we found nothing" — the exact lie this panel must not tell.
  const refusal =
    row.tier === "our_own_pages"
      ? "this term is already on your own pages, so it belongs in 02, not here"
      : row.contentType === "refresh"
        ? "this topic is already shared, so this is a refresh, not a new page"
        : null

  return (
    <article className="scard">
      <div className="scard-rank" aria-hidden>
        {String(rank).padStart(2, "0")}
      </div>
      <div className="scard-main">
        <h3 className="sterm">{row.label}</h3>

        <div className="schip">
          <span className="stier">{TIER_WORD[row.tier]}</span>
          <span className="stype">{refusal ? "refresh instead" : "write a new page"}</span>
          <span className="spath">goes to {row.targetPath}</span>
        </div>

        {refusal && <p className="srefuse">{refusal}</p>}

        {row.phrases.length > 1 && (
          <div className="scluster">
            <span className="k">the cluster it stands for</span>
            {row.phrases.map((phrase) => (
              <span className="sphrase" key={phrase}>
                {phrase}
              </span>
            ))}
          </div>
        )}

        <div className="sbars">
          <div className="dbar">
            <div className="k">priority</div>
            <div className="track">
              <div
                className="fill"
                style={{ width: `${Math.max(row.priority * 100, 1.5)}%` }}
              />
            </div>
            <div className="n">{pct(row.priority)}</div>
          </div>
        </div>

        <div className="sfoot">
          <span className="tag">we cover it: {row.ourState.replace(/_/g, " ")}</span>
          <span className="tag">
            {row.rivals.length} rival page{row.rivals.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="dexp"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide the evidence" : "why this is here"}
          </button>
        </div>

        {open && (
          <div className="smore">
            <div className="dmore-block">
              <div className="dk">why this is here</div>
              <div className="dv">
                {row.reasons.length > 0 ? row.reasons.join(" · ") : "no reason was returned"}
              </div>
            </div>
            <div className="dmore-block">
              <div className="dk">rivals already publishing on it</div>
              {row.rivals.length === 0 ? (
                <div className="dv muted">No rival page matched this term across their own sites.</div>
              ) : (
                <ul className="srivals">
                  {row.rivals.map((rival, i) => (
                    <li key={`${rival.domain ?? "site"}-${i}`}>
                      {rival.domain && <b>{rival.domain}</b>}
                      {rival.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

export interface PagesToBuildProps {
  subjects: SubjectRow[]
  running: boolean
  hasRun: boolean
  presearchRan: boolean
  presearchReason: string | null
  /** Terms judged but not proposed, so "none is a buying query" has a count. */
  termsJudged: number
  /** Subjects the producer held back as refresh rather than a new page. */
  refreshCount: number
}

export function PagesToBuild({
  subjects,
  running,
  hasRun,
  presearchRan,
  presearchReason,
  termsJudged,
  refreshCount,
}: PagesToBuildProps) {
  const newPages = useMemo(
    () =>
      subjects
        .filter((s) => s.isNewPage)
        .sort((a, b) => b.priority - a.priority),
    [subjects],
  )
  const held = subjects.filter((s) => !s.isNewPage)
  const allHeld = held.length > 0 && held.every((s) => s.contentType === "refresh")

  if (newPages.length === 0) {
    return (
      <div className="dempty">
        {running ? (
          <>
            <b>subjects are arriving</b>
            <p>A term lands here when it is typed and returned, or a rival publishes for it.</p>
          </>
        ) : !hasRun ? (
          <>
            <b>no run yet</b>
            <p>No presearch has run, so no term is typed and returned. Run an audit to fill this panel.</p>
          </>
        ) : !presearchRan ? (
          <>
            <b>presearch did not run</b>
            <p>
              {presearchReason ? `${presearchReason} ` : ""}Only terms a rival published can justify a
              new page.
            </p>
          </>
        ) : termsJudged === 0 ? (
          <>
            <b>no terms were judged</b>
            <p>Raise the keyword limit, or give the crawler more pages, and this fills.</p>
          </>
        ) : allHeld ? (
          <>
            <b>every gap was already shared</b>
            <p>
              Every gap sits in a strong or shared bucket, which is refresh work by rule. No new page
              follows from a shared topic.
            </p>
          </>
        ) : held.length > 0 ? (
          <>
            <b>everything is already covered</b>
            <p>
              Every judged term is already on your own pages, so this is refresh work. Find the work in 02,
              to do on your site.
            </p>
          </>
        ) : (
          <>
            <b>nothing earned a new page</b>
            <p>
              Terms were judged, but none is typed and returned, and no rival published one. No new page
              is justified.
            </p>
            {termsJudged > 0 && (
              <p className="dsee">
                {termsJudged} terms judged · none is a buying query. Real searches, none of them buying.
                There is no new page here worth the write.
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="pbuild">
      <div className="dlist">
        {newPages.map((row, i) => (
          <SubjectCard key={row.id} row={row} rank={i + 1} />
        ))}
      </div>
      {refreshCount > 0 && (
        <p className="dnote">
          {refreshCount} sent to refresh in 02 instead, because{" "}
          {refreshCount === 1 ? "it came" : "they came"} from your own text.
        </p>
      )}
    </div>
  )
}
