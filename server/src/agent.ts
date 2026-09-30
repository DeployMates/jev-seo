/**
 * The research agent: one `opencode run` process, one strict JSON blob back.
 *
 * Why a subprocess and not an HTTP call. Jev is a decision model and cannot
 * hold a session or call a tool. This layer needs both, and the local opencode
 * runtime is the thing that already has them. It is spawned as a child process
 * rather than driven in-process so a wedged or crashing agent cannot take the
 * audit server down with it, and so a run has a hard wall-clock ceiling.
 *
 * The shape of the guarantee, which matters more than the model choice:
 *
 * - **The tool allowlist is built per run from the onboarding gate.** No gate,
 *   no `gsc`. Prompt B physically has no Search Console tool to reach for, and
 *   if the model tried anyway the transcript shows it and the run is rejected.
 * - **A malformed blob never passes through.** JSON is parsed, then validated
 *   with zod, then checked against the tools that actually ran. One retry, with
 *   the validation error quoted back at it. A second failure degrades to
 *   crawl-only and says why, rather than handing a broken object downstream.
 * - **Every number is traceable to a tool call that happened.** A figure
 *   naming a tool that never ran is a validation failure, not a caveat.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { agentWorkspaceDir, researchDir } from "./paths.js"
import {
  CRAWL_ONLY_OUTPUT,
  ResearchOutputSchema,
  describeIssues,
  type AgentGate,
  type AgentReceipt,
  type DegradeReason,
  type PromptVariant,
  type ResearchOutput,
  type ResearchResult,
  type ToolCallRecord,
  type ToolId,
} from "./agentSchema.js"
import {
  buildAgentPrompt,
  variantForGate,
  type PromptContext,
} from "./agentPrompts.js"

export type {
  AgentGate,
  AgentReceipt,
  DegradeReason,
  PromptVariant,
  ResearchOutput,
  ResearchResult,
  ToolCallRecord,
  ToolId,
} from "./agentSchema.js"
export { buildAgentPrompt, variantForGate, variantLabel } from "./agentPrompts.js"
export type { PromptContext } from "./agentPrompts.js"

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * opencode resolves `.mcp.json` from the project it runs in, so this must be a
 * directory that has one — and it must be writable, which the install dir is not.
 * `AGENT_PROJECT_DIR` still wins, for pointing the agent at a real checkout.
 */
const PROJECT_DIR = process.env.AGENT_PROJECT_DIR ?? agentWorkspaceDir()

/** Pinned: the model must not drift under a validated schema. */
const AGENT_MODEL = process.env.AGENT_MODEL ?? "opencode/space-bunny-free"
const AGENT_BIN = process.env.AGENT_BIN ?? "opencode"

/** Deep research is slow by nature. The plan makes it an explicit button. */
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 240_000)

/** NDJSON transcript cap. A research run is chatty; 12 MiB is far past sane. */
const MAX_TRANSCRIPT_CHARS = 12 * 1024 * 1024

/** Tool outputs are kept for provenance; they are truncated for the receipt. */
const MAX_STORED_OUTPUT = 2_000

/** The plan allows exactly one retry. Not a loop, not a backoff schedule. */
const MAX_ATTEMPTS = 2

/* -------------------------------------------------------------------------- */
/* tool grants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Built per run from the gate. A run without verified Search Console access
 * does not contain `gsc` at all, so Prompt B cannot reach it even by accident.
 */
export function buildToolAllowlist(gate: AgentGate): ToolId[] {
  const tools: ToolId[] = []
  if (gate.gsc.verified) tools.push("gsc")
  tools.push("open-websearch", "undetected-browser")
  return tools
}

/**
 * Names each granted id may appear under once opencode namespaces MCP tools as
 * `<server>_<tool>`. Matching is a prefix on the lowercased name, so
 * `gsc_search_analytics` and `undetected-browser_browser_navigate` both resolve
 * without hard-coding tool lists that change between releases.
 */
const NAME_PATTERNS: Record<ToolId, string[]> = {
  gsc: ["gsc", "gsc_", "google-search-console", "search-console"],
  "open-websearch": ["websearch", "open-websearch", "web-search", "websearch_", "webfetch"],
  "undetected-browser": [
    "undetected-browser",
    "undetected_browser",
    "undetectedbrowser",
    "parallel-browser",
    "parallel_browser",
  ],
}

/**
 * Read-only inspection opencode does on its own. Permitted so a stray `read`
 * does not burn a run, recorded so the receipt is complete. Write and execute
 * tools are deliberately absent: an agent with a mandate to read the web has
 * no business writing files or running commands, and allowing it is the kind
 * of quiet over-permission that ends badly.
 */
