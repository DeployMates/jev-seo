import type { CompetitorProposal, MetricProposal } from "./researchTypes"
import type { CompetitorResult } from "./types"
import type { RivalSlot } from "./rivals"
import "./decisions.css"

const REFUSAL =
  "We never read a live results page. No search results page is fetched, parsed or stored at any point. " +
  "A rival match is topic overlap across pages we crawled from that rival's own site. It is never a ranking."

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
}

function ScoreRow({ rival }: { rival: CompetitorResult }) {
  // The summary line is four fields. A run judges every rival on thirteen, and
  // the ones that decide what to copy — the topics it covers, the gap it holds,
  // the single change that would help it most — were being crawled and then
  // dropped on the floor. A disclosure costs no state and no dependency, and it
  // keeps the row scannable for the eight rivals that need no reading.
  const facts: Array<{ k: string; v: string }> = []
  if (rival.businessModel) facts.push({ k: "business model", v: rival.businessModel.replace(/_/g, " ") })
  if (rival.proofDensity != null) facts.push({ k: "proof density", v: `${Math.round(rival.proofDensity * 100)}%` })
  facts.push({ k: "pages crawled", v: String(rival.pages) })
  facts.push({ k: "rule checks", v: String(rival.ruleFindings) })
  facts.push({ k: "worth copying", v: rival.worthCopying.toFixed(2) })
  if (rival.topFix) facts.push({ k: "biggest single fix", v: rival.topFix })
  if (rival.aiGap) facts.push({ k: "what they have that you do not", v: rival.aiGap })
  facts.push({ k: "judged by", v: rival.model })
  facts.push({ k: "judgement cost", v: `${rival.ms} ms · ${rival.inputTokens} in · $${rival.costUsd.toFixed(4)}` })

  return (
    <div className="comp">
      <div className="g">{rival.reachable ? rival.grade : "!"}</div>
      <div className="d">
        <div className="h" title={rival.url}>
          {rival.url.replace(/^https?:\/\//, "")}
        </div>
        <div className="m">
          {rival.reachable
            ? `${rival.pages} pages · ${rival.businessModel?.replace(/_/g, " ") ?? "unclassified"}${
                rival.proofDensity == null ? "" : ` · proof ${Math.round(rival.proofDensity * 100)}%`
              }`
            : (rival.error ?? "unreachable")}
        </div>
      </div>
      <div className="s">{rival.reachable ? rival.score : "–"}</div>
      <div className="copy">{rival.worthCopying >= 0.5 ? "worth copying" : ""}</div>

      {rival.reachable && (
        <details className="compfull">
          <summary>
            {rival.topics.length > 0 ? `${rival.topics.length} topics` : "all details"}
          </summary>
          {rival.topics.length > 0 && (
            <div className="topics">
              {rival.topics.map((topic) => (
                <span className="topic" key={topic}>
                  {topic}
                </span>
              ))}
            </div>
          )}
          <dl className="compfacts">
            {facts.map((fact) => (
              <div className="cf" key={fact.k}>
                <dt>{fact.k}</dt>
                <dd>{fact.v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}

/**
 * The row a rival occupies while it is being crawled. It sits in the same
 * position the finished row will take, so panel 04 shows the dequeue instead of
 * a gap. A stopped run leaves these behind deliberately — a rival that was
 * never judged is not a rival that was cleared.
 */
function PendingRow({ requested, running }: { requested: string; running: boolean }) {
  return (
    <div className="comp pending" aria-busy="true">
      <div className="g">…</div>
      <div className="d">
        <div className="h">{requested.replace(/^https?:\/\//, "")}</div>
        <div className="m">{running ? "crawling and judging this rival" : "not judged — the run stopped first"}</div>
      </div>
      <div className="s">–</div>
      <div className="copy" />
    </div>
  )
}

export interface RivalsPanelProps {
  self: { url: string; score: number | null; grade: string; meta: string }
  rivals: CompetitorResult[]
  /**
   * Dequeue order, including rivals still being crawled. The panel renders
   * this list rather than `rivals`, so a pending rival keeps its row and the
   * finished one replaces it in place instead of being appended.
   */
  slots: RivalSlot[]
  proposals: CompetitorProposal[]
  metrics: MetricProposal[]
  running: boolean
  hasRun: boolean
  /** Rival domains the form asked for, so reachability has a denominator. */
  requested: number
  presearchRan: boolean
  presearchDegraded: boolean
  presearchReason: string | null
}

export function RivalsPanel({
  self,
  rivals,
  slots,
  proposals,
  metrics,
  running,
  hasRun,
  requested,
  presearchRan,
  presearchDegraded,
  presearchReason,
}: RivalsPanelProps) {
  const reachable = rivals.filter((r) => r.reachable)
  const best = reachable.reduce<number | null>(
    (acc, r) => (acc === null || r.score > acc ? r.score : acc),
    null,
  )
  const worthCopying = reachable.filter((r) => r.worthCopying >= 0.5).length

  const rivalsReachable = rivals.filter((c) => c.reachable).length
  const rivalsJudged = rivals.length
  const rivalsUnfinished = slots.length - rivalsJudged

  let scorecardEmpty: { head: string; body: string; see?: string } | null = null
  if (!running && slots.length === 0) {
    if (!hasRun) {
      scorecardEmpty = {
        head: "no run yet",
        body: "No rival has been crawled. Add one above, then run the audit to compare against.",
      }
    } else if (requested === 0) {
      scorecardEmpty = {
        head: "no rivals to compare against",
        body: "This run had no rivals, so there is nothing to compare and no rival page was crawled.",
      }
    } else {
      scorecardEmpty = {
        head: "no rival was reachable",
        body: `None of the ${rivalsJudged} rivals this run actually attempted returned a usable page. ${requested > rivalsJudged ? `${requested - rivalsJudged} more were listed but sit past the ${rivalsJudged}-rival cap, so they were never crawled. ` : ""}This is a reachability problem, not a content one.`,
        see: "fix the rivals and re-run rather than writing these off",
      }
    }
  }

  return (
    <div className="rivalpanel">
      <section className="rblock">
        <h3 className="rh">side by side on the same rubric</h3>
        {scorecardEmpty ? (
          <div className="dempty">
            <b>{scorecardEmpty.head}</b>
            <p>{scorecardEmpty.body}</p>
            {scorecardEmpty.see && <p className="dsee">{scorecardEmpty.see}</p>}
          </div>
        ) : (
          <>
            <div className="comps">
              <div className="comp me">
                <div className="g">{self.grade || "–"}</div>
                <div className="d">
                  <div className="h">
                    {self.url || "your site"}
                    <span className="mebadge">you</span>
                  </div>
                  <div className="m">{self.meta}</div>
                </div>
                <div className="s">{self.score ?? "–"}</div>
                <div className="copy" />
              </div>
              {slots.map((slot) =>
                slot.result ? (
                  <ScoreRow key={slot.key} rival={slot.result} />
                ) : (
                  <PendingRow key={slot.key} requested={slot.requested} running={running} />
                ),
              )}
            </div>
            <p className="rnote">
              {rivalsReachable} of {requested || rivalsReachable} rivals reachable.
              {self.score === null
                ? " Your own score appears here once the audit finishes."
                : best === null
                  ? " No rival scored, so there is nothing to compare against yet."
                  : self.score >= best
                    ? " You are at or above the strongest rival on this rubric."
                    : ` The strongest rival scored ${best}, so the gap to close is ${
                        best - self.score
                      } points on the same rubric.`}
            </p>
          </>
        )}
        <p className="rrefuse">{REFUSAL}</p>
      </section>

      <div className="rside">
        <section className="rblock">
          <h3 className="rh">proposed rival</h3>
          {proposals.length === 0 ? (
            <div className="dempty">
              {reachable.length > 0 ? (
                <>
                  <b>
                    {reachable.length} rival{reachable.length === 1 ? "" : "s"} judged · no rival page
                    proposed
                  </b>
                  <p>
                    Every rival was judged on the same rubric as your site. None produced a page worth
                    copying.
                  </p>
                </>
              ) : (
                <>
                  <b>no proposals yet</b>
                  <p>
                    {!presearchRan
                      ? "Run presearch and the rivals it found land here, each with the query and tool that produced it."
                      : `Presearch ran and proposed none. ${presearchReason ?? ""}`.trim()}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="props">
              {proposals.map((proposal) => (
                <div className="prop" key={proposal.url || proposal.name}>
                  <div className="t">
                    {proposal.name}
                    <span className="dom">{hostOf(proposal.url)}</span>
                  </div>
                  <div className="dmore-block">
                    <div className="dk">why</div>
                    <div className="w">{proposal.why}</div>
                  </div>
                  {proposal.evidence_query && (
                    <div className="src">
                      asked: {proposal.evidence_query} on {proposal.evidence_tool}
                    </div>
                  )}
                  {proposal.angle && (
                    <div className="dmore-block">
                      <div className="dk">angle</div>
                      <div className="a">{proposal.angle}</div>
                    </div>
                  )}
                </div>
              ))}
              <p className="dsee">
                filling this is your call, and no number here says what it pays
              </p>
            </div>
          )}
        </section>

        <section className="rblock">
          <h3 className="rh">figures the tools returned</h3>
          {metrics.length === 0 ? (
            <div className="dempty">
              {!presearchRan ? (
                <>
                  <b>no run yet</b>
                  <p>No presearch has run, so no tool has returned a figure to quote.</p>
                </>
              ) : presearchDegraded ? (
                <>
                  <b>presearch did not run</b>
                  <p>
                    {presearchReason
                      ? `${presearchReason} Quote nothing rather than substitute a number.`
                      : "Quote nothing rather than substitute a number."}
                  </p>
                </>
              ) : (
                <>
                  <b>
                    {reachable.length} rival{reachable.length === 1 ? "" : "s"} judged · no metrics
                    returned
                  </b>
                  <p>
                    The metrics tool returned nothing for these rivals. Quote nothing rather than
                    substitute a number.
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="metrics">
                {metrics.map((metric) => (
                  <div className="metric" key={metric.key}>
                    <div className="mk">{metric.label}</div>
                    <div className="mv" title={metric.number.raw}>
                      {metric.number.raw}
                    </div>
                    <div className="ms">from {metric.number.source_tool}</div>
                  </div>
                ))}
              </div>
              <p className="rnote">
                every number here is quoted from the tool that returned it. No number here was estimated.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
