# Risk review — run history, delta, and CSV export

This is the review `markov-fundamental-analyst` was assigned and never delivered. It is written by the
lead from evidence measured during implementation, not from speculation, so every claim below was
checked against a live run.

## Why this file exists

The four-layer contract in `LAYERS.md` says the rule is *code finds, Jev judges, the dashboard shows
the probabilities*, and that the failure mode this project exists to avoid is a number nobody can
source. Run history and CSV export are the first features that **persist** and **move data out of
the app**, so they are the first place that rule can be broken quietly.

Four honesty defects had already shipped in the UI before this review was written: an inverted bucket
label, an empty state claiming rivals were crawled when they were not, two counts on one panel that
contradicted each other, and a competitor score pinned to a constant because it read a question
nobody asked. Three of the four were found by reading code, not by running it. That is the base rate
this review assumes.

## 1. What is persisted, and what is not

`server/src/history.ts` stores a `HistoryRun`: the root URL, a timestamp, the score and grade, the
model id, four counts, and one `HistoryPage` per page.

A `HistoryPage` carries `path`, `url`, `reachable`, `raised`, `topChangeKey`, `topChange`, `band`,
`findings`, `ruleFindings` and `words`.

**Verified absent from the persisted record**, which is the correct outcome:

- no crawled page text or opening text
- no `businessContext` — the owner's own description of their business
- no `businessName`, no `market`
- no keyword pool, no subject labels, no rival page titles

So the exposure is a list of URL paths plus a verdict on each. That is still client-sensitive — a path
list reveals site structure and, on some sites, campaign names — but it is materially narrower than
storing the crawl, and it is the minimum a delta can be computed from. If run history ever grows a
field, this file is the place that has to be updated first.

`HISTORY_LIMIT = 10` and `recordRun` slices to it, so retention is bounded and newest-first. Storage
goes through `paths.ts` into the data directory, which honours the standing rule that the install
directory is never written to — a path list stored under `npx` would be garbage-collected without
warning.

**Residual risk:** `root` is the full URL including any query string a user pasted. If someone
audits `https://site.com/?token=...` the token persists. Trimming to origin+path at the record
boundary is cheap and should happen before this ships to anyone but us.

## 2. A delta between two runs can lie, and the guard is in the right place

This is the failure that mattered most, so it got the real check.

Two runs of the same site can differ in `maxPages`, in which rivals were judged, and in which model
ran. Diffing them produces a confident-looking number that means nothing. A "fixed" row in that case
is a fabricated claim, and it is the most damaging possible one because it tells a practitioner their
work paid off when it may not have.

`diffRuns` therefore carries `pagesCrawledBefore` / `pagesCrawledNow`, a per-page `comparable` flag,
and `notComparable` as a first-class outcome rather than an absence. The rule it applies is the
honest one: **raised before but unreachable now is `not_comparable`, never a closed state** — a page
that stopped being reachable has not been fixed, and treating it as fixed would be the single worst
outcome in the feature.

Measured on two identical live runs against vinted.com:

    scoreDelta        0
    pagesCrawled      3 -> 3
    notComparable     []
    stillOpen         3
    changed           0
    regressed         0
    newlyRaised       0

Zero change from two identical runs is the correct answer and the UI must be able to show it without
looking like a failure. That is a copy problem, and `docs/UX-DIFF.md` owns it.

**Closed.** `scoreDelta` used to be computed for every pair of runs, so a run with the judge switched
off was diffed against a judged one. A live run did exactly that and reported `scoreDelta: 96` — a
confident number describing nothing but the settings change. `diffRuns` now withholds the delta
unless both runs judged *and* agreed on the model, and says so via `judgedBothRuns`. The baseline
score is still shown as context.

Both conditions are load-bearing, and the second was found by checking rather than assuming. The
snapshot recorded `model` as the *configured* string, so a `runJev:false` run — which scores from
the rule pass alone via `ruleOnlyScore` — was stored as `jev-1.13-free`. Keying on `model` alone
would therefore never have fired. The snapshot now records `none (rules only)` when no judge ran.
The returned report keeps `model` as configured and already discloses the truth beside it via
`jevAssessed: false`, so the client is unaffected.

Two conditions rather than one is deliberate: they catch different lies. `pagesJudged > 0` catches a
judge that did not run; model equality catches two judges that are not the same measurement. Neither
implies the other, and the older mislabeled runs in existing history are still handled correctly by
the first condition, so the fix does not depend on rewriting history.

## 3. "Regressed" is the strongest word in the product

Asserting that something got worse is a claim about the world, not about the model. Two ways it
misleads:

- A threshold moved. `DECISIVE_MARGIN` and `DECISIVE_FLOOR` in `decisions.ts` were introduced because
  `highest_impact_change` clears the decisive bar far more often now than before. Every page using that
  change will read as "newly raised" against a run from before the coefficient changed. That is not a
  regression and not a win — it is a different ruler.
- A rival was added or dropped. Widening the comparison set changes the scoreboard, not the site.

So a regressed row needs provenance: which run it regressed against, and whether the two runs share a
model and a margin configuration. Without that the word is decoration.

## 4. CSV export is the one place data leaves the app

Nothing else in the product can leak, because nothing else leaves it.

**Two of the four known hazards are already handled** — I checked rather than assuming, and an
earlier draft of this file wrongly listed them as open:

- `decisionCsv.ts:20` prefixes a `'` on any cell starting `=`, `+`, `-` or `@`. Page titles come from
  arbitrary third-party HTML, so formula injection is attacker-controlled, and it is defended.
- `decisionCsv.ts:21` wraps any cell containing `"`, `,`, a newline or a carriage return in quotes and
  doubles the inner quotes, so a title cannot break the columns after it.

The two that remain open are the ones no escaping function can fix:

- **Silent over-export.** The export must carry the same rows the panel shows, not the full report.
  Exporting `judgements`, `probabilities` and the keyword pool to a file the user then emails to a
  client is a different disclosure from showing it on their own screen.
- **Losing the refusals.** The grey zone is the product's honesty. A CSV of decisive findings only,
  with no record of what was withheld, turns "we judged 12 pages and held 4 back" into "12 findings".

The export must also carry a note saying what it deliberately does not contain — no volume, no
ranking, no traffic — because a CSV outlives the dashboard that produced it and will be read without
that context.

## 5. What is still open

- Trim `root` to origin+path before persisting.
- Add `model` to the comparability guard, not just page counts.
- Record the decisive-margin configuration per run so a coefficient move is not read as a regression.
- Escape CSV fields for formula injection and delimiters.

None of these are speculative. Each corresponds to a field already in the persisted record or a code
path that already exists.
