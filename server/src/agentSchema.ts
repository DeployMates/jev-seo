/**
 * The shape the research agent is allowed to answer in, and the run outcome.
 *
 * Two rules are enforced here rather than in a prompt, because a prompt is a
 * suggestion and a schema is a gate:
 *
 *  1. **No unsourced number is representable.** Every figure is a
 *     `SourcedNumber` — `{ value, source_tool, raw }`. There is nowhere in this
 *     schema to put a bare number, so "the agent reported a number it did not
 *     receive from a tool" is not a thing the model can do and get past us.
 *     `agent.ts` then checks each `source_tool` against the tools that were
 *     actually invoked in the run, so citing a tool that never ran is a
 *     validation failure, not a footnote.
 *
 *  2. **The agent cannot write a finding.** The top level is a strict object,
 *     so an extra key — `findings`, `verdict`, `score` — is rejected outright.
 *     The agent fills a form; `audit.ts` and the rule checks own judgement.
 *
 * `strictObject` is deliberate: a lenient object would let the model smuggle
 * prose verdicts past a validator that only checks the keys it knows about.
 */
import { z } from "zod"

/**
 * Research tools the agent may ever use. The allowlist is built per run from
 * the onboarding gate (see `buildToolAllowlist` in `agent.ts`), never fixed —
 * a run without verified Search Console access does not contain `gsc` at all.
 *
 * Every id here must be backed by a server actually registered in `.mcp.json`.
 * A granted tool that does not exist is worse than a missing one: the prompt
 * advertises it, the model either burns turns calling it or reports a figure
 * citing it, and gate 3a then fails the whole run on an `unsourced-number` the
 * model was told to produce. There is no trends tool because nothing here can
 * source one honestly — see the note in `agentPrompts.ts`.
 */
export const TOOL_IDS = ["gsc", "open-websearch", "undetected-browser"] as const
export type ToolId = (typeof TOOL_IDS)[number]

/**
 * The onboarding gate as the agent layer sees it. `gsc.verified` is the only
 * input that promotes a run from Prompt B to Prompt A, and it is decided by
 * `GET /api/gsc/status` before this layer is ever called.
 */
export interface AgentGate {
  gsc: {
    verified: boolean
    /** `siteOwner` unlocks indexing writes; `siteFullUser` is read-only. */
    permission?: "siteOwner" | "siteFullUser" | null
    /** The `sc-domain:` or `url-prefix:` property that matched, if any. */
    property?: string | null
  }
}

export type PromptVariant = "A" | "B"

/** A figure, with the tool it came from and the tool's own output for it. */
export const SourcedNumberSchema = z.object({
  value: z.number().finite(),
  source_tool: z.string().min(1, "source_tool must name the tool that produced the number"),
  raw: z.string().min(1, "raw must be the value as the tool returned it, not a restatement"),
})
export type SourcedNumber = z.infer<typeof SourcedNumberSchema>

/** A named figure. The name is for humans; the envelope is the guarantee. */
export const MetricSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  number: SourcedNumberSchema,
})
export type Metric = z.infer<typeof MetricSchema>

export const CompetitorSchema = z.strictObject({
  name: z.string().min(1),
  url: z.string().min(1),
  /** What they visibly do that this site does not. Description, not verdict. */
  why: z.string().min(1),
  /** The tool that surfaced them, so the claim can be challenged. */
  evidence_tool: z.string().min(1),
  /** The exact search string that surfaced them, so a human can re-run it. */
  evidence_query: z.string().min(1),
  /** Which discovery pass found them: direct, alternatives, directory, category, geography. */
  angle: z.string().min(1),
})
export type Competitor = z.infer<typeof CompetitorSchema>

export const KEYWORD_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
  "unknown",
] as const
export type KeywordIntent = (typeof KEYWORD_INTENTS)[number]

export const KeywordSeedSchema = z.strictObject({
  term: z.string().min(1),
  intent: z.enum(KEYWORD_INTENTS),
  evidence_tool: z.string().min(1),
})
export type KeywordSeed = z.infer<typeof KeywordSeedSchema>

/**
 * The one and only thing the agent is allowed to emit.
 *
 * The six fields are exactly the autofill target from the plan: business name,
 * what it does, market, competitors, keyword seeds — and the figures behind
 * them. No findings, no verdict, no score, no per-page advice. A single
 * hallucinated market field skews every downstream decision, so this is
 * reviewed by a human before any Jev call is made.
 */
export const ResearchOutputSchema = z.strictObject({
  business_name: z.string().min(1).nullable(),
  business_summary: z.string().min(1).nullable(),
  market: z.string().min(1).nullable(),
  competitors: z.array(CompetitorSchema),
  keyword_seeds: z.array(KeywordSeedSchema),
  metrics: z.array(MetricSchema),
  /** Anything a tool refused to give, and why. Never a substitute for a number. */
  notes: z.array(z.string()),
})
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>

/**
 * The crawl-only fallback: a structurally valid, entirely empty form. Downstream
 * code never has to special-case a missing result — it gets the same shape with
 * nothing in it, plus the reason, and the user sees "we could not research this"
 * instead of a blank screen.
 */
export const CRAWL_ONLY_OUTPUT: ResearchOutput = Object.freeze({
  business_name: null,
  business_summary: null,
  market: null,
  competitors: [],
  keyword_seeds: [],
  metrics: [],
  notes: [],
}) satisfies ResearchOutput

/** One tool invocation as it appeared in the run, kept for provenance. */
export interface ToolCallRecord {
  tool: string
  status: string
  ok: boolean
  input: unknown
  /** The tool's own output, verbatim and truncated. This is the `raw` of record. */
  output: string
}

export interface AgentReceipt {
  model: string
  ms: number
  attempts: number
  promptVariant: PromptVariant
  grantedTools: ToolId[]
  toolsCalled: ToolCallRecord[]
  /** Text of claims that could not be fully corroborated. Non-fatal, shown. */
  unsupportedCitations: string[]
  inputTokens: number
  outputTokens: number
  sessionId: string | null
  /** The one-line validation error that caused a retry, if there was one. */
  retryReason: string | null
}

export type DegradeReason =
  | "not-configured"
  | "binary-missing"
  | "spawn-failed"
  | "timeout"
  | "empty-output"
  | "invalid-json"
  | "schema-invalid"
  | "ungranted-tool"
  | "unsourced-number"

export type ResearchResult =
  | { ok: true; degraded: false; data: ResearchOutput; receipt: AgentReceipt }
  | { ok: false; degraded: true; data: ResearchOutput; reason: DegradeReason; detail: string; receipt: AgentReceipt }

/**
 * Turn a zod failure into one sentence the model can act on. The retry appends
 * this to the prompt, so it has to name the field and say what was wrong with
 * it — "validation failed" is not a correction.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
      return `${path}: ${issue.message}`
    })
    .join("; ")
}
