import { useMemo } from "react"
import type { CrawledPage } from "./types"
import "./opportunity.css"

export interface CrawlMeta {
  discovered: number
  robotsFetched: boolean
  sitemapUrls: number
  errors: number
  done: boolean
}

interface Props {
  pages: CrawledPage[]
  meta: CrawlMeta
  running: boolean
  onPick: (url: string) => void
  selected: string | null
}

function statusTone(status: number): string {
  if (status >= 200 && status < 300) return "ok"
  if (status >= 300 && status < 400) return "warn"
  return "bad"
}

function statusWord(status: number): string {
  if (status >= 200 && status < 300) return "served"
  if (status >= 300 && status < 400) return "redirect"
  if (status === 0) return "unreachable"
  return "error"
}

export function CrawlTable({ pages, meta, running, onPick, selected }: Props) {
  const totals = useMemo(
    () =>
      pages.reduce(
        (acc, p) => ({
          words: acc.words + (p.words ?? 0),
          findings: acc.findings + (p.ruleFindings ?? 0),
          thin: acc.thin + (p.words > 0 && p.words < 200 ? 1 : 0),
        }),
        { words: 0, findings: 0, thin: 0 },
      ),
    [pages],
  )

  const checked = pages.some((p) => p.ruleFindings !== undefined)

  return (
    <div className="panel tight crawl">
      <h2 className="hed">
        every page the crawler measured
        <span className="tag">
          {running ? (
            <i className="crawl-live" />
          ) : null}
          {pages.length} page{pages.length === 1 ? "" : "s"} ·{" "}
          {totals.words.toLocaleString()} words
          {checked ? ` · ${totals.findings} rule findings` : ""}
        </span>
      </h2>

      <div className="crawl-facts">
        <div className="cf">
          <div className="k">links discovered</div>
          <div className="v">{meta.done ? meta.discovered || "0" : "–"}</div>
        </div>
        <div className="cf">
          <div className="k">robots.txt</div>
          <div className="v">
            {!meta.done ? "reading…" : meta.robotsFetched ? "honoured" : "absent"}
          </div>
        </div>
        <div className="cf">
          <div className="k">sitemap urls</div>
          <div className="v">{meta.done ? meta.sitemapUrls || "0" : "–"}</div>
        </div>
        <div className="cf">
          <div className="k">thin pages</div>
          <div className="v">{totals.thin}</div>
        </div>
        <div className="cf">
          <div className="k">fetch errors</div>
          <div className="v">{meta.errors}</div>
        </div>
      </div>

      <div className="crawl-cols" aria-hidden>
        <span>path</span>
        <span>http</span>
        <span>words</span>
        <span>title</span>
        <span>rules</span>
        <span>links</span>
      </div>

      {pages.length === 0 ? (
        <div className="empty">
          {running
            ? "First page lands here the moment the crawler returns it — no waiting for the run to finish."
            : "Run an audit and the crawl fills this table page by page, in crawl order."}
        </div>
      ) : (
        <div className="crawl-rows">
          {pages.map((page) => (
            <button
              type="button"
              className={`crawl-row ${selected === `crawl:${page.url}` ? "sel" : ""}`}
              key={page.url}
              onClick={() => onPick(page.url)}
            >
              <span className="t" title={page.url}>
                {page.path}
              </span>
              <span className={`s ${statusTone(page.status)}`}>
                {page.status || "—"}<i>{statusWord(page.status)}</i>
              </span>
              <span className="w">{page.words.toLocaleString()}</span>
              <span className="ti" title={page.title}>
                {page.title || "(no title)"}
              </span>
              <span className={`r ${(page.ruleFindings ?? 0) > 0 ? "hot" : ""}`}>
                {page.ruleFindings ?? (meta.done ? 0 : "–")}
              </span>
              <span className="l">
                {(page.internalLinks ?? 0) + (page.externalLinks ?? 0) || "–"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
