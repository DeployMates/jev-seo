import { useEffect, useId, useRef, useState, type FocusEvent } from "react"
import {
  CHECK_LABEL,
  GapRow,
  checkViews,
  deriveCapacity,
  type CheckView,
  type GscCheck,
} from "./CapacityBadge"
import type { ServerConfig } from "./api"
import "./capacity.css"

/* ──────────────────────────────────────────────────────────────
   CapacityCluster — the honest signal, in the corner

   The same three checks and the same gaps the full-width banner
   carried, folded into one control: a state word, one icon per
   layer, and a count of what is blocking. The detail moved into a
   dropdown, so the header stops spending a full row of the page on
   something the reader only acts on when it is wrong.

   Every claim here is derived. `deriveCapacity` and `checkViews`
   come from ./CapacityBadge and are not reimplemented, so this
   surface cannot report a different state than the logic does.

   Three ways open it — pointer, click and keyboard focus — because
   a hover-only disclosure does not exist for touch or for anyone
   tabbing the header. A hover intent delay of 120ms keeps the panel
   from flashing as the pointer crosses the topbar.

   It is a disclosure, not a modal: focus is never moved into the
   panel and never trapped, and tabbing past the last control closes
   it. The old banner opened itself when capacity dropped, so a
   newly blocking gap still opens this — except on first paint,
   where popping a panel over the page is a worse version of the
   notice than a badge the reader can hover.
   ────────────────────────────────────────────────────────────── */

/** Two characters, so four cells fit beside the tour button. */
const ICON_KEY: Record<string, string> = { gsc: "GS", agent: "AG", jev: "JV", proxy: "PX" }

const OPEN_DELAY = 120
const CLOSE_DELAY = 160

export interface CapacityClusterProps {
  /** Everything /api/config resolved. The backend section reads it directly. */
  config: ServerConfig
  /** Live per-URL Search Console state, owned by App. */
  gsc: GscCheck
  url: string
  onOpenOnboarding: () => void
  onRecheck: () => void
}

/* ── one layer, as an icon. Never the full chip: that is in the panel. ── */

function LayerIcon({ check }: { check: CheckView }) {
  return (
    <span className={`capx-i ${check.tone}`}>
      <span className="capx-il">{ICON_KEY[check.key] ?? check.key.slice(0, 2).toUpperCase()}</span>
      {check.tone === "on" ? null : check.mark === "" ? (
        <span className="capx-spin" aria-hidden />
      ) : (
        <span className="capx-bub" aria-hidden>{check.mark}</span>
      )}
    </span>
  )
}

