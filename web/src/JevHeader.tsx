import { useEffect, useRef, useState } from "react"

export type Stage = "idle" | "crawl" | "site" | "pages" | "keywords" | "rivals" | "done"

const STAGES: Array<{ id: Stage; label: string; note: string }> = [
  { id: "crawl", label: "crawl", note: "fetch pages, robots, sitemap" },
  { id: "site", label: "ask", note: "what kind of business is this" },
  { id: "pages", label: "judge", note: "one typed call per page" },
  { id: "keywords", label: "mine", note: "is it a real query, does a buyer type it" },
  { id: "rivals", label: "compare", note: "same rubric on each competitor" },
  { id: "done", label: "score", note: "weight, rank, route the grey zone" },
]

const STAGE_ORDER: Stage[] = ["crawl", "site", "pages", "keywords", "rivals", "done"]

export interface LogLine {
  id: number
  text: string
  kind: "info" | "good" | "warn" | "bad"
}

interface Props {
  stage: Stage
  stageDetail: string
  running: boolean
  log: LogLine[]
  counters: Array<{ k: string; v: string }>
  hasRun: boolean
}

function kindOf(text: string): LogLine["kind"] {
  if (text.startsWith("✓")) return "good"
  if (text.startsWith("✕")) return "bad"
  if (text.startsWith("↻")) return "warn"
  if (text.startsWith("■")) return "good"
  if (text.startsWith("—") || text.startsWith("▶")) return "info"
  return "info"
}

export function JevHeader({ stage, stageDetail, running, log, counters, hasRun }: Props) {
  const [open, setOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const activeIndex = STAGE_ORDER.indexOf(stage)

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [open, log.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    if (open) window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <div className="jevhead">
      <button
        type="button"
        className={`jevbar ${running ? "busy" : ""} ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="How Jev works, and the live run log"
      >
        <span className="pulsewrap" aria-hidden>
          <span className="dot" />
        </span>

        <span className="label">
          {running ? (STAGES[activeIndex]?.label ?? "working") : hasRun ? "show log" : "how jev works"}
        </span>

        <span className="track" aria-hidden>
          {STAGES.map((s, i) => {
            const state = !hasRun && !running ? "idle" : i < activeIndex ? "done" : i === activeIndex ? "active" : "todo"
            return <span key={s.id} className={`node ${state}`} />
          })}
          {running && <span className="runner" style={{ animationDelay: `${(activeIndex % 3) * 0.18}s` }} />}
        </span>

        <span className="stats">
          {counters.map((c) => (
            <span key={c.k} className="stat">
              <b>{c.v}</b> {c.k}
            </span>
          ))}
        </span>

        <span className="chev" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="jevpanel" role="dialog" aria-label="Jev pipeline and run log">
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
              <span>run log</span>
              <span className="detail">{running ? stageDetail : hasRun ? "run finished" : "no run yet"}</span>
            </div>
            <div className="logscroll" ref={logRef}>
              {log.length === 0 ? (
                <div className="logempty">
                  Press <b>Run audit</b> and every step streams here: one line per stage, then one per decision.
                </div>
              ) : (
                log.map((line) => (
                  <div className={`logline ${line.kind}`} key={line.id}>
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
                <b>build</b> the state and the answer menu
              </li>
              <li>
                <b>call</b> Jev — every question in the call runs in parallel
              </li>
              <li>
                <b>threshold</b> — decisive, to verify, or needs a human
              </li>
              <li>
                <b>act or escalate</b>, never guess in the grey zone
              </li>
              <li>
                <b>log</b> a receipt: tokens, cost, latency, model version
              </li>
            </ol>
            <p className="note">
              Jev never writes prose. It returns typed answers with probabilities, and code decides what to do with
              them.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
