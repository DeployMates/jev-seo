# UX-DIFF — microcopy for run history, the delta column and CSV export

Companion to `UX-VALUE.md` and `UI-CONTRACT.md`. Those two settle the panels; this settles the
three things that only exist once there is a second run: the control that picks which run to
compare against, the column that says what moved, and the file that leaves the dashboard.

Every string in a fenced block is shippable copy. Lift it verbatim.

Voice rules are `UX-VALUE.md`, unchanged. In short: lowercase imperative headings, present tense,
no number unless code counted it or Jev returned it, every line 20 words or fewer, and never
`volume`, `demand`, `traffic`, `difficulty score`, `will rank`, `will improve`, `likely to`.

---

## The one thing this file is about

A diff here is **two judgements compared**, plus whatever the crawl reached in each. It is never a
measurement of the site between the runs. Every string below is chosen so a reader cannot walk away
with the opposite belief.

That is the whole reason this file exists. The instinct when shipping a delta column is to name the
states after what happened to the site — `fixed`, `broken`, `improved`. Nothing in a re-run can
support those words. So the states are named after the **runs**, and the site is never the subject
of the sentence.

---

## 01 THE RUN-HISTORY CONTROL

### Where it lives

In the run form's `.actions` row, immediately left of `Run audit`. It is a native `select`, not a
custom menu — the dashboard has no menu component and this is not where to add one.

It is disabled while a run is in flight, because a run in flight has no identity to compare yet.

It sits in the form, not in `01 scraped`, because it answers "which run am I looking at", which
applies to every panel below. Placing it in a panel makes the other four look like they are on the
old run.

### State label above the control

```
compare to
```

### Only one run exists

The control is present and disabled. It must not be hidden, because a reader who cannot see it
cannot tell that comparison exists.

```
nothing to compare yet
```

Second line, so the absence has a cause:

```
run the audit again on the same URL and this fills
```

### Two or more runs, control collapsed

The selected run, by wall clock. Both parts are countable, and the run carries both.

```
the run from 14 Sep, 09:12
```

Add the run index in the option list only, never in the closed label:

```
the run from 14 Sep, 09:12 · 2 runs ago
```

### The rule line, under the control, whenever a comparison is active

Rendered once, not per row.

```
Two runs of the same URL, judged the same way. Neither one is a search result.
```

### A run in the list that cannot be compared

Runs against a different URL stay in the list, unselectable, and say why.

```
12 Sep · different URL, so it cannot be compared
```

Silently hiding it is worse: the reader concludes the run is missing rather than incomparable.

### Nothing selected

```
no earlier run selected, so nothing is compared
```

**Rule:** when nothing is selected the delta column does not render at all. An empty column reads
as a comparison that produced nothing, which is the false reading this file exists to prevent.

### Persistence

The run list and the selection survive a reload, in `localStorage`, under `jev.runs.v1` and
`jev.compare.v1`. The dashboard already keeps `jev.tour.seen.v1`, so this matches the convention.

Keep at most 10 runs per URL. A dropdown with 40 dated entries in it is a log, not a control.

---

## 02 THE DELTA COLUMN

### Where it renders

Inside `02 do this now`, as a strip above the card list. **Not a new numbered panel.**

The delta is per-row state on the rows 02 already lists. A separate panel would list the same pages
a second time and leave the reader reconciling two lists of one thing. The panel chrome below is
supplied anyway for the case where it is rendered standalone.

### Strip chrome, verbatim

Header:

```
change since 14 Sep
```

The date is the compared-against run, not today. The reader needs to know which pair they are
looking at, and today tells them nothing.

Subhead:

```
One line per page, naming what the two runs said about it.
```

Promise, matching the existing `<b>What this gives you:</b>` pattern in 02:

```
What this gives you: how each page's change differs from the run you picked.
```

### If it is rendered as a standalone panel

```
06
since 14 Sep
```

```
One line per page, naming what the two runs said about it. Only pages both runs reached get a mark.
```

```
What this gives you: the pages where two runs disagreed, so you know what to look at first.
```

### The implementation rule, before any copy

A row is comparable only when the page was **crawled and judged in both runs**. Presence in
`decisions[]` is not sufficient evidence of reachability, and `notDecided[]` is how a page that was
judged and produced no row is recorded. Both runs' `crawlRows` are the reachability source; when
either is missing, the page is `not comparable`.

