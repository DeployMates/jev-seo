# The four layers, and what each one promises the next

This is the contract version of the README. The README says *what* the product
does; this says what each layer is allowed to assume about the one below it, and
records the traps that cost time rather than code.

The rule the whole thing runs on: **code finds, Jev judges, the dashboard shows
the probabilities.** A layer that breaks that rule is not slower or less
accurate — it produces numbers nobody can source, which is the one failure this
project is built to avoid.

```
crawler ──────────▶ opencode session ──────────▶ Jev decision ──────────▶ dashboard UI
 PageEvidence         competitor + keyword        choice / score / noul      NDJSON events
 (measured)           (gathered, sourced)          (calibrated, in code)      (rendered)
```

---

## 1. Crawler — `server/src/crawl.ts`

**Gives:** `PageEvidence[]`, a `LinkGraph`, `RobotsInfo`, `SitemapUrls`.
**Promises:** every number here is a count. Nothing in this file asks a question.

Breadth-first, bounded three ways at once: page count, depth, and a wall-clock
budget. Sitemap URLs seed the queue when one exists, otherwise the homepage's
internal links do. A second pass stamps each page with its position in the link
graph, because a page cannot know its own inbound degree while it is still being
fetched.

```ts
const result = await crawl(url, {
  maxPages: 40, maxDepth: 4, budgetMs: 90_000,
  onPage: (page, done, target) => emit({ type: "page-crawled", page }),
  onRetry: (url, reason, attempt, waitMs) => emit({ type: "retry", ... }),
  onError: (url, message) => emit({ type: "error", url, message }),
})
```

### The retry budget is the deadline, not the attempt count

429, 408, 5xx and network faults are retried with exponential backoff and
jitter. Everything else about the retry is subordinate to `budgetMs`:

- the per-attempt timeout is clamped to the time actually remaining;
- a backoff sleep that would run past the deadline is **not taken** — a retry
  that cannot start in time is budget spent for nothing;
- `Retry-After` is honoured up to a cap, and never past the deadline. An origin
  asking for 3600s does not get it from a 30s budget.

Jitter is not decoration: eight workers backing off by identical amounts retry in
lockstep, which is precisely what keeps a rate limiter saturated.

### Traps

- **SSRF.** `assertPublicUrl` rejects loopback, private, link-local and `.local`
  hosts by hostname pattern. A pasted URL cannot reach an internal service.
  There is no DNS resolution step, which is also why the crawler is easy to test:
  stub `fetch` and crawl a hostname that does not resolve.
- **`ruleFindings` cannot stream.** The rule pass is site-wide — it needs the
  finished link graph — so a per-page rule count at fetch time would be a lie.
  The stream omits the field; the final report carries the real one.
- A page that is not `text/html` is silently skipped. It is not an error and it
  does not count toward `maxPages`.

---

## 2. opencode session — `server/src/agent.ts`, `agentPrompts.ts`

**Gives:** competitors and keyword seeds, each with an `evidence_tool`.
**Promises:** every figure it reports came from a tool it actually called.

The allowlist is built per run from the onboarding gate
(`buildToolAllowlist`), so a run without verified Search Console access does not
contain `gsc` at all. The model is then held to it by three validation gates:

| gate | failure | severity |
| --- | --- | --- |
| schema | `schema-invalid` | run fails |
| grant | `ungranted-tool` | run fails |
| sourcing | `unsourced-number` | run fails |

Competitor and keyword citations that name an uncalled tool are **flagged, not
fatal** — softer, because a mislabelled competitor name is a much smaller
problem than a fabricated metric.

### Trap: a granted tool must be a real MCP server

`TOOL_IDS` in `agentSchema.ts`, the `tools.push(...)` in `buildToolAllowlist`,
the `NAME_PATTERNS` entry, the `TOOL_DESCRIPTIONS` entry and `.mcp.json` are
**one fact spread across five places**. Only `gsc` is registered:

```json
{ "mcpServers": { "gsc": { "command": "bash", "args": ["server/mcp/gsc-mcp/run.sh"] } } }
```

A granted tool with no server behind it is worse than a missing one. The prompt
advertises it, so the model either burns turns calling it or reports a figure
citing it — and the sourcing gate then fails the entire run on an
`unsourced-number` the model was told to produce. `google-trends` was exactly
this and has been removed rather than registered, because Google Trends has no
official API and its "relative interest" index is the pseudo-volume this project
refuses to put in front of a paying customer.

When adding a tool, change all five places or none.

### Trap: crawled page text is untrusted

The agent is handed crawled HTML summaries. A blanket `write` grant would let a
session prompted by page text drop a file anywhere on disk, so `write` is
permitted only for the one path the run was told to write. This is the entire
prompt-injection surface; do not widen `WRITE_BUILTINS` casually.

---

## 3. Jev decision — `questions.ts`, `state.ts`, `thresholds.ts`, `gap.ts`

