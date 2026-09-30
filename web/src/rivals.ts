import type { CompetitorResult } from "./types"

/**
 * Rival list parsing and the pending→done join key. Pure, no I/O.
 *
 * `rivalKey` is the load-bearing export. The server emits `competitor-start`
 * with the string the user typed (`"vinted.com"`), but `competitor-done`
 * carries `judgeCompetitor`'s return value, which sets `url` to
 * `result.root.toString()` (`"https://vinted.com/"`) on the reachable path and
 * to the raw requested string only when the crawl failed. The two events
 * therefore disagree on the url string for every rival that actually worked.
 * Keying a pending row on the raw string leaves a greyed row stuck under a
 * completed one and doubles the list.
 *
 * The parser is here so `api.ts` and `App.tsx` cannot drift on what a rival is.
 * They used to count on different expressions, and only a leading space in the
 * form exposed it.
 */

/**
 * Mirrors `MAX_COMPETITORS` in `server/src/audit.ts`. Only used until
 * `GET /api/config` answers with the server's own default, so the form can
 * never state a cap the server is not using.
 */
export const RIVAL_CAP_FALLBACK = 5

/**
 * The rivals the user entered, in the order entered.
 *
 * The split, trim and filter are copied verbatim from `api.ts` and
 * `server/src/audit.ts:1311-1313`. If any of the three changes, change it here
 * too, or the form will count rivals the run never judges.
 */
export function parseRivals(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * The key that joins `competitor-start` to `competitor-done`.
 *
 * `crawl.ts:306` resolves a schemeless host by prefixing `https://`, and it
 * never adds `www.`, so a host the user typed without `www.` comes back without
 * it. Lowercasing, dropping the scheme and dropping trailing slashes is
 * therefore sufficient to make both spellings of the same rival agree.
 *
 * `www.` is deliberately left alone. Stripping it would merge two genuinely
 * different rivals into one row, which is a worse failure than a duplicate.
 */
export function rivalKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
}

/**
 * One row in panel 04. Created by `competitor-start`, filled by
 * `competitor-done`, and never reordered — a rival keeps the row it was
 * dequeued into while it is still being crawled, which is the invariant the
 * compiler cannot enforce for us.
 */
export interface RivalSlot {
  key: string
  requested: string
  index: number
  result: CompetitorResult | null
}