const PERMITTED_BUILTINS = new Set(["read", "grep", "glob", "list", "todowrite", "todoread"])

/**
 * Write-capable builtins are permitted only for the one path this run was told
 * to write. A blanket `write` grant would let a session prompted by crawled page
 * text drop a file anywhere on the disk, which is the whole prompt-injection
 * surface the untrusted-content rule exists to close.
 */
const WRITE_BUILTINS = new Set(["write", "edit", "patch", "multiedit"])

function writtenPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  for (const key of ["filePath", "file_path", "path", "target"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

/** Which granted tool a transcript tool name belongs to, or null. */
export function resolveToolId(toolName: string, allowlist: ToolId[]): ToolId | null {
  const name = toolName.trim().toLowerCase()
  if (name.length === 0) return null
  for (const id of allowlist) {
    for (const pattern of NAME_PATTERNS[id]) {
      if (name === pattern || name.startsWith(pattern)) return id
    }
  }
  return null
}

export function isPermittedBuiltin(
  toolName: string,
  call?: { input?: unknown },
  writablePaths: readonly string[] = [],
): boolean {
  const name = toolName.trim().toLowerCase()
  if (PERMITTED_BUILTINS.has(name)) return true
  if (!WRITE_BUILTINS.has(name)) return false
  if (writablePaths.length === 0) return false
  const target = writtenPath(call?.input)
  if (!target) return false
  const absolute = isAbsolute(target) ? target : resolve(PROJECT_DIR, target)
  return writablePaths.some((allowed) => absolute === allowed)
}

/* -------------------------------------------------------------------------- */
/* transcript                                                                  */
/* -------------------------------------------------------------------------- */

interface Transcript {
  text: string
  toolCalls: ToolCallRecord[]
  sessionId: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
}

const EMPTY_TRANSCRIPT: Transcript = {
  text: "",
  toolCalls: [],
  sessionId: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
}

/**
 * `opencode run --format json` emits one JSON event per line. The assistant's
 * answer arrives as a sequence of `text` parts that must be concatenated — a
 * single reply is not guaranteed to be one event. Tool results arrive as
 * `tool_use` events carrying the tool name and its raw output, which is the
 * only trustworthy record of what the agent actually asked for.
 */
function parseTranscript(raw: string): Transcript {
  const out: Transcript = { ...EMPTY_TRANSCRIPT, toolCalls: [] }
  let text = ""

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue // a truncated final line, or a plugin writing something else
    }

    if (typeof event.sessionID === "string") out.sessionId = event.sessionID
    const part = event.part as Record<string, unknown> | undefined
    if (!part || typeof part !== "object") continue

    if (part.type === "text" && typeof part.text === "string") {
      text += part.text
      continue
    }

    if (part.type === "tool") {
      const name = String(part.tool ?? "unknown")
      const state = (part.state ?? {}) as Record<string, unknown>
      const status = String(state.status ?? "unknown")
      // A failed call emits `error` and omits `output` entirely (verified against
      // opencode 1.18.33), so the object branch would record "" and lose the only
      // explanation the user gets for a field the agent left null.
      const output =
        typeof state.output === "string"
          ? state.output
          : state.error !== undefined
            ? safeStringify(state.error)
            : safeStringify(state.output)
      out.toolCalls.push({
        tool: name,
        status,
        ok: status === "completed",
        input: state.input ?? null,
        output: output.slice(0, MAX_STORED_OUTPUT),
      })
      continue
    }

    if (part.type === "step-finish") {
      const tokens = (part.tokens ?? {}) as Record<string, unknown>
      // The last step-finish carries the run totals; earlier ones are per-step.
      out.inputTokens = Number(tokens.input ?? out.inputTokens)
      out.outputTokens = Number(tokens.output ?? out.outputTokens)
      const cost = Number(part.cost)
      if (Number.isFinite(cost)) out.costUsd = cost
    }
  }

  out.text = text.trim()
  return out
}

/** Was derived from `import.meta.url`, which pointed into the install dir — see paths.ts. */
const RESEARCH_OUTPUT_DIR = researchDir()

function readOutputFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, "utf8").trim()
    if (text.length === 0) return null
    return extractJsonBlob(text) ?? null
  } catch {
    return null
  }
}

