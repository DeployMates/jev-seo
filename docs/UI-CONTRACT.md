# UI contract — decision layer

Everything both slices need is defined here. Backend implements the producer,
frontend implements the consumer. Neither has to guess or wait.

## Why this exists

`highest_impact_change` is asked on every page (threshold `0.88`, `thresholds.ts:62`)
and **read by zero lines of `audit.ts`**. It is the one signal that converts a
score into an instruction. This contract wires it, and adds the two panels that
make the dashboard answer "what do I do now" instead of "here are some tabs".

## Producer — `server/src/decisions.ts` (new)

```ts
import type { Band } from "./thresholds.js"
import type { ContentType, GapBucket } from "./gap.js"

export interface TopChange {
  /** Question option key, e.g. "answer_in_the_first_two_sentences". */
  key: string
  /** HIGHEST_IMPACT_CHANGES[key].what, verbatim. Already imperative. */
  instruction: string
  /** HIGHEST_IMPACT_CHANGES[key].examples, verbatim. */
  example: string
  /** P(this is the highest-impact change). */
  p: number
  runnerUp: { key: string; p: number } | null
  band: Band
  /** A code-counted fact quoted from PageEvidence. Never a prediction. */
  witness: string | null
  /** The question id that must move for this change to be wrong. */
  falsifier: string
}

export interface Reach {
  inbound: number
  inboundShare: number
  outbound: number
  deadEnd: boolean
  hops: number
}

export interface DecisionRow {
  path: string
  url: string
  /** PAGE_PRIORITY.importance * importance + PAGE_PRIORITY.reach * inboundShare */
  priority: number
  topChange: TopChange
  /** Findings on this page that are NOT the top change. */
  extraFindings: number
  pageType: string
  intent: string
}

export const PAGE_PRIORITY = { importance: 0.55, reach: 0.45 } as const
```

`PAGE_PRIORITY` must be **gate, not weight**: if `topChange === null` (grey zone
or `nothing_missing`), the page produces no `DecisionRow` and a reason is pushed
instead. Never widen `act` to raise coverage.

## Producer — `server/src/subjects.ts` (new)

```ts
export type DemandTier =
  | "typed_and_returned" // matched a presearch keyword_seed — a real search returned results
  | "rival_published"    // gap pass said rival_serves >= 0.5
  | "our_own_pages"      // mined from our own body text

export interface SubjectRow {
  id: string
  /** Representative term, verbatim. NEVER a generated noun phrase. */
  label: string
  phrases: string[]      // the cluster, max 4
  contentType: ContentType
  targetPath: string
  isNewPage: boolean
  tier: DemandTier
  ourState: string
  rivals: Array<{ title: string; domain: string | null }>
  priority: number
  band: Band
  reasons: string[]
}
```

**Rule that must be enforced in code:** only `typed_and_returned` and
`rival_published` justify a **new** page. `our_own_pages` is coverage/refresh
work and must set `isNewPage = false`. A term we already have four pages on must
never appear as "write a new page".

Bucket → contentType is **composed, never asked** (consistent with `gap.ts`):
`strong`/`shared` force `refresh`, never a new page.

## Report additions (`audit.ts`)

```ts
decisions: DecisionRow[]
subjects: SubjectRow[]
presearch: { ran: boolean; degraded: boolean; reason: string | null }
```

## Request additions (`AuditRequest`)

```ts
keywordSeeds?: Array<{ term: string; intent: string; evidence_tool: string }>
metrics?: Array<{ key: string; label: string; number: { value: number; source_tool: string; raw: string } }>
rivalProposals?: Array<{ name: string; url: string; why: string; evidence_tool: string; evidence_query: string; angle: string }>
```

Presearch already returns all three and the client already holds them. They are
currently discarded at the audit boundary. Wiring them is the highest
value-per-line change available.

## Stream additions

```ts
| { type: "decision"; decision: DecisionRow }
| { type: "subject"; subject: SubjectRow }
```

Emitted as they are produced so panels fill live, not at `done`.

## Consumer — new bottom-half IA

The `pages` / `keywords` / `competitors` tabs are **demoted to a collapsed
"Evidence" drawer**. They are organised by entity type; the user thinks in
decisions. Order replaces tabs:

```
01  scraped                     (unchanged)
02  DO THIS NOW                 decisions[], one card per page
03  PAGES TO BUILD              subjects[], new-page only
04  RIVALS                      rivals + rivalProposals + metrics
05  NOT DECIDED                 the grey zone, count + expand
    ▸ EVIDENCE                  collapsed: old tabs, teardown, batch, score
```

### One DO THIS NOW card

1. `topChange.instruction` — largest type, imperative
2. path chip + `words · inbound links · inboundShare` (code-counted)
3. `topChange.witness` — the quoted fact
4. bars: `topChange.p`, plus `runnerUp` **when the gap < 0.15**
5. expander: `extraFindings` other findings, and `topChange.falsifier`

### Forbidden UI vocabulary

No "will rank / improve / boost / drive traffic". The system has no volume, no
index, no SERP. A rival match is topic overlap across pages we crawled from
their own site — never a ranking. CI guard:

```bash
grep -rnEi '\bwill\b[^.]{0,24}\b(rank|improve|increase|boost|drive|help|lift|grow)' web/src/ && exit 1
```

Also forbidden as column or panel names: volume, demand, search volume,
traffic, difficulty score.