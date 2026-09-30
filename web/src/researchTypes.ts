export type KeywordIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "unknown"

export interface CompetitorProposal {
  name: string
  url: string
  why: string
  evidence_tool: string
  evidence_query?: string
  angle?: string
}

export interface KeywordSeedProposal {
  term: string
  intent: KeywordIntent
  evidence_tool: string
}

export interface MetricProposal {
  key: string
  label: string
  number: { value: number; source_tool: string; raw: string }
}

export type AutofillFieldKey = "business_name" | "business_summary" | "market"

export interface AutofillPayload {
  business_name: string | null
  business_summary: string | null
  market: string | null
  competitors: CompetitorProposal[]
  keyword_seeds: KeywordSeedProposal[]
  metrics: MetricProposal[]
  notes: string[]
  /**
   * Provenance for the three top-level text fields. The server schema
   * does not require it, so a field with no entry here renders as
   * "no tool recorded" rather than borrowing a neighbour's source.
   */
  field_sources?: Partial<Record<AutofillFieldKey, string>>
}

/** `ResearchResult` + `AgentReceipt`, flattened to what the panel renders. */

export interface ResearchToolCall {
  tool: string
  status: string
  ok: boolean
}

export interface ResearchReceipt {
  model: string
  ms: number
  attempts: number
  promptVariant: "A" | "B" | null
  grantedTools: string[]
  toolsCalled: ResearchToolCall[]
}

export interface ResearchPayload {
  business_name: string | null
  business_summary: string | null
  market: string | null
  competitors: CompetitorProposal[]
  keyword_seeds: KeywordSeedProposal[]
  metrics: MetricProposal[]
  notes: string[]
}

export interface AutofillRun {
  ok: boolean
  degraded: boolean
  reason?: string | null
  detail?: string | null
  data: ResearchPayload | null
  receipt: ResearchReceipt | null
}
