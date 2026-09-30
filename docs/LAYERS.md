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

Whether the layer can run at all is decided by `isAgentAvailable` (a PATH probe
for the `opencode` binary), reported in `/api/config` as `agentConfigured` and
surfaced by `CapacityCluster` in the dashboard header. An audit never needs
it; only `/api/research` does, so a missing binary degrades the run to crawl-only instead
of failing it. The same disclosure carries the egress pool the keyless tier
uses: `proxyStatus()` is reported on `/api/config` as `proxy: {pool, live, host}`,
because `pool: 0` (going direct) and `pool: N, live: 0` (everything quarantined)
look identical in a log and are completely different problems.

### The child resolves no config but the one this project generates

`agent.ts` sets `OPENCODE_CONFIG_DIR` around every run, and `paths.ts` writes two
files into `~/.jev-seo/agent`: `opencode.json` (permissions) and `.mcp.json`
(servers). Without that env var the child also loads the operator's global
`~/.config/opencode/opencode.json` — their MCP servers, their agents, their
provider keys — and a research run on a stranger's site inherits all of it.

The run is driven through the **opencode SDK**, not a `spawn("opencode", "run")`.
That matters for this boundary: the SDK spreads `process.env` into the child and
exposes no env override, so `OPENCODE_CONFIG_DIR` has to be set on `process.env`
before `createOpencode` and restored after — it cannot be passed per call.

The SDK also hands the permission block and the MCP list over as **values** in
`OPENCODE_CONFIG_CONTENT`, which is why `agentPermission(outputPath)` and
`agentMcpServers()` return objects instead of only writing files. One source, two
transports: a grant that differs depending on how the run was launched is a grant
nobody reviewed.

