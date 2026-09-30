import { useEffect, useState, type ReactNode } from "react"
import "./capacity.css"

/* ──────────────────────────────────────────────────────────────
   CapacityBadge — the honest signal

   One question, answered: *is this run using everything, or is
   something missing?* (plan §2)

   The badge never asserts a check it did not make. Everything below
   is derived from three independent inputs, in one pure function,
   and every branch of that function produces a gap list. A gap
   without a fix is a decoration, so `deriveCapacity` cannot return
   a state the UI cannot act on.
   ────────────────────────────────────────────────────────────── */

/* ── the three checks, as the server reports them ────────────── */

export type GscPermission = "siteOwner" | "siteFullUser" | "siteRestrictedUser" | null

export interface GscCheck {
  /** A service-account key is stored on the server at all. */
  configured: boolean
  /** That key can see the URL being audited. Only the server knows. */
  verified: boolean
  permission: GscPermission
  /** The matched property, e.g. `sc-domain:example.com`. */
  property: string | null
  clientEmail: string | null
  /**
   * Set when the *check* failed. Distinct from "no access": one means
   * we could not find out, the other means we found out and it is no.
   */
  error: string | null
  /** false until the first answer lands. Renders as "unknown", never "✗". */
  checked: boolean
  checking: boolean
}

export interface CapacityBadgeProps {
  /** The URL about to be audited. Shown so a fix targets the right property. */
  url: string
  /** Resolved server-side. The Zen key never reaches the browser. */
  jevConfigured: boolean
  /** False when the local chat model is judging: it returns plausible numbers, not calibrated ones. */
  jevCalibrated?: boolean
  /** The opencode binary is on PATH and a model id is set. */
  agentConfigured: boolean
  agentModel?: string | null
  gsc: GscCheck
  /** Opens the onboarding modal — the fix for every GSC gap. */
  onOpenOnboarding: () => void
  /** Re-runs `GET /api/gsc/status`. Cheap, so it is always offered. */
  onRecheck: () => void
  /** Render the gaps list by default. */
  defaultExpanded?: boolean
  /** Extra content rendered in the foot strip. */
  children?: ReactNode
}

/* ── derivation. Total, pure, exported so it can be tested. ──── */

export type CapacityState = "full" | "reduced" | "crawl" | "none"

export type GapId =
  | "gsc-absent"
  | "gsc-unlisted"
  | "gsc-readonly"
  | "gsc-unknown"
  | "gsc-error"
  | "agent-missing"
  | "jev-missing"

export type GapFix =
  | { kind: "onboarding" }
  | { kind: "recheck" }
  | { kind: "command"; label: string; command: string }

export interface CapacityGap {
  id: GapId
  /** What is missing, in the user's words. */
  title: string
  /** Why it costs this run something. One sentence, no hedging. */
  detail: string
  fix: GapFix
  /**
   * True when this gap is the reason the run is not at full capacity.
   * Advisory gaps (a key that failed to check) still render, but the
   * headline claim is only ever downgraded by a `blocking` gap.
   */
  blocking: boolean
}

export interface CapacityReport {
  state: CapacityState
  label: string
  /** The one-line explanation under the state. */
  summary: string
  gaps: CapacityGap[]
  /** How many gaps actually cost this run something. */
  blockingCount: number
}

/** The exact fix for each gap, resolved once so copy and UI cannot drift. */
const AGENT_INSTALL_CMD = "npm i -g opencode-ai@latest"
const AGENT_PATH_NOTE = "opencode must be on your PATH, and AGENT_MODEL=opencode/space-bunny-free must be set"
const JEV_KEY_CMD = `echo "TYPESAFE_API_KEY=ts-…" > .env`

const STATE_LABEL: Record<CapacityState, string> = {
  full: "Full capacity",
  reduced: "Reduced capacity",
  crawl: "Crawl only",
  none: "Not configured",
}

/**
 * The single source of truth for what a run is capable of.
 *
 * Total by construction — every combination of the three booleans
 * lands in exactly one state — and never a hard-coded string: the
 * headline is computed from the checks, and the same checks produce
 * the gap list that justifies the headline. If the two ever disagree
 * the component would be lying, so they are built in one pass.
 */
