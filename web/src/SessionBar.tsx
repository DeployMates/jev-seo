import { useEffect, useRef, useState } from "react"
import type { LogLine } from "./JevHeader"

export type SessionStage = "idle" | "crawl" | "count" | "search" | "write" | "done"

const STAGES: Array<{ id: SessionStage; label: string; note: string }> = [
  { id: "search", label: "search", note: "direct, alternatives, directory, category, geography" },
  { id: "write", label: "propose", note: "rivals, keyword seeds, everything it can evidence" },
  { id: "done", label: "fill", note: "the form is filled and the audit can run" },
]

const ORDER: SessionStage[] = ["search", "write", "done"]

export interface SessionSummary {
  model: string
  ms: number
  toolsCalled: number
  competitors: number
  seeds: number
  degraded: boolean
  reason?: string
  /** Counted off the live stream, so they move during the run and not only after it. */
  aiTools?: number
  aiMsgs?: number
}

interface Props {
  stage: SessionStage
  running: boolean
  hasRun: boolean
  log: LogLine[]
  summary: SessionSummary | null
  /** True while the deterministic crawl is still going, so this session is queued. */
  queued?: boolean
}

function kindOf(text: string): LogLine["kind"] {
  if (text.startsWith("✓")) return "good"
  if (text.startsWith("✕")) return "bad"
  if (text.startsWith("↻")) return "warn"
  if (text.startsWith("—") || text.startsWith("▶")) return "info"
  return "info"
}

export function SessionBar({ stage, running, hasRun, log, summary, queued }: Props) {
  const [open, setOpen] = useState(false)
  const liveSearches = log.filter((l) => /^— \S+ (completed|error|pending)/.test(l.text)).length
  const searches = summary?.toolsCalled ?? liveSearches
  // Two different things, and deliberately not one: a tool call is the agent
  // reaching out, an AI message is the model writing back. Counting them from the
  // same stream means the banner shows a stalled run as stalled rather than
  // inferring activity from the elapsed timer.
  const liveTools = log.filter((l) => /^— \S+ (completed|running|pending|error)$/.test(l.text)).length
  const liveMsgs = log.filter((l) => l.text.startsWith("— ") && !/^— \S+ (completed|running|pending|error)$/.test(l.text)).length
  const aiTools = summary?.aiTools ?? liveTools
  const aiMsgs = summary?.aiMsgs ?? liveMsgs
  const logRef = useRef<HTMLDivElement>(null)
  const activeIndex = Math.max(0, ORDER.indexOf(stage))

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, open])

  return (
    <div className="jevhead">
      <button
        type="button"
        className={`jevbar ${running ? "busy" : ""} ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="The opencode presearch session, and its log"
      >
        <span className="pulsewrap" aria-hidden>
          <span className="dot" />
        </span>

        <span className="label">
          {queued
            ? "queue"
            : running
              ? (STAGES[activeIndex]?.label ?? "working")
              : hasRun
                ? "show session"
                : "presearch"}
        </span>

        <span className="track" aria-hidden>
          {STAGES.map((s, i) => {
            const state = !hasRun && !running ? "idle" : i < activeIndex ? "done" : i === activeIndex ? "active" : "todo"
            return <span key={s.id} className={`node ${state}`} />
          })}
          {running && <span className="runner" style={{ animationDelay: `${(activeIndex % 3) * 0.18}s` }} />}
        </span>

        <span className="stats">
          <span className="stat">
            <b>{summary?.competitors ?? 0}</b> rivals
          </span>
          <span className="stat">
            <b>{summary?.seeds ?? 0}</b> seeds
          </span>
          <span className="stat">
            <b>{searches}</b> searches
          </span>
          <span className="stat" title="Tool calls the agent made">
            <b>{aiTools}</b> AI tools
          </span>
          <span className="stat" title="Messages the model wrote back">
            <b>{aiMsgs}</b> AI msgs
          </span>
          {summary ? (
            <span className="stat">
              <b>{(summary.ms / 1000).toFixed(1)}s</b> session
            </span>
          ) : null}
        </span>

        <span className="chev" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="jevpanel" role="dialog" aria-label="Presearch pipeline and session log">
          <div className="pipeline">
            {STAGES.map((s, i) => {
              const state = !hasRun ? "idle" : i < activeIndex ? "done" : i === activeIndex ? "active" : "todo"
              return (
                <div className={`pstep ${state} ${running && i === activeIndex ? "busy" : ""}`} key={s.id}>
                  <div className="pip" aria-hidden />
                  <div className="txt">
                    <div className="nm">{s.label}</div>
                    <div className="nt">{s.note}</div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="pane">
            <div className="panehead">
              <span>session log</span>
              <span className="detail">
                {queued
                  ? "queued — the crawler runs first"
                  : running
                    ? "opencode session running"
                    : summary
                      ? summary.degraded
                        ? `degraded — ${summary.reason ?? "unknown reason"}`
                        : `${summary.model} finished`
                      : "no session yet"}
              </span>
            </div>
            <div className="logscroll" ref={logRef}>
              {log.length === 0 ? (
                <div className="logempty">
                  Press <b>Run presearch</b> and the crawl, every search, and the proposal stream here.
                </div>
              ) : (
                log.map((line) => (
                  <div className={`logline ${line.kind || kindOf(line.text)}`} key={line.id}>
                    {line.text}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pane">
            <div className="panehead">
              <span>the loop</span>
            </div>
            <ol className="loop">
              <li>
                <b>crawl</b> the site deterministically, so the session never re-derives what is already counted
              </li>
              <li>
                <b>search</b> five angles — direct, alternatives, directories, category, geography
              </li>
              <li>
                <b>propose</b> only rivals and terms a tool actually surfaced, deduplicated by domain
              </li>
              <li>
                <b>fill</b> the form, then <b>Run audit</b> hands the result to Jev
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  )
}