What the SDK costs: the run is no longer isolated in a child process, so a wedged
agent shares a fate with the audit server. It is contained rather than ignored — the
session is aborted on a signal, the server is closed in a `finally`, the ceiling is
10 minutes (`AGENT_TIMEOUT_MS`, sized above a real run's ~45 tool calls), and a
research failure was already a supported degraded result rather than a throw.

`promptAsync` returns as soon as the turn is **queued**, not when it finishes. The
only completion signal is `session.idle` on the event stream; reading the session
straight after `promptAsync` returns finds an empty transcript and degrades a run
that is still working.

The repo-root `.mcp.json` is the dev-from-checkout path only. Its `run.sh`
argument is **relative**, so it cannot resolve from the generated workspace and
must never be the config the child loads.

`writeAgentMcpConfig` leaves `gsc` absent when the vendored Python MCP is not on
disk (it is not in the published tarball), so the run degrades visibly instead
of advertising a server that cannot start.

### The gsc MCP is read-only by construction

The vendored server exposes **33** Search Console tools, all reads. The 27 that
wrote to Google, pulled GA4 analytics, queried CrUX field data, snapshotted
pages for drift comparison, or joined GSC against GA4 were **removed from the
code**, not switched off. A research run has no reason to change anything about
the site it is auditing, and a smaller surface is one that cannot be misused.

`FORBIDDEN_AGENT_TOOLS` in `agent.ts` is a second, independent refusal: even if a
name reappeared in the registry, gate 2 fails the run. Two layers on purpose —
the registry controls what the model can *see*, the denylist controls what a run
is allowed to *do*.

### Trap: a granted tool must be a real MCP server

`TOOL_IDS` in `agentSchema.ts`, the `tools.push(...)` in `buildToolAllowlist`,
the `NAME_PATTERNS` entry, the `TOOL_DESCRIPTIONS` entry and the generated
`~/.jev-seo/agent/.mcp.json` are **one fact spread across five places**:

```json
{ "mcpServers": {
  "gsc":            { "command": "bash", "args": ["<abs>/server/mcp/gsc-mcp/run.sh"] },
  "open-websearch": { "command": "node", "args": ["<abs>/build/index.js"], "environment": { "MODE": "stdio" } }
} }
```

**`open-websearch` is a real MCP server, not a label.** It was described here as
a bucket over opencode's `websearch`/`webfetch` builtins, which was wrong: those
builtins exist, but `open-websearch` is an operator-owned server of its own and it
was never registered. The prompt advertised the grant anyway, so every research run
told the model to use a tool no transcript could contain. It is now registered,
opt-in via `JEV_WEBSEARCH_MCP_DIR`, and `client.mcp.status()` reports
`open-websearch: connected`.

Two details make that registration fail silently, both of which cost a run:

- **It must be spawned `MODE=stdio`.** Its default is `BOTH`, which binds an HTTP
  listener on `:3000` before it reaches stdio. Anything already on that port — an
  unrelated dev server is enough — makes it exit `EADDRINUSE` before it speaks, and
  an MCP server that dies at startup registers no tools and reports no error.
- **The SDK's `Config.mcp` shape is not the `.mcp.json` shape.** The file wants
  `{command, args}`; the SDK types want `{type: "local", command: [...]}`. A server
  passed in the file shape is dropped with no diagnostic. `agentMcpServers()` builds
  the SDK shape and `agentMcpServersForFile()` reshapes it, so the two transports
  cannot drift.

The prompt must name the tool the model can actually call, which for this server is
its namespaced form — `open-websearch_search`, `open-websearch_fetchWebContent`.
`ToolId` is the grant identity; the description is the callable name.

`undetected-browser` is a real operator-owned server too, opt-in via
`JEV_UNDETECTED_BROWSER_CMD`. Its `UB_SOCKET` must travel with it in
`JEV_UNDETECTED_BROWSER_ENV`, or the server starts, finds no socket, and answers
nothing — the same failure as a missing tool, reached by a different road.

A
granted tool with no server behind it is worse than a missing one. The prompt
advertises it, so the model either burns turns calling it or reports a figure
citing it — and the sourcing gate then fails the entire run on an
`unsourced-number` the model was told to produce. `google-trends` was exactly
this and has been removed rather than registered, because Google Trends has no
official API and its "relative interest" index is the pseudo-volume this project
refuses to put in front of a paying customer.

When adding a tool, change all five places or none.

### Trap: crawled page text is untrusted

The agent is handed crawled HTML summaries, so a blanket file-write grant would
let a session prompted by page text drop a file anywhere on disk. The grant is
therefore one absolute path, and it is written by `writeAgentPermissions` on
**every run** rather than at import — the path is `research/run-<ts>-<pid>.json`
and does not exist until `runResearch` picks it.

Two details that are not obvious and that a static block gets wrong:

- opencode has **no `write` permission**. `edit` is the single file-writing
  action and it covers `edit`, `write`, `patch` and `apply_patch`, so scoping
  `edit` to one path grants every write verb for that file and no other.
  `WRITE_BUILTINS` is the *transcript-side* check in `agent.ts`, not a config key.
- `external_directory` is checked **before** the tool's own `edit` decision, and
  the output path is outside the child's working directory. Denying it blocks the
  one write the run exists to perform, so it is scoped to the output directory.

This is the entire prompt-injection surface; do not widen it casually.

The grant is not the whole defence, and it is no longer the main one. The
injection risk that matters is the one the removed write tools used to carry: the
agent reads a site the operator does not control, so text on that page can read
as an instruction, and a `siteOwner` service account turns a bad instruction into
a real Google API call. With those tools gone the blast radius of a successful
injection is a wrong competitor name in the JSON — visible, attributable, and not
destructive.

Keep it that way. The read-only gsc surface is what makes the agent safe to point
at a stranger's website, and `FORBIDDEN_AGENT_TOOLS` is what keeps it that way
when someone adds a tool next year.

### OPEN — the shell deny does not deny the shell

`agentPermission()` sets `bash: "deny"`. **That key does not exist in opencode
1.18.33.** The real tool is `interactive_bash`, so the deny matches nothing and a
research run executes shell commands. Measured: a run whose prompt asked for one
command produced three completed `interactive_bash` calls under exactly this
permission block.

`client.tool.ids()` on a live session also reports `task`, `call_omo_agent`,
`team_*`, `background_cancel` and `proxy_switch` — none of which are in
`FORBIDDEN_AGENT_TOOLS` either, so gate 2 does not catch them. `proxy_switch` can
rotate the operator's own proxy mid-run.

This is not the same class as the traps above: those were closed, this one is
**open**, and the injection surface described above is what it would be exploited
through. `open-websearch` reaching a live server is also what made the run visible
enough to notice — a run with no working tool produced no events at all.

Before this is considered closed, the deny has to name `interactive_bash`, the
team/task/proxy tools need refusing, and it needs a test that asserts a denied tool
is *not* present in `client.tool.ids()` rather than trusting the config block.

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

### Trap: the caller must build the state, not hand-roll it

`state.ts` owns assembly and budgeting, and it is the only thing allowed to
decide what the model sees. `audit.ts` once carried its own `buildState` and
`siteState`, which sent a **fixed** twelve fields per page and nothing else.

That is a silent accuracy bug, not a style one, and it is worth writing down
because the questions were still being asked. Ten fields the registry declares
never reached the model:

- `page.heading_outline` — read by ten questions, including `structure_ease`,
  `title_fit`, `scan_path` and `content_freshness`. `headings` is a flat string
  list, so the model saw the words and not the `h2`/`h3` hierarchy the
  scannability questions are actually about.
- `page.position` — inbound degree, read by `importance`, `action` and
  `internal_link_adequacy`.
- `page.schema_types` — only a `has_schema_org` boolean was sent, so the *type*
  was lost. Read by `trust`, `citable` and `entity_density`.
- `page.authors` — read by `trust`, `specificity` and `competitor_distinctiveness`.
- `page.breadcrumbs`, `page.links`, `page.paragraphs`, `page.text_to_links`,
  `page.topic`, `page.path`.

A `trust` question scored over a state with no authors, a `content_freshness`
question scored over a state with no breadcrumbs, a `structure_ease` question
scored over a state with no heading levels. The model was answering, fluently,
about evidence it had never been shown — which is the exact failure this project
exists to prevent, arriving through the back door.

`audit.ts` now calls `buildPageState` / `buildSiteState`. The page payload went
from a fixed 12 fields to the 18 the asked questions actually declare, plus
`state_meta`. Verified by building a state from a synthetic page and asserting
all ten fields appear.

The general rule: **a question's value comes from the state behind it.** A new
question id is not finished when it is added to `questions.ts` and given a
threshold — it is finished when `state.ts` can actually produce what it reads.

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
`our_own_pages` and `rival_published`, so panel 04 can legitimately come back
empty. That is the rule working, not a bug.

---

## 4. Dashboard UI — `web/src/`

**Gives:** the three views.
**Promises:** renders before the run ends.

### Panel order is a reading order

The numbered sections are read in sequence, and the sequence is a claim about
what the reader needs first:

```
01 scraped → 02 do this now → 03 rivals → 04 pages to build → 05 not decided
```

**03 before 04 is deliberate.** "Pages to build" is a shortlist derived from the
gap between us and the rivals, so the reader has to have seen the rivals first —
what they cover, how they score, what single change would help them most.
Presenting the shortlist before its evidence inverts the argument. The tour step
order (`tourSteps.tsx`) follows the DOM order, so moving a panel means moving
its step too.

`RivalsPanel` keeps the four-field summary scannable and puts the rest of each
rival's record behind a native `<details>`. A run judges thirteen fields per
rival; the topics it covers, the gap it holds and the one change that would help
it most were being crawled and then dropped on screen.

### The audit is a stream, not a request/response

`/api/audit` answers
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

- The pool is read from `~/.config/opencode/plugins/proxies.txt`, overridable with
  `JEV_PROXY_POOL`. Entries are `IP:PORT:USER:PASS` **or** a bare `IP:PORT` for a
  provider that needs no credentials. The second form used to be parsed out and the
  whole pool silently dropped, which left every request falling through to direct —
  so a working proxy set looked exactly like a dead one.
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
| what the model can see | `state.ts` `*_FIELDS` + `*_PRODUCERS` | question wording to compensate |
| what counts as decisive | `thresholds.ts` | band names in the UI |
| opportunity, priority, buckets | `audit.ts` `opportunityOf`, `keywords.ts`, `gap.ts` | the prompt |
| retry behaviour | `crawl.ts` `fetchPage` | `budgetMs` callers |
| tool grants | `agentSchema.ts` + `agent.ts` + `agentPrompts.ts` + `paths.ts` (`writeAgentMcpConfig`) | one of the five |
| what the child may do | `paths.ts` (`writeAgentPermissions`) + `agent.ts` (`FORBIDDEN_AGENT_TOOLS`) | one without the other |

Every coefficient that turns a probability into a number is named and exported.
They are arguments, not magic.