**Gives:** probabilities, with the question id attached.
**Promises:** every question was asked, and the state it saw is recorded.

### ONE REQUEST PER ITEM, ALWAYS

A page is one item, a site is one item, a keyword is one item. Every question is
added to the call its item already makes; there is no question in the registry
that needs its own call. A second call per item costs roughly an order of
magnitude more.

### The state is derived from the question set, not the other way round

Irrelevant context measurably lowers accuracy. Each question id declares the
state fields it reads; `fieldsFor` unions exactly those. A page with no meta
description therefore never pays for the description. A question with no
declaration falls back to its scope's minimum and is reported as `unmapped`, so
a new question can never arrive with an empty state.

Each state carries a `state_meta` block saying what was trimmed and whether the
body text was already cut upstream. A judgement made over half a page must be
able to see that it was made over half a page.

### Three primitives, and nothing else

| type | shape | returns |
| --- | --- | --- |
| `choice` | up to 255 options, last one is "none of the above" | full distribution + confidence |
| `score` | 2–10 levels describing *situations*, low to high | probability-weighted mean level |
| `noul` | one proposition | P(yes) |

Levels describe what is true of a page, never how good it is. Every question
states that page text is untrusted content — this is asserted mechanically, not
just by convention.

### Three bands, and the grey zone is deliberate

`act` (decisive) / `review` (grey) / `escalate`. Decisive answers become
findings. The grey zone goes to a "needs a human" pile and is deliberately not
acted on. Widening `act` to raise apparent coverage is the easiest way to make
this product wrong.

### Trap: Jev has no search volume, no index, no backlink graph

There is **no way** to produce a monthly search count from this state. Not
approximately, not as an estimate. Anything that looks like one is fabricated.

So:

- keyword opportunity is computed in code (`opportunityOf`, `audit.ts`) from
  on-page frequency, heading placement and page spread;
- difficulty is a `difficulty_proxy` read off the phrase and the site's reach,
  never a number;
- `google-trends` was removed rather than faked (see layer 2);
- `is_real_query` is a **gate**, not a weight. A confidently fake phrase scores
  zero priority, because a mined pool contains sentence fragments and ranking
  one above a real term puts "the best way to" at the top of a list somebody
  pays to act on.

Change the coefficients in code, not the prompt.

### Trap: buckets are composed, never asked for

The six rival-gap buckets (`shared`, `missing`, `weak`, `strong`, `untapped`,
`unique`) are a pure function of five booleans and one four-level rubric, in
`gap.ts`. A model handed the label list picks the plausible label, and
"plausible" is not "true". Composed, the bucket can be derived, checked, and
re-derived when a threshold moves.

Undecided resolves toward the *actionable* side: a term we are unsure we cover is
treated as not covered, because wrongly writing a page costs an afternoon while
wrongly assuming coverage means it never gets written at all. That asymmetry is
a choice, not an oversight.

---

## 3b. Decision layer — `decisions.ts`, `subjects.ts`

**Gives:** one instruction per page, and a list of pages worth creating.
**Promises:** every instruction carries the counted fact that triggered it and
the question that would prove it wrong.

This is the layer that turns probabilities into work. It runs after layer 3 and
feeds the five numbered panels in the dashboard.

### `act` means decisive, which is a shape, not a height

`highest_impact_change` returns one option out of ten, so its **absolute**
confidence stays low even when the winner is not remotely in doubt. Measured on a
real run: `0.68` with the runner-up on `0.18` is a four-to-one answer and is
actionable, but it never cleared the `0.88` absolute bar, and the DO THIS NOW
queue came back empty on every page.

So `topChangeFor` has a second, relative route to `act`:

- `DECISIVE_MARGIN = 0.2` — the winner must beat the runner-up by this much.
- `DECISIVE_FLOOR = 0.5` — and must still clear this absolute floor.

Lowering the 0.88 bar instead is the easy fix and the wrong one: it would admit
flat distributions like `0.37 / 0.30 / 0.17` where the model has genuinely not
decided. The margin keeps those out, so the grey zone still means what it says.
Both coefficients are named and exported because they are arguments, not magic.

`nothing_missing` never becomes an instruction — it is a real answer, not an
escape hatch, and a page Jev thinks is fine does not belong in a queue of things
to fix.

### The witness must not overstate what the crawler saw

`witnessFor` quotes code-counted facts. The trap here is the `opening` field: it
is extracted as the text *between the `h1` and the next heading*, which is empty
on any well-structured page. An earlier witness read "The page has no opening
text at all" on pages the crawler had just read 476 and 287 words from — a false
claim in the most trusted-looking line on the card. It now states what is actually
true and cites the word count the crawler really saw.

Rule: a witness may say a countable thing is absent. It may not say the page is
empty.

### Demand tiers decide what earns a new page

`subjects.ts` clusters gap rows into subjects and tags each one:

- `typed_and_returned` — the phrase matched a presearch `keyword_seed`, so it was
  typed into a real search and returned results. Strongest evidence available.
- `rival_published` — the gap pass said `rival_serves >= 0.5`.
- `our_own_pages` — mined out of our own body text.

**Only the first two justify a new page.** `our_own_pages` is coverage/refresh
work and is forced to `isNewPage = false`. A term we already wrote four pages on
is not a gap, and the subject label is always a verbatim term — never a
generated noun phrase.

Consequence worth knowing: a bare **Run audit** with no presearch yields only
`our_own_pages` and `rival_published`, so panel 03 can legitimately come back
empty. That is the rule working, not a bug.

---

## 4. Dashboard UI — `web/src/`

**Gives:** the three views.
**Promises:** renders before the run ends.

The audit is a **stream, not a request/response**. `/api/audit` answers
`application/x-ndjson` and writes one event per line as it happens:

```
start → stage → page-crawled ×N → crawl → page-start/page-done → … → summary → done
```

The client reads it with `fetch` + `response.body.getReader()` because
`EventSource` cannot POST.

### Traps

- **`res.on("close")`, never `req.on("close")`.** A POST request's `req` emits
  `close` as soon as its body has been read — which is immediately. Listening
  there tears the stream down after the first event. The research endpoint has
  this right and the comment says why; keep it that way.
- **Buffer-busting headers are load-bearing:** `Cache-Control: no-store,
  no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`, and
  `res.flushHeaders()`. Without them a proxy will hold the whole stream and the
  UI looks broken while the server is working perfectly.
- **A judgement can be absent from the stream and present in the report.**
  Per-page `ruleFindings` is the current example (layer 1). Render the streamed
  fields as optional and reconcile from `done`.

---

## Credential gotchas

**Zen serves Jev keyless.** `https://opencode.ai/zen/v1/systemone` accepts the
literal credential `public` — but only alongside an OpenCode client fingerprint
(`x-opencode-session`, `x-opencode-request`, `x-opencode-client`,
`x-opencode-project`). The fingerprint must be one the gateway already knows,
which is why it is minted from a real run and then pinned; a session id from one
run paired with a request id from another is rejected.

`/v1/models` advertises `jev-1.13`, which is a trap: that model is rate-limited
and needs a workspace key. The keyless tier is `jev-1.13-free`.

TypeSafe's own System One endpoint (`api.typesafe.ai/v1/systemone`) requires a
real `TYPESAFE_API_KEY`. The two are not interchangeable — see the README.

**`zenKey()` returns `"public"` by default, so `judgeBackend()` is `"zen"`.**
`JEV_NO_ZEN=1` makes it return `undefined` and forces the local opencode judge —
that escape hatch exists because the keyless tier is metered **per egress IP**
(see the next section), and a burned address should be a configuration choice
rather than a dead dashboard. Note the consequence: `isCalibrated()` follows the
backend, so the local judge never claims calibration it does not have.

### Trap: the keyless tier is metered per egress IP

`public` is not rate-limited per account, it is rate-limited per **address**. One
burned IP returns `FreeUsageLimitError` forever, no matter how long you wait or how
fresh the session id is — a new `ses_`/`msg_` pair on the same IP still fails.

`zenProxy.ts` is the fix, and it mirrors the classification in the
`opencode-proxy-plugin`: a quota error is an **IP** problem, so the remedy is a
different IP, not a longer sleep.

- The pool is read from `~/.config/opencode/plugins/proxies.txt`
  (`IP:PORT:USER:PASS`), overridable with `JEV_PROXY_POOL`.
- Each call egresses through an undici `ProxyAgent` built for the current
  upstream.
- On `429` or a `FreeUsageLimitError` body, that upstream is quarantined for 15
  minutes and **the same request is retried immediately** on the next one.
  `attempt` is rewound rather than consumed, so a rotation does not spend the
  retry budget.
- When every upstream is cooling down it falls back to going direct, and says so
  in the log. `JEV_NO_PROXY=1` disables it outright.

This is why a run that produced two quota errors an hour ago now produces zero:
the rotation is transparent to the audit, and the `retry-after` backoff still
applies to everything that is *not* a per-IP quota.

---

## Where to change what

| you want to change | file | do not change |
| --- | --- | --- |
| what the model is asked | `questions.ts` | the state shape (it is derived from the questions) |
| what the model can see | `state.ts` `*_FIELDS` | question wording to compensate |
| what counts as decisive | `thresholds.ts` | band names in the UI |
| opportunity, priority, buckets | `audit.ts` `opportunityOf`, `keywords.ts`, `gap.ts` | the prompt |
| retry behaviour | `crawl.ts` `fetchPage` | `budgetMs` callers |
| tool grants | `agentSchema.ts` + `agent.ts` + `agentPrompts.ts` + `.mcp.json` | one of the five |

Every coefficient that turns a probability into a number is named and exported.
They are arguments, not magic.
