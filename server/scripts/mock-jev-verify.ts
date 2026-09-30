/**
 * Verification harness for the Jev path. Stands up a local endpoint that returns
 * the exact response shape from the TypeSafe docs, points the server at it, and
 * asserts that typed answers become probabilities, findings and a needs-a-human
 * pile. Proves the pipeline without spending a real call.
 *
 * Run: node --experimental-strip-types scripts/mock-jev-verify.ts
 */
import { createServer } from "node:http"

interface MockAnswers {
  [id: string]: unknown
}

const state: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }> = {
  page_type: {
    choice: "article_or_guide",
    confidence: 0.93,
    probabilities: { article_or_guide: 0.88, category_or_listing: 0.07, other: 0.05 },
  },
  intent: {
    choice: "informational",
    confidence: 0.88,
    probabilities: { informational: 0.79, navigational: 0.12, commercial: 0.09 },
  },
  action: {
    choice: "rewrite",
    confidence: 0.91,
    probabilities: { rewrite: 0.84, keep_or_improve: 0.12, merge_or_remove: 0.04 },
  },
}

function buildAnswers(questions: Record<string, { type: string; criteria: unknown }>): MockAnswers {
  const answers: MockAnswers = {}

  for (const [id, question] of Object.entries(questions)) {
    if (id in state) {
      answers[id] = { type: "choice", ...state[id]! }
      continue
    }

    if ((id === "intent" || id === "cluster") && question.type === "choice") {
      const options = Object.keys(question.criteria as Record<string, unknown>)
      const winner = id === "intent" ? "commercial" : options[0]!
      answers[id] = {
        type: "choice",
        choice: winner,
        confidence: 0.86,
        probabilities: Object.fromEntries(
          options.map((o, i) => [o, i === 0 ? 0.72 : 0.28 / (options.length - 1)]),
        ),
      }
      continue
    }

    if (question.type === "score") {
      // Level 0 twice as likely as level 1: a weak page, decided cleanly.
      answers[id] = {
        type: "score",
        score: 0.33,
        confidence: 0.9,
        legend: { 0: "weak", 1: "ok", 2: "good", 3: "excellent" },
        probabilities: { 0: 0.67, 1: 0.33 },
      }
      continue
    }

    if (question.type === "noul") {
      // A realistic mix: most gates decisive, a couple genuinely in the grey
      // zone so the needs-a-human path is exercised rather than bypassed.
      const byId: Record<string, number> = {
        competitor_distinctiveness: 0.55,
        coverage_gap: 0.12,
        is_buyer_query: 0.88,
        is_real_query: 0.93,
      }
      answers[id] = { type: "noul", noul: byId[id] ?? 0.08 }
      continue
    }
  }

  return answers
}

const server = createServer((req, res) => {
  if (!req.url?.endsWith("/systemone") || req.method !== "POST") {
    res.writeHead(404).end("not found")
    return
  }

  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    const payload = JSON.parse(body) as {
      state: unknown
      model: string
      questions: Record<string, { type: string; criteria: unknown }>
    }

    // State size drives the token count, which drives the cost receipt.
    const inputTokens = Math.ceil(JSON.stringify(payload.state).length / 3.6)

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        model: payload.model,
        answers: buildAnswers(payload.questions),
        usage: { input_tokens: inputTokens, output_tokens: 40 },
      }),
    )
  })
})

