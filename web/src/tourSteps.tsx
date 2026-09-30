import type { Step } from "react-joyride"

/**
 * The guided tour, rewritten for the decision-first layout.
 *
 * Two rules shaped this list.
 *
 * 1. It follows reading order, not architecture order: the layers that run, then
 *    the form, then 01 through 05 top to bottom. A tour that jumps around teaches
 *    the implementation instead of the product.
 *
 * 2. It only targets elements that are actually on screen. `board`, `tabs`,
 *    `teardown`, `batch`, `findings` and `score` now live inside a collapsed
 *    <details> drawer, so they have zero height and cannot be spotlighted — they
 *    get one step on the drawer itself rather than six steps on hidden nodes.
 *
 * Anchors are `data-tour` attributes so restyling a panel cannot silently break
 * the tour.
 */
export const TOUR_STEPS: Step[] = [
  {
    target: "body",
    placement: "center",
    title: "Jev SEO — a 90-second tour",
    content: (
      <div className="tourbody">
        <p>
          This dashboard crawls a website, finds the competitors you are actually fighting, and asks a
          decision model (<b>Jev</b>) narrow questions about each page. It then turns that into a work
          queue: one change per page, and a short list of pages worth creating.
        </p>
        <p className="tourhint">
          Fifteen short steps. Press <kbd>Esc</kbd> to leave, and reopen from <b>Take the tour</b> in the
          header.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="headline"]',
    placement: "bottom",
    title: "The headline",
    content: (
      <p>
        The site you are auditing and the size of the run. After a run it states how many pages, keywords
        and rivals were judged, so you always know what the numbers below rest on.
      </p>
    ),
  },
  {
    target: '[data-tour="crawl"]',
    placement: "bottom",
    title: "CRAWL — layer 1, the crawler",
    content: (
      <div className="tourbody">
        <p>
          A real browser fetch of your site, breadth-first, bounded by page count, depth and a wall-clock
          budget. It reads <code>robots.txt</code>, seeds from your <code>sitemap.xml</code> when one exists,
          and refuses private and loopback addresses.
        </p>
        <p className="tourhint">
          <b>Produces:</b> titles, headings, body text, word counts, canonical, alt coverage, link counts,
          structured data, and the internal link graph. Every number here is countable in code — nothing in
          this bar came out of a model.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="presearch"]',
    placement: "bottom",
    title: "PRESEARCH — layer 2, the opencode session",
    content: (
      <div className="tourbody">
        <p>
          One <b>opencode</b> session that researches your market: which sites you genuinely compete with,
          and which phrases those sites target. It calls real tools — <code>websearch</code>, page fetches —
          and writes its result to a JSON file on disk for the server to read.
        </p>
        <p className="tourhint">
          <b>Produces:</b> your rival list and the keyword seeds to judge. It cannot invent a figure —
          every number it reports has to come from a tool it actually called, or the run fails.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="form"]',
    placement: "top",
    title: "The form",
    content: (
      <p>
        The only required field is your website URL. The rest sharpen the judgement — more rivals gives a
        fairer scoreboard, and the page, keyword and concurrency limits decide how big and how fast the run
        is.
      </p>
    ),
  },
  {
    target: '[data-tour="context"]',
    placement: "top",
    title: "What the business actually does",
    content: (
      <div className="tourbody">
        <p>
          Only you know this. It goes into the state Jev reads, so pages are graded against your real
          business instead of a guess at what your industry is for.
        </p>
        <p className="tourhint">
          <b>Why it matters:</b> this is the difference between &ldquo;your H1 is vague&rdquo; and &ldquo;your
          H1 does not name the categories you sell&rdquo;.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="rivals-input"]',
    placement: "top",
    title: "Competitors — one per line",
    content: (
      <div className="tourbody">
        <p>
          Each rival is crawled and judged on the <b>same rubric</b> as your site, which is what makes the
          scorecards comparable instead of two opinions side by side.
        </p>
        <p className="tourhint">
          You can leave this empty and run presearch instead — it finds the rivals for you. Rivals matter
          more than they look: until one is reachable, the gap pass cannot run and the new-pages panel stays
          empty.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="run"]',
    placement: "top",
    title: "Two buttons, two jobs",
    content: (
      <div className="tourbody">
        <p>
          <b>Run presearch</b> — research the market first: who you compete with, which keywords to judge.
          Best done once, before a big run.
        </p>
        <p>
          <b>Run audit</b> — crawl and judge your site now. Results stream in live while it runs, so you do
          not wait for the end.
        </p>
        <p className="tourhint">
          A failed request waits and retries with backoff rather than giving up, so a slow server does not
          produce a blank dashboard.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="counters"]',
    placement: "bottom",
    title: "Live counters",
    content: (
      <p>
        Pages scraped, judgements made, keywords judged, judgements per second, elapsed time and cost so
        far. These tick during the run, so you can watch progress — and cost — before deciding whether to let
        it finish.
      </p>
    ),
  },
  {
    target: '[data-tour="scraped"]',
    placement: "top",
    title: "01 SCRAPED — what the crawler measured",
    content: (
      <div className="tourbody">
        <p>
          What was fetched and counted in code. No model produced any of it, so you can trust this half
          before reading a single recommendation.
        </p>
        <p className="tourhint">
          <b>Produces:</b> per-page rule findings, response times, word counts, and the deterministic checks a
          script does better than a language model. Read it first — it is the evidence every recommendation
          below rests on.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="dnow"]',
    placement: "top",
    title: "02 TO DO — the deliverable",
    content: (
      <div className="tourbody">
        <p>
          <b>One change per page.</b> Not a list of twelve findings competing for attention — Jev picks the
          single highest-impact change for each page and the rest collapse behind it. Each card gives you the
          instruction, the counted fact that triggered it, how confident the model is, and the candidate it
          rejected.
        </p>
        <p className="tourhint">
          Every card also carries a <b>falsifier</b>: the question that would prove the advice wrong. It is the
          one line that turns a probability into a claim you can check, and it is why you can act on this
          without a second opinion.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="rivals-panel"]',
    placement: "top",
    title: "03 RIVALS — what they do that you don't",
    content: (
      <div className="tourbody">
        <p>
          Each rival judged on the same rubric, with the reason it was chosen and the page titles their own
          crawl produced.
        </p>
        <p className="tourhint">
          <b>Important:</b> we never read a live search results page. A rival match is topic overlap across
          pages we crawled from their site — never a ranking, and never a position. Anything claiming otherwise
          would be guessing.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="pages-to-build"]',
    placement: "top",
    title: "04 PAGES TO BUILD — the new pages",
    content: (
      <div className="tourbody">
        <p>
          Subjects you have no page for, where someone actually <b>typed the phrase</b> or a rival{" "}
          <b>already published for it</b>. Phrases mined out of your own pages are routed elsewhere, because a
          term you already wrote four pages on is not a gap.
        </p>
        <p className="tourhint">
          <b>Produces:</b> a short ordered list of pages to create, each with what to write, where it goes,
          and who covers it today. Terms we are not confident enough about are held back rather than dressed up
          as advice.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="undecided"]',
    placement: "top",
    title: "05 NOT DECIDED — the honest edge",
    content: (
      <div className="tourbody">
        <p>
          Everything Jev was not decisive enough about. It is listed rather than hidden, and it is{" "}
          <b>not acted on</b> — acting on an uncertain answer is how an audit starts telling you things that
          are not true.
        </p>
        <p className="tourhint">
          Everything above this line is something the model committed to. This line is where it refused to, and
          it is worth reading: a tool that admits its uncertainty is the one you can plan around.
        </p>
      </div>
    ),
  },
  {
    target: '[data-tour="evidence"]',
    placement: "top",
    title: "The evidence drawer",
    content: (
      <div className="tourbody">
        <p>
          Everything behind the four decisions above, kept but out of the way: the opportunity board, every
          judged page and keyword, the per-item teardown with its full probability breakdown, site-wide
          patterns, the findings list and the score.
        </p>
        <p className="tourhint">
          This is the audit trail. Open it when you want to check our working — not to find your next task.
        </p>
      </div>
    ),
  },
]