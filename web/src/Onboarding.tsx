import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent } from "react"
import { API } from "./api"
import "./onboarding.css"

/* ──────────────────────────────────────────────────────────────
   Types
   ────────────────────────────────────────────────────────────── */

export interface GscConnection {
  clientEmail: string
  properties: GscProperty[]
}

export interface OnboardingProps {
  open: boolean
  /**
   * The URL the user is about to audit. Shown so the Owner grant is made on
   * the right property, and so "what you give up" is concrete.
   */
  targetUrl?: string
  /** The server accepted the key. The caller owns closing the modal. */
  onConnected: (result: GscConnection) => void
  /** A first-class choice: the dashboard keeps working, without GSC. */
  onSkip: () => void
  /** Dismissed without deciding — Escape, backdrop or the close button. */
  onClose: () => void
}

export type ServiceAccountErrorCode =
  | "empty"
  | "too-large"
  | "not-json"
  | "not-object"
  | "wrong-type"
  | "missing-email"
  | "missing-key"
  | "bad-key"

export interface ServiceAccountCheck {
  ok: boolean
  /** Present on success only, and echoed back into the UI on purpose. */
  clientEmail: string | null
  projectId: string | null
  code: ServiceAccountErrorCode | null
  /** Written for a human, and each one says what to do next. */
  message: string | null
  /** The parsed key, so the caller never re-parses. Never render this. */
  account: Record<string, unknown> | null
}

/* ──────────────────────────────────────────────────────────────
   Server contract
   Mirrors server/src/gsc.ts (GscProperty, GscPermission,
   ConnectResult) and server/src/index.ts route handlers. The
   workspaces typecheck separately and share no types package, so
   these are hand-mirrored and WILL drift silently if the server
   changes. Anything crossing the wire is re-checked at runtime by
   isGscProperty rather than trusted.
   ────────────────────────────────────────────────────────────── */

export type GscPermission = "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "unverified"

export interface GscProperty {
  readonly siteUrl: string
  readonly permissionLevel: GscPermission
}

/** POST /api/gsc/connect — ConnectResult, verbatim, on success and on 400. */
export interface GscConnectResponse {
  connected?: boolean
  clientEmail?: string
  properties?: readonly GscProperty[]
  error?: string
}

function isGscPermission(value: unknown): value is GscPermission {
  return value === "siteOwner" || value === "siteFullUser" || value === "siteRestrictedUser" || value === "unverified"
}

function isGscProperty(value: unknown): value is GscProperty {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.siteUrl === "string" && record.siteUrl.length > 0 && isGscPermission(record.permissionLevel)
}

function readProperties(value: unknown): GscProperty[] {
  return Array.isArray(value) ? value.filter(isGscProperty) : []
}

/** How much of the product each permission level unlocks, in plain words. */
const PERMISSION_NOTE: Record<GscPermission, string> = {
  siteOwner: "Full capacity — indexing, sitemaps, submit",
  siteFullUser: "Read capacity — analytics only, no indexing writes",
  siteRestrictedUser: "Restricted — too limited to audit from",
  unverified: "Not listed in Search Console",
}

function isReadOnly(permission: GscPermission): boolean {
  return permission === "siteFullUser" || permission === "siteRestrictedUser" || permission === "unverified"
}

type Phase = "idle" | "connecting" | "connected"

/* ──────────────────────────────────────────────────────────────
   Client-side validation — runs before anything leaves the browser
   ────────────────────────────────────────────────────────────── */

const PRIVATE_KEY_HEAD = "-----BEGIN PRIVATE KEY-----"
/** A real service-account key is ~2.3 KB. This cap only catches a wrong file. */
const MAX_BYTES = 256 * 1024

function fail(code: ServiceAccountErrorCode, message: string): ServiceAccountCheck {
  return { ok: false, clientEmail: null, projectId: null, code, message, account: null }
}

const IDLE_CHECK: ServiceAccountCheck = {
  ok: false,
  clientEmail: null,
  projectId: null,
  code: null,
  message: null,
  account: null,
}

/**
 * Everything the plan asks for in §1.1, in the order a human would diagnose
 * it: is it JSON, is it a service account, does it carry an identity, does it
 * carry a usable key. The last one matters most — a key that does not start
 * with the PEM header is truncated or was hand-edited, and Google will reject
 * it at connection time with an opaque error instead of a useful one.
 */
