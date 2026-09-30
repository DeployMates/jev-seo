# UX value — exact microcopy for the new bottom half

Companion to `UI-CONTRACT.md`. That file defines the shapes; this one defines
the words. Every string in a fenced block below is shippable copy — lift it
verbatim, do not paraphrase it.

## Voice rules

1. Headings are lowercase, imperative, two or three words. Match `scraped` and `needs a human`.
2. Present tense. A fact is counted, judged or absent. Never predicted.
3. A panel that is empty says which of its causes it is. Never one generic line.
4. No number appears unless code counted it or Jev returned it.
5. Every line is 20 words or fewer. Longer copy is two lines.

### Never write these words

```
volume
search volume
demand
traffic
difficulty score
```

### Never write these constructions

```
will rank
will improve
will increase
will boost
will drive
will lift
will grow
likely to
is projected to
```

They are predictions. This system has no index, no volume data, no backlink
graph and no SERP, so every one of them is invented. The CI guard from
`UI-CONTRACT.md` covers the first block:

```bash
grep -rnEi '\bwill\b[^.]{0,24}\b(rank|improve|increase|boost|drive|help|lift|grow)' web/src/ && exit 1
```

---

## 02 DO THIS NOW

The work list. One card per page. Ordered by `decisions[].priority`.

### Headings

Index and heading, matching the `01 scraped` block:

```
02
do this now
```

Subheading, one line:

```
One change per page, the one Jev ranked first, each with the counted fact behind it.
```

Promise, matching the existing `<b>What this gives you:</b>` pattern:

```
What this gives you: the single highest-ranked edit per page, and the fact that produced it.
```

Count chip:

```
{decided} pages decided · {held} held back in 05
```

### Card subheadings

Top of card, no label — `topChange.instruction` is the largest type on the card.

Path and reach strip. Every number here is code-counted, but the crawl is bounded, so the counts are
floors rather than site facts. Say so on the card:

```
{path} · {words} words · {inbound}+ inbound links from the pages we crawled
```

```
{inboundShare}% of the inbound links we found
```

`+` is not decoration. `crawl.ts` caps the run at 40 pages, depth 4 and a 90-second budget, and a
page at depth 4 has its links never scanned for discovery at all — so a page can show zero inbound
links purely because the crawl stopped. A reader shown "0 inbound links" concludes the page is
orphaned; the run only guarantees it found none in what it reached. Never write "all inbound links":
the denominator is the crawl, not the site. The producer's own comment says to read `inbound` as a
floor and never as proof — the card has to say it too, or the qualifier lives only in a source file
nobody reading the dashboard will see.

The witness line. Label, then the quoted fact:

```
counted on this page
{topChange.witness}
```

The probability line, then the runner-up only when the gap is under 0.15:

```
jev
```

```
runner-up · {runnerUp.instruction} · {runnerUp.p}
```

When the two are close, say so rather than pretending the first one won:

```
these two are within {gap} of each other, so treat them as one decision
```

When there is no runner-up at all:

```
only one change was on the table, so there is no second
```

The expander:

```
{n} other findings on this page
```

```
we would be wrong if
{topChange.falsifier}
```

### Empty states for 02

**No run yet.**

```
no run yet
Nothing has been crawled, so there is no page to change. Edits appear here as Jev picks them.
```

**Legitimately empty — the gate refused.** This is the honest and common case, not a failure.

```
0 of {crawled} pages cleared the gate
Every crawled page landed in the grey zone or needs nothing. This is the gate refusing, not a clean site.
```

```
see 05 for what was held back, and why
```

**The pass ran and produced nothing.** Never report this as a clean site.

```
the decision pass produced no rows
Pages were crawled and judged, so a top change should have been picked. None was. Treat this as incomplete.
```

**Still running.**

```
pages are arriving
A page lands here the moment Jev picks a change for it.
```

---

## 03 PAGES TO BUILD

`subjects[]`, filtered to `isNewPage === true` only. Refresh work is never in this panel.

### Headings

```
03
pages to build
```

Subheading:

```
Only terms someone actually typed, or that a rival already published for.
```

Promise:

```
What this gives you: the terms that earned a new page, and where each one should point.
```

Count chip:

