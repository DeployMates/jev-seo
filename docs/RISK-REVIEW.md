# RISK-REVIEW — the decision layer

Correctness audit of the design in `docs/UI-CONTRACT.md` against the code that implements it.
Owner: setbon. Task #6. Written 2026-09-30.

The question this review answers is narrow: **where can the panel state something false while every
declared invariant still passes?** Not "is the code clean" — it is clean — but "can a reader be
told a falsehood that the code believes is true."

Each finding is written as four things: what the reader concludes, what the code actually
guarantees, the gap between them, and the guard that would catch it.

## Method, and its limits

Three read-only audits covered the decisions report, the subject tiers, and crawl truncation. Every
finding marked **verified** below I re-read in the source myself. Findings I did not re-derive
independently are attributed to the audit that found them and are marked as such.

That distinction is deliberate and it is not decoration. Earlier in this run I reported three falsifier
ids as dead when they were presence-gated, and I escalated that false positive three times. The cause
was a check too narrow to see the code it was inspecting. So: a finding here that says "verified" means
I read the line. One that says "audit" means I believe the sub-agent's quotation but have not
independently re-run it, and the exact line is given so it can be checked in seconds.

One structural note before the findings. The producer was built to a spec that is explicit about not
lying, and it largely holds: witnesses are code-extracted, question ids resolve, the model chooses
*which* witness template and never authors one. Almost every finding below is therefore not a bug in
the arithmetic. It is a **gap between what the code can prove and what the panel asserts**, and in
several cases the honest version already exists in a source comment that no reader of the dashboard
will ever see. `crawl.ts:111-116` is the clearest example:

> `inbound` counts *crawled* pages that link here, not the whole site… Read `inbound` as a floor,
> never as proof, which is why `inboundCoverage` on the graph states how much of the site was
> actually seen.

That is the correct statement of the limitation. It is in a comment. The card says "0 inbound links."

---

## Summary

| # | Finding | Severity |
| --- | --- | --- |
| C1 | `/api/audit` drops the presearch passthrough; `typed_and_returned` is unreachable | **critical** |
| C2 | Nothing verifies a seed came from a real search | **critical** |
| C3 | `rival_published` can be produced by an answer that was never given | **critical** |
| C4 | 05 says "every answer landed in the decisive band" when no answer was given | **critical** |
| C5 | 02 says "every page landed in the grey zone" when the judge never ran | **critical** |
| C6 | Reach numbers are presented as site facts under a bounded crawl | **critical** |
| M1 | `PAGE_PRIORITY` is a weight; the contract calls it a gate | major |
| M2 | `extraFindings` is unordered, stale, and double-counts the card's own finding | major |
| M3 | 03's empty state asserts a cause the data can contradict | major |
| M4 | `presearch.degraded` is exactly `!ran` — two flags, one bit | major |
| M5 | `rivals[]` lists pages that were never said to serve the term | major |
| M6 | `targetPath` is invented, with no exists/proposed signal | major |
| M7 | A missing witness is silently omitted | major |
| M8 | Per-page judgement errors are counted nowhere | major |
| m1–m7 | See Minor | minor |

**C1 alone means the headline tier of the flagship panel cannot fire.** It should block the run.

---

# Critical

## C1 — `/api/audit` silently drops the presearch passthrough, so `typed_and_returned` cannot fire

**verified**

*Reader concludes:* 03 PAGES TO BUILD is showing terms people actually typed, and 04 RIVALS has
metrics and proposals from the research pass.

*Code guarantees:* `typed_and_returned` is unreachable in production, and the report permanently
states that no presearch data was sent.

Three facts, each verified:

1. The client sends them. `web/src/App.tsx:661-663` sets `keywordSeeds`, `metrics`, `rivalProposals`
   from the presearch payload; `web/src/api.ts:63` spreads `extras` into the POST body.
2. The server declares them. `server/src/audit.ts:202,204` put `keywordSeeds` and `rivalProposals`
   on `AuditRequest`.
