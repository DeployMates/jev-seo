# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-30
**Commit:** b886731
**Branch:** main
**Remote:** `git@github.com:DeployMates/jev-seo.git` → https://github.com/DeployMates/jev-seo (private)

## OWNERSHIP — two identities, both correct

| | |
|---|---|
| **Git repository** | `DeployMates/jev-seo` — a **DeployMates** repository. Private. Canonical source of truth. |
| **npm package** | `jevseo` — published under the **`vakandi`** account. |

These are deliberately different and **neither is a mistake to be "fixed"**. The code belongs to the
DeployMates organisation; the npm scope is a personal publishing namespace. Do not propose renaming the
package to `@deploymates/*`, do not rename the repo to `vakandi/jev-seo`, and do not treat the
mismatch as drift to reconcile. Issue trackers, Pages and CI live on the **DeployMates** repo.

## OVERVIEW

`jevseo` (repo: `DeployMates/jev-seo`) — audits any business website for SEO and AI-search
visibility. Deterministic crawl → narrow typed judgements from the **Jev** "System One" model (keyless
OpenCode Zen gateway) → probabilities surfaced in a React dashboard. Express 4 + Vite 6 + TypeScript,
shipped prebuilt as a single-port npx CLI. **The rule it is built on: code finds, Jev judges, the
dashboard shows the probabilities.** An LLM-authored finding is the defining failure mode, not a bug
to fix later.

## STRUCTURE

```
jev-seo/
├── bin/jev-seo.js     # THE entry point. Zero-dependency lifecycle CLI. Plain JS, not TS.
├── server/            # workspace: Express API + crawl/judge/decision engine  → server/AGENTS.md
│   └── mcp/gsc-mcp/   # vendored Python MCP (60 Google tools), agent-side only → its own AGENTS.md
├── web/               # workspace: React 18 SPA, served as a built bundle  → web/AGENTS.md
├── docs/              # 6 design contracts. Read before changing the decision layer.
├── .assets/           # README assets + the static GitHub Pages site. Tracked; see WHERE TO LOOK.
├── .github/workflows/ # `pages.yml` publishes `.assets/`. The repo's ONLY workflow — there is no CI.
├── start.sh stop.sh   # LEGACY 2-process dev workflow. Not shipped, not the product path.
└── .mcp.json          # registers the `gsc` Python MCP — dev-from-checkout only (see ANTI-PATTERNS 13)
```

`server/dist/` and `web/dist/` are generated and untracked. `package.json` `files` ships them —
the tarball carries **prebuilt output**, because `prepare` never runs on a registry install. Note
`.assets/` is **not** in that allowlist, so the README on npmjs.com renders without its images.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Start/stop/status/doctor | `bin/jev-seo.js` | Commands dispatch at `:372`. Bare `npx` defaults to `start`. |
| HTTP surface | `server/src/index.ts` | All 9 routes. Nothing else defines a route. |
| Change a question or a threshold | `server/src/questions.ts`, `server/src/thresholds.ts` | The project's real tuning levers — see `docs/LAYERS.md`. |
| Where state is written | `server/src/paths.ts` | Sole owner of every filesystem path. Enforces the read-only-install rule. |
| Env loading / Zen credential | `server/src/config.ts` | Import-time-frozen consts vs per-call functions — see NOTES. |
| Audit orchestration | `server/src/audit.ts` | `runAudit` at `:1049`. The 18-kind NDJSON event union at `:238`. |
| Crawl + SSRF guard | `server/src/crawl.ts` | `crawl` at `:1107`, `assertPublicUrl` at `:303`. |
| Browser → server contract | `web/src/api.ts` | The only API client. NDJSON stream reader, not SSE. |
| Decision-panel producer | `server/src/decisions.ts` | Contract in `docs/UI-CONTRACT.md`. |
| Decide "act / review / escalate" | `server/src/thresholds.ts` | `DECISIVE_BY_QUESTION` + friends. Tuned per question. |
| README images / the static site | `.assets/` | One folder at the root. `index.html` is the Pages site. |
| Change the Pages deploy | `.github/workflows/pages.yml` | The only workflow. Needs the Pages source set to "GitHub Actions". |

