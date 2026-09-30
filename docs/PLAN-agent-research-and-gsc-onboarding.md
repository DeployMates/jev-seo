# Plan — Agent Research Layer + Search Console Onboarding

Status: proposed · not started
Scope: `/Users/vakandi/Documents/jev-seo`

---

## 0. The one thing to get right first

Jev has **no index, no volume data, no backlink graph** and **never touches the
network**. It is a closed text-only decision model. Everything in this plan
exists to put better *text* in front of it. Nothing here lets Jev fetch
anything.

The layering is deliberate and must not be collapsed:

| Layer | Job | Allowed to be wrong about |
|---|---|---|
| Agent (LLM + tools) | find, read, write | yes — it is a research assistant |
| Jev | decide, with a probability | no — it gates on confidence |
| Code | count, weight, rank, act | deterministic |

**Rule the codebase must enforce:** the agent fills fields and proposes
keywords. It never writes a finding. If it did, every finding would be an LLM
opinion wearing a confidence number, which is exactly the failure mode the
source doc warns about.

---

## 1. Search Console onboarding (the gate)

### Why an onboarding gate and not a checkbox

GSC is hard-walled by Google. Verified live on a site we do not own:

```
403 — User does not have sufficient permission for site 'sc-domain:vuejs.org'
```

So the dashboard must **never** assume access. The user uploads a GCP service
account JSON; we verify it against the target URL; only then do we enable the
GSC tools for that run. Without the JSON the product still works fully on any
website — it just runs at reduced capacity and says so.

### 1.1 Onboarding modal — `web/src/Onboarding.tsx`

Shown on first visit, and re-openable from the capacity banner.

- Drag-and-drop zone for the service account JSON, plus a click-to-browse
  fallback. Both required — drag-drop alone is not accessible.
- **Client-side validation before any upload:**
  - parses as JSON
  - has `type: "service_account"`
  - has `client_email` and `private_key`
  - `private_key` is a non-empty string beginning `-----BEGIN PRIVATE KEY-----`
  - rejects anything else with a specific, human message
- Shows the `client_email` that will be added to Search Console, and the
  three-step instruction: *Google Cloud → IAM → grant that email **Owner** on
  the property*. (Owner, not Full — the indexing API needs it.)
- Explicit consent line: the file is stored **locally on this machine only**,
  git-ignored, never sent to any third party. The key is never echoed back in
  any API response.
- Big primary action: **"Connect Search Console"**. Secondary: **"Skip — run
  without it"**. Skipping is a first-class choice, not a dead end.

### 1.2 Upload endpoint — `POST /api/gsc/connect`

```
1. parse + schema-validate the JSON
2. write to <repo>/.gsc/service-account.json   (mode 0600, git-ignored)
3. spawn `gsc-mcp` with GSC_SERVICE_ACCOUNT_PATH pointing at that file
4. call list_properties
5. reply { connected, clientEmail, properties: [...], error? }
```

Writes go through a path the server owns, never a path taken from the
request body. The filename is fixed, so a hostile upload cannot traverse
out of the directory. The raw `private_key` is never returned to the browser.

### 1.3 Verification — `GET /api/gsc/status?url=…`

Normalises the URL to `sc-domain:<host>` and checks it against
`list_properties`. Returns `verified: true | false` plus the matched
permission (`siteOwner` vs `siteFullUser`).

UI copy is honest about the difference:

| Permission | Badge |
|---|---|
| `siteOwner` | Full capacity — indexing, sitemaps, submit |
| `siteFullUser` | Read capacity — analytics only, no indexing writes |
| not listed | No Search Console access for this URL |

### 1.4 The MCP copy (per the explicit request)

Copy the working server into the project so the project is self-contained and
can be versioned and edited with it:

```
cp -R ~/Documents/mcps_server/google-search-console-mcp/src  →  jev-seo/mcp/gsc-mcp/src
cp    ~/Documents/mcps_server/google-search-console-mcp/.env.example → jev-seo/mcp/gsc-mcp/
```

Register it **locally to this project only** in
`/Users/vakandi/Documents/jev-seo/.mcp.json` — never touching the global
`~/.config/mcp/mcp_servers.json`, which 52 other servers depend on.

```json
{
  "mcpServers": {
    "gsc": {
      "command": "gsc-mcp",
      "env": { "GSC_SERVICE_ACCOUNT_PATH": "<repo>/.gsc/service-account.json",
               "GSC_SKIP_OAUTH": "true" }
    }
  }
}
```