```
{n} to build · {k} sent to refresh in 02 instead
```

### Row subheadings

The term, verbatim. Never a generated noun phrase — the label is the string Jev returned.

Tier, spelled out, because it is the whole justification for the row:

```
typed and returned
```

```
rival published
```

Content type. Only one of these can render:

```
write a new page
```

```
refresh instead
```

The destination:

```
goes to {subject.targetPath}
```

The reason, when there is more than one:

```
why this is here
{subject.reasons joined with ·}
```

### Refusal copy

`our_own_pages` forces `isNewPage = false` and must never render here. If it ever does, it is a bug
and the row says so:

```
this term is already on your own pages, so it belongs in 02, not here
```

A `strong` or `shared` gap bucket is refresh work by rule. It can never become a new page:

```
this topic is already shared, so this is a refresh, not a new page
```

### Empty states for 03

**No run yet.**

```
no run yet
No presearch has run, so no term is typed and returned. Run an audit to fill this panel.
```

**Presearch did not run or was degraded.** Report the degradation rather than hiding it.

```
presearch did not run
{report.presearch.reason} Only terms a rival published can justify a new page.
```

**Nothing earned a new page.** This is the honest success case.

```
nothing earned a new page
Terms were judged, but none is typed and returned, and no rival published one. No new page is justified.
```

**A fourth cause this panel must be able to state, because the data will contradict the line above.**
`clusterNewPage` vetoes on more than tier. A cluster is refused a new page if *any* member already
has an existing path — so a term that **is** `typed_and_returned` can still be withheld, and it is
still in `subjects[]` with its tier intact. The panel filters to `isNewPage`, the data keeps the
subject, and the empty state above then asserts something the report contains the counterexample to.
When this is the cause, say it:

```
every term earned a page, and a page you already have covers it
These terms were typed and returned, and each is served by a page you already own. Refresh, do not add.
```

**Every candidate is already covered.**

```
everything is already covered
Every judged term is already on your own pages, so this is refresh work.
Find the work in 02 do this now.
```

**Every gap sat in a strong or shared bucket.**

```
every gap was already shared
Every gap sits in a strong or shared bucket, which is refresh work by rule.
No new page follows from a shared topic.
```

**No term is a buying query.**

```
{n} terms judged · none is a buying query
Real searches, none of them buying. There is no new page here worth the write.
```

---

## 04 RIVALS

`rivals`, `rivalProposals[]` and `metrics[]`.

### Headings

```
04
rivals
```

Subheading:

```
Side by side on the same rubric, judged from pages crawled off each rival's own site.
```

Promise:

```
What this gives you: the topics a rival covers that you do not, and the angle they took.
```

Count chip:

```
{reachable} of {requested} rivals reachable
```

### Row subheadings

```
on {rival.page}
```

```
matched on {shared terms}
```

```
worth copying
```

Proposal block:

```
proposed rival
```

```
why
{rivalProposal.why}
```

```
asked: {rivalProposal.evidence_query} on {rivalProposal.evidence_tool}
```

```
angle
{rivalProposal.angle}
```

```
filling this is your call, and no number here says what it pays
```

Metric block. The label comes from the source tool and the value is quoted, never recomputed:

```
{metric.label}
{metric.number.raw}
```

```
from {metric.number.source_tool}
```

```
every number here is quoted from the tool that returned it. No number here was estimated.
```

### The standing refusal note

Required, permanent, and never removed for space. Render once per panel, not per row.

Full form, for the panel head:

```
We never read a live results page. No search results page is fetched, parsed or stored at any point.
A rival match is topic overlap across pages we crawled from that rival's own site. It is never a ranking.
```

One-line form, for the tight filter strip where the existing `opp-honest` slot sits:

```
no live results page is ever read
a rival match is topic overlap across pages crawled from their site, never a ranking
```

The second line replaces the current string, which is close but lets `matched on` read as a placement.
`matched on` is topic overlap. It must never sit next to a word implying position.

### Empty states for 04

**No run yet.**

```
no run yet
No rival has been crawled. Add one above, then run the audit to compare against.
```

**No rivals were configured.** Not a failure, and not the same as unreachable.