export function validateServiceAccountText(text: string): ServiceAccountCheck {
  // A text editor on Windows may leave a BOM, which JSON.parse rejects.
  const source = text.replace(/^\uFEFF/, "").trim()

  if (!source) {
    return fail("empty", "That file is empty. Download the service-account key again from Google Cloud.")
  }
  if (source.length > MAX_BYTES) {
    return fail(
      "too-large",
      `That file is ${Math.round(source.length / 1024)} KB. A service-account key is about 2 KB — you have probably picked the wrong file.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return fail(
      "not-json",
      "That file is not valid JSON. Open it in a text editor: it should start with { and contain \"type\" and \"client_email\".",
    )
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("not-object", "That file is JSON, but it is not a key file — it has no fields at the top level.")
  }

  const record = parsed as Record<string, unknown>

  if (record.type !== "service_account") {
    const found = typeof record.type === "string" ? `type "${record.type}"` : "no type field at all"
    return fail(
      "wrong-type",
      `That file has ${found}. Search Console needs a service account key — Google Cloud → IAM & Admin → Service Accounts → Keys → Add key → JSON.`,
    )
  }

  const email = record.client_email
  if (typeof email !== "string" || !email.includes("@") || email.trim().length === 0) {
    return fail(
      "missing-email",
      "The key has no usable client_email. Every Google service account has one — download the JSON again rather than editing it by hand.",
    )
  }

  const key = record.private_key
  if (typeof key !== "string" || key.trim().length === 0) {
    return fail(
      "missing-key",
      "The key has no private_key, so nothing here can sign a request to Google. Download the JSON again.",
    )
  }
  if (!key.trimStart().startsWith(PRIVATE_KEY_HEAD)) {
    return fail(
      "bad-key",
      "The private_key does not start with -----BEGIN PRIVATE KEY-----. The file is truncated or was edited — download a fresh copy.",
    )
  }

  const projectId = typeof record.project_id === "string" ? record.project_id : null
  return { ok: true, clientEmail: email.trim(), projectId, code: null, message: null, account: record }
}

/* ──────────────────────────────────────────────────────────────
   Component
   ────────────────────────────────────────────────────────────── */

const STEPS = [
  {
    title: "Google Cloud console — enable the Search Console API",
    detail:
      "APIs & Services → Library → search “Search Console API” → Enable. Without this the key signs a request Google then refuses, and the error you get back is unreadable.",
  },
  {
    title: "IAM & Admin — grant the address above OWNER",
    detail:
      "IAM & Admin → IAM → Grant Access → paste the client_email → role Owner. Owner, not Full: Full can read analytics but cannot submit sitemaps or request indexing, so the indexing tools stay switched off.",
  },
  {
    title: "Search Console — add the property",
    detail: "Open the property you are auditing → Settings ⚙ → Users and permissions → Add user → the same address, Owner, then Add.",
  },
] as const

export function Onboarding({ open, targetUrl, onConnected, onSkip, onClose }: OnboardingProps) {
  const [check, setCheck] = useState<ServiceAccountCheck>(IDLE_CHECK)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [serverError, setServerError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [properties, setProperties] = useState<GscProperty[]>([])

  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // dragenter/dragleave fire for every child, so count them instead of toggling.
  const dragDepth = useRef(0)
  // The keydown handler is registered once per open; read props through a ref
  // so the listener never goes stale. Assigned in an effect, not during render.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  /* reset on close so a re-open never shows the previous attempt */
  useEffect(() => {
    if (open) return
    setCheck(IDLE_CHECK)
    setFileName(null)
    setFileSize(null)
    setDragging(false)
    setPhase("idle")
    setServerError(null)
    setCopied(false)
    setProperties([])
    dragDepth.current = 0
    if (inputRef.current) inputRef.current.value = ""
  }, [open])

  /* focus trap + scroll lock + Escape */
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    dialogRef.current?.focus()

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== "Tab") return
      const node = dialogRef.current
      if (!node) return
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null)
      const first = focusable.at(0)
      const last = focusable.at(focusable.length - 1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = previousOverflow
      previous?.focus?.()
    }
  }, [open])

  const ingest = async (file: File) => {
    setServerError(null)
    setCopied(false)

    if (file.size > MAX_BYTES) {
      setCheck(
        fail(
          "too-large",
          `That file is ${Math.round(file.size / 1024)} KB. A service-account key is about 2 KB — you have probably picked the wrong file.`,
        ),
      )
      setFileName(file.name)
      setFileSize(file.size)
      return
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      setCheck(fail("not-json", "That file could not be read. It may still be downloading, or blocked by the system."))
      setFileName(file.name)
      setFileSize(file.size)
      return
    }

    setFileName(file.name)
    setFileSize(file.size)
    setCheck(validateServiceAccountText(text))
  }

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void ingest(file)
  }

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void ingest(file)
  }

  const clear = () => {
    setCheck(IDLE_CHECK)
    setFileName(null)
    setFileSize(null)
    setServerError(null)
    setCopied(false)
    if (inputRef.current) inputRef.current.value = ""
    inputRef.current?.focus()
  }

  const copyEmail = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!check.clientEmail) return
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(check.clientEmail)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — the address is on screen, selected by definition */
    }
  }

  const connect = async () => {
    if (!check.ok || !check.account || phase === "connecting") return
    setPhase("connecting")
    setServerError(null)

    let response: Response
    try {
      response = await fetch(`${API}/api/gsc/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(check.account),
      })
    } catch {
      setPhase("idle")
      setServerError(`Cannot reach the local server at ${API}. Start it, then try again.`)
      return
    }

    const raw = await response.text().catch(() => "")
    let body: GscConnectResponse | null = null
    try {
      body = raw ? (JSON.parse(raw) as GscConnectResponse) : null
    } catch {
      body = null
    }

    if (response.status === 404) {
      setPhase("idle")
      setServerError("This server has no /api/gsc/connect endpoint yet, so nothing was written to disk.")
      return
    }
    if (!response.ok) {
      setPhase("idle")
      setServerError(body?.error ?? (raw ? raw.slice(0, 220) : `The server refused the key (status ${response.status}).`))
      return
    }
    if (body?.error) {
      setPhase("idle")
      setServerError(body.error)
      return
    }
    if (!body?.connected) {
      setPhase("idle")
      setServerError("The server stored the key but did not confirm a connection. Nothing was lost — try again, or skip.")
      return
    }

    setProperties(readProperties(body.properties))
    setPhase("connected")
  }

  if (!open) return null

  const email = check.clientEmail
  const busy = phase === "connecting"

  return (
    <div
      className="ob-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="ob-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ob-title"
        aria-describedby="ob-sub"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="ob-head">
          <div className="ob-headtext">
            <span className="ob-kicker">setup · one time</span>
            <h2 id="ob-title">Connect Search Console</h2>
            <p id="ob-sub" className="ob-sub">
              Optional. Jev already works on any website without it — with it, Jev reads your own clicks, impressions
              and positions instead of describing the market.
            </p>
          </div>
          <button type="button" className="ob-close" onClick={onClose} aria-label="Close without connecting">
            ✕
          </button>
        </div>

        {phase === "connected" ? (
          <div className="ob-body">
            <div className="ob-success">
              <span className="ob-successmark" aria-hidden>
                ✓
              </span>
              <div>
                <strong>Search Console connected</strong>
                <p>
                  {properties.length === 0
                    ? "The key is stored and verified, but this account sees no properties yet. Grant Owner on the property in Search Console, then re-open this."
                    : `${properties.length} ${properties.length === 1 ? "property is" : "properties are"} visible to ${email}.`}
                </p>
                {properties.length > 0 && (
                  <ul className="ob-props">
                    {properties.map((property) => (
                      <li key={property.siteUrl} className={isReadOnly(property.permissionLevel) ? "ro" : "full"}>
                        <span className="ob-propurl">{property.siteUrl}</span>
                        <span className="ob-proplevel">{PERMISSION_NOTE[property.permissionLevel]}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {properties.some((property) => isReadOnly(property.permissionLevel)) && (
                  <p className="ob-propwarn">
                    Not every property is Owner, so indexing stays switched off for the ones that are not — Jev reads
                    their analytics only. Grant Owner in Search Console to turn indexing on for them.
                  </p>
                )}
              </div>
            </div>
            <div className="ob-actions solo">
              <button type="button" className="ob-btn primary" onClick={() => onConnected({ clientEmail: email ?? "", properties })}>
                Start the audit
              </button>
            </div>
          </div>
        ) : (
          <div className="ob-body">
            {/* ── drop zone + accessible browse fallback ──
                The <input> is real, full-bleed and focusable, wrapped in a
                <label>. Dragging is a pointer gesture with no keyboard or
                touch equivalent, so the click path is not a convenience —
                it is the only path some users have. */}
            {check.ok ? (
              <div className="ob-file">
                <div className="ob-filemain">
                  <span className="ob-filetick" aria-hidden>
                    ✓
                  </span>
                  <div className="ob-fileinfo">
                    <span className="ob-fname">{fileName}</span>
                    <span className="ob-fmeta">
                      valid service-account key
                      {fileSize !== null && ` · ${Math.max(1, Math.round(fileSize / 1024))} KB`}
                    </span>
                  </div>
                </div>
                <button type="button" className="ob-btn quiet" onClick={clear} disabled={busy}>
                  Choose another
                </button>
              </div>
            ) : (
              <label
                className={`ob-drop ${dragging ? "over" : ""} ${check.message ? "bad" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault()
                  dragDepth.current += 1
                  setDragging(true)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  event.preventDefault()
                  dragDepth.current = Math.max(0, dragDepth.current - 1)
                  if (dragDepth.current === 0) setDragging(false)
                }}
                onDrop={onDrop}
              >
                <svg className="ob-dropicon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <span className="ob-dropt">Drop the service-account JSON</span>
                <span className="ob-drops" id="ob-drop-hint">
                  Checked in this browser, before anything is sent
                </span>
                <span className="ob-browse" aria-hidden>
                  Browse files
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/json,.json,text/plain"
                  className="ob-fileinput"
                  aria-label="Choose the service-account JSON key file"
                  aria-describedby="ob-drop-hint"
                  onChange={onInput}
                />
              </label>
            )}

            {/* One live region for every outcome, so errors are announced. */}
            <div className="ob-live" role="status" aria-live="polite">
              {check.message && !check.ok && (
                <p className="ob-errbox">
                  <span className="ob-errcode">{check.code}</span>
                  <span className="ob-errmsg">
                    {fileName && <span className="ob-errfile">{fileName}</span>}
                    {check.message}
                  </span>
                </p>
              )}
              {serverError && (
                <p className="ob-errbox">
                  <span className="ob-errcode">server</span>
                  <span className="ob-errmsg">{serverError}</span>
                </p>
              )}
            </div>

            {check.ok && email && (
              <>
                <section className="ob-block">
                  <h3 className="ob-h3">the address to grant</h3>
                  <p className="ob-lede">
                    This is the <code>client_email</code> from the key file. It goes into two places — Google Cloud IAM
                    and Search Console — both steps below.
                  </p>
                  <div className="ob-emailrow">
                    <code className="ob-email">{email}</code>
                    <button type="button" className="ob-btn quiet" onClick={copyEmail}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </section>

                <section className="ob-block">
                  <h3 className="ob-h3">
                    three steps
                    {targetUrl && <span className="ob-h3tag">{targetUrl}</span>}
                  </h3>
                  <ol className="ob-steps">
                    {STEPS.map((step, index) => (
                      <li className="ob-step" key={step.title}>
                        <span className="ob-stepn" aria-hidden>
                          {index + 1}
                        </span>
                        <div>
                          <strong className="ob-stept">{step.title}</strong>
                          <p className="ob-stepd">{step.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}

            {!check.ok && !fileName && (
              <section className="ob-block">
                <h3 className="ob-h3">no key yet? three steps to get one</h3>
                <ol className="ob-steps">
                  <li className="ob-step">
                    <span className="ob-stepn" aria-hidden>
                      1
                    </span>
                    <div>
                      <strong className="ob-stept">Google Cloud → IAM & Admin → Service Accounts</strong>
                      <p className="ob-stepd">Create one if you have not, or open the one you want to use.</p>
                    </div>
                  </li>
                  <li className="ob-step">
                    <span className="ob-stepn" aria-hidden>
                      2
                    </span>
                    <div>
                      <strong className="ob-stept">Keys → Add key → Create new key → JSON</strong>
                      <p className="ob-stepd">JSON is the only format that works. The download cannot be repeated later.</p>
                    </div>
                  </li>
                  <li className="ob-step">
                    <span className="ob-stepn" aria-hidden>
                      3
                    </span>
                    <div>
                      <strong className="ob-stept">Drop that file above</strong>
                      <p className="ob-stepd">Then grant the address it contains Owner on the property, in Search Console.</p>
                    </div>
                  </li>
                </ol>
              </section>
            )}

            <section className="ob-block">
              <h3 className="ob-h3">where this file goes</h3>
              <ul className="ob-privacy">
                <li>
                  Written to <code>.gsc/service-account.json</code> on this machine, mode 0600, inside a git-ignored
                  folder.
                </li>
                <li>Never sent to a third party, never attached to an audit, never echoed back by the server.</li>
                <li>Only the local server signs requests with it, to read your own Search Console data.</li>
              </ul>
            </section>

            {/* Sticky: the two decisions never scroll out of reach, and Skip
                always carries its own consequence rather than being a bare link. */}
            <div className="ob-foot">
              <p className="ob-skipwhy">
                <b>Skip is a real option.</b> Jev still crawls, still judges, still audits any website. You lose your
                own clicks, impressions and positions, so keyword work stays inferred instead of measured. Re-open
                this any time from the capacity bar.
              </p>
              <div className="ob-actions">
                <button type="button" className="ob-btn primary" onClick={connect} disabled={!check.ok || busy}>
                  {busy ? "Connecting…" : "Connect Search Console"}
                </button>
                <button type="button" className="ob-btn ghost" onClick={onSkip} disabled={busy}>
                  Skip — run without it
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Onboarding