function safeStringify(value: unknown): string {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

/* -------------------------------------------------------------------------- */
/* json extraction                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pull the JSON object out of a reply. The prompt demands a bare object, but a
 * model that wraps it in a fence or prefixes a sentence should not cost a run —
 * so fences are stripped and the first balanced brace span is taken.
 * String-aware, because a `}` inside a quoted value is not the end of anything.
 */
export function extractJsonBlob(text: string): string | null {
  if (text.length === 0) return null

  const direct = tryParse(text)
  if (direct !== null) return direct

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) {
    const fromFence = tryParse(fenced[1].trim())
    if (fromFence !== null) return fromFence
  }

  const start = text.indexOf("{")
  if (start < 0) return null
  const balanced = balancedSpan(text, start)
  return balanced === null ? null : tryParse(balanced)
}

function tryParse(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/\0+$/, "")
  if (!trimmed.startsWith("{")) return null
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    return null
  }
}

function balancedSpan(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* validation                                                                  */
/* -------------------------------------------------------------------------- */

type Violation = { reason: DegradeReason; detail: string }

type Validation =
  | { ok: true; data: ResearchOutput; flagged: string[] }
  | { ok: false; violation: Violation; flagged: string[] }

/**
 * Three gates, in order of how much they cost to be wrong about.
 *
 * 1. The blob parses and matches `ResearchOutputSchema` — a strict object, so a
 *    smuggled `verdict` fails here.
 * 2. No tool outside the grant ran. This is what makes "unowned URL never calls
 *    gsc" true rather than merely prompted.
 * 3. Every metric names a tool that actually ran in this transcript. A figure
 *    citing a tool that never ran is exactly the hallucinated metric the plan
 *    is trying to prevent, so it fails the run.
 *
 * Competitor and keyword-seed `evidence_tool` fields are checked the same way
 * but only *flagged*, not fatal: a wrong competitor is a wrong suggestion a
 * human is about to review and edit, and losing the whole run over it would
 * push the model toward a looser habit on the numbers that matter.
 */
function validateRun(
  blob: string,
  transcript: Transcript,
  allowlist: ToolId[],
  writablePaths: readonly string[] = [],
): Validation {
  const flagged: string[] = []

  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch (error) {
    return {
      ok: false,
      violation: {
        reason: "invalid-json",
        detail: `The reply was not valid JSON: ${(error as Error).message}`,
      },
      flagged,
    }
  }

  const schema = ResearchOutputSchema.safeParse(parsed)
  if (!schema.success) {
    return {
      ok: false,
      violation: { reason: "schema-invalid", detail: describeIssues(schema.error) },
      flagged,
    }
  }

  // Gate 2 — nothing outside the grant ran.
  for (const call of transcript.toolCalls) {
    if (isPermittedBuiltin(call.tool, call, writablePaths)) continue
    if (resolveToolId(call.tool, allowlist) === null) {
      return {
        ok: false,
        violation: {
          reason: "ungranted-tool",
          detail: `The agent called "${call.tool}", which was not granted for this run. Allowed: ${allowlist.join(", ")}.`,
        },
        flagged,
      }
    }
  }

  const called = new Set(transcript.toolCalls.map((call) => call.tool.trim().toLowerCase()))

  // Gate 3a — metrics. A number with no tool call behind it is not a number.
  for (const metric of schema.data.metrics) {
    const source = metric.number.source_tool.trim().toLowerCase()
    if (!called.has(source)) {
      return {
        ok: false,
        violation: {
          reason: "unsourced-number",
          detail: `Metric "${metric.key}" reports ${metric.number.value} from "${metric.number.source_tool}", but that tool made no call in this run. Only report figures a tool actually returned.`,
        },
        flagged,
      }
    }
  }

  // Gate 3b — the softer half, recorded rather than fatal.
  for (const competitor of schema.data.competitors) {
    const source = competitor.evidence_tool.trim().toLowerCase()
    if (!called.has(source)) {
      flagged.push(`competitor "${competitor.name}" cites uncalled tool "${competitor.evidence_tool}"`)
    }
  }
  for (const seed of schema.data.keyword_seeds) {
    const source = seed.evidence_tool.trim().toLowerCase()
    if (!called.has(source)) {
      flagged.push(`keyword "${seed.term}" cites uncalled tool "${seed.evidence_tool}"`)
    }
  }
  for (const metric of schema.data.metrics) {
    if (!rawContainsValue(metric.number.raw, metric.number.value)) {
      flagged.push(
        `metric "${metric.key}" reports ${metric.number.value} but its raw "${metric.number.raw}" does not contain that figure`,
      )
    }
  }

  return { ok: true, data: schema.data, flagged }
}

/**
 * Does the tool's own output actually contain this figure? A generous check —
 * grouping separators and trailing zeroes are tolerated — but if a model
 * restates a number instead of copying it, the digits will not be there, and
 * that is worth surfacing to a human even when the run is allowed to stand.
 */
function rawContainsValue(raw: string, value: number): boolean {
  const digits = (input: string): string => input.replace(/[^0-9]/g, "")
  const target = digits(String(value))
  if (target.length === 0) return true
  return digits(raw).includes(target)
}

/* -------------------------------------------------------------------------- */
/* process                                                                     */
/* -------------------------------------------------------------------------- */

let binaryChecked = false
let binaryPresent = false

/**
 * Whether the agent layer can run at all. The capacity badge derives its
 * "agent ✓" from this rather than from a flag someone can forget to set.
 */
export function isAgentAvailable(): boolean {
  if (binaryChecked) return binaryPresent
  binaryChecked = true
  binaryPresent = probeBinary()
  return binaryPresent
}

function probeBinary(): boolean {
  if (AGENT_BIN.includes("/")) return existsSync(AGENT_BIN)
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of dirs) {
    if (existsSync(resolve(dir, AGENT_BIN))) {
      binaryPresent = true
      return true
    }
  }
  return false
}