3. **The HTTP handler does not forward them.** `server/src/index.ts:219-231` builds an explicit
   object literal with ten fields. `keywordSeeds`, `metrics`, `rivalProposals` and `maxGaps` are
   not among them. `runAudit` has exactly one call site — `grep -rnE "runAudit\(" server/src/`
   returns only `index.ts:219` — so there is no alternate path.

The consequence chain is mechanical:

- `request.keywordSeeds` is always `undefined`
- `subjects.ts:327` `seedSet` returns an empty `Set`
- `subjects.ts:114` `if ((isRealQuery ?? 0) >= 0.5 && seeds.has(normalised(gap.term)))` can never be true
- `audit.ts:1442` `ran` is permanently `false`; `audit.ts:1443` `degraded` permanently `true`
- `audit.ts:1447` `reason` permanently reads *"no presearch data was sent with this request"*

The last one is the user-facing insult. The data *was* sent. The server discarded it and then tells
the user they failed to send it.

The client compounds it. `web/src/App.tsx:848`:
```ts
const presearchRan = report?.presearch?.ran ?? presearchPayload !== null
```
`??` only falls through on `null`/`undefined`, and `ran` is `false`, not nullish — so the server's
hardcoded `false` wins over the client-side fallback even after a successful presearch.

*Gap:* `UI-CONTRACT.md:112-114` states the passthrough "is currently discarded at the audit boundary"
and calls wiring it "the highest value-per-line change available." The wiring was done in
`audit.ts`. The HTTP boundary was never updated, so the contract's own diagnosis is now stale — the
fields are still discarded at the boundary, one layer earlier than the contract says.

*Guard:* a route-level test that POSTs a fixture with `keywordSeeds` and asserts
`report.presearch.ran === true`. One assertion; it would have caught this before the panels shipped.

## C2 — Nothing verifies a keyword seed came from a real search

**verified (the gap); the agent-side handling is from audit, quoted**

*Reader concludes:* the chip `typed and returned` means a person typed this into a search box and
results came back.

*Code guarantees:* the term is a string that a model emitted alongside a non-empty string it called
`evidence_tool`.

`subjects.ts:324-327` narrows the seed type to terms only, structurally discarding the evidence field:
```ts
export function seedSet(seeds: ReadonlyArray<{ term: string }> | undefined): Set<string> {
  return new Set((seeds ?? []).map((seed) => normalised(seed.term)).filter((term) => term.length > 0))
}
```
`UI-CONTRACT.md:207` says *"`evidence_tool` is what makes the term real."* It is never read in
`subjects.ts`.

The schema only requires a non-empty string (`agentSchema.ts:98` `z.string().min(1)`), and the
validation for a citation to a tool that was never called is explicitly **non-fatal**
(`agent.ts:441` *"Gate 3b — the softer half, recorded rather than fatal"*, `agent.ts:448-453`).
Those flags land in `unsupportedCitations`, which no file under `web/src` reads.

*Gap:* once C1 is fixed, a hallucinated seed from a degraded presearch becomes a card asserting human
search behaviour. And `presearch.degraded` is never consulted during tiering — `buildSubjects` is
called at `audit.ts:1424`, before `presearch` is computed at `audit.ts:1441`, and takes no presearch
input. So the server has no way to discount a degraded run's seeds even if it wanted to.

*Guard:* carry the agent's degraded flag into the audit request and refuse `typed_and_returned` when
the run that produced the seeds is degraded. Failing closed is correct here: without evidence of a
search, the honest tier is `our_own_pages`, and the panel already has copy for "only terms a rival
published can justify a new page."

## C3 — `rival_published` can be produced by an answer that was never given

**verified**

*Reader concludes:* "a rival published for this" — and 03 shows up to eight rival page titles as
the evidence.

*Code guarantees:* one boolean that defaults to `true` when the question is absent.