```
no rivals to compare against
This run had no rivals, so there is nothing to compare and no rival page was crawled.
```

**No rival was reachable.**

```
no rival was reachable
All {n} rivals were crawled without a usable result. This is a reachability problem, not a content one.
```

```
fix the rivals and re-run rather than writing these off
```

**Rivals judged, but nothing worth copying was proposed.**

```
{n} rivals judged · no rival page proposed
Every rival was judged on the same rubric as your site. None produced a page worth copying.
```

**Judged, but no metrics came back.**

```
{n} rivals judged · no metrics returned
The metrics tool returned nothing for these rivals. Quote nothing rather than substitute a number.
```

---

## 05 NOT DECIDED

The grey zone. This absorbs the existing `needs a human` panel — do not ship both.

### Headings

```
05
not decided
```

Subheading:

```
Everything above this line is something the model committed to. This line is the honest edge of it.
```

Promise:

```
What this gives you: what Jev refused to commit to, so you can judge it yourself.
```

Count chip:

```
{n} in the grey zone · not acted on
```

### Row subheadings

```
{band === "escalate" ? "needs a human" : "to verify"}
```

```
why it was held back
{reasons joined with ·}
```

The held-back row never carries a fix, an instruction or a priority. It is listed and nothing more.

### Empty states for 05

**No run yet.**

```
no run yet
Nothing has been judged, so nothing is being held back. Run an audit to fill this panel.
```

**Legitimately empty.** The good case, and it deserves the same care as a full panel.

```
nothing in the grey zone
Every answer Jev gave landed inside the decisive band, so nothing is held back for you to check.
```

---

## The falsifier line

One line per card, inside the expander. It is the whole reason to trust the card: the claim states
what result would prove it wrong.

### Label

```
we would be wrong if
```

Four words, first person, nothing hedged. Not `caveat`, not `might be wrong`, not `confidence`.

### Shape

The line names a question id and the result that would contradict the claim.

**Polarity is the whole trick, and it is easy to invert.** For a *fix* — the change exists
because something is missing — the falsifier is the **positive** result. If proof already
substantiates the claims, the fix is unnecessary. Getting this backwards makes the card announce
doubt at the exact moment the evidence agrees with it, which is worse than shipping no falsifier.

The one exception is `nothing_missing`, where the claim is already the positive one: there, the
falsifier is the **negative** result.

A noul question takes its answer. A score question takes the band. A choice question takes the option.

```
we would be wrong if {question_id} already answers yes on this page
```

```
we would be wrong if {question_id} already clears the decisive band on this page
```

```
we would be wrong if {question_id} already names a specific action
```

### The map to implement

This is the `FALSIFIER` map in `server/src/decisions.ts`. Ids are verbatim from `questions.ts`.

Most page questions are **presence-gated**: `answer_first` and `title_fit` are only asked when the
page has an H1 or a title, `meta_fit` only with a description. A question that was never asked cannot
be the one that has to move, so the server substitutes `structure_ease` or `intent` and only falls
back to `page_type` when the gated questions were all skipped. `falsifier` is therefore always a
question this run actually asked — but the panel must never imply a check the run could not make.
Where the substituted question is weaker than the original, say so rather than borrowing the
original's label.

The third column is the line as it ships, with the id rendered to English. The id column is for
whoever implements it. Never show the reader the id itself.

| `key` | falsifier id | rendered line |
| --- | --- | --- |
| `answer_in_the_first_two_sentences` | `answer_first` | `we would be wrong if the opening already answers in the first two sentences` |
| `add_self_contained_facts` | `citable` | `we would be wrong if this page is already quotable out of context` |
| `add_proof_and_sources` | `claims_substantiated` | `we would be wrong if every claim on this page is already backed` |
| `name_an_author` | `trust` | `we would be wrong if this page already shows real expertise` |
| `link_onward` | `internal_link_adequacy` | `we would be wrong if this page already carries a reader onward` |
| `break_it_into_sections` | `scan_path` | `we would be wrong if this page already gives a route through it` |
| `name_one_action` | `clear_next_step` | `we would be wrong if this page already gives an obvious next step` |
| `retitle_for_the_searcher` | `title_fit` | `we would be wrong if the title already fits what a searcher would type` |
| `narrow_or_split_the_page` | `intent` | `we would be wrong if this page already names one topic` |

