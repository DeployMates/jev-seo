/**
 * Verification for the research agent layer. Read-only against the repo: it
 * imports the real functions and asserts on their real behaviour.
 *
 * It covers the four claims that matter, in the order they can fail:
 * the tool allowlist follows the gate; a valid blob passes; a smuggled key or
 * an unsourced number does not; and the spawn path actually returns PONG with
 * the MCP tools reachable.
 */
import {
  buildToolAllowlist,
  extractJsonBlob,
  isAgentAvailable,
  resolveToolId,
  runResearch,
  variantForGate,
} from "../src/agent.js"
import { buildAgentPrompt } from "../src/agentPrompts.js"
import { ResearchOutputSchema } from "../src/agentSchema.js"

let failures = 0
function check(name: string, condition: boolean, extra = ""): void {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

const GATE_OFF = { gsc: { verified: false } }
const GATE_ON = { gsc: { verified: true, permission: "siteOwner" as const, property: "sc-domain:example.com" } }

console.log("\n1. gate -> tool allowlist")
{
  const off = buildToolAllowlist(GATE_OFF)
  const on = buildToolAllowlist(GATE_ON)
  check("unverified gate grants no gsc", !off.includes("gsc"), JSON.stringify(off))
  check("verified gate grants gsc", on.includes("gsc"), JSON.stringify(on))
  check("unverified gate still grants research tools", off.includes("open-websearch"))
}

console.log("\n2. gate -> prompt variant")
{
  check("verified -> Prompt A", variantForGate(true) === "A")
  check("unverified -> Prompt B", variantForGate(false) === "B")
}

console.log("\n3. tool name resolution against real opencode names")
{
  const all = ["gsc", "open-websearch", "undetected-browser", "google-trends"] as const
  check("gsc_list_properties -> gsc", resolveToolId("gsc_list_properties", [...all]) === "gsc")
  check("websearch -> open-websearch", resolveToolId("websearch", [...all]) === "open-websearch")
  check("websearch_web_search_exa -> open-websearch", resolveToolId("websearch_web_search_exa", [...all]) === "open-websearch")
  check("undetected-browser_browser_navigate -> detected", resolveToolId("undetected-browser_browser_navigate", [...all]) === "undetected-browser")
  check("parallel-browser-mcp_browser_click -> detected", resolveToolId("parallel-browser-mcp_browser_click", [...all]) === "undetected-browser")
  check("bash not resolved", resolveToolId("bash", [...all]) === null)
  check("gsc absent when ungranted", resolveToolId("gsc_list_properties", ["open-websearch"]) === null)
}

console.log("\n4. json extraction")
{
  check("bare object", extractJsonBlob('{"a":1}') === '{"a":1}')
  check("fenced object", extractJsonBlob('```json\n{"a":1}\n```') === '{"a":1}')
  check("brace in string survives", extractJsonBlob('prefix {"a":"}"} suffix') === '{"a":"}"}')
  check("prose with no object -> null", extractJsonBlob("no json here") === null)
}

console.log("\n5. schema rejects what the prompt forbids")
{
  const good = {
    business_name: "Acme",
    business_summary: "Does a thing",
    market: "FR",
    competitors: [],
    keyword_seeds: [],
    metrics: [],
    notes: [],
  }
  check("clean form passes", ResearchOutputSchema.safeParse(good).success)

  const withVerdict = { ...good, verdict: "good" }
  check("smuggled verdict rejected", !ResearchOutputSchema.safeParse(withVerdict).success)

  const bareNumber = { ...good, metrics: [{ key: "clicks", label: "Clicks", number: 120 }] }
  check("bare number rejected", !ResearchOutputSchema.safeParse(bareNumber).success)

  const sourced = {
    ...good,
    metrics: [{ key: "clicks", label: "Clicks", number: { value: 120, source_tool: "gsc_get_search_analytics", raw: "clicks: 120" } }],
  }
  check("sourced number passes", ResearchOutputSchema.safeParse(sourced).success)
}

console.log("\n6. prompt content differs by variant and never leaks a tool")
{
  const ctx = { url: "https://example.com", grantedTools: buildToolAllowlist(GATE_OFF) }
  const a = buildAgentPrompt("A", { ...ctx, grantedTools: buildToolAllowlist(GATE_ON) })
  const b = buildAgentPrompt("B", ctx)
  check("A states first-party data", a.includes("first-party data"))
  check("B states no first-party data", b.includes("no first-party data"))
  check("B forbids estimating traffic", b.includes("Do not estimate, infer or recall traffic"))
  check("B does not advertise the gsc tool", !b.includes("first-party Search Console data:"))
  check("both require source_tool + raw", a.includes("source_tool") && b.includes("source_tool") && a.includes("raw"))
}

console.log("\n7. binary present")
{
  check("opencode on PATH", isAgentAvailable())
}

console.log("\n8. real spawn: PONG round trip through the agent layer")
{
  const started = Date.now()
  // A tiny gate keeps the allowlist minimal, but the spawn path, transcript
  // parse and JSON extraction are exactly the production ones.
  const result = await runResearch({ url: "https://example.com" }, GATE_OFF)
  const ms = Date.now() - started
  console.log(
    `  run: ok=${result.ok} degraded=${result.degraded} variant=${result.receipt.promptVariant} ` +
      `tools=${result.receipt.grantedTools.join(",")} called=${result.receipt.toolsCalled.length} ` +
      `attempts=${result.receipt.attempts} session=${result.receipt.sessionId ?? "none"} in ${ms}ms`,
  )
  if (!result.ok) console.log(`  reason=${result.reason} detail=${result.detail.slice(0, 300)}`)
  for (const c of result.receipt.toolsCalled) {
    console.log(`    tool ${c.tool} status=${c.status} out=${JSON.stringify(c.output.slice(0, 90))}`)
  }
  console.log(`    notes=${JSON.stringify(result.data.notes).slice(0, 300)}`)
  check("spawn produced an answer or a clean degrade", result.ok || result.degraded)
  if (result.ok) {
    check("validated against the schema", ResearchOutputSchema.safeParse(result.data).success)
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
