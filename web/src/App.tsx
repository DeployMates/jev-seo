import { useEffect, useMemo, useRef, useState } from "react"
import { fetchConfig, runAudit, API } from "./api"
import type { LogLine, Stage } from "./JevHeader"
import { GuideTour } from "./GuideTour"
import { Onboarding, type GscConnection } from "./Onboarding"
import { type GscCheck } from "./CapacityBadge"
import { CapacityCluster } from "./CapacityCluster"
import { PropertyPicker, type GscProperty } from "./PropertyPicker"
import type { AutofillRun } from "./researchTypes"
import { SessionBar, type SessionStage, type SessionSummary } from "./SessionBar"
import { CrawlBar } from "./CrawlBar"
import { CrawlTable, type CrawlMeta } from "./CrawlTable"
import { DoThisNow } from "./DoThisNow"
import { PagesToBuild } from "./PagesToBuild"
import { RivalsPanel } from "./RivalsPanel"
import { RunDiff, RunDiffCount } from "./RunDiff"
import { OpportunityBoard } from "./OpportunityBoard"
import { runResearch as runResearchStream } from "./api"
import type { ServerConfig } from "./api"
import "./onboarding.css"
import "./capacity.css"
import "./opportunity.css"
import "./guide.css"
import "./decisions.css"
import type {
  AuditEvent,
  AuditForm,
  AuditReport,
  Band,
  CompetitorResult,
  CrawledPage,
  DecisionRow,
  GapRow,
  KeywordJudgement,
  PageJudgement,
  PatternCount,
  SubjectRow,
} from "./types"
import { parseRivals, rivalKey, RIVAL_CAP_FALLBACK, type RivalSlot } from "./rivals"
import type { ResearchPayload } from "./researchTypes"

type View = "pages" | "keywords" | "competitors"

const BAND_WORD: Record<Band, string> = {
  act: "decisive",
  review: "to verify",
  escalate: "needs a human",
}

function Explain({ children }: { children: React.ReactNode }) {
  return <p className="whatline">{children}</p>
}

function domainOf(url: string): string {
  const raw = url.trim()
  if (!raw) return ""
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, "")
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] ?? ""
  }
}

function Favicon({ domain, size = 22 }: { domain: string; size?: number }) {
  const [stage, setStage] = useState(0)
  const sources = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
  ]
  const initial = (domain.replace(/^www\./, "")[0] ?? "?").toUpperCase()

  if (!domain) {
    return (
      <span className="fav fav-fallback" style={{ width: size, height: size, fontSize: size * 0.5 }}>
        ?
      </span>
    )
  }
  if (stage >= sources.length) {
    return (
      <span className="fav fav-fallback" style={{ width: size, height: size, fontSize: size * 0.52 }}>
        {initial}
      </span>
    )
  }
  return (
    <img
      className="fav"
      src={sources[stage]}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setStage((s) => s + 1)}
    />
  )
}

function FormBanner({ form, onExpand }: { form: AuditForm; onExpand: () => void }) {
  const domain = domainOf(form.url)
  const rivals = form.competitors.split(/[\n,]/).filter((v) => v.trim()).length
  const badges: Array<{ k: string; v: string; hint?: string }> = []

  // With no site there is no run to describe. `maxPages`, `maxKeywords` and
  // `runJev` are still sitting at their defaults, so printing them here would
  // state a configuration the operator never chose — a collapsed form that
  // reads "15 pages · 24 keywords · Jev on" for a run that does not exist.
  if (!domain) {
    return (
      <div className="formbanner" data-tour="form-banner">
        <Favicon domain="" />
        <span className="fb-domain" title="">
          no site yet
        </span>
        <span className="fb-badges">
          <span className="fb-badge">
            <span className="k">run</span>
            <span className="v">nothing to run yet</span>
          </span>
        </span>
        <button type="button" className="ghost fb-expand" onClick={onExpand}>
          Set up a run
        </button>
      </div>
    )
  }

  if (form.businessName.trim()) badges.push({ k: "business", v: form.businessName.trim() })
  if (form.market.trim()) badges.push({ k: "market", v: form.market.trim() })
  if (form.businessContext.trim()) {
    badges.push({ k: "context", v: `${form.businessContext.trim().split(/\s+/).length} words` })
  }
  badges.push({
    k: "rivals",
    v: rivals ? `${rivals}` : "none",
    hint: rivals ? "judged on the same rubric" : "no rival means the gap pass cannot run",
  })
  badges.push({ k: "pages", v: String(form.maxPages) })
  if (form.maxKeywords > 0) badges.push({ k: "keywords", v: String(form.maxKeywords) })
  badges.push({ k: "judge", v: form.runJev ? "Jev on" : "rules only" })

  return (
    <div className="formbanner" data-tour="form-banner">
      <Favicon domain={domain} />
      <span className="fb-domain" title={form.url}>
        {domain || "no site yet"}
      </span>
      <span className="fb-badges">
        {badges.map((b) => (
          <span className="fb-badge" key={b.k} title={b.hint ?? `${b.k}: ${b.v}`}>
            <span className="k">{b.k}</span>
            <span className="v">{b.v}</span>
          </span>
        ))}
      </span>
      <button type="button" className="ghost fb-expand" onClick={onExpand}>
        Edit run
      </button>
    </div>
  )
}

function Ring({ value, caption, hot }: { value: number; caption: string; hot?: boolean }) {
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const filled = (Math.max(0, Math.min(100, value)) / 100) * circumference
  return (
    <div className="ring">
      <svg width="108" height="108" viewBox="0 0 108 108">
        <circle cx="54" cy="54" r={radius} fill="none" stroke="var(--line)" strokeWidth="9" />
        <circle
          cx="54"
          cy="54"
          r={radius}
          fill="none"
          stroke={hot ? "var(--hot)" : "var(--ink)"}
          strokeWidth="9"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
      <div className="val">{Math.round(value)}</div>
      <div className="cap">{caption}</div>
    </div>
  )
}

interface Dim {
  k: string
  v: number
  hot?: boolean
}

function Dims({ dims }: { dims: Dim[] }) {
  return (
    <div className="dims">
      {dims.map((dim) => (
        <div className="dim" key={dim.k}>
          <div className="k">{dim.k}</div>
          <div className="track">
            <div
              className={`fill ${dim.hot ? "hot" : ""}`}
              style={{ width: `${Math.max(Math.min(dim.v * 100, 100), 1)}%` }}
            />
          </div>
          <div className="p">{Math.round(dim.v * 100)}%</div>
        </div>
      ))}
    </div>
  )
}

function Bars({ rows, hotFirst }: { rows: PatternCount[]; hotFirst?: boolean }) {
  if (rows.length === 0) return <div className="empty">Nothing classified yet.</div>
  return (
    <div className="bars">
      {rows.slice(0, 8).map((row, i) => (
        <div className="bar" key={row.label}>
          <div className="k" title={row.label}>
            {row.label.replace(/_/g, " ")}
          </div>
          <div className="track">
            <div
              className={`fill ${hotFirst && i === 0 ? "hot" : ""}`}
              style={{ width: `${Math.max(row.share * 100, 1)}%` }}
            />
          </div>
          <div className="n">
            {row.count} <b>{Math.round(row.share * 100)}%</b>
          </div>
        </div>
      ))}
    </div>
  )
}

function Histogram({ keywords }: { keywords: KeywordJudgement[] }) {
  const buckets = [0, 0, 0, 0, 0]
  for (const k of keywords) {
    const index = Math.min(4, Math.floor(k.opportunity * 5))
    buckets[index] = (buckets[index] ?? 0) + 1
  }
  const max = Math.max(...buckets, 1)
  return (
    <div className="hist">
      {buckets.map((count, i) => (
        <div className="col" key={i}>
          <div className="c">{count || ""}</div>
          <div className={`b ${i >= 3 ? "hot" : ""}`} style={{ height: `${(count / max) * 100}%` }} />
          <div className="l">{i * 20}%</div>
        </div>
      ))}
    </div>
  )
}

function MiniLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="foot" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
      {children}
    </div>
  )
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [view, setView] = useState<View>("pages")
  const [form, setForm] = useState<AuditForm>({
    url: "",
    businessName: "",
    businessContext: "",
    market: "",
    competitors: "",
    maxPages: 15,
    maxKeywords: 24,
    maxCompetitors: RIVAL_CAP_FALLBACK,
    concurrency: 8,
    runJev: true,
  })
  const [running, setRunning] = useState(false)
  const [pages, setPages] = useState<PageJudgement[]>([])
  const [keywords, setKeywords] = useState<KeywordJudgement[]>([])
  const [rivalSlots, setRivalSlots] = useState<RivalSlot[]>([])
  const [pending, setPending] = useState<Array<{ label: string; url: string; kind: View }>>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [report, setReport] = useState<AuditReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [stage, setStage] = useState<Stage>("idle")
  const [stageDetail, setStageDetail] = useState("")
  const [hasRun, setHasRun] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  const [gsc, setGsc] = useState<GscCheck>({
    configured: false,
    verified: false,
    permission: null,
    property: null,
    clientEmail: null,
    error: null,
    checked: false,
    checking: false,
  })
  const [autofill, setAutofill] = useState<AutofillRun | null>(null)
  const [tourSignal, setTourSignal] = useState(0)
  const [formOpen, setFormOpen] = useState(true)
  /**
   * The rest of the form — business name, market, rivals, budgets — is manual
   * input, and presearch fills all of it in. So it is hidden behind an explicit
   * control: someone who pastes a URL and presses presearch should not be shown
   * six fields they are about to have filled for them, and someone who wants to
   * override a guess should not have to hunt for the field.
   */
  const [manualOpen, setManualOpen] = useState(false)
  const [researching, setResearching] = useState(false)
  const [sessionLog, setSessionLog] = useState<LogLine[]>([])
  const [crawlLog, setCrawlLog] = useState<LogLine[]>([])
  const [crawlStage, setCrawlStage] = useState<SessionStage>("idle")
  const [sessionStage, setSessionStage] = useState<SessionStage>("idle")
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null)
  const [crawled, setCrawled] = useState<CrawledPage[]>([])
  const [liveGaps, setLiveGaps] = useState<GapRow[]>([])
  const [decisions, setDecisions] = useState<DecisionRow[]>([])
  const [subjects, setSubjects] = useState<SubjectRow[]>([])
  const [presearchPayload, setPresearchPayload] = useState<ResearchPayload | null>(null)
  const [crawlMeta, setCrawlMeta] = useState<CrawlMeta>({
    discovered: 0,
    robotsFetched: false,
    sitemapUrls: 0,
    errors: 0,
    done: false,
  })
  const [live, setLive] = useState({
    pagesCrawled: 0,
    pagesJudged: 0,
    keywordsJudged: 0,
    judgements: 0,
    questionsAsked: 0,
    costUsd: 0,
    elapsed: "0.0",
  })
  const startedAt = useRef<number>(0)
  const abortRef = useRef<AbortController | null>(null)
  const tickRef = useRef<number | null>(null)

  useEffect(() => {
    void fetchConfig()
      .then((loaded) => {
        setConfig(loaded)
        setGsc((prev) => ({ ...prev, configured: loaded.gscConfigured }))
      })
      .catch(() =>
        setConfig({
          jevConfigured: false,
          jevModel: "unknown",
          agentConfigured: false,
          agentModel: "unknown",
          gscConfigured: false,
          model: "unknown",
          defaults: { maxPages: 15, concurrency: 8 },
        }),
      )
  }, [])

  const checkGsc = useMemo(
    () => async (url: string) => {
      if (!url.trim()) {
        // No URL typed yet, but the key may already be on disk. Asking for the
        // property list is what makes a refresh reveal it: this check is the only
        // caller and it used to bail on an empty field, so a correctly installed
        // key rendered as "not connected" until the user typed something and ran
        // an audit. The badge is about the connection, not about the last URL.
        // The server decides: an empty list means no usable key, so there is no
        // need to read `configured` here and no stale closure to worry about.
        try {
          const response = await fetch(`${API}/api/gsc/properties`)
          const data = (await response.json()) as {
            properties?: GscProperty[]
            clientEmail?: string | null
          }
          const sites = data.properties ?? []
          // With no URL to check, the badge must reflect the best access this key
          // has to *any* property, not whichever one the API listed first: a key
          // that is Owner on one site and Full on another would render as the
          // weaker grant and claim reduced capacity while the strong one sits
          // unused in the same list.
          const rank: Record<string, number> = {
            siteOwner: 3,
            siteFullUser: 2,
            siteRestrictedUser: 1,
          }
          const best = [...sites].sort(
            (a, b) => (rank[b.permissionLevel] ?? 0) - (rank[a.permissionLevel] ?? 0),
          )[0]
          setGsc((prev) => ({
            ...prev,
            configured: sites.length > 0,
            verified: sites.length > 0,
            permission: (best?.permissionLevel ?? null) as GscCheck["permission"],
            property: prev.property ?? best?.siteUrl ?? null,
            clientEmail: prev.clientEmail ?? data.clientEmail ?? null,
            checked: sites.length > 0,
            checking: false,
          }))
        } catch {
          setGsc((prev) => ({ ...prev, checked: false, verifying: false, checking: false }))
        }
        return
      }
      setGsc((prev) => ({ ...prev, checking: true, error: null }))
      try {
        const response = await fetch(
          `${API}/api/gsc/status?url=${encodeURIComponent(url.trim())}`,
        )
        const data = (await response.json()) as {
          configured?: boolean
          verified?: boolean
          siteUrl?: string | null
          permissionLevel?: GscCheck["permission"]
          clientEmail?: string | null
          error?: string
        }
        setGsc({
          configured: Boolean(data.configured),
          verified: Boolean(data.verified),
          permission: data.permissionLevel ?? null,
          property: data.siteUrl ?? null,
          clientEmail: data.clientEmail ?? null,
          error: data.error ?? null,
          checked: true,
          checking: false,
        })
      } catch (cause) {
        setGsc((prev) => ({
          ...prev,
          checked: true,
          checking: false,
          error: (cause as Error).message,
        }))
      }
    },
    [],
  )

  useEffect(() => {
    void checkGsc(form.url)
  }, [form.url, checkGsc])

  useEffect(() => {
    if (!running) {
      if (tickRef.current) window.clearInterval(tickRef.current)
      return
    }
    tickRef.current = window.setInterval(() => {
      const seconds = (Date.now() - startedAt.current) / 1000
      setLive((prev) => ({ ...prev, elapsed: seconds.toFixed(1) }))
    }, 100)
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current)
    }
  }, [running])

  const logId = useRef(0)
  const sessionLogId = useRef(0)
  function push(text: string) {
    const kind: LogLine["kind"] = text.startsWith("✓")
      ? "good"
      : text.startsWith("✕")
        ? "bad"
        : text.startsWith("↻")
          ? "warn"
          : text.startsWith("■")
            ? "good"
            : "info"
    setLog((prev) => [...prev.slice(-200), { id: (logId.current += 1), text, kind }])
  }

  function resetRun() {
    logId.current = 0
    setStage("idle")
    setStageDetail("")
    setHasRun(true)
  }

  async function research() {
    setFormOpen(false)
    if (!form.url.trim() || researching) return
    setResearching(true)
    setAutofill(null)
    setSessionLog([])
    setCrawlLog([])
    setSessionSummary(null)
    setSessionStage("crawl")
    setCrawlStage("crawl")

    const id = (logId.current += 1)
    const add = (
      target: "crawl" | "session",
      text: string,
      kind: LogLine["kind"] = "info",
    ) => {
      const line = { id: id * 1000 + Math.floor(performance.now()), text, kind }
      if (target === "crawl") setCrawlLog((prev) => [...prev.slice(-200), line])
      else setSessionLog((prev) => [...prev.slice(-200), line])
    }
    const cs = (text: string) => add("crawl", text)
    const ss = (text: string, kind: LogLine["kind"] = "info") => add("session", text, kind)

    ss("▶ presearch: crawl first, then one opencode session")
    let sawResult = false

    try {
      const result = await runResearchStream(form.url.trim(), {
        signal: abortRef.current?.signal ?? new AbortController().signal,
        onEvent: (event) => {
          if (event.type === "stage") {
            if (event.stage === "crawl") {
              setCrawlStage("crawl")
              cs(`— ${event.detail}`)
            } else {
              setSessionStage("search")
              ss(`— ${event.detail}`)
            }
            return
          }
          if (event.type === "crawl") {
            if (event.kind === "page") {
              setCrawlStage("count")
              cs(
                `■ ${event.path} · ${event.status} · words=${event.words} · ${(event.title ?? "").slice(0, 70) || "(no title)"}`,
              )
            } else if (event.kind === "error") {
              cs(`✕ ${event.url} — ${event.message}`)
            } else {
              setCrawlStage("done")
              cs(`✓ crawl finished: ${event.pages} page(s) measured`)
            }
            return
          }
          if (event.type === "session") {
            if (event.kind === "session") {
              ss(`— session ${event.text}`)
            } else if (event.kind === "tool") {
              setSessionStage("search")
              ss(`— ${event.tool} ${event.status}`)
            } else if (event.kind === "reasoning") {
              // Prefixed so the log stays readable: the model thinking is not the
              // same class of line as what it wrote back, and the distinction is
              // what tells a run that is reasoning from one that has stalled.
              ss(`· ${(event.text ?? "").slice(0, 160)}`, "warn")
            } else if (event.kind === "text") {
              setSessionStage("write")
              ss(`— ${(event.text ?? "").slice(0, 160)}`)
            }
            return
          }
          if (event.type === "result") {
            sawResult = true
            setAutofill(event)
          } else if (event.type === "error") {
            ss(`✕ ${event.message}`, "bad")
          }
        },
        onError: (message) => ss(`✕ ${message}`, "bad"),
        onClose: () => undefined,
      })

      setSessionStage("done")

      if (result && !result.degraded) {
        const payload = (result.data ?? {}) as Record<string, unknown>
        const rivals = Array.isArray(payload.competitors) ? (payload.competitors as unknown[]) : []
        const seeds = Array.isArray(payload.keyword_seeds) ? (payload.keyword_seeds as unknown[]) : []
        const receipt = result.receipt

        setPresearchPayload(result.data)

        setSessionSummary({
          model: receipt?.model ?? "opencode",
          ms: receipt?.ms ?? 0,
          toolsCalled: (receipt?.toolsCalled ?? []).length,
          competitors: rivals.length,
          seeds: seeds.length,
          degraded: false,
          aiTools: receipt?.aiTools ?? 0,
          aiMsgs: receipt?.aiMsgs ?? 0,
        })

        applyAutofill({
          businessName: String(payload.business_name ?? form.businessName ?? ""),
          businessContext: String(payload.business_summary ?? form.businessContext ?? ""),
          market: String(payload.market ?? form.market ?? ""),
          competitors: rivals
            .map((c) => String((c as { name?: unknown }).name ?? ""))
            .filter(Boolean)
            .join("\n"),
        })
        ss(`✓ ${rivals.length} rivals, ${seeds.length} keyword seeds — the form is filled`, "good")
      } else if (result) {
        setSessionSummary({
          model: result.receipt?.model ?? "opencode",
          ms: result.receipt?.ms ?? 0,
          toolsCalled: 0,
          competitors: 0,
          seeds: 0,
          degraded: true,
          aiTools: result.receipt?.aiTools ?? 0,
          aiMsgs: result.receipt?.aiMsgs ?? 0,
          reason: result.reason ?? undefined,
        })
        ss(`✕ presearch degraded: ${result.reason ?? "unknown reason"} — your own values are kept`, "bad")
      } else if (!sawResult) {
        ss("✕ presearch ended without a result", "bad")
      }
    } catch (cause) {
      ss(`✕ presearch failed: ${(cause as Error).message}`, "bad")
    } finally {
      setResearching(false)
    }
  }

  function applyAutofill(values: {
    businessName: string
    businessContext: string
    market: string
    competitors: string
  }) {
    setForm((prev) => ({ ...prev, ...values }))
    push("✓ agent values applied — run the audit when you are ready")
  }

  async function start() {
    if (!form.url.trim() || running) return
    setRunning(true)
    setFormOpen(false)
    setError(null)
    setPages([])
    setKeywords([])
    setRivalSlots([])
    setPending([])
    setSelected(null)
    setReport(null)
    setLog([])
    setCrawled([])
    setLiveGaps([])
    setDecisions([])
    setSubjects([])
    setCrawlMeta({ discovered: 0, robotsFetched: false, sitemapUrls: 0, errors: 0, done: false })
    resetRun()
    startedAt.current = Date.now()
    setLive({
      pagesCrawled: 0,
      pagesJudged: 0,
      keywordsJudged: 0,
      judgements: 0,
      questionsAsked: 0,
      costUsd: 0,
      elapsed: "0.0",
    })

    const controller = new AbortController()
    abortRef.current = controller

    await runAudit(
      form,
      {
        signal: controller.signal,
        onEvent: (event: AuditEvent) => {
          switch (event.type) {
            case "start":
              push(
                `▶ ${event.model} · ${event.concurrency} in flight · jev ${event.jevEnabled ? "on" : "off (partial)"}`,
              )
              break
            case "stage": {
              const key = event.stage.toLowerCase()
              setStage(
                key.startsWith("crawl")
                  ? "crawl"
                  : key.startsWith("keyword")
                    ? "keywords"
                    : key.startsWith("competitor")
                      ? "rivals"
                      : "site",
              )
              setStageDetail(event.detail)
              push(`— ${event.stage}: ${event.detail}`)
              break
            }
            case "crawl":
              setStage("crawl")
              setStageDetail(
                `${event.pages} pages measured, ${event.discovered} links seen, ${event.errors} fetch errors`,
              )
              setCrawlMeta({
                discovered: event.discovered,
                robotsFetched: event.robotsFetched,
                sitemapUrls: event.sitemapUrls,
                errors: event.errors,
                done: true,
              })
              setLive((prev) => ({ ...prev, pagesCrawled: event.pages }))
              push(
                `✓ crawl · ${event.pages} pages · robots ${event.robotsFetched ? "read" : "absent"} · ${event.discovered} links`,
              )
              break
            case "page-crawled": {
              const { page } = event
              setCrawled((prev) =>
                prev.some((p) => p.url === page.url)
                  ? prev.map((p) => (p.url === page.url ? { ...p, ...page } : p))
                  : [...prev, page],
              )
              setStage("crawl")
              setStageDetail(`${page.path} measured`)
              break
            }
            case "gap-done":
              setLiveGaps((prev) => [
                ...prev.filter((g) => g.term !== event.gap.term),
                event.gap,
              ])
              break
            // Upserted, not appended: a replayed event must not duplicate a card.
            case "decision":
              setDecisions((prev) => [
                ...prev.filter((d) => d.url !== event.decision.url),
                event.decision,
              ])
              break
            case "subject":
              setSubjects((prev) => [
                ...prev.filter((s) => s.id !== event.subject.id),
                event.subject,
              ])
              break
            case "page-start":
              setStage("pages")
              setStageDetail("one typed call per page")
              setPending((prev) => [...prev, { label: event.path, url: event.url, kind: "pages" }])
              break
            case "page-done":
              setPages((prev) => [...prev, event.page])
              setPending((prev) => prev.filter((p) => p.url !== event.page.url))
              setSelected((prev) => prev ?? `page:${event.page.url}`)
              setLive((prev) => ({
                ...prev,
                pagesJudged: prev.pagesJudged + 1,
                questionsAsked: prev.questionsAsked + 14,
                judgements: prev.judgements + 1,
                costUsd: Number((prev.costUsd + event.page.costUsd).toFixed(6)),
              }))
              break
            case "keyword-start":
              setPending((prev) => [...prev, { label: event.term, url: `kw:${event.term}`, kind: "keywords" }])
              break
            case "keyword-done":
              setKeywords((prev) => [...prev, event.keyword])
              setPending((prev) => prev.filter((p) => p.url !== `kw:${event.keyword.term}`))
              setSelected((prev) => prev ?? `kw:${event.keyword.term}`)
              setLive((prev) => ({
                ...prev,
                keywordsJudged: prev.keywordsJudged + 1,
                questionsAsked: prev.questionsAsked + 6,
                judgements: prev.judgements + 1,
                costUsd: Number((prev.costUsd + event.keyword.costUsd).toFixed(6)),
              }))
              break
            case "competitor-start":
              setRivalSlots((prev) => {
                const key = rivalKey(event.url)
                if (prev.some((slot) => slot.key === key)) return prev
                return [
                  ...prev,
                  { key, requested: event.url, index: event.index, result: null },
                ]
              })
              break
            case "competitor-done": {
              const key = rivalKey(event.competitor.url)
              setRivalSlots((prev) => {
                const at = prev.findIndex((slot) => slot.key === key)
                if (at === -1) {
                  return [
                    ...prev,
                    {
                      key,
                      requested: event.competitor.url,
                      index: prev.length,
                      result: event.competitor,
                    },
                  ]
                }
                return prev.map((slot, i) =>
                  i === at ? { ...slot, result: event.competitor } : slot,
                )
              })
              if (event.competitor.reachable) {
                setLive((prev) => ({
                  ...prev,
                  questionsAsked: prev.questionsAsked + 6,
                  judgements: prev.judgements + 1,
                  costUsd: Number((prev.costUsd + event.competitor.costUsd).toFixed(6)),
                }))
              }
              break
            }
            case "retry":
              push(`↻ retry ${event.attempt} · ${event.url}`)
              break
            case "error":
              push(`✕ ${event.message}`)
              if (/^https?:\/\//.test(event.url)) {
                setCrawlMeta((prev) => ({ ...prev, errors: prev.errors + 1 }))
                setCrawled((prev) =>
                  prev.some((p) => p.url === event.url)
                    ? prev
                    : [
                        ...prev,
                        {
                          url: event.url,
                          path: event.url.replace(/^https?:\/\//, ""),
                          status: 0,
                          words: 0,
                          title: event.message,
                        },
                      ],
                )
              }
              break
            case "summary": {
              const t = event.totals
              setStage("done")
              setStageDetail(`${t.judgements} judgements, ${t.questionsAsked} questions`)
              setLive({
                pagesCrawled: t.pagesCrawled,
                pagesJudged: t.pagesJudged,
                keywordsJudged: t.keywordsJudged,
                judgements: t.judgements,
                questionsAsked: t.questionsAsked,
                costUsd: t.costUsd,
                elapsed: (t.elapsedMs / 1000).toFixed(1),
              })
              push(
                `■ ${event.score}/100 ${event.grade} · ${t.judgements} judgements · ${t.questionsAsked} questions · $${t.costUsd.toFixed(5)} · median ${t.medianMs}ms`,
              )
              break
            }
            case "done":
              setReport(event.report)
              // The report is authoritative; the live lists are the same rows
              // mid-run and are only kept when the server returned none.
              if (event.report.decisions?.length) setDecisions(event.report.decisions)
              if (event.report.subjects?.length) setSubjects(event.report.subjects)
              break
          }
        },
        onError: (message) => setError(message),
        onClose: () => setRunning(false),
      },
      presearchPayload
        ? {
            keywordSeeds: presearchPayload.keyword_seeds,
            metrics: presearchPayload.metrics,
            rivalProposals: presearchPayload.competitors,
          }
        : undefined,
    )
  }

  const selectedKeyword = useMemo(
    () => keywords.find((k) => `kw:${k.term}` === selected) ?? null,
    [keywords, selected],
  )
  const selectedPage = useMemo(
    () => pages.find((p) => `page:${p.url}` === selected) ?? null,
    [pages, selected],
  )
  const crawlRows = useMemo(() => {
    const final = new Map((report?.crawled ?? []).map((c) => [c.url, c]))
    const merged = crawled.map((p) => {
      const back = final.get(p.url)
      return back ? { ...p, ...back } : p
    })
    const seen = new Set(merged.map((p) => p.url))
    return [...merged, ...[...final.values()].filter((c) => !seen.has(c.url))]
  }, [crawled, report])

  const selectedCrawled = useMemo(
    () => crawlRows.find((c) => `crawl:${c.url}` === selected) ?? null,
    [crawlRows, selected],
  )

  const elapsedSeconds = Number(live.elapsed)
  const perSecond = elapsedSeconds > 0 ? Math.round(live.judgements / elapsedSeconds) : 0

  const pagesCrawledLive = Math.max(live.pagesCrawled, crawlRows.length)
  const crawlRunning = running && (stage === "crawl" || !report)

  const allJudged = report
    ? report.totals.pagesJudged + report.totals.keywordsJudged + report.totals.competitorsJudged
    : 0
  const needsHumanCount =
    pages.filter((p) => p.needsHuman).length + keywords.filter((k) => k.needsHuman).length

  const pageFindings = report?.findings ?? []
  const topKeywords = report?.keywords ?? []

  const wordsByUrl = useMemo(
    () => new Map(crawlRows.map((row) => [row.url, row.words])),
    [crawlRows],
  )

  const judgedPageCount = pages.length > 0 ? pages.length : (report?.totals.pagesJudged ?? 0)
  const newPageCount = subjects.filter((s) => s.isNewPage).length
  const refreshCount = subjects.length - newPageCount

  /**
   * The gate's own `notDecided` list plus the grey-zone items Jev returned
   * mid-run, de-duplicated by url.
   *
   * A page that produced a decision is still listed when anything on it landed
   * in the grey zone. "Decided" and "committed on every question" are different
   * things: a page can earn a rewrite in 02 and still leave
   * `competitor_distinctiveness` at P(yes) 0.55, and that uncertainty is exactly
   * what this panel exists to surface. Filtering these out by `decidedUrls` made
   * the panel read 0 on runs where Jev was genuinely unsure — the list was
   * emptying itself, which is the one thing an honesty panel must never do.
   *
   * A page appearing in both 02 and 05 is not duplication. 02 is the work,
   * 05 is where the work came from and what is still open.
   */
  const notDecided = useMemo(() => {
    const seen = new Set<string>()
    const rows: Array<{ url: string; path: string; reason: string; bandLabel: string }> = []
    for (const item of report?.notDecided ?? []) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      rows.push({ ...item, bandLabel: "to verify" })
    }
    for (const page of pages) {
      if (seen.has(page.url) || !page.needsHuman) continue
      seen.add(page.url)
      rows.push({
        url: page.url,
        path: page.path,
        reason: page.reasons.join(" · ") || "spread",
        bandLabel: page.band === "escalate" ? "needs a human" : "to verify",
      })
    }
    for (const keyword of keywords) {
      if (!keyword.needsHuman) continue
      rows.push({
        url: `kw:${keyword.term}`,
        path: keyword.term,
        reason: keyword.reasons.join(" · ") || "borderline",
        bandLabel: keyword.band === "escalate" ? "needs a human" : "to verify",
      })
    }
    return rows
  }, [report?.notDecided, pages, keywords])

  const notDecidedCount = notDecided.length

  /**
   * Slots carry the dequeue order, so panel 04 renders them as they arrived.
   * The report's flat `competitors[]` is the fallback for a report that
   * arrived without live slots behind it; it has no pending state to lose.
   */
  const slots = useMemo(() => {
    if (rivalSlots.length > 0) return [...rivalSlots].sort((a, b) => a.index - b.index)
    return (report?.competitors ?? []).map((result, index) => ({
      key: rivalKey(result.url),
      requested: result.url,
      index,
      result,
    }))
  }, [rivalSlots, report?.competitors])

  const rivalsNow = useMemo(
    () => slots.flatMap((slot) => (slot.result ? [slot.result] : [])),
    [slots],
  )
  const rivalsReachable = rivalsNow.filter((c) => c.reachable).length
  const rivalsJudged = rivalsNow.length
  const rivalsInFlight = slots.length - rivalsJudged
  const rivalsEntered = parseRivals(form.competitors).length
  const rivalCap = Math.max(1, form.maxCompetitors)
  const rivalsJudgedThisRun = Math.min(rivalsEntered, rivalCap)
  const rivalsPastCap = Math.max(0, rivalsEntered - rivalCap)

  const delta = report?.delta ?? null
  const proposals = presearchPayload?.competitors ?? []
  const presearchRan = report?.presearch?.ran ?? presearchPayload !== null
  const presearchDegraded = report?.presearch?.degraded ?? sessionSummary?.degraded ?? false
  const presearchReason = report?.presearch?.reason ?? sessionSummary?.reason ?? null

  return (
    <div className="shell">
      <div className="topbar">
        <div className="headline" data-tour="headline">
          <h1>what your site is leaving on the table</h1>
          <div className="sub">
            {form.url || "any site"} ·{" "}
            {report
              ? `${report.totals.pagesCrawled} pages · ${report.totals.keywordsJudged} keywords · ${report.totals.competitorsJudged} rivals · every number from a real run`
              : "enter a site below · typed judgements, probabilities kept"}
          </div>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="ghost"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => setTourSignal((n) => n + 1)}
        >
          Take the tour
        </button>
        {config && (
          <CapacityCluster
            config={config}
            gsc={gsc}
            url={form.url}
            onOpenOnboarding={() => setOnboardingOpen(true)}
            onRecheck={() => void checkGsc(form.url)}
            onAgentModelChanged={(model) =>
              setConfig((prev) => (prev ? { ...prev, agentModel: model } : prev))
            }
          />
        )}
      </div>

      {!onboardingDismissed && !gsc.verified && (
        <div className="note" style={{ marginBottom: 14 }}>
          New here?{" "}
          <button
            type="button"
            className="ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => setOnboardingOpen(true)}
          >
            Connect Search Console
          </button>{" "}
          for full capacity, or{" "}
          <button
            type="button"
            className="ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => setOnboardingDismissed(true)}
          >
            skip
          </button>
          .{" "}
          {onboardingDismissed ? "" : "The audit works either way — it just runs without your own ranking data."}
        </div>
      )}

      <div data-tour="crawl">
        <CrawlBar
          stage={crawlStage}
          running={researching && crawlStage !== "done"}
          hasRun={crawlLog.length > 0}
          log={crawlLog}
        />
      </div>

      <div data-tour="presearch">
        <SessionBar
          stage={sessionStage}
          running={researching && sessionStage !== "done"}
          hasRun={sessionSummary !== null}
          log={sessionLog}
          summary={sessionSummary}
          queued={researching && crawlStage !== "done"}
        />
      </div>

      {error && <div className="err">{error}</div>}

      {!formOpen && <FormBanner form={form} onExpand={() => setFormOpen(true)} />}

      {formOpen && (
      <section className="form" data-tour="form">
        <button
          type="button"
          className="formtoggle"
          onClick={() => setFormOpen(false)}
          title="Collapse the form and show the run summary"
          aria-label="Collapse the form"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="field span2">
          <div className="urlrow">
            <div className="urlgrow">
              <label htmlFor="url">Website URL</label>
              <input
                id="url"
                type="text"
                placeholder="https://trustmrr.com/"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void start()
                }}
              />
            </div>
            <PropertyPicker
              onPick={(url) => {
                setForm((prev) => ({ ...prev, url }))
                void checkGsc(url)
              }}
            />
          </div>
        </div>

        <button
          type="button"
          className={`manualtoggle${manualOpen ? " open" : ""}`}
          onClick={() => setManualOpen((v) => !v)}
          aria-expanded={manualOpen}
          aria-controls="manual-fields"
        >
          <span>{manualOpen ? "Hide manual fields" : "Fill it in myself"}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {manualOpen && (
        <div className="manual-fields" id="manual-fields">
        <div className="field">
          <label htmlFor="name">Business name</label>
          <input
            id="name"
            type="text"
            placeholder="TrustMRR"
            value={form.businessName}
            onChange={(e) => setForm({ ...form, businessName: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="market">Market</label>
          <input
            id="market"
            type="text"
            placeholder="Worldwide, English-speaking"
            value={form.market}
            onChange={(e) => setForm({ ...form, market: e.target.value })}
          />
        </div>

        <div className="field span2" data-tour="context">
          <label htmlFor="ctx">What the business actually does</label>
          <textarea
            id="ctx"
            placeholder="Verified customer reviews for SaaS and online services. Revenue comes from subscriptions, with a free tier that buyers can use before they pay."
            value={form.businessContext}
            onChange={(e) => setForm({ ...form, businessContext: e.target.value })}
          />
          <span className="hint">
            Only you know this. It goes into the Jev state so the model grades against your real business.
          </span>
        </div>

        <div className="field span2" data-tour="rivals-input">
          <label htmlFor="comp">Competitors — one per line</label>
          <textarea
            id="comp"
            placeholder={"g2.com\ncapterra.com\ntrustpilot.com"}
            value={form.competitors}
            onChange={(e) => setForm({ ...form, competitors: e.target.value })}
            style={{ minHeight: 54 }}
          />
          <div className="capline">
            <span
              className="capnum"
              title="Rivals this run judges, out of the rivals you entered. Anything past the cap is never crawled."
            >
              {rivalsJudgedThisRun} of {rivalsEntered} rivals entered are judged this run
            </span>
            {rivalsPastCap > 0 && (
              <span className="capwarn" title="These sit past the cap and are never crawled.">
                {rivalsPastCap} past the cap, never crawled
              </span>
            )}
          </div>
          <div className="capctl">
            <label htmlFor="rivalcap">Rival cap</label>
            <input
              id="rivalcap"
              type="number"
              min={1}
              max={20}
              value={form.maxCompetitors}
              onChange={(e) =>
                setForm({
                  ...form,
                  maxCompetitors: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                })
              }
            />
            <span className="hint">
              Judged on the same rubric, so the scorecards compare. This run crawls the first {rivalCap}{" "}
              {rivalCap === 1 ? "rival" : "rivals"} you list.
            </span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="pages">Pages</label>
          <input
            id="pages"
            type="number"
            min={1}
            max={60}
            value={form.maxPages}
            onChange={(e) => setForm({ ...form, maxPages: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="kw">Keywords</label>
          <input
            id="kw"
            type="number"
            min={0}
            max={60}
            value={form.maxKeywords}
            onChange={(e) => setForm({ ...form, maxKeywords: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="conc">Concurrency</label>
          <input
            id="conc"
            type="number"
            min={1}
            max={20}
            value={form.concurrency}
            onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })}
          />
        </div>
        <div className="field inline">
          <input
            id="runjev"
            type="checkbox"
            checked={form.runJev}
            onChange={(e) => setForm({ ...form, runJev: e.target.checked })}
          />
          <label htmlFor="runjev">Use Jev</label>
        </div>
        </div>
        )}
        <div className="actions" data-tour="run">
          <button
            className="primary"
            onClick={() => void research()}
            disabled={!form.url.trim() || researching || running}
          >
            {researching ? "Presearching…" : "Run presearch"}
          </button>
          {running ? (
            <button
              className="ghost"
              onClick={() => {
                abortRef.current?.abort()
                setRunning(false)
              }}
            >
              Stop
            </button>
          ) : (
            <button className="primary" onClick={() => void start()} disabled={!form.url.trim()}>
              Run audit
            </button>
          )}
        </div>
      </section>
      )}

      {log.some((line) => line.kind === "bad") && (
        <details className="errstrip" open>
          <summary>
            {log.filter((line) => line.kind === "bad").length} problem
            {log.filter((line) => line.kind === "bad").length === 1 ? "" : "s"} during this
            run — open for detail
          </summary>
          <div className="errlines">
            {log
              .filter((line) => line.kind === "bad")
              .slice(-12)
              .map((line) => (
                <div key={line.id}>{line.text}</div>
              ))}
          </div>
        </details>
      )}

      <div className="counters" data-tour="counters">
        <div className="counter dark">
          <div className="k">Pages scraped</div>
          <div className="v">{pagesCrawledLive}</div>
        </div>
        <div className="counter">
          <div className="k">Typed judgements</div>
          <div className="v">{allJudged || live.judgements}</div>
        </div>
        <div className="counter">
          <div className="k">Keywords</div>
          <div className="v">
            {live.keywordsJudged}
            <span className="u">/{report ? report.keywordPool.length : form.maxKeywords}</span>
          </div>
        </div>
        <div className="counter">
          <div className="k">Judgements / sec</div>
          <div className="v">{perSecond}</div>
        </div>
        <div className="counter">
          <div className="k">Elapsed</div>
          <div className="v">
            {live.elapsed}
            <span className="u">s</span>
          </div>
        </div>
        <div className="counter">
          <div className="k">Cost so far</div>
          <div className="v">
            <span className="u">$</span>
            {live.costUsd.toFixed(5)}
          </div>
        </div>
      </div>

      <div className="split">
        <section className="half scraped" aria-labelledby="scraped-h" data-tour="scraped">
          <div className="halfhead">
            <span className="idx">01</span>
            <h2 id="scraped-h">scraped</h2>
            <span className="what">
              What the crawler measured. Every number here is countable in code — fetched, timed, counted.
              Nothing in this half came out of a model, so you can trust it before you read a single
              recommendation.
            </span>
            <span className="count">
              {crawlRows.length} page{crawlRows.length === 1 ? "" : "s"} ·{" "}
              {crawlMeta.discovered || 0} links seen
            </span>
          </div>
          <div className="halfbody">
            <CrawlTable
              pages={crawlRows}
              meta={crawlMeta}
              running={crawlRunning}
              selected={selected}
              onPick={(url) => setSelected(`crawl:${url}`)}
            />
          </div>
        </section>

        <section className="half advice" aria-labelledby="dnow-h" data-tour="dnow">
          <div className="halfhead">
            <span className="idx">02</span>
            <h2 id="dnow-h">to do on {domainOf(form.url) || "your website"}</h2>
            <span className="what">One change per page, the one Jev ranked first, each with the counted fact behind it.</span>
            <span className="count">
              {decisions.length} pages decided · {notDecidedCount} held back in 05
            </span>
            {delta && (
              <span className="count dcount">
                <RunDiffCount delta={delta} />
              </span>
            )}
          </div>
          <div className="halfbody">
            <Explain>
              <b>What this gives you:</b> the single highest-ranked edit per page, and the fact that
              produced it.
            </Explain>
            <DoThisNow
              decisions={decisions}
              wordsByUrl={wordsByUrl}
              running={running && !report}
              crawled={crawlRows.length}
              pagesJudged={judgedPageCount}
              held={notDecidedCount}
              site={report?.root ?? form.url}
              generatedAt={report?.generatedAt ?? new Date().toISOString()}
              model={report?.model ?? config?.model ?? ""}
              delta={delta}
            />
          </div>
        </section>

        <section className="half advice" aria-labelledby="rivals-h" data-tour="rivals-panel">
          <div className="halfhead">
            <span className="idx">03</span>
            <h2 id="rivals-h">rivals</h2>
            <span className="what">Side by side on the same rubric, judged from pages crawled off each rival&rsquo;s own site.</span>
            <span
              className="count"
              title="Rivals that returned a usable crawl, out of the rivals this run judges."
            >
              {rivalsReachable} of {rivalsJudgedThisRun} rivals reachable
              {rivalsInFlight > 0 ? ` · ${rivalsInFlight} still crawling` : ""}
            </span>
          </div>
          <div className="halfbody">
            <Explain>
              <b>What this gives you:</b> the topics a rival covers that you do not, and the angle they
              took.
            </Explain>
            <RivalsPanel
              self={{
                url: form.url,
                score: report ? report.score : null,
                grade: report?.grade ?? "",
                meta: report
                  ? `${report.totals.pagesCrawled} pages · ${report.totals.keywordsJudged} keywords`
                  : "not run",
              }}
              rivals={rivalsNow}
              slots={slots}
              proposals={proposals}
              metrics={presearchPayload?.metrics ?? []}
              running={running && !report}
              hasRun={hasRun}
              requested={rivalsJudgedThisRun}
              presearchRan={presearchRan}
              presearchDegraded={presearchDegraded}
              presearchReason={presearchReason}
            />
          </div>
        </section>

<section className="half advice" aria-labelledby="pages-h" data-tour="pages-to-build">
          <div className="halfhead">
            <span className="idx">04</span>
            <h2 id="pages-h">pages to build</h2>
            <span className="what">Only terms someone actually typed, or that a rival already published for.</span>
            <span className="count">
              {newPageCount} to build · {refreshCount} sent to refresh in 02 instead
            </span>
          </div>
          <div className="halfbody">
            <Explain>
              <b>What this gives you:</b> the terms that earned a new page, and where each one should
              point.
            </Explain>
            <PagesToBuild
              subjects={subjects}
              running={running && !report}
              hasRun={hasRun}
              presearchRan={presearchRan}
              presearchReason={presearchReason}
              termsJudged={report ? report.totals.keywordsJudged : keywords.length}
              refreshCount={refreshCount}
            />
          </div>
        </section>

        <section className="half advice" aria-labelledby="undecided-h" data-tour="undecided">
          <div className="halfhead">
            <span className="idx">05</span>
            <h2 id="undecided-h">not decided</h2>
            <span className="what">
              Everything above this line is something the model committed to. This line is the honest
              edge of it.
            </span>
            <span className="count">{notDecidedCount} in the grey zone · not acted on</span>
          </div>
          <div className="halfbody">
            <Explain>
              <b>What this gives you:</b> what Jev refused to commit to, so you can judge it yourself.
            </Explain>
            <details className="undecided">
              <summary>
                <span className="uk">held-back list</span>
                <span className="ud">
                  What Jev refused to commit to, so you can judge it yourself. Nothing here carries a fix.
                </span>
                <span className="uc">
                  {notDecidedCount} item{notDecidedCount === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="ubody">
                {notDecided.length === 0 ? (
                  <div className="dempty">
                    {running && (pages.length > 0 || keywords.length > 0) ? (
                      <>
                        <b>nothing held back yet</b>
                        <p>
                          Still judging. This list fills as answers land outside the decisive band, so an
                          empty one mid-run means nothing so far — not that there is nothing.
                        </p>
                      </>
                    ) : hasRun ? (
                      <>
                        <b>nothing in the grey zone</b>
                        <p>
                          Every answer Jev gave landed inside the decisive band, so nothing is held back
                          for you to check.
                        </p>
                      </>
                    ) : (
                      <>
                        <b>no run yet</b>
                        <p>Nothing has been judged, so nothing is being held back. Run an audit to fill this panel.</p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="ureasons">
                    {notDecided.map((item) => (
                      <div className="ureason" key={item.url}>
                        <span className="ut">{item.bandLabel}</span>
                        <span className="uu" title={item.url}>
                          {item.path}
                        </span>
                        <span className="ur">why it was held back · {item.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        </section>

        <div data-tour="evidence">
          <details className="drawer">
            <summary>
              <span className="dhead">evidence</span>
              <span className="dsub">
                Everything the run measured, kept in one collapsed place so the sections above stay
                decisions. Per-item teardowns, batch patterns, the ranked findings and the score live
                here — grouped by entity, not used to navigate between them.
              </span>
              <span className="dcount">
                {pages.length} pages · {keywords.length} subjects · {rivalsNow.length} rivals
              </span>
            </summary>
            <div className="dbody">
              <div data-tour="board">
                <OpportunityBoard
                  keywords={report ? report.keywords : keywords}
                  gaps={report ? report.gaps : liveGaps}
                  competitors={rivalsNow}
                  judgedTotal={report ? report.totals.keywordsJudged : keywords.length}
                  judgedAll={keywords}
                  keywordsEnabled={form.maxKeywords > 0}
                  hasRun={hasRun}
                  rivals={rivalsNow}
                  pages={pages.length > 0 ? pages : (report?.pages ?? [])}
                  running={running && !report}
                />
                <Explain>
                  <b>What this gives you:</b> the raw gap table behind section 04 — every mined term,
                  who covers it, whether you do, and where a page would go. Section 04 is the shortlist
                  drawn from it; this is the whole set, including the rows the gate dropped.
                </Explain>
              </div>

            <div className="segrow" data-tour="tabs">
              <span className="seglabel">group the archive by entity</span>
              {(["pages", "keywords", "competitors"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`seg ${view === v ? "on" : ""}`}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {v}
                  {v === "pages" && pages.length > 0 ? <span className="c">{pages.length}</span> : ""}
                  {v === "keywords" && keywords.length > 0 ? <span className="c">{keywords.length}</span> : ""}
                  {v === "competitors" && rivalsNow.length > 0 ? (
                    <span className="c">{rivalsNow.length}</span>
                  ) : ""}
                </button>
              ))}
            </div>

            <div className="grid wall">
              <div className="panel tight">
                <h2 className="hed">
                  {view === "pages"
                    ? "every page judged"
                    : view === "keywords"
                      ? "every keyword judged"
                      : "every rival judged"}
                  <span className="tag">
                    {view === "competitors"
                      ? `${rivalsJudged} / ${rivalsEntered}`
                      : `${live.pagesJudged + live.keywordsJudged}${
                          report && report.keywordPool.length > 0
                            ? ` / ${report.totals.pagesJudged + report.keywordPool.length}`
                            : ""
                        }`}
                  </span>
                </h2>
                <Explain>
                  <b>What this gives you:</b> every item the model ruled on, switchable by type. The
                  colour is the confidence band, not a quality grade — click any row to open its teardown.
                </Explain>
                <div className="legend">
                  <span className="k">
                    <span className="sw" style={{ background: "#1f7a4d" }} /> decisive
                  </span>
                  <span className="k">
                    <span className="sw" style={{ background: "#b8860b" }} /> to verify
                  </span>
                  <span className="k">
                    <span className="sw" style={{ background: "#ff5a1f" }} /> needs a human
                  </span>
                  <span className="k">
                    <span className="sw" style={{ background: "#d8d5ce" }} /> queued
                  </span>
                  <span className="count">1x speed</span>
                </div>

                {view === "pages" && (
                  <div className="wall">
                    {pages.map((page) => (
                      <div
                        key={page.url}
                        className={`wallrow band-${page.band} ${selected === `page:${page.url}` ? "sel" : ""}`}
                        onClick={() => setSelected(`page:${page.url}`)}
                      >
                        <div className="t" title={page.path}>
                          {page.path}
                        </div>
                        <div className="m">
                          <span className="big">{page.findings.length}</span>
                          <span className="ms">{page.ms}ms</span>
                        </div>
                      </div>
                    ))}
                    {pending
                      .filter((p) => p.kind === "pages")
                      .map((p) => (
                        <div key={p.url} className="wallrow band-pending">
                          <div className="t" title={p.label}>
                            {p.label}
                          </div>
                          <div className="m">
                            <span className="big">···</span>
                          </div>
                        </div>
                      ))}
                    {/* Crawled but not judged — the page exists, Jev has not ruled on
                        it yet. Fills from the same live list the SCRAPED table uses. */}
                    {crawlRows
                      .filter((c) => !pages.some((p) => p.url === c.url))
                      .map((c) => (
                        <div
                          key={c.url}
                          className={`wallrow band-review ${selected === `crawl:${c.url}` ? "sel" : ""}`}
                          onClick={() => setSelected(`crawl:${c.url}`)}
                        >
                          <div className="t" title={c.path}>
                            {c.path}
                          </div>
                          <div className="m">
                            <span className="big">{c.ruleFindings ?? 0}</span>
                            <span className="ms">{c.words}w</span>
                          </div>
                        </div>
                      ))}
                    {pages.length === 0 && pending.length === 0 && crawlRows.length === 0 && (
                      <div className="empty">Nothing crawled yet.</div>
                    )}
                  </div>
                )}

                {view === "keywords" && (
                  <div className="wall">
                    {keywords.map((k) => (
                      <div
                        key={k.term}
                        className={`wallrow band-${k.band} ${selected === `kw:${k.term}` ? "sel" : ""}`}
                        onClick={() => setSelected(`kw:${k.term}`)}
                      >
                        <div className="t" title={k.term}>
                          {k.term}
                        </div>
                        <div className="m">
                          <span className="big">{Math.round(k.opportunity * 100)}</span>
                          <span className="ms">{k.ms}ms</span>
                        </div>
                      </div>
                    ))}
                    {pending
                      .filter((p) => p.kind === "keywords")
                      .map((p) => (
                        <div key={p.url} className="wallrow band-pending">
                          <div className="t" title={p.label}>
                            {p.label}
                          </div>
                          <div className="m">
                            <span className="big">···</span>
                          </div>
                        </div>
                      ))}
                    {keywords.length === 0 && pending.length === 0 && <div className="empty">No keywords mined yet.</div>}
                  </div>
                )}

                {view === "competitors" && (
                  <div className="comps">
                    <div className="comp me">
                      <div className="g">{report?.grade ?? "–"}</div>
                      <div className="d">
                        <div className="h">
                          {form.url || "your site"}
                          <span className="mebadge">you</span>
                        </div>
                        <div className="m">
                          {report
                            ? `${report.totals.pagesCrawled} pages · ${report.totals.keywordsJudged} keywords`
                            : "not run"}
                        </div>
                      </div>
                      <div className="s">{report ? report.score : "–"}</div>
                      <div className="copy" />
                    </div>
                    {rivalsNow.map((c) => (
                      <div className="comp" key={c.url}>
                        <div className="g">{c.reachable ? c.grade : "!"}</div>
                        <div className="d">
                          <div className="h" title={c.url}>
                            {c.url.replace(/^https?:\/\//, "")}
                          </div>
                          <div className="m">
                            {c.reachable
                              ? `${c.pages} pages · ${c.businessModel?.replace(/_/g, " ") ?? "unclassified"}${c.proofDensity == null ? "" : ` · proof ${Math.round(c.proofDensity * 100)}%`}`
                              : (c.error ?? "unreachable")}
                          </div>
                        </div>
                        <div className="s">{c.reachable ? c.score : "–"}</div>
                        <div className="copy">{c.worthCopying >= 0.5 ? "WORTH COPYING" : ""}</div>
                      </div>
                    ))}
                    {rivalsNow.length === 0 && <div className="empty">No rivals given.</div>}
                  </div>
                )}
              </div>

              <div className="grid" style={{ gap: 14 }}>
                <div className="panel" data-tour="teardown">
                  <h2>{view === "keywords" ? "keyword teardown" : "page teardown"}</h2>
                  <Explain>
                    <b>What this gives you:</b> the selected item in full — the ring is its importance or
                    opportunity, the bars are the individual probabilities behind the verdict, and the
                    footer is what that verdict cost in questions, milliseconds and tokens.
                  </Explain>
                  {view === "keywords" ? (
                    selectedKeyword ? (
                      <>
                        <div className="teardown">
                          <Ring
                            value={selectedKeyword.opportunity * 100}
                            caption="opportunity"
                            hot={selectedKeyword.opportunity >= 0.6}
                          />
                          <div className="who">
                            <div className="name">{selectedKeyword.term}</div>
                            <div className="url">
                              on {selectedKeyword.pages.length} page
                              {selectedKeyword.pages.length === 1 ? "" : "s"} · frequency{" "}
                              {selectedKeyword.frequency} · {selectedKeyword.inHeadings} in headings
                            </div>
                            <div className="tags">
                              <span className="tag">{selectedKeyword.intent.replace(/_/g, " ")}</span>
                              <span className="tag">{selectedKeyword.cluster.replace(/_/g, " ")}</span>
                              <span className={`tag ${selectedKeyword.coverageGap >= 0.5 ? "hot" : "ok"}`}>
                                {selectedKeyword.coverageGap >= 0.5 ? "no page serves this" : "already covered"}
                              </span>
                            </div>
                          </div>
                        </div>
                        <Dims
                          dims={[
                            { k: "buyer query", v: selectedKeyword.isBuyerQuery, hot: selectedKeyword.isBuyerQuery >= 0.5 },
                            { k: "real query", v: selectedKeyword.isRealQuery },
                            { k: "coverage gap", v: selectedKeyword.coverageGap, hot: selectedKeyword.coverageGap >= 0.5 },
                            { k: "in headings", v: Math.min(selectedKeyword.inHeadings / 3, 1) },
                            { k: "page spread", v: Math.min(selectedKeyword.pages.length / 4, 1) },
                          ]}
                        />
                        <div className="foot">
                          6 questions · {selectedKeyword.ms} ms · {selectedKeyword.inputTokens} tokens ·{" "}
                          {BAND_WORD[selectedKeyword.band]}
                        </div>
                      </>
                    ) : (
                      <div className="empty">Pick a keyword on the left.</div>
                    )
                  ) : selectedPage ? (
                    <>
                      <div className="teardown">
                        <Ring
                          value={selectedPage.importance * 100}
                          caption={selectedPage.pageType.replace(/_/g, " ")}
                          hot={selectedPage.band !== "act"}
                        />
                        <div className="who">
                          <div className="name">{selectedPage.path}</div>
                          <div className="url">
                            {selectedPage.url} · {selectedPage.words} words
                          </div>
                          <div className="tags">
                            <span className="tag">{selectedPage.intent.replace(/_/g, " ")}</span>
                            <span className="tag">{selectedPage.action.replace(/_/g, " ")}</span>
                            <span className={`tag ${selectedPage.band === "act" ? "ok" : "hot"}`}>
                              {BAND_WORD[selectedPage.band]}
                            </span>
                          </div>
                        </div>
                      </div>
                      <Dims
                        dims={Object.entries(selectedPage.probabilities)
                          .filter(([key]) => key.startsWith("page_type:"))
                          .slice(0, 5)
                          .map(([key, entry]) => ({ k: key.split(":")[1]!.replace(/_/g, " "), v: entry.value }))}
                      />
                      <div className="foot">
                        14 questions · {selectedPage.ms} ms · {selectedPage.inputTokens} tokens ·{" "}
                        {selectedPage.findings.length} findings
                      </div>
                    </>
                  ) : selectedCrawled ? (
                    <>
                      <div className="teardown">
                        <Ring
                          value={Math.min((selectedCrawled.ruleFindings ?? 0) * 10, 100)}
                          caption="rule issues"
                          hot
                        />
                        <div className="who">
                          <div className="name">{selectedCrawled.path}</div>
                          <div className="url">
                            {selectedCrawled.url} · {selectedCrawled.words} words · HTTP {selectedCrawled.status}
                          </div>
                          <div className="tags">
                            <span className="tag hot">{selectedCrawled.ruleFindings ?? 0} rule findings</span>
                            <span className="tag">not judged by Jev</span>
                          </div>
                        </div>
                      </div>
                      <div className="foot">
                        deterministic checks only · enable Jev for typed judgements on this page
                      </div>
                    </>
                  ) : (
                    <div className="empty">Run an audit, then pick an item on the left.</div>
                  )}
                </div>

                <div className="panel" data-tour="batch">
                  <h2>
                    the batch
                    <span className="tag">{view === "keywords" ? "keyword market" : "site patterns"}</span>
                  </h2>
                  <Explain>
                    <b>What this gives you:</b> site-wide patterns across everything judged — how page
                    types, intents and topic clusters distribute. Catches a site skewed the same way even
                    when no single page looks broken.
                  </Explain>
                  {view === "keywords" ? (
                    <div className="grid two">
                      <div>
                        <MiniLabel>opportunity spread</MiniLabel>
                        <Histogram keywords={topKeywords} />
                      </div>
                      <div>
                        <MiniLabel>intent mix</MiniLabel>
                        <Bars rows={report?.patterns.keywordIntent ?? []} hotFirst />
                      </div>
                      <div style={{ gridColumn: "span 2" }}>
                        <MiniLabel>topic clusters</MiniLabel>
                        <Bars rows={report?.patterns.keywordCluster ?? []} />
                      </div>
                    </div>
                  ) : (
                    <div className="grid two">
                      <div>
                        <MiniLabel>page types</MiniLabel>
                        <Bars rows={report?.patterns.pageType ?? []} hotFirst />
                      </div>
                      <div>
                        <MiniLabel>search intent</MiniLabel>
                        <Bars rows={report?.patterns.intent ?? []} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid two">
              <div className="panel tight" data-tour="findings">
                <h2 className="hed">
                  findings
                  <span className="tag">{pageFindings.length} ranked by impact</span>
                </h2>
                <Explain>
                  <b>What this gives you:</b> the work list — every finding with its severity, the
                  evidence behind it, and a Fix written as an instruction. If you read one panel, read this
                  one.
                </Explain>
                {pageFindings.length === 0 ? (
                  <div className="empty">No findings yet.</div>
                ) : (
                  <div className="findings">
                    {pageFindings.slice(0, 30).map((f, i) => (
                      <div className="finding" key={`${f.id}-${i}`}>
                        <div className="t">
                          <span className={`sev ${f.severity}`}>{f.severity}</span>
                          {f.title}
                          <span className="src">{f.source}</span>
                        </div>
                        <div className="d">
                          {f.detail}
                          {f.pages && f.pages.length > 0 ? ` (${f.pages.slice(0, 4).join(", ")})` : ""}
                        </div>
                        <div className="f">
                          <b>Fix: </b>
                          {f.fix}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid" style={{ gap: 14 }}>
                <div className="panel" data-tour="score">
                  <h2>score</h2>
                  <Explain>
                    <b>What this gives you:</b> a summary of this run — the score, the share of decisive
                    answers, median and p95 latency, and which model produced it. The layer icons in the
                    header say whether those probabilities are calibrated; read the score as a summary,
                    not a league table.
                  </Explain>
                  {report ? (
                    <>
                      <div className="teardown">
                        <Ring value={report.score} caption={`grade ${report.grade}`} hot={report.score < 58} />
                        <div className="who">
                          <div className="name">
                            {report.score}/100 for {report.root.replace(/^https?:\/\//, "")}
                          </div>
                          <div className="url">
                            {report.jevAssessed
                              ? `${Math.round(report.totals.decisiveShare * 100)}% decisive · median ${report.totals.medianMs}ms · p95 ${report.totals.p95Ms}ms`
                              : "partial audit: deterministic rules only, no Jev judgements"}
                          </div>
                          <div className="tags">
                            <span className="tag">{report.model}</span>
                            <span className="tag">{report.crawl.robotsFetched ? "robots honoured" : "no robots.txt"}</span>
                            {report.business.modelClassification && (
                              <span className="tag ok">{report.business.modelClassification.replace(/_/g, " ")}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      {rivalsNow.length > 0 && (
                        <div className="note">
                          Rivals judged on the same rubric. The gap is the market story, not the model&rsquo;s opinion.
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty">No score yet.</div>
                  )}
                </div>

                {report && report.linkSuggestions.length > 0 && (
                  <div className="panel">
                    <h2>internal links to add</h2>
                      <Explain>
                        <b>What this gives you:</b> pages that should link to each other and currently do
                        not — the cheapest structural wins on the list, because they need no new writing.
                      </Explain>
                    <div className="bars">
                      {report.linkSuggestions.slice(0, 8).map((link, i) => (
                        <div className="bar" key={`${link.from}-${link.to}-${i}`}>
                          <div className="k" title={link.from}>
                            {link.from}
                          </div>
                          <div className="track">
                            <div className="fill hot" style={{ width: `${Math.max(link.p * 100, 2)}%` }} />
                          </div>
                          <div className="n">{link.to}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>
        </details>
      </div>
    </div>

      {report && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="endcard">
            <div className="big">
              {report.totals.judgements} judgements. {report.totals.questionsAsked} questions.{" "}
              <em>${report.totals.costUsd.toFixed(5)}.</em>
            </div>
            <div className="note">
              Provenance, not advice. <b>01 SCRAPED</b> is {report.totals.pagesCrawled} pages fetched and
              counted in code. <b>02 TO DO</b> and <b>04 PAGES TO BUILD</b> are drawn from{" "}
              {report.totals.judgements} Jev calls at $0.042 per million input tokens, scored {report.score}
              /100. No count of searches appears anywhere in this: subject priority is computed in code
              from on-page frequency, heading placement and page spread, because Jev carries no index, and
              a rival match is topic overlap across that rival&rsquo;s own crawled titles, never a position
              read from a search engine. Thresholds are a starting point, not a tuned result.
            </div>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <p className="note" style={{ marginTop: 18, textAlign: "center" }}>
          {log.length} log lines · open the bar at the top for the full run log.
        </p>
      )}

      <GuideTour startSignal={tourSignal} />

      <Onboarding
        open={onboardingOpen}
        targetUrl={form.url}
        onConnected={(result: GscConnection) => {
          setGsc((prev) => ({
            ...prev,
            configured: true,
            clientEmail: result.clientEmail,
            checked: false,
          }))
          setOnboardingOpen(false)
          void checkGsc(form.url)
          push("✓ Search Console connected — checking this URL's access")
        }}
        onSkip={() => {
          setOnboardingOpen(false)
          setOnboardingDismissed(true)
          push("— skipped Search Console: this run uses rules and Jev only, with no data from your own Search Console")
        }}
        onClose={() => setOnboardingOpen(false)}
      />
    </div>
  )
}