There is deliberately no `nothing_missing` row. `topChangeFor` returns `null` on NO_CHANGE, so no
`TopChange` can ever carry that key, and the no-change case reaches the panel as prose on
`notDecided.reason` instead. An unreachable row invites a reader to assume it is live — the same trap
as a falsifier naming a question the run never asked.

Two rules survive that deletion, and both matter if the row is ever reinstated. It must not be
`nothing_missing` itself, since the change would be grading itself. And its polarity **inverts**:
every other falsifier is the POSITIVE result, but "nothing is missing" is already the positive
claim, so it takes the NEGATIVE one. `citable` is the right id for it — high citability would prove
something is missing, and low citability would leave the claim standing.

The server also emits `page_type` as a last resort, and only when a page's gated questions were all
skipped. `page_type` is deliberately **not** `highest_impact_change`: a falsifier taken from the
question that produced the change is a tautology, not a test. `page_type` is asked on every page and
can genuinely contradict an instruction — a page decisively typed `legal_or_policy` is not helped by
most of the changes above.

The `nothing_missing` case is not in the table above, for the reason given there. Its falsifier, if
the gate is ever relaxed, is `citable` in the negative direction.

Note that row. It is the only change that claims nothing is wrong, so it is the only one whose
falsifier is a **negative** result. Copy the polarity from the row above it and the remaining nine
all break. Its falsifier is also not the question that produced it: `action` is what the harness
asked to reach `nothing_missing`, so naming `action` would be the change grading itself.

A second line is allowed where code, not Jev, can settle it:

```
we would be wrong if this page already links onward from body copy, not just the footer
```

### Rendering the falsifier id

`falsifier` arrives from the server as a raw question id. It must never reach the screen as one.
`<code>title_question_answered</code>` is a machine artefact on the one line the card's credibility
rests on, and it reads as though the panel stopped trying.

Render the id through this map and drop the `<code>` wrapper:

| id | rendered as |
| --- | --- |
| `answer_first` | `the opening already answers in the first two sentences` |
| `citable` | `this page is already quotable out of context` |
| `claims_substantiated` | `every claim on this page is already backed` |
| `trust` | `this page already shows real expertise` |
| `internal_link_adequacy` | `this page already carries a reader onward` |
| `scan_path` | `this page already gives a route through it` |
| `structure_ease` | `a visitor already finds what they came for` |
| `clear_next_step` | `this page already gives an obvious next step` |
| `title_fit` | `the title already fits what a searcher would type` |
| `intent` | `this page already names one topic` |
| `page_type` | `this page is already doing the job its type calls for` |

**An id that is not in this table must not be printed.** Drop the id and render the generic form
instead, which is vaguer but still true:

```
we would be wrong if this page already did this
```

That way an id that is unknown, or a question that was never asked because the page lacked the field
it is gated on, degrades to a weaker true claim rather than a confident false one. Never interpolate
an unknown id into the sentence, and never imply a check the run could not have made.

### The cross-file invariant

Three files hold this line, and the split between them is deliberate:

| file | owns |
| --- | --- |
| `server/src/decisions.ts` | which question a change is falsified by — **id only, never direction** |
| `docs/UX-VALUE.md` | the English label, and the **polarity** |
| `web/src/decisionCopy.ts` | the label lookup and the unknown-id fallback |

The producer cannot hold polarity because **one id can falsify two opposite claims**. If the
`nothing_missing` gate is ever relaxed, `citable` will serve `add_self_contained_facts` — where high
citability proves the change is unnecessary, so the positive result falsifies it — and
`nothing_missing`, where low citability proves something *is* missing, so the negative result
falsifies it. A single field on the producer would have to mean both. So the map emits the id, this
file states the direction, and the table below is the only place the direction is written down.

That makes this file load-bearing in a way the other two are not. Deleting a row here does not break
a build; it silently reverts a claim to whichever direction the reader assumes.

**A label for an id the producer can never emit is a defect, not a safety net.** Keeping the
superseded ids around "in case the correction has not shipped yet" is how a retracted value survives
in a shipping file — it already happened once, in `decisionCopy.ts`, with a comment asserting the
producer had not been corrected. It had. Delete them; the unknown-id fallback is the correct answer
to a stale producer, and it is honest.