This is the same trap as the `inbound` floor in `UX-VALUE.md`: absence from a bounded crawl is
absence from what the crawl reached, not absence from the site. Getting it wrong here is worse,
because a wrongly-closed page is one a practitioner stops doing work on.

### The six states

| condition | enum | renders as |
| --- | --- | --- |
| both reachable, raised in both, same `topChangeKey` | `still_open` | still open |
| both reachable, raised in both, different `topChangeKey` | `changed` | changed |
| raised before only, both reachable | `not_longer_raised` | no longer raised |
| raised now only, both reachable | `regressed` | regressed |
| raised now, never reachable before | `newly_raised` | newly raised |
| raised before, not reachable now | `not_comparable` | not comparable |

`regressed` is not a peer of `newly raised`. A page reachable in both runs that goes from silent to
raising is a regression; a page this run reached for the first time is not. Same shape, opposite
reading, so they cannot share a chip.

### The wire shape, AS SHIPPED

`server/src/history.ts`, gilfoyle's file. This is verified against the code, not proposed.

```
DeltaState = "still_open" | "changed" | "not_longer_raised"
           | "regressed" | "newly_raised" | "not_comparable" | "clean"
```

```
PageDelta {
  path, url, state,
  comparable: boolean,          // false wherever state is not_comparable
  raisedNow: boolean, raisedBefore: boolean,
  topChangeKey: string | null,  // the key alone, never the prose
  topChange: string | null,     // the prose instruction, for the row to show
  bandNow: PageBandWord | null, // decisive | to verify | needs a human
  bandBefore: PageBandWord | null
}
```

There is no `openNow` / `openBefore` on `PageDelta`. Both fields are named `raised*`, which matters
at exactly one place: branching the `regressed` body line. `raisedBefore` is the discriminator, not
the open/closed pair, because cause two is a page that was **raised and judged without raising
anything** — reachable, in the payload, but not raised.

```
RunDelta {
  baseline: null | { generatedAt, score, openPages },
  stillOpen: PageDelta[], changed: PageDelta[], notLongerRaised: PageDelta[],
  regressed: PageDelta[], newlyRaised: PageDelta[], notComparable: PageDelta[],
  clean: number, unreachableBefore: number,
  pagesCrawledNow: number, pagesCrawledBefore: number
}
```

`HistoryPage` carries `reachable`, and that is the only reachability source. `baseline.openPages` is
kept, and it is the earlier run's count of pages that raised a change.

Three things in that shape are load-bearing for the copy:

- **`comparable`** is carried on every row and is false wherever the state is `not_comparable`. It is
  what separates `regressed` from `newly raised`, and those two have opposite reader actions.
- **`topChangeKey`** is the key alone. `changed` is decidable because the key is compared, and the
  prose instruction is carried beside it for the row to show.
- **`bandNow` / `bandBefore`** use the three band words already in `02 do this now`, not
  `act`/`review`/`escalate`. The wire enum is internal; these three are the only ones that reach the
  screen, and they are the ones the delta copy interpolates.

### `notComparable` is not optional

`notComparable` is a bucket for a page the earlier run raised and this run could **not reach**. It
is the only reason `no longer raised` is safe to believe: a page that left the crawl must never
appear as closed.

**Rendering it is a correctness requirement, not a nicety.** Dropped, a page that silently fell out
of the crawl disappears, and it can disappear while the nothing-moved state reads as healthy. That is
the one path where this feature states something false.

A shrunken-crawl caveat is not a substitute. It fires on `pagesCrawledNow < pagesCrawledBefore`, so a
page can leave while the total holds steady or grows and the caveat stays silent.

Hard rule: when `notComparable.length > 0`, the nothing-moved state may not render.

`offCrawl` supplies `not comparable`, so reachability is carried without a `comparable` boolean. The
`fixed` enum value is fine as a wire key — it must never reach the screen, which is what the
`COLUMN_WORD` map in `RunDiff.tsx` is for.

`baseline.generatedAt` is the run's own wall clock, and it is what the `compare to` control and the
`change since 14 Sep` header both render. It is countable, so it is allowed on screen.