`gap.ts:122-124` `noulP` returns `?? 0.5` for a missing answer. `gap.ts:409`:
```ts
rivalServes: noulP(answers, "rival_serves") >= 0.5,
```
`subjects.ts:115` `if (gap.rivalServes) return "rival_published"`.

An unanswered noul is therefore *exactly* at the pass threshold, and passes. `jevClient.ts:116-125`
`coerceAnswers` silently drops unparseable answers, so absence is a reachable state, not a theoretical one.

The grey-zone detector misses precisely this field. `gap.ts:349-355` `needsHumanFor` checks the band of
`our_serves` but never `rival_serves`. With `bandForNoul(0.5)` returning `review` (`YES = 0.8`,
`NO = 0.2`), an absent `our_serves` *is* caught — so a fully-empty response lands in `shared` and is
accidentally safe. The dangerous case is the **partial** response: `our_serves` answered no,
`rival_serves` omitted. That yields bucket `missing`, tier `rival_published`, and reason text at
`subjects.ts:304` asserting *"A rival page is written to answer this subject."*

*Gap:* the default for an unanswered question was chosen as the neutral midpoint, and the gate was
then written as `>=`. Neutral-default plus inclusive-gate means absence reads as presence. Any noul
gate written this way inherits the same bug.

*Guard:* `noulP` should return `null` for absent, and every gate should treat `null` as "unknown —
do not claim". As a test: feed the gap builder a response with `rival_serves` removed and assert the
tier is not `rival_published`.

## C4 — 05 NOT DECIDED reports band-wide agreement when no answer was given

**verified**

*Reader concludes:* "Every answer Jev gave landed inside the decisive band, so nothing is held back
for you to check."

*Code guarantees:* a run was *started*.

`App.tsx:405`, in `resetRun()`:
```ts
setHasRun(true)
```
`hasRun` is set at the **start** of a run, not its completion. The 05 empty state is gated on it, so if
the run died, auth-failed, or the model never answered, `hasRun` is `true` and `notDecided` is `[]` —
and the panel states that every answer was decisive.

*Gap:* `hasRun` answers "did the user press the button", which is not the question the copy claims to
answer. There is no `decisionState` on the report — `audit.ts:1438-1448` builds exactly this for
presearch and nothing equivalent for decisions. That asymmetry is the root cause: the presearch half
got a `{ran, degraded, reason}` triple and the decisions half got nothing, so the decisions panels
are reconstructing run state from a proxy (`totals.pagesJudged`) that lies in the failure cases.

*Guard:* a `decisions: { ran, degraded, reason }` sibling on `AuditReport`, mirroring `presearch`.
Then 05 and 02 both branch on real state instead of a counter.

## C5 — 02 DO THIS NOW says the gate refused when the gate never ran

**verified**

*Reader concludes:* "0 of 40 pages cleared the gate. Every crawled page landed in the grey zone or
needs nothing."

*Code guarantees:* zero pages were judged.

`web/src/DoThisNow.tsx:184-186` branches on `pagesJudged === 0`, where `pagesJudged` comes from
`App.tsx:801` (`report.totals.pagesJudged`). That is `0` when `runJev` is false (`audit.ts:1053`), when
the site-level call threw `JevAuthError` (`audit.ts:1149-1152` skips the whole page pass), and when
every per-page call threw (`audit.ts:1204-1210`).

*Gap:* the branch claims the gate refused. Nothing was offered to the gate. Worse, the honest branch
immediately below — `"the decision pass produced no rows … Treat this as incomplete"` — is
**unreachable**: it requires `pagesJudged > 0 && rows.length === 0`, but `pagesJudged === 0` is claimed
first, and the two conditions are mutually exclusive. That copy is mine (`UX-VALUE.md:150-155`). I
specified an unreachable state and then the branch order made sure it could never render.

*Guard:* the `decisions: {ran, degraded, reason}` from C4, plus a test asserting that a run with
`runJev: false` produces the "judge did not run" state rather than the "gate refused" state.

