/**
 * Proves the two claims a prompt cannot make: a bad reply is retried exactly
 * once and then degraded, and it never reaches the caller as data.
 *
 * `opencode` is replaced with a stub that replays a canned transcript, so each
 * case is deterministic and the run count is countable. AGENT_BIN is read at
 * module load, so it must be set before the import below -- hence the separate
 * entry point rather than a second suite.
 */
import { writeFile } from "node:fs/promises"
import { runResearch } from "../src/agent.js"

const STUB = process.env.STUB_BIN ?? "/tmp/stub-opencode.sh"
const LOG = process.env.STUB_RUN_LOG ?? "/tmp/stub-runs.log"
const REPLY_FILE = process.env.STUB_REPLY_FILE ?? "/tmp/stub-reply.txt"

let failures = 0

async function scenario(name: string, reply: string, expectReason: string): Promise<void> {
  await writeFile(REPLY_FILE, reply, "utf8")
  const before = await countRuns()
  const result = await runResearch({ url: "https://example.com" }, { gsc: { verified: false } })
  const after = await countRuns()
  const spawns = after - before

  const degraded = !result.ok && result.degraded
  const emptyForm =
    result.data.business_name === null &&
    result.data.competitors.length === 0 &&
    result.data.keyword_seeds.length === 0 &&
    result.data.metrics.length === 0

  console.log(`\n  ${name}`)
  console.log(`    spawns=${spawns} ok=${result.ok} degraded=${result.degraded} reason=${result.ok ? "-" : result.reason}`)
  console.log(`    attempts recorded=${result.receipt.attempts}  detail=${result.ok ? "-" : result.reason === expectReason ? result.detail.slice(0, 120) : `UNEXPECTED (wanted ${expectReason})`}`)

  const checks: Array<[string, boolean]> = [
    ["did not pass bad data through", degraded],
    ["degraded to an empty form", emptyForm],
    ["retried exactly once (2 spawns)", spawns === 2],
    ["attempts recorded as 2", result.receipt.attempts === 2],
    [`reason is ${expectReason}`, !result.ok && result.reason === expectReason],
    ["carries a reason for the user", !result.ok && result.detail.length > 0],
  ]
  for (const [label, ok] of checks) {
    if (!ok) failures += 1
    console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}`)
  }
}

async function countRuns(): Promise<number> {
  const { readFile } = await import("node:fs/promises")
  try {
    const text = await readFile(LOG, "utf8")
    return text.split("\n").filter((l) => l.trim() === "STUB_RUN").length
  } catch {
    return 0
  }
}

console.log("\n== retry-then-degrade ==")

{
  const { existsSync, accessSync, constants } = await import("node:fs")
  let usable = existsSync(STUB)
  if (usable) {
    try {
      accessSync(STUB, constants.X_OK)
    } catch {
      usable = false
    }
  }
  if (!usable) {
    failures += 1
    console.log(`  FAIL  stub binary ${STUB} is missing or not executable`)
  } else {
    console.log(`  stub binary ok: ${STUB}`)
  }
  process.env.STUB_REPLY_FILE = REPLY_FILE
  process.env.STUB_RUN_LOG = LOG
}

await scenario(
  "reply is prose, no JSON at all",
  "I could not research this website, sorry.",
  "invalid-json",
)

await scenario(
  "reply is valid JSON with a smuggled verdict key",
  '{"business_name":"Acme","business_summary":"s","market":"FR","competitors":[],"keyword_seeds":[],"metrics":[],"notes":[],"verdict":"good","score":91}',
  "schema-invalid",
)

await scenario(
  "reply cites a tool that never ran",
  '{"business_name":"Acme","business_summary":"s","market":"FR","competitors":[],"keyword_seeds":[],"metrics":[{"key":"clicks","label":"Clicks","number":{"value":4820,"source_tool":"gsc_get_search_analytics","raw":"4820"}}],"notes":[]}',
  "unsourced-number",
)

await scenario(
  "reply is truncated mid-object",
  '{"business_name":"Acme","business_summary":"does th',
  "invalid-json",
)

console.log("\n== provenance gate accepts a correctly sourced number ==")

{
  const { existsSync, rmSync } = await import("node:fs")
  const flag = process.env.STUB_TOOL_FLAG ?? "/tmp/stub-emit-tool"
  // Created here, not up front: the degrade scenarios above must run with no
  // tool calls, or "cites a tool that never ran" stops testing anything.
  await writeFile(flag, "", "utf8")
  if (!existsSync(flag)) {
    failures += 1
    console.log(`  FAIL  stub tool flag ${flag} missing; cannot emit a tool call`)
  } else {
    await writeFile(
      REPLY_FILE,
      '{"business_name":"Acme","business_summary":"Makes a thing","market":"FR",' +
        '"competitors":[{"name":"Rival","url":"https://rival.example","why":"Ships same product","evidence_tool":"gsc_get_search_analytics"}],' +
        '"keyword_seeds":[{"term":"example widget","intent":"commercial","evidence_tool":"gsc_get_search_analytics"}],' +
        '"metrics":[{"key":"clicks_28d","label":"Clicks (28d)","number":{"value":4820,"source_tool":"gsc_get_search_analytics","raw":"clicks 4820"}},' +
        '{"key":"ctr_28d","label":"CTR (28d)","number":{"value":0.0529,"source_tool":"gsc_get_search_analytics","raw":"ctr 0.0529"}}],' +
        '"notes":[]}',
      "utf8",
    )
    // Verified gate: the stub emits a gsc tool call, so gsc must be granted or
    // the ungranted-tool check fires first and we would be testing that instead.
    const result = await runResearch({ url: "https://example.com" }, { gsc: { verified: true, property: "sc-domain:example.com" } })
    rmSync(flag, { force: true })
    console.log(`  ok=${result.ok} degraded=${result.degraded} spawns=${result.receipt.attempts} calls=${result.receipt.toolsCalled.length}`)
    if (!result.ok) console.log(`  reason=${result.reason} detail=${result.detail.slice(0, 200)}`)
    console.log(`  metrics=${JSON.stringify(result.data.metrics)}`)
    console.log(`  flagged=${JSON.stringify(result.receipt.unsupportedCitations)}`)

    const checks: Array<[string, boolean]> = [
      ["accepted on the first attempt", result.ok && !result.degraded],
      ["did not need a retry", result.receipt.attempts === 1],
      ["kept the sourced metric", result.data.metrics.length === 2],
      ["kept business_name", result.data.business_name === "Acme"],
      ["kept the competitor", result.data.competitors.length === 1],
      ["kept the keyword seed", result.data.keyword_seeds.length === 1],
      ["no unsupported citations", result.receipt.unsupportedCitations.length === 0],
    ]
    for (const [label, ok] of checks) {
      if (!ok) failures += 1
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`)
    }
  }
}

console.log(`\n${failures === 0 ? "ALL DEGRADE CHECKS PASSED" : `${failures} DEGRADE CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)