### Every chip must survive being wrong

A band moves when a threshold is retuned. A judgement moves when the model version changes. A page
can gain a rival and lose its page on the list without a single byte changing on the site. If the
wording asserts something about the **site**, it is asserting something this feature cannot know.

So every chip names the **runs**, never the site. That is why `no longer raised` exists instead of
`fixed`, and why the regression chip says which run is the worse one rather than that anything got
worse.

### Chip: the enum renders, not a prose sentence

The chip on the card is the **mapped enum**, not a sentence:

```
still_open
changed
not_longer_raised
regressed
newly_raised
not_comparable
```

An enum does not change meaning when the copy around it is revised, and a prose chip has to be found
and edited in every place it appears. That is the same reason every chip here names the runs: a
display string should not encode an assertion a later revision would falsify.

The framing a bare enum loses — that a regression is a statement about the two runs, not the site —
moves to the **standing note** under the column, once, instead of into six row sentences.

### Where the enum maps to prose, and why it is not on the server

The mapping lives in the web, keyed by enum. That is the architecture this repo already uses:
`web/AGENTS.md:52` forbids a raw id reaching the screen and `decisionCopy.ts` maps ids to prose, so
the server owns keys and the web owns words. A `deltaChip` field on the server would invert that
split for one feature and leave two conventions in the codebase.

Drift is the real concern behind putting it on the server, and the repo already has the answer: the
`FALSIFIER` invariant in `UX-VALUE.md` checks server id, web label and doc table against each other.
The same three-file check covers these six states.

**An enum with no mapping renders nothing.** Never the raw value, never a blank chip. Unknown keys
are the signal that the three files have drifted.

```bash
python3 - <<'PY'
import re, sys
hist = open('server/src/history.ts').read()
web  = open('web/src/RunDiff.tsx').read()
doc  = open('docs/UX-DIFF.md').read()

block = re.search(r'export type DeltaState =(.*?)(?:\nexport |\Z)', hist, re.S)
states = set(re.findall(r'"([a-z_]+)"', block.group(1))) if block else set()
if not states:
    print("GUARD BROKEN: DeltaState not found in server/src/history.ts")

col = re.search(r'const COLUMN_WORD[^=]*= \{(.*?)\n\}', web, re.S)
mapped = set(re.findall(r'^\s+([a-z_]+):', col.group(1), re.M)) if col else set()
if not mapped:
    print("GUARD BROKEN: COLUMN_WORD not found in web/src/RunDiff.tsx")

tabled = set(re.findall(r'^\| [^|]+\|\s*`([a-z_]+)`\s*\|', doc, re.M))
if not tabled:
    print("GUARD BROKEN: no enum column found in docs/UX-DIFF.md")

# A detection that cannot find its input is itself a failure, but it must not
# share the flag the findings use, or the findings get erased.
broken = not (states and mapped and tabled)
bad = broken
for x in sorted(mapped - states):
    print(f"STALE KEY: web maps {x}, server cannot emit it"); bad = True
for x in sorted(states - mapped - {"clean"}):
    print(f"UNMAPPED: server can emit {x}, web has no label"); bad = True
for x in sorted(states - tabled - {"clean"}):
    print(f"UNDOCUMENTED: server has {x}, this file does not tabulate it"); bad = True
print("DELTA INVARIANT:", "FAIL" if bad else "PASS")
sys.exit(1 if bad else 0)
PY
```

`clean` is a count, not a chip, so it is excluded from the mapping and the table. If it ever becomes
a chip, both exclusions must go.

### The cells, verbatim

**Still open.**

```
still open
Both runs raised the same change on this page. Nothing about it moved.
```

**Changed.**

```
changed
The earlier run raised one change here. This run raised another.
```

**No longer raised.**

```
no longer raised
The earlier run raised a change here. This run did not raise one.
```

**Newly raised.**

```
newly raised
This run raised it. The earlier run did not reach this page, so nothing is compared.
```

**Regressed.** The one state that must not read as good news, so the chip says so in words and never
relies on colour alone. It names the runs, so it stays true when the cause was a retuned threshold
rather than a worse page.

```
regressed — this run treats the page worse than the one before
Both runs judged this page. This one raised it, and the band moved {from} to {to}.
```