## C6 — Reach numbers are presented as site facts under a bounded crawl

**verified; the reach computations are from audit, quoted with line numbers**

*Reader concludes:* this page has 2 inbound links, or 0, and is (or is not) a dead end.

*Code guarantees:* a count over the pages the crawl happened to fetch, within bounds the reader is
never told about.

The bounds: `maxPages` defaults to 40 (`config.ts:82`), `maxDepth: 4` and `budgetMs: 90_000` are
hardcoded inline at `audit.ts:1071-1072` and are not on `AuditRequest` at all. Rivals are crawled
far smaller — `audit.ts:971` `maxPages: Math.min(maxPages, 8), maxDepth: 2, budgetMs: 45_000` — so a
subject page measured over 40 pages is compared against a rival measured over 8.

Two truncation paths make zero actively misleading:
- `crawl.ts:1179` `if (next.depth >= opts.maxDepth) return` fires **before** the link scan, so every
  page at depth 4 has its outbound links never offered to the graph. Those links appear as outbound
  but are never counted as inbound on anything.
- Sitemap-seeded pages (`crawl.ts:1222-1238`) are extracted and pushed, but no link-expansion loop
  runs and `discovered` is never incremented for them.

`deadEnd` inherits the same defect: `outbound` counts only crawled targets (`crawl.ts:988`), so a page
whose links all point past `maxPages` is stamped dead-end.

*Gap:* **there is no truncation flag on the report.** `sitemap.truncated` is a genuine flag
(`crawl.ts:956`) and is read by nothing — `audit.ts:1100` and `1558` take only `.urls.length`.
`inboundCoverage` (`crawl.ts:1071`) is the one number that could bound this and it stops at the Jev
state (`state.ts:349,467`); `graph_coverage` appears nowhere in `web/src`. And `inboundCoverage` is
itself blind to the depth truncation, because its denominator skips exactly the pages that
contribute nothing — so the honesty mechanism is optimistic precisely where truncation is worst.

Meanwhile the card says "0 inbound links" and, in my own copy, **"of all inbound links."** The word
"all" is false: the denominator is the crawl.

*Guard:* surface `inboundCoverage` (or a `truncated` boolean) on the report and render it next to the
reach strip. Failing that, the copy must carry the caveat — `crawl.ts:111-116` already says to read
`inbound` as a floor, and that sentence belongs on the card, not in a comment.

**Fixed in `UX-VALUE.md` while writing this:** the reach strip now reads
`{inbound}+ inbound links from the pages we crawled` and `{inboundShare}% of the inbound links we
found`, and the `+` is explained in the file. The shipping component still needs the change; it is
picasso's.

---

# Major

## M1 — `PAGE_PRIORITY` is a weight; the contract calls it a gate

**verified.** The contract is wrong, the code is right — which makes this the one finding whose fix
is a documentation rewrite, and the lead asked for exactly that.

`UI-CONTRACT.md:59` — *"`PAGE_PRIORITY` must be **gate, not weight**"*.
`decisions.ts:82` — `{ importance: 0.55, reach: 0.45 }`.
`decisions.ts:214-218` — `PAGE_PRIORITY.importance * importance + PAGE_PRIORITY.reach * reach.inboundShare`.

One call site (`audit.ts:752`), one consumer: `audit.ts:1535` `decisions.sort((a, b) => b.priority - a.priority)`.
Zero comparisons, zero early returns. It is a weighted sum and nothing else. The actual gate is
`decisions.ts:314` `if (band !== "act") return null`.

`decisions.ts:73-81` documents this correctly — *"A gate and a weight, in that order… these
coefficients only ever reorder pages"* — and so contradicts the contract it implements.
`UI-CONTRACT.md:47` states the weighted-sum formula while `:59` calls it a gate, twelve lines apart in
the same file.

*Gap:* a reader of the contract would conclude `PAGE_PRIORITY` can suppress rows, and would try to
"fix" the gate by editing coefficients that cannot affect membership.

