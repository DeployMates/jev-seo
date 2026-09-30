import { useEffect, useRef, useState } from "react"
import type { LogLine } from "./JevHeader"

import type { SessionStage } from "./SessionBar"

type Stage = SessionStage

const STAGES: Array<{ id: Stage; label: string; note: string }> = [
  { id: "crawl", label: "fetch", note: "robots, sitemap, then pages breadth-first" },
  { id: "search", label: "count", note: "headings, words, links, alt, structured data" },
  { id: "write", label: "digest", note: "handed to the opencode session verbatim" },
  { id: "done", label: "done", note: "the session can start" },
]

const ORDER: Stage[] = ["crawl", "search", "write", "done"]

interface Props {
  stage: Stage
  running: boolean
  hasRun: boolean
  log: LogLine[]
  pages?: number
  words?: number
  errors?: number
}

function kindOf(text: string): LogLine["kind"] {
  if (text.startsWith("✓")) return "good"
  if (text.startsWith("✕")) return "bad"
  if (text.startsWith("↻")) return "warn"
  if (text.startsWith("—") || text.startsWith("▶")) return "info"
  return "info"
}

export function CrawlBar({ stage, running, hasRun, log }: Props) {
  const [open, setOpen] = useState(false)
  const pageCount = log.filter((l) => l.text.startsWith("■ ")).length
  const wordCount = log.reduce((sum, l) => {
    const m = /words=(\d+)/.exec(l.text)
    return sum + (m ? Number(m[1]) : 0)
  }, 0)
  const errors = log.filter((l) => l.kind === "bad").length
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
        aria-label="The deterministic crawl, page by page"
      >
        <span className="pulsewrap" aria-hidden>
          <span className="dot" />
        </span>

        <span className="label">
          {running ? (STAGES[activeIndex]?.label ?? "crawling") : hasRun ? "show crawl" : "crawl"}
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
            <b>{pageCount}</b> pages
          </span>
          <span className="stat">
            <b>{wordCount}</b> words
          </span>
          <span className="stat">
            <b>{errors}</b> errors
          </span>
        </span>

        <span className="chev" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="jevpanel" role="dialog" aria-label="Crawl log">
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
              <span>crawl log</span>
              <span className="detail">
                {running ? "fetching" : hasRun ? "crawl finished" : "no crawl yet"}
              </span>
            </div>
            <div className="logscroll" ref={logRef}>
              {log.length === 0 ? (
                <div className="logempty">
                  Press <b>Run presearch</b> and every page the crawler fetches streams here as it lands.
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
              <span>what the crawl decides</span>
            </div>
            <ol className="loop">
              <li>
                <b>fetch</b> pages breadth-first, honouring robots.txt and refusing private addresses
              </li>
              <li>
                <b>count</b> title, headings, words, links, alt coverage, structured data — no model involved
              </li>
              <li>
                <b>hand over</b> the whole digest to the opencode session, so it never re-derives what is
                already counted
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  )
}