`{from}` and `{to}` are the band words already shipped in `02 do this now`: `decisive`,
`to verify`, `needs a human`. A band word next to the chip, so a skim still lands correctly:

```
regressed — this run treats the page worse than the one before
```

The cause caveat ships with the cell, because a band moves for reasons that have nothing to do with
the site:

```
A band also moves when a threshold is retuned, or a rival joins the comparison.
```

**Not comparable.**

```
not comparable
One of the two runs did not crawl this page, so there is nothing to compare.
```

**`regressed` has two causes, and the body line is per-cause.** The chip is the same for both, and
that is deliberate — splitting it would make seven columns and split attention on the row that
matters most. What distinguishes them is that one of them presupposes a prior state and the other
does not: on a page that went from silent to raising, the reader was never handed that page, so
`regressed` on its own overstates what there was to regress from.

The chip survives both because its claim is true of both: before the run it was silent, now an edit
is raised, and this run does treat the page worse than the one before. The body carries the cause.

**Cause one — a band that moved against a page already raised.** `decisive` to `to verify`,
`decisive` to `needs a human`, `to verify` to `needs a human`, and a page that moved out of
`05 not decided` into `02 do this now`. Here `raisedBefore` is `true`, so there is a prior state.

```
regressed — this run treats the page worse than the one before
The change is the same, but the band moved {bandBefore} to {bandNow}.
```

**Cause two — a page that was reachable and judged without raising anything, and now raises
something.** Here `raisedBefore` is `false`. Not a seventh column: same chip, different body, because
the reader's action differs — this one is a page they were never handed.

```
regressed — this run treats the page worse than the one before
Both runs judged this page. The earlier one raised nothing on it, and this one does.
```

`{bandBefore}` and `{bandNow}` are `PageBandWord`, already the three screen words, so no mapping is
needed. A `null` on either side means the page was not raised in that run, which is cause two.

### The standing note

Once, under the column, never per row. Same slot as the rival note in `04`.

```
A difference here is a difference between two judgements. It is not a measurement of the site.
```

```
Pages one run did not reach are marked not comparable, never as closed.
```

### Count chip

**Every count reads `X of Y` plus a line naming what Y is.** A bare breakdown gives the reader no
denominator and no idea what it is a share of.

The denominator is `stillOpen.length + notLongerRaised.length` — the pages the earlier run raised a
change on that this run could also reach. Every numerator counted against it is a subset of that set,
so the ratio is bounded and cannot exceed 100%.

It deliberately is **not** `baseline.openPages`. That count includes pages this run could not reach,
so a ratio over it can exceed 100%: `newly_raised` was never raised before at all, and part of
`regressed` went from silent to raising, so neither sits inside `openPages`.

```
{n} of {stillOpen + notLongerRaised} pages the earlier run raised are no longer raised
```

```
{stillOpen + notLongerRaised} pages the earlier run raised a change on, and this run could reach
```

Then the breakdown, regressed leading, because that is the row needing a decision today:

```
{k} regressed · {n} no longer raised · {j} newly raised · {i} still open
```

**When `regressed.length > 0`, a hot line sits above the closure headline.** That headline counts
only closures, so on its own it reads as a success rate, which is the one misreading this whole
column exists to prevent. The regression count goes first and is never the second line:

```
{k} pages regressed since 14 Sep — take these first
```

**Do not label `baseline.openPages` as "pages appeared in both runs".** That is a different number.
A page can be in both runs and clean, and it is not counted in `openPages`, so the label would
understate the comparable set by however many pages are clean.

With no comparison active the chip is unchanged from today. It never renders all zeros, and it never
renders a bare breakdown without the denominator line above it.

### Per-column empty states

Six columns, six different causes. `nothing in this column` is banned: it is one generic line for six
unrelated situations, which is exactly what the voice rules forbid.

**Regressed.** The body has to cover both causes of a regression — a band that worsened, and a page
that went from silent to raising. A body that only mentions bands is false for the second.

```
no page got worse between these two runs
Nothing went from decided to undecided, and no page that was silent is now raising.
```

**No longer raised.**

```
nothing closed since the last run
Every page the earlier run raised is still on the list.
```

**Newly raised.**