export function CapacityCluster({
  config,
  gsc,
  url,
  onOpenOnboarding,
  onRecheck,
}: CapacityClusterProps) {
  const report = deriveCapacity({
    jevConfigured: config.jevConfigured,
    agentConfigured: config.agentConfigured,
    gsc,
  })
  const checks = checkViews({
    jevConfigured: config.jevConfigured,
    jevCalibrated: config.jevCalibrated,
    agentConfigured: config.agentConfigured,
    gsc,
  })

  const panelId = useId()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)

  const clearTimers = () => {
    if (openTimer.current !== undefined) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
    openTimer.current = undefined
    closeTimer.current = undefined
  }

  const close = () => {
    pinned.current = false
    setOpen(false)
  }

  useEffect(() => clearTimers, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const onEnter = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    window.clearTimeout(openTimer.current)
    if (open) return
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY)
  }

  const onLeave = () => {
    window.clearTimeout(openTimer.current)
    openTimer.current = undefined
    if (pinned.current) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY)
  }

  const onToggle = () => {
    clearTimers()
    if (pinned.current) {
      close()
      return
    }
    pinned.current = true
    setOpen(true)
  }

  // Capacity dropped since the last render: say so rather than wait to be
  // hovered. Deliberately skipped on the first render, where every gap is
  // already true and a panel would only obscure the page it is warning about.
  const lastBlocking = useRef<number | null>(null)
  useEffect(() => {
    const previous = lastBlocking.current
    lastBlocking.current = report.blockingCount
    if (previous !== null && previous === 0 && report.blockingCount > 0) setOpen(true)
  }, [report.blockingCount])

  const onBlurAway = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    close()
  }

  const pending = gsc.checking
  const rail = pending ? "checking" : report.state
  const label = pending ? "Checking…" : report.label
  const missingLabel =
    report.gaps.length === 0
      ? "nothing missing"
      : report.blockingCount === 0
        ? `${report.gaps.length} optional`
        : `${report.blockingCount} of 3 layers missing`
  const gapOffersRecheck = report.gaps.some((gap) => gap.fix.kind === "recheck")

  const judge =
    config.jevBackend === "zen"
      ? `zen live · ${config.jevModel}`
      : config.jevBackend === "local"
        ? `local judge, not Jev · ${config.jevModel} unreachable`
        : "judge backend not reported"
  const judgeTone = config.jevBackend === "zen" ? "ok" : config.jevBackend === "local" ? "warn" : "dim"

  const calibrated =
    config.jevCalibrated === undefined
      ? "not reported"
      : config.jevCalibrated
        ? "calibrated"
        : "local, uncalibrated"
  const calibratedTone =
    config.jevCalibrated === undefined ? "dim" : config.jevCalibrated ? "ok" : "warn"

  // The pool the keyless tier egresses through. `pool: 0` is a legitimate
  // configuration — the server went direct — so it reads as dim, not as a fault.
  // A pool that exists with nothing live is the actual problem: every call is
  // either quarantined or falling back direct, which is what burns an address.
  const proxy = config.proxy
  const proxyPool = proxy?.pool ?? 0
  const proxyLive = proxy?.live ?? 0
  const proxyEnabled = proxyPool > 0
  const proxyTone: "ok" | "warn" | "dim" = !proxyEnabled
    ? "dim"
    : proxyLive > 0
      ? "ok"
      : "warn"
  const proxyView = {
    key: "proxy",
    tone: !proxyEnabled ? "unknown" : proxyLive > 0 ? "on" : "half",
    mark: !proxyEnabled ? "direct" : proxyLive > 0 ? "✓" : "none live",
    note: !proxyEnabled ? "direct" : `${proxyLive}/${proxyPool} live`,
  } satisfies CheckView

  const backend: { k: string; v: string; tone?: "ok" | "warn" | "dim" }[] = [
    { k: "judge", v: judge, tone: judgeTone },
    { k: "probabilities", v: calibrated, tone: calibratedTone },
    { k: "agent", v: config.agentModel || "not reported", tone: config.agentConfigured ? "ok" : "warn" },
    {
      k: "proxy pool",
      v: !proxyEnabled
        ? "not started with a pool — going direct"
        : `${proxyLive} of ${proxyPool} live${proxy?.host ? ` · ${proxy.host}` : ""}`,
      tone: proxyTone,
    },
    {
      k: "crawl",
      v: `${config.defaults.maxPages} pages · ${config.defaults.concurrency} concurrent`,
    },
    // The client observed this response, so it is the one health fact it can
    // state. /api/health returns these fields plus `ok: true`; that flag is
    // not reported here because this run never received it.
    { k: "api", v: "/api/config answered" },
  ]

  return (
    <div
      className="capx"
      ref={wrapRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onBlur={onBlurAway}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`capx-trigger ${rail}`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Capacity: ${label}. ${missingLabel}.`}
        title={`Capacity: ${label} · ${missingLabel}`}
        onClick={onToggle}
        onFocus={() => setOpen(true)}
      >
        <span className="capx-rail" aria-hidden />
        <span className={`capx-state ${rail}`}>{label}</span>
        <span className="capx-cells">
          {checks.map((check) => (
            <LayerIcon key={check.key} check={check} />
          ))}
          <LayerIcon check={proxyView} />
        </span>
        {report.blockingCount > 0 && (
          <span className="capx-count" aria-hidden>{report.blockingCount}</span>
        )}
      </button>

      {open && (
        <div className="capx-panel" id={panelId}>
          <div className="cap-id">
            <span className="cap-kicker">capacity</span>
            <span className={`capx-state ${rail}`}>{label}</span>
          </div>

          <div className="cap-checks">
            {checks.map((check) =>
              check.key === "gsc" && !gsc.verified && !pending ? (
                <button
                  key={check.key}
                  type="button"
                  className={`cap-check ${check.tone} actionable`}
                  onClick={onOpenOnboarding}
                  title="Connect Search Console — upload a service-account key"
                >
                  <span className="k">{CHECK_LABEL[check.key]}</span>
                  <span className="m" aria-hidden>{check.mark}</span>
                  <span>{check.note}</span>
                </button>
              ) : (
                <span
                  key={check.key}
                  className={`cap-check ${check.tone}`}
                  title={`${CHECK_LABEL[check.key]}: ${check.note}`}
                >
                  <span className="k">{CHECK_LABEL[check.key]}</span>
                  {check.mark === "" ? <span className="spin" aria-hidden /> : <span className="m" aria-hidden>{check.mark}</span>}
                  <span>{check.note}</span>
                </span>
              ),
            )}
          </div>

          <p className="cap-why">{report.summary}</p>

          {(pending || !gsc.checked) && !gapOffersRecheck && (
            <div className="cap-acts">
              <button type="button" className="cap-btn quiet" onClick={onRecheck}>
                Re-check
              </button>
            </div>
          )}

          {report.gaps.length > 0 && (
            <div className="cap-gaps">
              {report.gaps.map((gap) => (
                <GapRow key={gap.id} gap={gap} onOpenOnboarding={onOpenOnboarding} onRecheck={onRecheck} />
              ))}
            </div>
          )}

          <div className="cap-kicker capx-seckick">backend</div>
          <dl className="capx-kv">
            {backend.map((row) => (
              <div className="capx-row" key={row.k}>
                <dt>{row.k}</dt>
                <dd className={row.tone}>{row.v}</dd>
              </div>
            ))}
          </dl>

          <div className="cap-foot">
            <span>
              Site <b>{url || "not set"}</b>
            </span>
            <span>{missingLabel}</span>
            {gsc.verified && gsc.property && <span>Property <b>{gsc.property}</b></span>}
            {config.agentModel && <span>Agent <b>{config.agentModel}</b></span>}
          </div>
        </div>
      )}
    </div>
  )
}

export default CapacityCluster