server.listen(8799, async () => {
  // The crawl target must be a real public host: the SSRF guard correctly
  // refuses loopback, and weakening it to make a test pass would remove a
  // security control. Only the Jev endpoint is faked.
  const crawlTarget = process.env.VERIFY_CRAWL_URL ?? "https://www.iana.org"
  const { runAudit } = await import("../src/audit.js")

  const events: string[] = []
  const report = await runAudit(
    {
      url: crawlTarget,
      businessName: "Acme",
      businessContext: "A test business",
      market: "Switzerland",
      maxPages: 3,
      maxKeywords: 6,
      concurrency: 2,
      competitors: ["https://www.iana.org/help/example-domains"],
    },
    (event) => events.push(event.type),
  )

  const failures: string[] = []
  const assert = (label: string, condition: boolean) => {
    if (!condition) failures.push(label)
  }

  assert("crawled pages", report.totals.pagesCrawled > 0)
  assert("judged pages", report.totals.pagesJudged > 0)
  assert("asked questions", report.totals.questionsAsked > 20)
  assert("charged cost", report.totals.costUsd > 0)
  assert("recorded input tokens", report.totals.inputTokens > 0)
  assert("has findings", report.findings.length > 0)
  assert("has a needs-a-human pile", report.needsHuman.length > 0)
  assert("grey-zone answer is flagged for a human, not acted on", report.pages.some((p) => p.needsHuman))
  assert("grey zone names the uncertain question", report.pages.some((p) => p.reasons.some((r) => r.includes("uncertain"))))
  assert("low action score became a finding", report.pages.some((p) => p.findings.some((f) => f.id === "rewrite")))
  assert("confident no became a finding, not a review", report.pages.some((p) => p.findings.some((f) => f.band === "act")))
  assert(
    "commercial-only gate suppressed on an informational page",
    report.pages.every((p) => p.intent !== "informational" || !p.findings.some((f) => f.id === "clear_next_step")),
  )
  assert(
    "probabilities kept for the teardown",
    report.pages.every((p) => Object.keys(p.probabilities).length > 5),
  )
  assert("ledger has a receipt per call", report.ledger.length >= report.totals.judgements)
  assert("stream emitted page-done events", events.filter((e) => e === "page-done").length === report.totals.pagesJudged)
  assert("score is in range", report.score >= 0 && report.score <= 100)

  assert("mined a keyword pool", report.keywordPool.length > 0)
  assert("judged keywords", report.totals.keywordsJudged > 0)
  assert("streamed keyword-done events", events.filter((e) => e === "keyword-done").length === report.totals.keywordsJudged)
  assert("keyword opportunity computed in code", report.keywords.every((k) => k.opportunity >= 0 && k.opportunity <= 1))
  assert("only real buyer terms reach the market list", report.keywords.every((k) => k.isRealQuery >= 0.5))
  assert("keyword probabilities kept", report.keywords.every((k) => Object.keys(k.probabilities).length >= 4))
  assert("grey-zone keywords excluded from the market list", report.keywords.every((k) => k.band !== "escalate"))
  assert("keyword intent distribution built", report.patterns.keywordIntent.length > 0)
  assert("keyword cluster distribution built", report.patterns.keywordCluster.length > 0)

  assert("judged the competitor", report.competitors.length === 1)
  assert("competitor got a scorecard", report.competitors[0]!.score > 0)
  assert("competitor carries a grade", /^[A-E]$/.test(report.competitors[0]!.grade))
  assert("streamed competitor-done", events.filter((e) => e === "competitor-done").length === 1)

  const sample = report.pages[0]
  console.log("─── verified run ───")
  console.log(`pages crawled      ${report.totals.pagesCrawled}`)
  console.log(`pages judged       ${report.totals.pagesJudged}`)
  console.log(`questions asked    ${report.totals.questionsAsked}`)
  console.log(`input tokens       ${report.totals.inputTokens}`)
  console.log(`cost US$           ${report.totals.costUsd}`)
  console.log(`needs a human      ${report.totals.needsHuman}`)
  console.log(`score / grade      ${report.score} / ${report.grade}`)
  console.log(`findings           ${report.findings.length}`)
  console.log(`keywords judged    ${report.totals.keywordsJudged} of ${report.keywordPool.length} mined`)
  console.log(`keyword market     ${report.keywords.length} actionable`)
  console.log(`top keyword        ${report.keywords[0]?.term ?? "none"} @ ${report.keywords[0]?.opportunity ?? 0}`)
  console.log(`keyword clusters   ${report.patterns.keywordCluster.slice(0, 3).map((c) => c.label).join(", ") || "none"}`)
  console.log(`competitor         ${report.competitors[0]?.url} -> ${report.competitors[0]?.grade} ${report.competitors[0]?.score} (${report.competitors[0]?.error ?? "reachable"})`)
  console.log(`link suggestions   ${report.linkSuggestions.length}`)
  console.log(`sample path        ${sample?.path}`)
  console.log(`sample page type   ${sample?.pageType} (${sample?.importance} importance)`)
  console.log(`sample reasons     ${sample?.reasons.join(" | ") || "none"}`)
  console.log(`sample findings    ${sample?.findings.map((f) => f.id).join(", ") || "none"}`)
  console.log(`top prob rows      ${Object.keys(sample?.probabilities ?? {}).length}`)

  server.close()

  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.join("; ")}`)
    process.exit(1)
  }
  console.log("\nAll Jev pipeline assertions passed.")
})