*Guard:* rewrite `UI-CONTRACT.md:59` to name the real gate (`band !== "act"` / `topChange === null`)
and describe `PAGE_PRIORITY` as an ordering weight only. Separately: the 0.55/0.45 split is reasoned
in prose and derived from nothing — no labelled data, no sensitivity check — yet it determines the
visible order of the flagship panel. A reader sees "01, 02, 03" and reasonably reads that as "do these
first."

## M2 — `extraFindings` is unordered, stale, and double-counts the card's own finding

**verified (ordering and staleness); the double-count is from audit, quoted**

`audit.ts:754` `extraFindings: findings.length`, where `findings` is the per-page array built by three
sequential unsorted pushes (`audit.ts:653, 708, 723`). No sort. Severity is assigned but the order is
array order.

Stale: the cannibalization pass runs *after* the decision rows are built and appends to the same array
at `audit.ts:1257` `if (target) target.findings.push(finding)`. The count is never recomputed, so a
serious cannibalization finding is uncounted.

Double-counted: for most change keys the finding matching the card's own diagnosis is inside the
count. `FALSIFIER` (`decisions.ts:99-104`) points at `answer_first`, `trust`, `title_fit`,
`clear_next_step` — all of which are also finding ids. The contract's "findings that are NOT the top
change" (`UI-CONTRACT.md:50`) is true only in the literal sense that no
`highest_impact_change` option key is ever converted to a `Finding`, which is an accident of id naming
rather than a filter.

The UI then asserts a ranking that does not exist — `DoThisNow.tsx:135-136`:
```tsx
? "This change was the only one that cleared the band, so nothing sits behind it."
: `${row.extraFindings} cleared the band but rank below this one, in the evidence drawer.`
```
*"rank below this one"* is a fabricated ordering, and *"N other findings on this page"* is false
whenever the count includes the card's own defect. The first branch is worse: "the only one that
cleared the band" is contradicted by the cannibalization pass appending a `serious` finding after
the snapshot was taken.

*Guard:* sort the per-page findings by severity before counting, compute the count after all passes
complete, and subtract findings whose id matches the top change's underlying check.

## M3 — 03's empty state asserts a cause the data can contradict

**verified — this was mine, and I have fixed it in `UX-VALUE.md`.**

`subjects.ts:279-285` `clusterNewPage` refuses a new page on four conditions, not the one the contract
states: content type `none`, tier not in `NEW_PAGE_TIERS`, content type `refresh`, **or any cluster
member with a non-empty `existingPaths`**.

The fourth is not in the contract, and `rows.push` at `subjects.ts:238` is unconditional — so a
subject that *is* `typed_and_returned` can be withheld while remaining in `subjects[]` with its tier
intact. The panel filters to `isNewPage`, so the data keeps a counterexample to the empty state.

My copy read *"Terms were judged, but none is typed and returned, and no rival published one."* When
the cluster veto is the cause, that sentence is false and the report holds the disproof.

*Fix applied:* a fourth empty state — *"every term earned a page, and a page you already have covers
it"* — with the line *"These terms were typed and returned, and each is served by a page you already
own. Refresh, do not add."*

Worth noting the guard is **stricter** than documented. `UI-CONTRACT.md:91` says "A term we already
have four pages on must never appear as 'write a new page'"; the code vetoes at **one** page
(`existingPaths.length > 0`). There is no count-based guard. The binary veto is better than the spec
asked for — but the spec should say so, and should acknowledge that `existingPaths` is keyed on
*exact term occurrence* (`keywords.ts:279` `byPage.get(term)`), not topic overlap. A weak or unique
bucket where the term never appears in our own text passes the veto even though we serve the topic.

## M4 — `presearch.degraded` is exactly `!ran`; two flags carry one bit

**verified**