Also support `sites.json` multi-site mode (the server prefers it over the env
var) so several properties can be configured at once.

**Secrets rule:** `.gsc/` and `.env` are git-ignored before the first commit,
and the service account file is chmod 600. A private key must never be
committed.

---

## 2. Capacity badge — the honest signal

A persistent banner answering one question: *is this run using everything, or
is something missing?*

| State | Badge |
|---|---|
| GSC verified + agent + Jev key | **Full capacity** — GSC ✓ · agent ✓ · Jev ✓ |
| GSC not verified, agent + Jev | **Reduced** — no Search Console data for this URL |
| No agent key | **Crawl only** — deterministic rules, no Jev |
| Nothing | **Not configured** — see setup |

Derived from three independent checks, never hard-coded. It must also state
*what is missing and how to fix it* in one click. A capacity badge that cannot
be acted on is decoration.

---

## 3. Two agent prompts, selected by the gate

Both prompts target the same JSON schema, so downstream code is identical.
Only the allowed tool set and the instructions differ.

### 3.1 Prompt A — with Search Console access

Tools: `gsc` + `open-websearch` + `undetected-browser` + `google-trends`

System prompt must instruct: you have **first-party data for this site**;
prefer it over anything inferred; a zero-click row with impressions is a
*title and description* problem, not a content problem; never report a number
you did not receive from a tool; cite the tool and the raw value for every
figure; if a tool fails, continue and mark the field `null` with a reason —
never guess.

### 3.2 Prompt B — without Search Console access

Same tools minus `gsc`, plus an explicit instruction: you have **no first-party
data**; you are describing the market, not the site's own performance; do not
estimate traffic, rank, clicks or impressions; you may describe what a
searcher would see, and what competitors are visible doing.

**Trigger rule (explicit in the request):** onboarding not completed, or the
target URL fails verification → Prompt B. The UI says which prompt is in use
and why.

---

## 4. The agent layer

### 4.1 `server/src/agent.ts`

- opencode SDK, **one** session, model `space-bunny-free` (1M ctx, free,
  tool-calling confirmed).
- Tool allowlist is **constructed per run** from the gate result, not fixed.
  The agent physically cannot call a tool it was not granted.
- Output: one strict JSON blob, validated with `zod`. On invalid JSON: **one**
  retry with the validation error appended. On a second failure: degrade to
  crawl-only and say so. Never pass a malformed blob onward.
- Every returned number carries `{ value, source_tool, raw }` so the UI can
  show provenance and a human can challenge it.

### 4.2 Autofill target

The agent populates the **form** — business name, what it does, market,
competitors, keyword seeds — and nothing else. The user reviews and edits
before any Jev call. Rationale: a single hallucinated market field skews every
downstream decision, and Jev calls cost money.

### 4.3 Explicitly out of scope

- No writing findings. No verdict. No score.
- No crawling in the agent — the deterministic crawler in `crawl.ts` already
  does it better and cheaper.
- No access to the Zen key from the browser. It stays server-side.

---

## 5. Jev input enrichment (the "very extensive" part)

Today each page sends ~14 questions. Goal: widen the state and the rubric so
the same cost buys more signal.

### 5.1 Enrich the state (code-side, free)

Feed Jev the evidence it currently cannot see:

- headings outline, word count, link counts in/out, image count and alt
  coverage
- the page's own title, H1, description, canonical, and **its position in the
  site's internal link graph**
- breadcrumbs, structured-data types found, `lang`, viewport, HTTPS
- a trimmed competing-page summary when the cannibalization pass runs
- for keywords: the candidate's on-page frequency, page spread, heading
  placement, **and Search Console impressions/position/CTR when available**

Every addition must be justified by a question that needs it. The doc is
explicit that *irrelevant context lowers accuracy* and that trimming the state
to the fields a question actually needs cuts cost and raises accuracy. So
state grows **per question set**, not globally. Truncation is flagged in the
state, as it already is.

### 5.2 Widen the rubric

Site level: brand entity consistency, AI citability, content freshness, author
evidence, topic authority.