export function activeAgentModel(): string {
  return AGENT_MODEL
}

class RunFailure extends Error {
  constructor(readonly reason: DegradeReason, message: string) {
    super(message)
    this.name = "RunFailure"
  }
}

export interface AgentEvent {
  kind: "session" | "tool" | "text" | "retry"
  tool?: string
  status?: string
  text?: string
  attempt?: number
}

function runOpencode(
  message: string,
  sessionId: string | null,
  onEvent?: (event: AgentEvent) => void,
): Promise<Transcript> {
  return new Promise<Transcript>((resolvePromise, rejectPromise) => {
    const args = [
      "run",
      "--model",
      AGENT_MODEL,
      "--format",
      "json",
      "--dir",
      PROJECT_DIR,
    ]
    // The plan calls for one session. The retry continues the same one, so the
    // model can see what it already said instead of being asked cold.
    if (sessionId) args.push("--session", sessionId)
    args.push(message)

    const child = spawn(AGENT_BIN, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env })

    let stdout = ""
    let stderr = ""
    let settled = false
    let overflow = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      rejectPromise(new RunFailure("timeout", `The agent did not finish within ${AGENT_TIMEOUT_MS} ms.`))
    }, AGENT_TIMEOUT_MS)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    let carry = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return
      const text = carry + chunk.toString("utf8")
      const lines = text.split("\n")
      carry = lines.pop() ?? ""
      for (const line of lines) {
        stdout += `${line}\n`
        if (!onEvent || !line.trim().startsWith("{")) continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const part = event.part as Record<string, unknown> | undefined
        if (!part || typeof part !== "object") continue
        if (typeof event.sessionID === "string" && !sessionId) {
          onEvent({ kind: "session", text: event.sessionID })
        }
        if (part.type === "tool") {
          const state = (part.state ?? {}) as Record<string, unknown>
          onEvent({
            kind: "tool",
            tool: String(part.tool ?? "unknown"),
            status: String(state.status ?? "unknown"),
          })
        } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          onEvent({ kind: "text", text: part.text.trim().slice(0, 240) })
        }
      }
      if (stdout.length > MAX_TRANSCRIPT_CHARS) overflow = true
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8")
    })

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        const reason: DegradeReason = error.code === "ENOENT" ? "binary-missing" : "spawn-failed"
        rejectPromise(new RunFailure(reason, `Could not start \`${AGENT_BIN}\`: ${error.message}`))
      })
    })

    child.on("close", (code) => {
      finish(() => {
        if (overflow) {
          rejectPromise(new RunFailure("spawn-failed", "The agent transcript exceeded the size cap."))
          return
        }
        const transcript = parseTranscript(stdout)
        if (transcript.text.length === 0 && transcript.toolCalls.length === 0) {
          const detail = stderr.trim().slice(0, 300)
          rejectPromise(
            new RunFailure(
              "empty-output",
              detail.length > 0
                ? `The agent produced no answer. ${detail}`
                : `The agent produced no answer (exit code ${code ?? "null"}).`,
            ),
          )
          return
        }
        resolvePromise(transcript)
      })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* public api                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The caller supplies context, never the tool list. The allowlist is derived
 * from the gate here, inside the agent, so there is no input by which a caller
 * could grant a tool the gate did not clear.
 */
export type ResearchRequest = Omit<PromptContext, "grantedTools" | "gscProperty">

function baseReceipt(
  variant: PromptVariant,
  allowlist: ToolId[],
  transcript: Transcript,
  startedAt: number,
  attempts: number,
  retryReason: string | null,
): AgentReceipt {
  return {
    model: AGENT_MODEL,
    ms: Date.now() - startedAt,
    attempts,
    promptVariant: variant,
    grantedTools: allowlist,
    toolsCalled: transcript.toolCalls,
    unsupportedCitations: [],
    inputTokens: transcript.inputTokens,
    outputTokens: transcript.outputTokens,
    sessionId: transcript.sessionId,
    retryReason,
  }
}

function degraded(
  reason: DegradeReason,
  detail: string,
  receipt: AgentReceipt,
): ResearchResult {
  return { ok: false, degraded: true, data: CRAWL_ONLY_OUTPUT, reason, detail, receipt }
}

/**
 * Run the research agent. Always resolves: every failure mode ends in an
 * explicit degraded result rather than a throw, because a research failure must
 * never take an audit down with it — the crawl-only path is a supported mode,
 * not an error.
 */
export async function runResearch(
  request: ResearchRequest,
  gate: AgentGate,
  onEvent?: (event: AgentEvent) => void,
): Promise<ResearchResult> {
  const startedAt = Date.now()
  const allowlist = buildToolAllowlist(gate)
  const variant = variantForGate(gate.gsc.verified)
  const outputPath = resolve(RESEARCH_OUTPUT_DIR, `run-${Date.now()}-${process.pid}.json`)
  mkdirSync(RESEARCH_OUTPUT_DIR, { recursive: true })
  rmSync(outputPath, { force: true })

  const prompt = buildAgentPrompt(variant, {
    ...request,
    grantedTools: allowlist,
    gscProperty: gate.gsc.property ?? null,
    outputPath,
  })

  if (!isAgentAvailable()) {
    const receipt = baseReceipt(variant, allowlist, EMPTY_TRANSCRIPT, startedAt, 0, null)
    return degraded(
      "not-configured",
      `The \`${AGENT_BIN}\` CLI was not found on PATH, so the research agent cannot run. The audit continues on deterministic rules only.`,
      receipt,
    )
  }

  let transcript: Transcript = EMPTY_TRANSCRIPT
  let sessionId: string | null = null
  let lastViolation: Violation = { reason: "empty-output", detail: "The agent produced no answer." }
  let retryReason: string | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const message =
      attempt === 1
        ? prompt
        : `${prompt}\n\n---\n\n## Your previous reply was rejected\n\n${lastViolation.detail}\n\nReply again with the complete JSON object and nothing else.`

    try {
      transcript = await runOpencode(message, sessionId, onEvent)
    } catch (error) {
      const failure =
        error instanceof RunFailure
          ? error
          : new RunFailure("spawn-failed", (error as Error).message)

      const receipt = baseReceipt(variant, allowlist, transcript, startedAt, attempt - 1, retryReason)
      const detail =
        failure.reason === "binary-missing"
          ? `The \`${AGENT_BIN}\` CLI was not found on PATH. The audit continues on deterministic rules only.`
          : failure.message
      return degraded(failure.reason, detail, receipt)
    }

    if (transcript.sessionId) sessionId = transcript.sessionId

    // The file wins: a chat model emitting a 4KB object into a JSON event
    // stream truncates or fences it often enough to matter, and a real file
    // cannot be corrupted by a stray sentence either side of it.
    let blob = readOutputFile(outputPath)
    if (blob === null) blob = extractJsonBlob(transcript.text)
    if (blob === null) {
      lastViolation = {
        reason: "invalid-json",
        detail: "Your reply did not contain a JSON object. Reply with the object only: it must start with `{` and end with `}`.",
      }
    } else {
      const validation = validateRun(blob, transcript, allowlist, [outputPath])
      if (validation.ok) {
        const receipt = baseReceipt(variant, allowlist, transcript, startedAt, attempt, retryReason)
        receipt.unsupportedCitations = validation.flagged
        return { ok: true, degraded: false, data: validation.data, receipt }
      }
      lastViolation = validation.violation
    }

    retryReason = lastViolation.detail
  }

  // Two failures. Say so, and hand back an empty but valid form so the caller
  // has one shape to render.
  const receipt = baseReceipt(variant, allowlist, transcript, startedAt, MAX_ATTEMPTS, retryReason)
  return degraded(
    lastViolation.reason,
    `The research agent returned invalid output twice (${lastViolation.reason}). Falling back to crawl-only: ${lastViolation.detail}`,
    receipt,
  )
}