Check all three files still agree:

```bash
python3 - <<'PY'
import re, sys
dec = open('server/src/decisions.ts').read()
cop = open('web/src/decisionCopy.ts').read()
doc = open('docs/UX-VALUE.md').read()

def block(src, start, ends):
    i = src.index(start) + len(start)
    j = min([src.index(e, i) for e in ends if src.find(e, i) != -1] or [len(src)])
    return src[i:j]

prim = block(dec, 'export const FALSIFIER:', ['export const FALSIFIER_FALLBACK:', '/**'])
fall = block(dec, 'export const FALSIFIER_FALLBACK:', ['export const', '/**'])
vals = lambda b: set(re.findall(r':\s*"([a-z_]+)"', b))
emittable = vals(prim) | vals(fall) | set(re.findall(r'LAST_RESORT_QUESTION = "([a-z_]+)"', dec))
server = dict(re.findall(r'^\s+(\w+):\s*"([a-z_]+)"', prim, re.M))
labelled = set(re.findall(r'^\s+([a-z_]+):\s*"', block(cop, 'FALSIFIER_LABELS', ['}']), re.M))
tabled = dict(re.findall(r'^\| `([a-z_]+)` \| `([a-z_]+)` \|', doc, re.M))

bad = False
for x in sorted(labelled - emittable):
    print(f"DEAD LABEL (producer can never emit it): {x}"); bad = True
for x in sorted(emittable - labelled):
    print(f"MISSING LABEL (degrades to generic): {x}"); bad = True
for k, q in tabled.items():
    if server.get(k) != q:
        print(f"DRIFT: doc says {k} -> {q}, server says {server.get(k)}"); bad = True
for k in server:
    if k not in tabled:
        print(f"MISSING IN DOC: server has {k}"); bad = True
print("FALSIFIER INVARIANT:", "FAIL" if bad else "PASS")
sys.exit(1 if bad else 0)
PY
```

Note the split keys carry their trailing colon. `'export const FALSIFIER'` also matches
`'export const FALSIFIER_FALLBACK'`, so splitting on the bare name silently cuts the block before the
fallbacks and reports every fallback as a dead label. A guard that cries wolf gets switched off.

The dead-label direction is the one worth failing the build on. A missing label only costs a vaguer
true sentence; a dead label means someone is keeping a value alive on purpose, which is exactly how
a retracted claim outlives its own retraction.

### Words banned from the falsifier line

```
may
might
could
possibly
probably
likely
perhaps
we think
we believe
we feel
```

A falsifier that hedges is not a falsifier. Guard it:

```bash
grep -rnEi '\b(may|might|could|possibly|probably|likely|perhaps|we (think|believe|feel))\b' web/src/decision*.tsx && exit 1
```

---

## One existing line to change

`web/src/OpportunityBoard.tsx:207` currently reads:

```
the traffic would be reading, not converting
```

That is a predicted outcome and it uses a banned word. Replace it with the `none is a buying query`
body in 03, which makes the same point from what was judged:

```
Real searches, none of them buying. There is no new page here worth the write.
```

## Verification

Every fenced block in this file is copy, except the `bash` blocks. Count the words:

```bash
python3 - <<'PY'
import re
lines = open('docs/UX-VALUE.md').read().split('\n')
blocks, cur, tag = [], [], None
for ln in lines:
    m = re.match(r'^```(\w*)\s*$', ln)
    if m:
        if tag is None: tag = m.group(1) or 'copy'
        else: blocks.append(cur); cur, tag = [], None
    elif tag is not None: cur.append(ln)
bad = [l for b in blocks for l in b if l.strip() and len(l.split()) > 20]
print(f"{len(blocks)} blocks, {len(bad)} over 20 words")
for l in bad: print(len(l.split()), l)
PY
```

Plain `awk` toggling on `^```$` does not work here: a tagged fence like ```` ```bash ```` never
matches, so the state flips on every tagged block and the count silently comes back clean.

No line above 20 words is shippable. Placeholders in `{}` count as one word each.