## CODE MAP

Refs = inbound edges from the codegraph index (`.codegraph/codegraph.db`).

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `PageEvidence` | interface | `server/src/crawl.ts:25` | 48 | Highest-fan-in type; the crawl's output shape |
| `StateObject` / `emit` | interface / fn | `server/src/state.ts:99` | 36 / 33 | Builds budgeted model-facing state |
| `PatternCount` | interface | `server/src/audit.ts:105` | 27 | Feeds the batch-patterns panel |
| `Questions` | type | `server/src/questions.ts:126` | 28 | The question registry. Zero imports — deliberate. |
| `crawl` | async fn | `server/src/crawl.ts:1107` | 3 callers | BFS crawl, bounded by pages/depth/wall-clock |
| `runAudit` | async fn | `server/src/audit.ts:1049` | 1 | The harness |
| `dataDir` | fn | `server/src/paths.ts:43` | 10 | Most-imported function in the repo |
| `runResearch` | async fn | `server/src/agent.ts:685` | 1 | Spawns `opencode` for `/api/research` |
| `runAudit` (client) | fn | `web/src/api.ts:68` | 7 | NDJSON reader; 7 call sites in `App.tsx` |
| `ProxyRotator` | class | `server/src/proxyRotator.ts:114` | **0** | Dead code — see ANTI-PATTERNS |

## CONVENTIONS

Only what deviates from a standard Node/React project.

- **npm workspaces**, not a monorepo tool. Every command is `npm --workspace server|web run …`. The
  4 runtime deps are duplicated verbatim in root *and* `server/package.json` — they must stay in sync
  or a published install breaks.
- **Relative-import extensions are contradictory by workspace.** `server/src/**` requires `.js`
  (`from "./crawl.js"`) because `tsc` emits real Node ESM; `web/src/**` is extensionless because Vite
  bundles. Never normalise these into one style.
- **`verbatimModuleSyntax: true`** (both tsconfigs) → type-only imports need `import type`; a plain
  import of a type is a compile error. **`noUncheckedIndexedAccess: true`** (server) → every
  `answers[id]` / `arr[i]` is `T | undefined`, which is why the code is full of `?.`.
- **No semicolons.** 2-space indent, double quotes, trailing commas, camelCase filenames in
  `server/src` (PascalCase for React components in `web/src`, kebab-case only for
  `server/scripts/verify-*.ts`). Enforced by imitation only — there is **no linter and no
  formatter** in the repo.
- **Express 4, not 5.** `app.get("*")` is the v4 string form; v5 needs `"*splat"` and this throws at
  startup. `server` is built by plain `tsc`, not a bundler; `web` is Vite 6.
- `noul` (in `questions.ts`) is a real primitive name, not a typo. Renaming it breaks the schema.
- `tools/` and `server/mcp/` are **not** the npm `tools` bin or an npm script dir. `server/scripts/`
  holds verification harnesses; `server/test/` holds one fixture and **zero** tests.
- **All README assets live in `.assets/` at the root**, referenced as `./.assets/<file>`. It is
  tracked (an uncommitted banner is a broken image) and it is where the static Pages site lives.
  Never scatter assets into `docs/` or a per-feature folder.

## ANTI-PATTERNS (THIS PROJECT)

Verbatim prohibitions, with authority.

1. **Never kill by process-name pattern.** `bin/jev-seo.js:13` — *"`pkill -f vite` takes down every
   Vite on the machine, including other people's projects."* Use `bin/jev-seo.js stop` (PID file at
   `~/.jev-seo/jev-seo.pid`). **`stop.sh:7` violates this today** — it is legacy and unsafe.