`audit.ts:1442-1443`:
```ts
ran: seedsIn.length > 0 || metricsIn.length > 0 || proposalsIn.length > 0,
degraded: seedsIn.length === 0 && metricsIn.length === 0 && proposalsIn.length === 0,
```
These are logical negations. Enumerating all eight input combinations, `degraded === !ran` always. The
state the two-field shape implies — ran but degraded — is unrepresentable.

`ran` is also not monotone with the panel's capability. If only `metrics` arrive, `ran` is `true` and
`degraded` is `false`, yet no term can be `typed_and_returned` because the seed set is empty. The
panel reports a healthy presearch while being structurally unable to justify a new page, and says
nothing about the missing seeds.

The name is additionally overloaded client-side: `App.tsx:761` falls back to
`sessionSummary?.degraded`, which is real agent-side degradation. So "degraded" means one thing from
the server and another from the client, and `RivalsPanel.tsx:203` branches on the merged value.

*Guard:* three presearch products with three independent availabilities need three flags, or one
`Record<"seeds"|"metrics"|"proposals", boolean>`. A single boolean pair cannot represent eight states.

## M5 — `rivals[]` lists pages that were never said to serve the term

**verified (the wiring); the quoted rationale is from audit**

`audit.ts:1399-1401` — whenever `rivalServes` is true, up to eight rival page *titles* are attached.
`gap.ts:91-92`'s own comment says these are "titles shown to the model, not titles it said serve the
term. Gate on rivalServes." The titles are not filtered by whether the model attributed the term to
them.

The panel renders them as *"rivals already publishing on it"* (`PagesToBuild.tsx:92`), which is an
attribution the run did not make. Combined with C3 — where `rivalServes` can be true because the
question was omitted — this is the weakest evidence chain in the build: an unanswered question
produces a tier, and the tier then displays eight arbitrary titles as corroboration.

*Guard:* only attach titles the model named as serving the term, and say so when none were.

## M6 — `targetPath` is invented, and a refresh row can target the homepage

**verified (construction); the homepage case is from audit, quoted**

`gap.ts:234-248` `targetPathFor` returns `/${slugFor(term)}` for a new page — a slug composed from the
term, at the root. `gap.ts:156-159` states the principle it violates: *"a URL is a fact about the
site, not a judgement."*

`SubjectRow` has no `pathExists` or `isProposed` flag, so nothing distinguishes a page that exists
from a path the system invented. The only signal is the future tense in `PagesToBuild.tsx:39`
`goes to {row.targetPath}`.

The refresh case is worse: `gap.ts:242` `return existing ?? existingPaths[0]!` falls back to the first
existing path in crawl order, and `gap.ts:199-205`'s own docstring warns that this "is usually the
homepage". So a refresh card can read *"goes to /"*.

*Guard:* add a `pathExists: boolean` to `SubjectRow` and render new paths as proposed. Fix the
homepage fallback — if no existing path shares a word, the target is unknown, not `/`.

## M7 — A missing witness is silently omitted

**verified (the omission); the null path is from audit, quoted**

`DoThisNow.tsx:60` renders the witness block only when `topChange.witness` is truthy. `UX-VALUE.md:90-95`
documents copy for the present case and none for the absent case, unlike panel 02 which has four
documented empty states.

`witnessFor` returns `null` both when the key has no template and when the function throws. Those are
different facts — "no countable fact existed" and "the producer swallowed an error" — and the card
renders them identically, by showing nothing.

This breaks the panel's own promise. `UX-VALUE.md:71` sells it as *"the single highest-ranked edit
per page, and the fact that produced it."* When the fact is absent there is no signal that it is
missing, so the card reads as though no fact was ever counted.

*Guard:* document a null-witness state, and separate the two null causes so a swallowed error is
visible rather than silent.

## M8 — Per-page judgement errors are counted nowhere

**verified**

`audit.ts:1496` `errors: crawlResult.errors.length` — crawl errors only. A per-page Jev failure emits
a stream event at `audit.ts:1209` and is then discarded: not in `totals`, not in the report, and the
ledger is only pushed on success (`audit.ts:1202`).

