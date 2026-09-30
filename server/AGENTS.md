# SERVER WORKSPACE

**Parent:** `../AGENTS.md`

## OVERVIEW

Express 4 API + the crawl → judge → decision engine. 22 TypeScript modules, 10,333 LOC in `src/`.
The project is here: `bin/jev-seo.js` spawns `server/dist/index.js` (`app.listen` at
`src/index.ts:296`), which serves `web/dist` and the API on one port. This file covers `src/`,
`scripts/`, `test/`. `mcp/` has its own file.

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| HTTP routes, static mount, boot | `src/index.ts` | 311 lines, 9 routes, **zero exports** — all import side effect |
| Crawl, extract, robots, sitemap, SSRF guard | `src/crawl.ts` | 1,245 lines. `assertPublicUrl` at `:303`, `crawl` at `:1107` |
| The audit harness + NDJSON event union | `src/audit.ts` | 1,590 lines — largest file. `runAudit` at `:1049` |
| Question registry | `src/questions.ts` | 1,199 lines, **zero imports** — deliberate |
| Confidence bands, per-question overrides | `src/thresholds.ts` | Also **zero imports** — deliberate |
| Model-facing state objects, budgeted | `src/state.ts` | Highest-centrality module in the repo |
| Zen client / judge switch / local fallback | `src/jevClient.ts`, `src/judge.ts`, `src/localJudge.ts` | `judge.ts` is 64 lines and is the seam between the two judges |
| Spawns `opencode` for `/api/research` | `src/agent.ts` | Tool allowlist at `:93` |
| GSC: RS256 JWT, token cache, onboarding | `src/gsc.ts` | **No Google SDK** — hand-rolled with `node:crypto` |
| Every filesystem path | `src/paths.ts` | Sole owner. Enforces the read-only-install rule |
| Env loading, Zen credential, limits | `src/config.ts` | See the freeze note below |
| Topic/outcome modelling (pure, no I/O) | `src/gap.ts`, `src/subjects.ts`, `src/decisions.ts`, `src/keywords.ts`, `src/checks.ts` | Zero `try`/`catch` by design |

## ROUTE TABLE — all in `index.ts`, nowhere else

| Line | Route | Failure behaviour |
|------|-------|-------------------|
| 60 | `GET /api/health` | never fails |
| 68 | `GET /api/config` | same body as health, minus `ok` |
| 75 | `GET /api/gsc/properties` | **200** on failure, error in body |
| 83 | `GET /api/gsc/status` | 400 without `?url=`; **200** on failure |
| 102 | `POST /api/gsc/connect` | 400. Body **is** the service-account key material |
| 115 | `POST /api/research` | NDJSON stream. 400 without a url |
| 193 | `POST /api/audit` | NDJSON stream. 400 without a url |
| 260 | `express.static(dist)` | only when `webDist()` is non-null |
| 262 / 270 | `app.get("*")` | SPA fallback, then a 503 when unbuilt |

Middleware: `cors()` at `:44` — **wide open, no origin allowlist**, which is what makes the
hardcoded absolute URL in `web/src/api.ts:9` legal. `express.json({limit:"1mb"})` at `:45`.

## CONVENTIONS

- **Relative imports carry a mandatory `.js`** (`from "./crawl.js"`) — `tsc` emits real Node ESM.
  The `web/` workspace is extensionless. Never normalise.
- `verbatimModuleSyntax` and `noUncheckedIndexedAccess` are both on. Hence `import type` for types
  and `?.` / explicit fallbacks on every index access. Both are compile errors if ignored.
- No semicolons, 2-space, double quotes, trailing commas, camelCase filenames. Imitation only —
  there is no linter or formatter.
- **10 of 22 modules contain zero `try`/`catch`.** That is the convention: async I/O modules catch,
  pure computation over plain data does not. `questions.ts`, `thresholds.ts`, `state.ts`, `gap.ts`,
  `subjects.ts`, `decisions.ts`, `keywords.ts`, `checks.ts`, `agentSchema.ts`, `judge.ts` are pure.
- **There is no central error middleware.** Express 4's default handler catches whatever escapes.
  Five custom error classes exist: `JevAuthError`, `JevApiError` (`jevClient.ts`), `GscValidationError`,
  `GscAuthError` (`gsc.ts`), and a module-private `RunFailure` (`agent.ts`).
- **Config is frozen at import.** `PORT`, `ZEN_BASE_URL`, `JEV_MODEL`, and every crawl/retry knob are
  module-level `const`s evaluated once. `zenKey()` (`config.ts:108`) is the deliberate exception and
  re-reads per call. Mutating `process.env` after import does almost nothing.
- `.env` never overrides a real env var (`config.ts:27` guards with `if (!(key in process.env))`).
- Three **independent** retry policies, none shared: crawl (jittered backoff), `jevClient`
  (honors `retry-after`, aborts immediately on 401/403), agent (`MAX_ATTEMPTS = 2` at `agent.ts:83`,
  and the retry continues the same session id so the model sees its own prior output).

## ANTI-PATTERNS

1. **Never add a route below `index.ts:262`.** The catch-all is mounted last on purpose. Moving it
   above the API routes, or dropping the `/api/` exclusion inside it, makes every API call return
   `index.html`.