```
no page arrived that the last run did not reach
Every page on this list was already in the earlier run's crawl.
```

**Changed.**

```
every page both runs raised still carries the same change
```

**Still open.** The complement of `changed`: if this column is empty, every page both runs raised now
carries a different change.

```
every page both runs raised now carries a different change
```

**Not comparable.** Never say a page here was reached. This column holds the ones that were not.

```
no page raised earlier went out of reach this run
```

Then, once, under the grid rather than in the column:

```
A column is empty because that case did not occur, not because it was skipped.
```

---

## 03 WHEN NOTHING MOVED

The common case. It must read as a **normal, healthy result**: a re-run over pages nobody has edited
yet is not a problem, and nothing about it is a failure.

The temptation is to over-read it. `all clear`, `your site is in good shape` and `no action needed`
are all false here — two runs agreeing is compatible with a site that needs the same twenty edits.
The honest way to sound healthy is to say what is true and what it means for today, not to
apologise or to sell.

So: state the cause, say the list is unchanged, and point at 02. No warning, no reassurance, no
apology.

### Both runs ran and agreed

```
nothing moved between these two runs
Every page the two runs share has the same change raised on it.
```

```
This is what a re-run looks like before the edits land.
```

```
Every change in 02 came from the earlier run. Nothing was taken off the list.
```

Second line names the cause, which is what the voice rules require of an empty panel. Third is the
reader's next move and it is a place, not an instruction. It is also honest under either cause —
edited or not edited — because nothing came off the list either way.

**A standing line, once under the strip, not per row.** This is where the honest bound lives now,
instead of inside the empty state:

```
Two runs agreeing is normal. It is not a sign the pages are finished.
```

Put it on the strip rather than in the empty state so it is present when the panel is full too,
which is when a reader is most likely to over-read a row of `still open`.

### The page sets differ

```
the two runs did not cover the same pages
{r} pages were crawled in one run and not the other, so they cannot be compared.
```

### One of the two raised nothing

```
one of these runs raised nothing
Comparing against a run with no changes would invent a movement that did not happen.
```

### Both runs have rows but share no page

```
no page appears in both runs
Both runs have rows, and none of them is a page the other run reached.
```

### The panel is not empty, but every row is `not comparable`

```
nothing here can be compared
The two runs reached no page in common, so every row is marked not comparable.
```

Do not collapse this into the first state. They read identically and mean opposite things: one says
the judge repeated itself, the other says the crawl moved.

---

## 04 CSV EXPORT

### Button

In the `02` half head, under the count chip. `ghost` styling, like every non-primary action in the
dashboard.

```
Download these rows as CSV
```

With no comparison active, so the label never promises a comparison that is not on screen:

```
Download this run as CSV
```

### The note, under the button

Two lines. The first is what is in the file, the second is what is deliberately not.

```
One row per page: path, the change raised, its band, its probability, and how it moved.
Every number is quoted from the tool that returned it. None was estimated here.
```

Second line is the provenance line, in the same register as the one shipped in `04 rivals`. It is
also literally true here: `probability` comes from Jev, `band` from `thresholds.ts` in code, words
and inbound links from the crawler.

### The deliberate omissions, enumerated

A file is handed to someone else, so the omissions have to be complete and they have to be in the
file's own sheet, not only in the dashboard.

```
deliberately not in this file
no search volume · no keyword positions · no backlink counts · no promised outcome
page text · anything a model inferred that no tool returned
```

`page text` is in the list for a reason worth stating: the file leaves the dashboard, and page text
is the one thing in it that is not a measurement or a judgement. It stays behind.

### Column order, fixed

`path`, `change raised`, `band`, `probability`, `moved since {date}`. The `moved` column carries
the chip word verbatim, so a row lifted out of the CSV still says `regressed` and not `worse` or
`down`.

### The button is disabled, never hidden, when there are no rows

```
nothing to download yet
```

---

## A practitioner, day one to day thirty

Not copy. This is the check on whether the strings above serve the person who has to use them.

**Day one.** They paste a URL, run the audit, and read `02 do this now` top to bottom. They
recognise the top change on the pages they wrote themselves, which is the moment the product earns
trust. They open the three pages whose instruction they already know, edit them, and export the CSV
to whoever writes the rest. They do not read `03`, `04` or `05` today, and the copy should not try
to make them.