*Reader concludes:* 0 errors, 40 pages judged, and the gate refused all 40.
*Code guarantees:* 40 pages failed and nothing recorded it. The only forensic trace is a short
`ledger.length`, which nothing reads.

*Guard:* a `jevErrors` count in `AuditTotals`, and surface it in the same branch as C5.

---

# Minor

**m1 — Reach floors unlinked pages at 0.55.** `decisionPriority` is `0.55*importance + 0.45*inboundShare`.
A page with zero inbound links — the homepage, most posts — scores at most 0.55, so ordering is
dominated by link count. The rank chip presents the result with no explanation.

**m2 — Witnesses quote attacker-controlled text.** `decisions.ts:174` and `:192-193` interpolate
`page.authors` and `page.topic.primary` — both code-extracted, both derived from page HTML — under
the label *counted on this page*. No model output reaches a witness, so the provenance claim holds;
but a site owner can place arbitrary text in the "counted fact" slot.

**m3 — Empty final reports do not clear streamed rows.** `App.tsx:739`
`if (event.report.decisions?.length) setDecisions(...)` — a report with zero decisions leaves the
streamed rows on screen.

**m4 — `maxGaps` is never forwarded** (`index.ts:219-231`), so `audit.ts:1341` `request.maxGaps ?? 8`
is always 8. Dead configuration.

**m5 — `namedEntityForm` and `broadForm` still order the keyword pool.** Their model questions were
deleted (`questions.ts:894-902`), but the code-side flags remain and `keywords.ts:315` awards
`namedEntityForm` a `+2` weight. This is a documented, deliberate trade-off, not an oversight — but
the residual is real: which terms get judged at all is shaped by a miner heuristic, and no empty
state distinguishes *"no such term exists on this site"* from *"our ranker did not surface it."*

**m6 — `band` is carried and never rendered.** `SubjectRow.band` exists and `PagesToBuild.tsx`
references neither it nor `needsHuman`, so a row's own uncertainty label never reaches the reader.

**m7 — Dead branches.** `hasRun` and the `words` null fallback (`DoThisNow.tsx`, the `wordsByUrl`
fallback in the card props) are unreachable for reports this code produces; both exist only to
tolerate unknown-provenance persisted reports.

---

# What I changed in my own file

Three defects were mine, and I fixed them in `UX-VALUE.md` rather than only reporting them:

1. **The reach strip said "of all inbound links."** False under a bounded crawl (C6). Now
   `{inbound}+ inbound links from the pages we crawled` and `% of the inbound links we found`, with
   the `+` and the depth-4 truncation explained inline.
2. **03's empty state missed the cluster veto** (M3). A fourth cause now exists.
3. **I specified an unreachable empty state** for 02 — *the decision pass produced no rows* — which
   the branch order in `DoThisNow.tsx` makes impossible to render (C5). Still wrong, and now written
   down as wrong rather than shipped as a promise.

I also added the cross-file falsifier invariant and a mutation-tested CI check, which is not a
finding but is what caught three retracted values surviving in `decisionCopy.ts`.

---

# The one-line version

The producer is honest and the panels are not, and the gap is almost always a **missing state
field** rather than a wrong computation. `presearch` got a `{ran, degraded, reason}` triple because
somebody recognised that a silent panel needs a state; `decisions` never got one, so both decision
panels reconstruct run state from proxies that lie precisely in the failure cases. C1, C4 and C5 are
the same omission three times over, and fixing it once — a `decisions: {ran, degraded, reason}`
sibling on `AuditReport` — is worth more than any individual guard in this document.

The second pattern: **the honest caveat already exists, in a comment nobody reading the dashboard
will see.** `crawl.ts:111-116` states that `inbound` is a floor and must never be read as proof. That
sentence is the fix for C6, and it was written before the card existed. The gap is not knowledge. It
is that knowledge stops at the file boundary.
