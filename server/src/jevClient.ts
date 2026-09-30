/**
 * Typed answers as they come back, and the client that gets them.
 *
 * Jev answers are typed: `choice` (one option from your list, plus the full
 * distribution and a confidence), `score` (a level on your rubric, returned as
 * the probability-weighted average of the level numbers), or `noul` (a single
 * number, the probability that the answer is yes).
 *
 * Question ids are labels for our code only and are never sent, so the whole
 * question has to live in the `instructions` field. The response `model` field
 * tells us which version actually answered, which matters once thresholds are
 * tuned — so every receipt records it.
 */
import {
  DEFAULT_MODEL,
  JEV_MAX_RETRIES,
  JEV_TIMEOUT_MS,
  USD_PER_MTOK,
  ZEN_BASE_URL,
  zenHeaders,
  zenKey,
} from "./config.js"
import {
  currentUpstream,
  dispatcherFor,
  rotateAfterQuota,
  rotateAfterTransportFailure,
} from "./zenProxy.js"
import type { Dispatcher } from "undici"
import type { Questions } from "./questions.js"

export interface ChoiceAnswer {
  type: "choice"
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface ScoreAnswer {
  type: "score"
  score: number
  confidence: number
  legend?: Record<string, string>
  probabilities: Record<string, number>
}

export interface NoulAnswer {
  type: "noul"
  noul: number
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer
export type Answers = Record<string, Answer>

export interface JevReceipt {
  model: string
  ms: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  attempts: number
}

export interface JevResult {
  answers: Answers
  receipt: JevReceipt
}

export class JevAuthError extends Error {
  constructor() {
    super("Jev rejected the credential or the OpenCode client fingerprint.")
    this.name = "JevAuthError"
  }
}

export class JevApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number,
  ) {
    super(message)
    this.name = "JevApiError"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Normalise the wire shape, tolerating a few harmless variants. */
function coerceAnswer(raw: Record<string, unknown>): Answer | null {
  const type = String(raw.type ?? "").toLowerCase()

  if (type === "choice" || typeof raw.choice === "string") {
    const probabilities = (raw.probabilities ?? {}) as Record<string, number>
    return {
      type: "choice",
      choice: String(raw.choice ?? ""),
      confidence: Number(raw.confidence ?? 0),
      probabilities,
    }
  }

  if (type === "score" || typeof raw.score === "number") {
    return {
      type: "score",
      score: Number(raw.score ?? 0),
      confidence: Number(raw.confidence ?? 0),
      legend: raw.legend as Record<string, string> | undefined,
      probabilities: (raw.probabilities ?? {}) as Record<string, number>,
    }
  }

  if (type === "noul" || typeof raw.noul === "number") {
    return { type: "noul", noul: Number(raw.noul ?? 0) }
  }

  return null
}

function coerceAnswers(raw: unknown): Answers {
  const out: Answers = {}
  if (!raw || typeof raw !== "object") return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const answer = coerceAnswer(value as Record<string, unknown>)
    if (answer) out[id] = answer
  }
  return out
}

function costOf(inputTokens: number): number {
  return (inputTokens * USD_PER_MTOK) / 1_000_000
}

export function isConfigured(): boolean {
  return zenKey() !== undefined
}

export function activeModel(): string {
  return DEFAULT_MODEL
}

interface CallOptions {
  model?: string
  signal?: AbortSignal
}

/**
 * One request: one state, many questions, all evaluated in parallel and in
 * isolation. Adding questions barely changes response time, which is why the
 * harness packs every question it might need into a single call.
 */
export async function systemOne(
  state: unknown,
  questions: Questions,
  options: CallOptions = {},
): Promise<JevResult> {
  const key = zenKey()
  if (!key) throw new JevAuthError()

  const model = options.model ?? DEFAULT_MODEL
  const started = Date.now()

  let lastError: unknown
  let upstream = currentUpstream()
  for (let attempt = 1; attempt <= JEV_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await fetch(`${ZEN_BASE_URL}/systemone`, {
        method: "POST",
        headers: zenHeaders(key),
        body: JSON.stringify({ state, model, questions }),
        signal: controller.signal,
        dispatcher: dispatcherFor(upstream),
      } as RequestInit & { dispatcher?: Dispatcher })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        // 401/403 mean a credential problem: abort the run rather than retry.
        if (response.status === 401 || response.status === 403) {
          throw new JevAuthError()
        }
        const isQuota =
          response.status === 429 || /FreeUsageLimitError|rate limit exceeded/i.test(body)
        if (isQuota) {
          const next = rotateAfterQuota(upstream)
          if (next) {
            upstream = next
            lastError = undefined
            attempt -= 1
            continue
          }
        }
        const retryAfterHeader = response.headers.get("retry-after")
        const retryAfterMs = retryAfterHeader
          ? Math.min(Number(retryAfterHeader) * 1000 || 0, 30_000)
          : 0
        throw new JevApiError(
          response.status,
          body.slice(0, 300) || `Jev request failed with ${response.status}`,
          response.status === 429 || response.status === 408 || response.status >= 500,
          retryAfterMs,
        )
      }

      const payload = (await response.json()) as Record<string, unknown>
      const answers = coerceAnswers(payload.answers)
      const usage = (payload.usage ?? {}) as Record<string, unknown>
      const inputTokens = Number(usage.input_tokens ?? 0)
      const outputTokens = Number(usage.output_tokens ?? 0)

      return {
        answers,
        receipt: {
          model: String(payload.model ?? model),
          ms: Date.now() - started,
          inputTokens,
          outputTokens,
          costUsd: costOf(inputTokens),
          attempts: attempt,
        },
      }
    } catch (error) {
      lastError = error
      if (error instanceof JevAuthError) throw error

      const isLast = attempt === JEV_MAX_RETRIES
      const retryable =
        error instanceof JevApiError ? error.retryable : true // timeouts and network errors retry
      if (isLast || !retryable) throw error

      // A transport failure means this egress address is unusable, exactly as a
      // 429 does. Park it and retry immediately on the next one rather than
      // burning the backoff on the same dead proxy.
      if (!(error instanceof JevApiError) && upstream) {
        const next = rotateAfterTransportFailure(upstream)
        if (next) {
          upstream = next
          lastError = undefined
          attempt -= 1
          continue
        }
      }

      const retryAfterMs = error instanceof JevApiError ? error.retryAfterMs : 0
      await sleep(Math.max(1000 * 2 ** (attempt - 1), retryAfterMs))
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  throw lastError
}
