import type { AuditEvent, AuditForm, AuditReport, AuditRequestBody } from "./types"
import type {
  AutofillRun,
  CompetitorProposal,
  KeywordSeedProposal,
  MetricProposal,
} from "./researchTypes"

const API = import.meta.env.VITE_API ?? "http://localhost:8787"

export interface ServerConfig {
  jevConfigured: boolean
  jevModel: string
  jevBackend?: "zen" | "local"
  jevCalibrated?: boolean
  agentConfigured: boolean
  agentModel: string
  gscConfigured: boolean
  model: string
  defaults: { maxPages: number; concurrency: number }
}

export async function fetchConfig(): Promise<ServerConfig> {
  const response = await fetch(`${API}/api/config`)
  if (!response.ok) throw new Error(`Config request failed: ${response.status}`)
  return (await response.json()) as ServerConfig
}

export interface RunHandlers {
  onEvent: (event: AuditEvent) => void
  onError: (message: string) => void
  onClose: () => void
  signal: AbortSignal
}

export interface AuditExtras {
  keywordSeeds?: KeywordSeedProposal[]
  metrics?: MetricProposal[]
  rivalProposals?: CompetitorProposal[]
}

/**
 * The audit is a stream, not a request/response: read it as it arrives so the
 * counters tick while judgements land. Uses fetch + reader because EventSource
 * cannot POST.
 *
 * `extras` carries presearch output the client already holds. The server reads
 * only what it recognises, so passing it against a build that does not consume
 * it yet is inert rather than an error.
 */
export async function runAudit(
  form: AuditForm,
  handlers: RunHandlers,
  extras?: AuditExtras,
): Promise<AuditReport | null> {
  const { competitors, ...rest } = form
  const body: AuditRequestBody = {
    ...rest,
    competitors: competitors
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
    ...(extras ?? {}),
  }

  let response: Response
  try {
    response = await fetch(`${API}/api/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: handlers.signal,
    })
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      handlers.onClose()
      return null
    }
    handlers.onError(`Cannot reach the audit server at ${API}. Is it running?`)
    return null
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    handlers.onError(detail || `Audit failed with status ${response.status}`)
    return null
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let report: AuditReport | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const event = JSON.parse(line) as AuditEvent
          handlers.onEvent(event)
          if (event.type === "done") report = event.report
        } catch {
          /* ignore malformed line */
        }
      }
      newline = buffer.indexOf("\n")
    }
  }

  handlers.onClose()
  return report
}

export { API }

/* ── the presearch stream ────────────────────────────────────────────────────
 * Two long waits in sequence: a deterministic crawl, then one opencode session.
 * Both are streamed so the dashboard shows the crawl landing page by page and
 * the session's tool calls as they fire, instead of one blank wait. */

export type ResearchEvent =
  | { type: "stage"; stage: "crawl" | "session"; detail: string }
  | {
      type: "crawl"
      kind: "page" | "error" | "done"
      url?: string
      path?: string
      status?: number
      words?: number
      title?: string
      done?: number
      target?: number
      message?: string
      pages?: number
    }
  | {
      type: "session"
      kind: "session" | "tool" | "text" | "retry"
      tool?: string
      status?: string
      text?: string
      attempt?: number
    }
  | ({ type: "result" } & AutofillRun)
  | { type: "error"; message: string }

export interface ResearchHandlers {
  onEvent: (event: ResearchEvent) => void
  onError: (message: string) => void
  onClose: () => void
  signal: AbortSignal
}

export async function runResearch(
  url: string,
  handlers: ResearchHandlers,
): Promise<AutofillRun | null> {
  let response: Response
  try {
    response = await fetch(`${API}/api/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: handlers.signal,
    })
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      handlers.onClose()
      return null
    }
    handlers.onError(`Cannot reach the research server at ${API}. Is it running?`)
    return null
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    handlers.onError(detail || `Presearch failed with status ${response.status}`)
    return null
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let result: AutofillRun | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith("{")) {
        try {
          const event = JSON.parse(line) as ResearchEvent
          if (event.type === "result") result = event as AutofillRun
          handlers.onEvent(event)
        } catch {
          /* a partial line; the next chunk completes it */
        }
      }
      newline = buffer.indexOf("\n")
    }
  }

  handlers.onClose()
  return result
}
