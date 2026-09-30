/**
 * The falsifier line: "we would be wrong if …".
 *
 * This is the one line a card's credibility rests on, so it has two hard rules.
 *
 * 1. A raw question id must never reach the screen. `<code>answer_first</code>`
 *    is a machine artefact on the exact line that is supposed to read as a
 *    considered claim.
 * 2. Polarity is positive. Every label below states what the page would ALREADY
 *    have. A card that says "we would be wrong if the page already does X" is
 *    making the positive the falsifier, which is correct for a fix: the change
 *    exists because something is missing, so proof that it is already there
 *    disproves the need for it. Inverting this makes a card announce doubt at
 *    the moment the evidence agrees with it.
 *
 * An id that is not in the table degrades to the generic form rather than being
 * interpolated. An unknown id is either a question this run never asked, or one
 * that does not exist — and a confident sentence built on either is a lie. The
 * generic form is vaguer but still true, which is the right trade. It also keeps
 * the panel from implying a check the run was unable to make.
 */
const FALSIFIER_LABELS: Record<string, string> = {
  answer_first: "the opening already answers in the first two sentences",
  citable: "this page is already quotable out of context",
  claims_substantiated: "every claim on this page is already backed",
  trust: "this page already shows real expertise",
  internal_link_adequacy: "this page already carries a reader onward",
  scan_path: "this page already gives a route through it",
  structure_ease: "a visitor already finds what they came for",
  clear_next_step: "this page already gives an obvious next step",
  title_fit: "the title already fits what a searcher would type",
  intent: "this page already names one topic",
  page_type: "this page is already doing the job its type calls for",
}

export const FALSIFIER_LABEL = "we would be wrong if"

export const GENERIC_FALSIFIER = "this page already did this"

export function falsifierSentence(id: string | null | undefined): string {
  const label = id ? FALSIFIER_LABELS[id] : undefined
  return `${FALSIFIER_LABEL} ${label ?? GENERIC_FALSIFIER}`
}

/**
 * True when the id has no label and the sentence fell back to the generic form.
 * The card uses this to stay silent about which question was asked rather than
 * implying a check the run was unable to make.
 */
export function falsifierIsGeneric(id: string | null | undefined): boolean {
  return !id || !(id in FALSIFIER_LABELS)
}