export function deriveCapacity(input: {
  jevConfigured: boolean
  agentConfigured: boolean
  gsc: GscCheck
}): CapacityReport {
  const { jevConfigured, agentConfigured, gsc } = input
  const gaps: CapacityGap[] = []

  /* ── GSC. The only check that can fail for a reason we cannot fix
     with a click, and the only one that is URL-specific. ── */
  if (!gsc.checked) {
    // Never promote an unanswered check to a claim: `verified: true` is the
    // pre-answer default, so trusting it here reports "Full capacity" blind.
    if (!gsc.checking) {
      gaps.push({
        id: "gsc-unknown",
        title: "Search Console not checked for this URL",
        detail:
          "No answer yet, so this run does not claim the Search Console layer. Check it and the badge updates itself.",
        fix: { kind: "recheck" },
        blocking: false,
      })
    }
  } else if (gsc.error) {
    gaps.push({
      id: "gsc-error",
      title: "Search Console check failed",
      detail: gsc.error,
      fix: { kind: "recheck" },
      blocking: false,
    })
  } else if (!gsc.configured) {
    gaps.push({
      id: "gsc-absent",
      title: "No Search Console key",
      detail:
        "Everything still works — the run just describes the market instead of your own clicks, impressions and positions.",
      fix: { kind: "onboarding" },
      blocking: true,
    })
  } else if (!gsc.verified) {
    gaps.push({
      id: "gsc-unlisted",
      title: "This URL is not in the key's properties",
      detail: gsc.clientEmail
        ? `${gsc.clientEmail} cannot see this site. Grant it Owner on this property, then re-check.`
        : "The key is stored but it has no access to this site. Grant it Owner on this property, then re-check.",
      fix: { kind: "onboarding" },
      blocking: true,
    })
  } else if (gsc.permission === "siteFullUser") {
    gaps.push({
      id: "gsc-readonly",
      title: "Owner, not Full",
      detail:
        "Read capacity is real: your clicks, impressions and positions are used. Indexing and sitemaps stay off, because a Full grant cannot write.",
      fix: { kind: "onboarding" },
      blocking: false,
    })
  } else if (gsc.permission === "siteRestrictedUser") {
    gaps.push({
      id: "gsc-readonly",
      title: "Restricted access",
      detail:
        "This key is restricted to specific metrics, so most Search Console data is out of reach. Owner unlocks the rest.",
      fix: { kind: "onboarding" },
      blocking: true,
    })
  }

  /* ── the model layers. Without at least one, no report is possible:
     the crawl and the rule checks still run, but nothing is judged. ── */
  if (!agentConfigured) {
    gaps.push({
      id: "agent-missing",
      title: "No research agent",
      detail: `Deep research is off, so the form stays blank and the run is crawl-only. ${AGENT_PATH_NOTE}.`,
      fix: { kind: "command", label: "Install", command: AGENT_INSTALL_CMD },
      blocking: true,
    })
  }

  if (!jevConfigured) {
    gaps.push({
      id: "jev-missing",
      title: "No Jev key",
      detail:
        "Jev could not be reached, so the crawl and all 15 deterministic checks still run and are reported. Every Jev judgement is marked not assessed rather than guessed.",
      fix: { kind: "command", label: "Copy", command: JEV_KEY_CMD },
      blocking: true,
    })
  }

  const blockingCount = gaps.filter((gap) => gap.blocking).length
  const hasModel = jevConfigured || agentConfigured

  let state: CapacityState
  if (!hasModel) {
    state = "none"
  } else if (
    gsc.checked &&
    !gsc.error &&
    gsc.verified &&
    gsc.permission === "siteOwner" &&
    jevConfigured &&
    agentConfigured
  ) {
    state = "full"
  } else if (jevConfigured && agentConfigured) {
    // Both model layers present, so the run judges properly. Anything less
    // than Full is a missing enrichment, not a missing capability — and the
    // badge must not call a working run "reduced" over a UI convenience.
    state = "reduced"
  } else {
    state = "crawl"
  }

  const summary =
    state === "full"
      ? "Every layer is on. Jev is reading your own Search Console data, not describing the market."
      : state === "reduced"
        ? "Judged properly, from the market rather than your own data. Fix the gap below to close the difference."
        : state === "crawl"
          ? "Crawl and rule checks only — no model judgement. Everything below is one command away."
          : "No run is possible yet. The crawl still happens, but nothing can be judged or scored."

  return { state, label: STATE_LABEL[state], summary, gaps, blockingCount }
}

/* ── the three chips, derived from the same three checks ─────── */

type Tone = "on" | "off" | "half" | "unknown"

interface CheckView {
  key: string
  tone: Tone
  mark: string
  note: string
}

function checkViews(input: {
  jevConfigured: boolean
  jevCalibrated?: boolean
  agentConfigured: boolean
  gsc: GscCheck
}): CheckView[] {
  const { jevConfigured, jevCalibrated, agentConfigured, gsc } = input

  const gscView: CheckView = !gsc.checking && !gsc.checked
    ? { key: "gsc", tone: "unknown", mark: "?", note: "not checked" }
    : gsc.checking
      ? { key: "gsc", tone: "unknown", mark: "", note: "checking…" }
      : gsc.error
        ? { key: "gsc", tone: "unknown", mark: "?", note: "check failed" }
        : !gsc.configured
          ? { key: "gsc", tone: "off", mark: "✗", note: "not connected" }
          : !gsc.verified
            ? { key: "gsc", tone: "off", mark: "✗", note: "no access" }
            : gsc.permission === "siteOwner"
              ? { key: "gsc", tone: "on", mark: "✓", note: "owner" }
              : { key: "gsc", tone: "half", mark: "~", note: gsc.permission === "siteFullUser" ? "read-only" : "restricted" }

  return [
    gscView,
    {
      key: "agent",
      tone: agentConfigured ? "on" : "off",
      mark: agentConfigured ? "✓" : "✗",
      note: agentConfigured ? "ready" : "missing",
    },
    {
      key: "jev",
      tone: jevConfigured ? (jevCalibrated === false ? "half" : "on") : "off",
      mark: jevConfigured ? (jevCalibrated === false ? "~" : "✓") : "✗",
      note: jevConfigured ? (jevCalibrated === false ? "local, uncalibrated" : "ready") : "missing",
    },
  ]
}