Page level: above the fold, scannability, internal link adequacy, image
usefulness, CTA clarity, **citation-worthiness of individual paragraphs**
(which is the AI-search lever Ryze's build targets), and the single highest-
impact change.

Keyword level: real-query guard, buyer-intent guard, lookalike guard, intent,
cluster, coverage gap, and **difficulty proxy** from competitor presence.

### 5.3 Cost control

Packing questions into one call is the whole reason this is cheap — 13
questions in one call cost **12.2x less** than 13 calls. Therefore: one request
per page carrying every applicable question, always. New questions are added
to the existing call, never issued as a second call. Budget guard: abort a run
that would exceed a configurable spend ceiling.

---

## 6. TODO — calibrate the input format against known data

**This is the highest-value research task in the plan and it is not a coding
task.** Jev reads questions literally, and the source doc's own numbers say
question design moved phishing accuracy from 62.6% → 95.0% and threshold tuning
moved another 76% → 87%. Those gaps are larger than most differences between
models. So the *format* of what we send is worth more than the model choice.

### 6.1 Build a labelled set

Collect 200–500 real pages **with known ground truth** where available:

- Search Console rows give real queries, positions, clicks, impressions, CTR
  for owned properties — a free labelled set for the "is this page actually
  pulling traffic" question
- pages whose problems are unambiguous (no H1, missing description, duplicate
  title) need no labelling; the deterministic checks are the answer key
- hand-label a slice to check the labels, as the doc's recipe requires

### 6.2 Sweep the variables, one at a time

| Variable | Variants to test |
|---|---|
| State size | minimal fields vs full extract vs truncated |
| State shape | flat JSON vs named nested objects |
| Question wording | plain vs backticked field paths |
| Criteria style | one-line labels vs `what`/`not_for`/`examples` |
| Escape options | with `other`/`not stated` vs without |
| Uncertainty framing | "is the content specific?" vs "does the content name specifics?" |
| Prompt injection defence | explicit "untrusted" clause vs absent |
| Truncation limit | 6k chars vs 2k vs 12k |
| Language | English vs the site's language |

### 6.3 Measure, and keep only what wins

For each variant: accuracy against the labels, **decisive rate** (how often the
answer clears the threshold), coverage, token cost, median and p95 latency.

The metric that matters most is **decisive rate at acceptable accuracy** — a
question that always lands in the grey zone is worthless regardless of its
accuracy, because nothing acts on it.

### 6.4 Lock the winners

Write the winning format into the question registry as the default, with the
losing variants kept behind a flag so the result is reproducible and a future
model change can be re-tested against the same data. Pin a model version once
thresholds are tuned; `jev-latest` moves without notice.

---

## 7. Build order

| # | Step | Depends on | Verify by |
|---|---|---|---|
| 1 | Git-ignore secrets; copy the GSC MCP in; register in local `.mcp.json` | — | `gsc-mcp` starts with the env var set |
| 2 | `POST /api/gsc/connect` + client-side JSON validation | 1 | uploads a bad file → specific error, no write |
| 3 | `GET /api/gsc/status` + capacity badge | 2 | verified / full-user / absent all render correctly |
| 4 | Prompt A + Prompt B + tool allowlist | 3 | unowned URL uses Prompt B and never calls `gsc` |
| 5 | `agent.ts` with zod validation + 1 retry | 4 | malformed JSON degrades, never passes through |
| 6 | Autofill form, editable, user-approved | 5 | no Jev call fires before approval |
| 7 | State + rubric enrichment | 5 | token cost per page stays inside budget |
| 8 | Calibration harness (section 6) | 7 | produces a written comparison table |
| 9 | Lock the winning input format | 8 | defaults updated, variants kept behind flags |

Steps 1–3 are independent of the Zen key and can be built and tested today.
Steps 4–6 need it. Step 8 needs real data and is the slowest.

---

## 8. Risks, stated plainly

| Risk | Handling |
|---|---|
| Private key committed to git | `.gsc/` git-ignored before first commit; file mode 0600 |
| Agent hallucinating a metric | every figure carries its source tool and raw value; no figure = no claim |
| GSC 403 on an unowned site | checked before tools are granted; degrades to Prompt B, never an error |
| Deep research too slow | explicit button, not the default; the 3-second crawl stays instant |
| Yandex MCP returns 403 | excluded — dead credential, verified |
| Model drift | pin a versioned model id once thresholds are tuned |
| Thresholds are untuned defaults | banner says so; the calibration work in section 6 is what makes them real |
| Search volume still absent | Jev has no index. Opportunity is code-computed from observable on-page signals, and the UI says so. GSC adds *your own* data, not a market-wide volume index |