2. **Never assume non-2xx means failure.** The two GSC GET routes return 200 with the error in the
   body, and both streaming routes report failure as an in-band `{type:"error"}` line on a 200.
3. **Never add a second request to widen a judgement.** New questions join the existing call
   (`questions.ts:8`). Budget guard is a documented abort, not a second round-trip.
4. **Never add a question id without its `thresholds.ts` override.** Question ids are *never
   transmitted* (`jevClient.ts:9-10`) so nothing type-checks the link — renaming an id silently
   breaks every `DECISIVE_BY_QUESTION` / `SCORE_MASS_BY_QUESTION` / `GATE_FLOOR_BY_QUESTION` key.
   `thresholdCoverage()` (`thresholds.ts:161`) reports which ids still fall back to global defaults.
5. **Never make `thresholds.ts` import `questions.ts`.** It takes the registry as an argument
   precisely so both stay zero-import leaves (`thresholds.ts:154-159`).
6. **Never reorder `crawl.ts:707`.** The JSON-LD count must precede the `remove()` strip below it.
7. **Never widen the SSRF guard's call site.** `assertPublicUrl` is applied at exactly one place
   (`crawl.ts:1122`). `redirect: "follow"` means a public→private redirect is only caught because the
   final URL is re-tested; adding a fetch that skips the guard reopens the hole.
8. **Never treat `localJudge` output as calibrated.** It fabricates a worked example with `0.9`
   confidence (`localJudge.ts:56-73`) — a `0.9` in a local answer is that example leaking. The
   backend switch is `judgeBackend()` (`judge.ts:20`), and `isCalibrated()` correctly keys off it.
9. **Never pass the full `process.env` to a subprocess.** `agent.ts:547` already does
   (`env: process.env`), which hands the Zen key to an LLM agent with web tools. Use an explicit
   allowlist for any new spawn.
10. **Never call a destructive Google tool from agent-initiated code.** `buildToolAllowlist`
    (`agent.ts:93`) grants the whole `gsc` namespace on `verified` alone, without consulting
    `permission`, and that namespace includes `submit_url(URL_DELETED)`, `force_reindex`,
    `sitemaps_delete`. See `mcp/gsc-mcp/AGENTS.md`.
11. **Never import `proxyRotator.ts`.** It has zero importers and is not on the crawl path.

## THE QUESTION FILE IS THE ASSET

`questions.ts` + `thresholds.ts` move accuracy more than the model choice does, so both live in one
reviewable place instead of being generated per call. `CALIBRATION_TODOS` (`questions.ts:55-58`) is
self-flagged: *"Nothing below is measured… it is the part of this file most likely to be wrong."* The
`current` column is also the A/B switch — a decision changed without a recorded A/B is
indistinguishable from a decision changed for no reason.

## `scripts/` AND `test/`

`scripts/` is **not** an npm scripts dir and **not** a test dir — 5 hand-rolled `tsx` harnesses:
`verify-entry.ts` (monkey-patches `ZEN_BASE_URL` at `:5`, then imports the mock), `mock-jev-verify.ts`
(a `node:http` mock of the documented Jev response shape), `verify-rubric.ts` (meta-harness;
**typecheck it first** — `tsx` strips mistyped props silently), `verify-agent.ts`,
`verify-agent-degrade.ts`. The last two are in **no** npm script; run by hand.
`verify-agent-degrade.ts` reads `AGENT_BIN` at module load, so the stub must exist before import —
that is why it is a separate entry point. `test/` contains exactly one file,
`fixtures/fake-service-account.json`, whose `private_key` is an obvious fake. There is **no test
runner anywhere in the repo** and no `npm test`; `npm run verify` is the entire gate.

## NOTES

- `runAudit` is fed by `index.ts:221` with no `presearch` field, and `maxGaps` is never forwarded, so
  `request.maxGaps ?? 8` (`audit.ts:1341`) is always 8 — dead configuration. These are findings C1
  and the `maxGaps` note in `docs/RISK-REVIEW.md`; read that file before touching the decision panel.
- `/api/research` hardcodes `crawlForResearch(url, 12, 30_000)` (`index.ts:150`) — not configurable.
  It also uses `res.on("close")` while `/api/audit` uses `req.on("close")`; the asymmetry is
  deliberate (`index.ts:132`) because a POST `req` closes the moment its body is read.
- Two callers of `crawl()` with different limits: research `maxDepth 2`, audit `maxDepth 4` +
  `budgetMs 90_000`. Intentional (`crawlDigest.ts:42-44`).
- `band` is declared twice — `thresholds.ts:136` and `audit.ts:66`. `decisions.ts`, `gap.ts` and
  `subjects.ts` import it from `thresholds.js`; `audit.ts` re-declares it locally.
- Zod validation exists **only** on the agent path (`agentSchema.ts`). A Zen or local-judge answer is
  structurally trusted; `coerceAnswers` (`jevClient.ts:116`) silently drops malformed ones.
- `probeWritable()` (`index.ts:288`) runs before `listen` and `process.exit(1)`s on failure. A
  non-writable data dir means no server at all, not a degraded one.
- `npm run typecheck` is currently clean. The 2 errors that once forced `prepublishOnly` to omit the
  typecheck gate have been fixed, so the gate could be restored.