/* ── component ──────────────────────────────────────────────── */

const CHECK_LABEL: Record<string, string> = { gsc: "GSC", agent: "agent", jev: "Jev" }

function GapRow({ gap, onOpenOnboarding, onRecheck }: {
  gap: CapacityGap
  onOpenOnboarding: () => void
  onRecheck: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    if (gap.fix.kind !== "command") return
    try {
      await navigator.clipboard.writeText(gap.fix.command)
      setCopied(true)
    } catch {
      /* clipboard blocked — the command is on screen and selectable */
    }
  }

  return (
    <div className="cap-gap">
      <div className="cap-gapbody">
        <div className="cap-gapt">{gap.title}</div>
        <p className="cap-gapd">{gap.detail}</p>
      </div>
      <div className="cap-fix">
        {gap.fix.kind === "onboarding" && (
          <button type="button" className="cap-btn" onClick={onOpenOnboarding}>
            Connect Search Console
          </button>
        )}
        {gap.fix.kind === "recheck" && (
          <button type="button" className="cap-btn quiet" onClick={onRecheck}>
            Re-check
          </button>
        )}
        {gap.fix.kind === "command" && (
          <span className="cap-cmd">
            <code>{gap.fix.command}</code>
            <button type="button" onClick={() => void copy()} className={copied ? "done" : undefined}>
              {copied ? "Copied" : gap.fix.label}
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

export function CapacityBadge({
  url,
  jevConfigured,
  jevCalibrated,
  agentConfigured,
  agentModel,
  gsc,
  onOpenOnboarding,
  onRecheck,
  defaultExpanded = true,
  children,
}: CapacityBadgeProps) {
  const report = deriveCapacity({ jevConfigured, agentConfigured, gsc })
  const checks = checkViews({ jevConfigured, jevCalibrated, agentConfigured, gsc })
  const [expanded, setExpanded] = useState(defaultExpanded)

  // The badge opens itself when something new breaks, and folds itself
  // away once everything is green. A badge that needs a click to reveal
  // that capacity dropped is a badge that gets ignored.
  useEffect(() => {
    setExpanded(report.blockingCount > 0)
  }, [report.blockingCount, report.state])

  // A check in flight is genuinely unknown. A check that was never made is
  // not the same thing: it gets the derived label, plus the advisory gap
  // and a re-check button that says so.
  const pending = gsc.checking
  const rail = pending ? "checking" : report.state === "crawl" ? "crawl" : report.state
  const label = pending ? "Checking…" : report.label
  const missingLabel =
    report.gaps.length === 0
      ? "nothing missing"
      : report.blockingCount === 0
        ? `${report.gaps.length} optional`
        : `${report.blockingCount} of 3 layers missing`

  return (
    <section className={`cap ${rail}`} aria-label="Run capacity">
      <div className="cap-main">
        <div className="cap-id">
          <span className="cap-kicker">Capacity</span>
          <span className="cap-state">{label}</span>
        </div>

        <div className="cap-checks">
          {checks.map((check) => (
            <span
              key={check.key}
              className={`cap-check ${check.tone}`}
              title={`${CHECK_LABEL[check.key]}: ${check.note}`}
            >
              <span className="k">{CHECK_LABEL[check.key]}</span>
              {check.mark === "" ? <span className="spin" aria-hidden /> : <span className="m" aria-hidden>{check.mark}</span>}
              <span>{check.note}</span>
            </span>
          ))}
        </div>

        <p className="cap-why">{report.summary}</p>

        <div className="cap-acts">
          {report.gaps.length > 0 && (
            <button
              type="button"
              className="cap-btn quiet"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? "Hide" : "Fix"} · {report.gaps.length}
            </button>
          )}
          {(pending || !gsc.checked) && (
            <button type="button" className="cap-btn quiet" onClick={onRecheck}>
              Re-check
            </button>
          )}
        </div>
      </div>

      {expanded && report.gaps.length > 0 && (
        <div className="cap-gaps">
          {report.gaps.map((gap) => (
            <GapRow key={gap.id} gap={gap} onOpenOnboarding={onOpenOnboarding} onRecheck={onRecheck} />
          ))}
        </div>
      )}

      <div className="cap-foot">
        <span>
          Target <b>{url || "not set"}</b>
        </span>
        <span>{missingLabel}</span>
        {gsc.verified && gsc.property && <span>Property <b>{gsc.property}</b></span>}
        {agentModel && <span>Agent <b>{agentModel}</b></span>}
        {children}
      </div>
    </section>
  )
}

export default CapacityBadge
