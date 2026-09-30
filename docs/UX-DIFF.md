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

### The five states

A decision, not four. The brief's `regressed` is not a peer of `new` — a page that is newly raised
and was reachable in both runs **is** a regression, and the two must not share a label.

| condition | chip | why it is this and not the other word |
| --- | --- | --- |
| in both, same `topChange.key` | `still open` | nothing about it moved |
| in both, different `topChange.key` | `changed` | the judge picked a different edit |
| earlier only, reachable in both | `no longer raised` | not `fixed` — a run not raising it is not a site being fixed |
| this run only, reachable in both | `regressed` | the page was judged before and is worse now |
| this run only, not reachable earlier | `newly raised` | coverage, not a finding about the site |
| either run missed the page | `not comparable` | never `fixed` |

`changed` is a fifth state the brief did not ask for, and shipping without it forces `still open`
to cover two situations that are not the same. The reader's action differs: one is "leave it", the
other is "read the new instruction".

### Every chip must survive being wrong

A band moves when a threshold is retuned. A judgement moves when the model version changes. A page
can gain a rival and lose its page on the list without a single byte changing on the site. If the
wording asserts something about the **site**, it is asserting something this feature cannot know.

So every chip names the **runs**, never the site. That is why `no longer raised` exists instead of
`fixed`, and why the regression chip says which run is the worse one rather than that anything got
worse.

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

**A band that moved against you on a page that was already raised is also `regressed`.**
`decisive` to `to verify`, `decisive` to `needs a human`, `to verify` to `needs a human`, and a
page that moved out of `05 not decided` into `02 do this now`. The cell names the move:

```
regressed — this run treats the page worse than the one before
The change is the same, but the band moved {from} to {to}.
```

### The standing note

Once, under the column, never per row. Same slot as the rival note in `04`.

```
A difference here is a difference between two judgements. It is not a measurement of the site.
```

```
Pages one run did not reach are marked not comparable, never as closed.
```

### Count chip

In the `02` half head, next to the existing `{n} decided · {k} held` chip. Regressed leads, because
it is the row that needs a decision today.

```
{k} regressed · {n} no longer raised · {j} newly raised · {i} still open
```

With no comparison active the chip is unchanged from today. It never renders all zeros.

---

## 03 WHEN NOTHING MOVED

The common case, and the one that is easy to write badly. "Nothing changed" written as a triumph
is the failure: two runs agreeing is the **weakest** evidence the product produces, and the copy
has to say so in the same breath.

### Both runs ran and agreed

```
nothing moved between these two runs
Every page the two runs share has the same change raised on it.
```

```
Two runs agreed. That is not the same as a page being right.
```

```
Make one edit, then re-run. Two runs agreeing is the weakest evidence here.
```

Third line is the call to action. There is always one, because the reader's only move is to change
something and re-run.

Do not write `your site is in good shape`, `no action needed`, or `all clear`. A bounded crawl
reaching the same pages and a model answering the same way twice is compatible with a site that
needs the same twenty edits. This product cannot tell those apart, and neither can the reader.

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
Every column is measured or judged here. No search volume, no positions, no forecasts.
```

### The deliberate omissions, enumerated

The second line above is a summary. A file is handed to someone else, so the list has to be
complete and it has to be in the file's own sheet.

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