**Day seven.** They have made a batch of edits and they re-run, expecting to be told which ones
landed. This is the day the delta column is the whole product: they pick last week's run and read
`no longer raised` first, because that is the answer to the question they arrived with. Then they
read `regressed`, because a page that was judged before and is worse now is the one that needs a
decision today. If `regressed` is empty and `no longer raised` is long, the copy has done its job.

**Day thirty.** The list is shorter than the work, and the remaining rows are mostly `still open`
and rows sitting in `05 not decided`. The question they now have is not "what do I do next" but
"is this tool right about what is left", and it is the question the current design cannot answer.
They stop opening it daily. It becomes a monthly check, run at the start of a content cycle, and
the export is what they attach to that conversation.

## The one missing feature that would stop them renewing

A per-page **acceptance mark** — the practitioner records that they made the change, and the next
run checks in code whether the change is present on the page.

Without it, every cell in the delta column is the judge grading itself. A page that reads
`no longer raised` may have closed because the edit was made, or because the model answered
differently on a second pass. The product cannot currently tell those apart, and neither can the
practitioner. A practitioner who spots one wrong close has no way to calibrate how many others to
believe, and a tool whose error rate cannot be estimated does not get renewed.

The mark also makes the third state in `02` decidable, which is the other half of the same problem:
an item in `05 not decided` becomes closeable by a person saying they handled it, instead of
waiting on a judgement that will not commit.

It is also the only version of this that stays honest. Asking the model whether the edit was made is
the same self-grading mistake; checking the page in code is `01 scraped`, which is the half of the
dashboard that never invokes a model.

---

## Verification

One script does both checks, and both run **against the copy blocks only**. A `grep` over the whole
file fails on its own restatement of the banned list, so it cannot be the guard.

```bash
python3 - <<'PY'
import re, sys
lines = open('docs/UX-DIFF.md').read().split('\n')
# Tagged fences are NOT copy. `bash` holds this script, whose regex literals
# contain every banned word, so including them makes the guard fail on itself.
blocks, cur, tag = [], [], None
for ln in lines:
    m = re.match(r'^```(\w*)\s*$', ln)
    if m:
        if tag is None:
            tag = m.group(1) or 'copy'
        else:
            if tag == 'copy': blocks.append(cur)
            cur, tag = [], None
    elif tag is not None: cur.append(ln)
copy = [l for b in blocks for l in b if l.strip()]

long = [(len(l.split()), l) for l in copy if len(l.split()) > 20]

BAN_WORDS = r'\b(volume|search volume|demand|traffic|difficulty score)\b'
BAN_VERBS = r'\bwill\b[^.]{0,24}\b(rank|improve|increase|boost|drive|help|lift|grow)|\b(likely to|is projected to)\b'

# One exemption, on BAN_WORDS only. Naming an absent thing is not claiming it,
# so a line that negates the word may say the word. BAN_VERBS gets no exemption:
# "no page will rank better" is still a prediction.
NEGATED = re.compile(r'\b(no|not|never|nothing|zero|neither)\b', re.I)

banned = []
for l in copy:
    m = re.search(BAN_VERBS, l, re.I)
    if m:
        banned.append((m.group(0), l)); continue
    m = re.search(BAN_WORDS, l, re.I)
    if m and not NEGATED.search(l):
        banned.append((m.group(0), l))

print(f"{len(blocks)} copy blocks, {len(long)} over 20 words, {len(banned)} banned")
for n, l in long: print("LONG", n, l)
for w, l in banned: print("BANNED", w, l)
print("UX-DIFF INVARIANT:", "FAIL" if (long or banned) else "PASS")
sys.exit(1 if (long or banned) else 0)
PY
```

Three lines are legitimately outside the guard and must stay that way. Two are the CSV omission
copy, whose entire job is to name what the file does not contain, and one is the voice-rule
restatement near the top quoting `UX-VALUE.md` at itself. All three pass because they negate the
word. Rewrite any of them as an ordinary assertion and the guard starts failing on it — which is
the correct outcome, not a false positive.

The `UX-VALUE.md` word counter does not exclude tagged fences, so it passes only because its regex
literals happen to stay under twenty words. Do not copy that counter forward.