2. **Never write inside the install directory.** `paths.ts` — npm garbage-collects the `npx` cache
   dir, so a key or transcript written there vanishes silently. `JEV_REPO_ROOT` was deliberately
   deleted; do not reintroduce it. All mutable state → `dataDir()`.
3. **Never log a value.** Log the `.env` path and **key names** only (`config.ts:56`). Use
   `proxyRotator.ts` `redact()` for proxies. `private_key` never leaves `gsc.ts`.
4. **Never derive a path from a request.** `gsc.ts:95` *"Fixed, server-owned location. Never derived
   from a request."* — a security boundary, not a convenience.
5. **Never report a number the run did not receive from a tool.** `agentPrompts.ts:118`.
   `agentSchema.ts:70` enforces it structurally via Zod `strictObject`.
6. **Never remove the `UNTRUSTED` clause** from a page-text question (`questions.ts:140`) — it is the
   only prompt-injection defence, and it is unmeasured.
7. **One request per item, always** (`questions.ts:8`). Packing items per request is documented as
   costing accuracy.
8. **Never register the Express catch-all before the API routes, or without the `/api` exclusion**
   (`index.ts:260-267`). Registered first, it answers every API call with `index.html`.
9. **Never lower `PAGE_PRIORITY` to widen coverage** — it is a gate, not a weight
   (`docs/UI-CONTRACT.md`).
10. **`server/src/proxyRotator.ts` is dead code** — zero importers. `proxies.txt` and
    `JEV_PROXIES_FILE` are resolved and documented but have **no effect on crawling**. Do not describe
    the proxy pool as an active feature, and do not wire it in without a deliberate decision.
11. **Never let a granted tool be absent from `.mcp.json`.** `agentSchema.ts:29` — a granted tool that
    does not exist is *worse* than a missing one: the prompt advertises it and gate 3a then fails the
    whole run. Note `buildToolAllowlist` (`agent.ts:93`) grants the whole `gsc` namespace on
    `verified` alone, without checking permission — and that namespace includes destructive writers.
12. **The spawned agent resolves no config but the one this project generates.**
    `agent.ts` sets `OPENCODE_CONFIG_DIR` to `PROJECT_DIR` on every `spawn`, and `paths.ts`
    writes `opencode.json` (permissions) plus `.mcp.json` (servers) into `~/.jev-seo/agent`.
    Drop that env var and the child silently loads the operator's global
    `~/.config/opencode/opencode.json` — their MCP servers, their agents, their provider keys —
    and a research run on a stranger's site inherits all of it. The repo-root `.mcp.json` is the
    dev-from-checkout path only; its `run.sh` argument is **relative**, so it cannot work from
    `~/.jev-seo/agent` and must never be the config the child resolves. The permission block is
    rewritten per run by `writeAgentPermissions` because its one allowed write target is an
    absolute path chosen at call time — a constant cannot name it.
13. **Never reorder `crawl.ts:707`** — the JSON-LD count must precede the `remove()` strip below it,
    or structured-data detection silently returns 0.

## UNIQUE STYLES

- Streaming NDJSON, not SSE — `EventSource` cannot POST (`web/src/api.ts:45`). Server sets
  `X-Accel-Buffering: no` and `flushHeaders()`.
- **Never assume non-2xx means failure.** `/api/gsc/properties` and `/api/gsc/status` return HTTP 200
  with the error in the body; the streaming routes report failure as an in-band `{type:"error"}` line
  on a 200.
- The two streaming routes are **not symmetric**: `/api/research` aborts on `res.on("close")`,
  `/api/audit` on `req.on("close")` (`index.ts:132` explains why — a POST `req` closes as soon as its
  body is read). `/api/research` also hardcodes its crawl budget: 12 pages, 30 s (`index.ts:150`).
- The dashboard refuses to serve a bare API: if `webDist()` is null, non-API routes get a 503
  (`index.ts:270`).
- Three independent retry policies (crawl with jitter, jevClient honoring `retry-after`, agent with
  exactly one session-continuing retry). None shared.

## COMMANDS

```bash
npm install
npm run dev          # 2 ports, HMR: Vite 5173 + API 8787
npm run build        # server/dist (tsc) + web/dist (vite) — REQUIRED before pack
npm run typecheck    # tsc --noEmit, both workspaces. Currently clean.
npm run verify       # tsx server/scripts/verify-{entry,rubric}.ts against a local mock
npm pack             # → vakandi-jev-seo-1.0.0.tgz

node bin/jev-seo.js start [--detach] [--port N]   # the product path
node bin/jev-seo.js stop | status | doctor | version
```

`verify-agent.ts` and `verify-agent-degrade.ts` exist but are in **no** npm script — run them by
hand. `verify-rubric.ts` reads source signatures, so typecheck it first.

## NOTES

- **State lives outside the repo:** `~/.jev-seo` (`JEV_DATA_DIR`). Repo-local `.gsc/` and `.logs/` are
  dev leftovers the running server ignores — and `.gsc/service-account.json` is a **real private key**
  (gitignored). `~/.jev-seo/.gsc/` and `<repo>/.gsc/` are different directories.
- **`.env` is read from the launch cwd** (`JEV_ENV_FILE` → `<dataDir>/.env` → `cwd/.env`). So
  `npm --workspace server run start` (what `start.sh` runs) does **not** load the repo-root `.env`;
  `node bin/jev-seo.js start` does. Observed in `.logs/server.log`: `env: none loaded`.
- **Config is frozen at import.** `PORT`, `ZEN_BASE_URL`, `JEV_MODEL`, all crawl/retry knobs are
  module-level `const`s evaluated once. Only `zenKey()` (`config.ts:108`) re-reads per call. Mutating
  `process.env` after import affects almost nothing — and `zenKey()` is the exception.
- **The port lives in three places:** `bin/jev-seo.js:27`, `server/src/config.ts:76`, and
  `web/src/api.ts:9`. `api.ts` bakes an **absolute** `http://localhost:8787` into the bundle, so
  changing the port needs a web rebuild — and CORS (`index.ts:44`, wide open) is what makes the
  cross-origin call legal.
- **No CI, no linter, no formatter, one commit.** `prepublishOnly` (`build && verify`) is the only
  release gate and runs only on the maintainer's machine. **`npm run typecheck` is currently clean**,
  so the typecheck gate that was omitted from `prepublishOnly` could be restored.
- **Version `1.0.0` is in three manifests** plus a hardcoded install command in
  `docs/PLAN-npm-distribution.md`. Bump all of them.
- **The committed `.tgz` is stale** — its `web/dist` asset hashes predate current source. Re-run
  `npm pack` before trusting it.
- **Docs drift from code.** `README.md` claims the Zen session ids are read from
  `~/.omp/agent/models.yml`; `config.ts:136-137` only reads env vars with hardcoded defaults.
  `docs/RISK-REVIEW.md` lists 6 unfixed critical honesty bugs (C1–C6) — read it before touching the
  decision panel. `docs/PLAN-agent-research-and-gsc-onboarding.md` is **proposed, not started**.
- `server/package.json` declares `"types": "dist/index.d.ts"` but `tsconfig.build.json` sets
  `declaration: false`, so no `.d.ts` is emitted. The field is dangling.
- **GitHub Pages is configured but cannot deploy yet.** `DeployMates` is on the **free** plan, and
  Pages for a **private** repo needs Pro/Team/Enterprise. `POST /repos/DeployMates/jev-seo/pages`
  answers `422 Your current plan does not support GitHub Pages for this repository.` The workflow
  and the site are committed and correct; enabling it needs either an org plan upgrade or a public
  repo — a decision for the maintainer, not a code change.
