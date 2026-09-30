# Plan — npm / npx Distribution

Status: **implemented** · P1–P6 shipped and clean-room verified · P7 not started · Zen proxy pool exposed in the CLI (§7)
Scope: `/Users/vakandi/Documents/jev-seo`
Package: **`jevseo`** (unscoped `jev-seo` was taken on 2026-09-26)
Goal: `npx jevseo` starts the whole product — API + UI — from a clean machine with no clone, no Python, and no `npm install` run by hand.

---

## 0. The distribution question: npx, and why

`npx` is the right target, for three reasons:

1. **It is the strictest environment.** npx installs into
   `~/.npm/_npx/<hash>/node_modules/jev-seo`, a directory npm garbage-collects
   whenever it likes. Anything the app writes into its own install directory is
   already lost by design. If the product survives npx, it survives every other
   install path — global, `npm link`, CI, Docker.
2. **It removes the install step from the user's hands.** For a server+UI
   product nobody should be reading a README to learn which of four processes
   to start. One command → a URL on stdout.
3. **It is the lowest-friction demo.** Drop the command in a terminal, get the
   dashboard.

But npx alone is **not enough to run a server**, and the plan has to say so
honestly: npx is a foreground process, and a real server wants to detach, hold
a PID, survive the terminal closing, and be stoppable. npm may also swap the
cached copy on upgrade while the old process still holds port 8787.

So the answer is **npx-first with a full server lifecycle behind one binary**.
Designing for `npm i -g` first and retrofitting npx means fighting npm's cache
GC the whole way; the reverse order is free.

One fact that shapes the whole build pipeline, stated once so it is not
rediscovered later:

> **`prepare` does not run when a user installs from the registry.** It only
> runs for git and local-directory installs. So the published tarball **must
> contain prebuilt `server/dist` and `web/dist`**. A source-only tarball
> installs fine and then fails at runtime, which is the worst possible failure.

### What diverged from the plan below

Everything in P1–P6 is implemented and was verified in a clean room: the tarball
was installed into an empty project with no repo, no `.env`, and a `PATH`
stripped to a single `node` symlink, and the install tree held 51 files before
*and* after a full start/stop cycle — nothing is ever written into the install
directory.

Four things in this document turned out to be wrong, or were changed on purpose.
The reasoning is kept so the next reader does not "fix" them back:

- **§1.3 said `name: "jev-seo"`.** Wrong: the unscoped name is already
  registered to someone else. It ships as **`jevseo`**. The `bin` is
  still `jev-seo`, so a global install gives a short command.
- **§1.11 said delete `start.sh` / `stop.sh`.** Wrong call, reverted. They are
  macOS-shaped and `pkill -f vite` does kill unrelated projects, but they are
  the existing dev workflow and replacing them is a convenience, not a
  requirement. **They stay.** `bin/jev-seo.js` sits alongside them.
- **§1.2's `NodeNext` caveat was unnecessary.** TypeScript 5.9.3 emits cleanly
  with the existing `module: ESNext` + `moduleResolution: bundler`, and the
  emitted ESM loads natively in Node because every relative import already
  carries `.js`. No source file was changed for the build.
- **`prepublishOnly` briefly skipped `typecheck`.** §1.3 wanted that gate, but
  `server/src/audit.ts` had two type errors, so the gate was permanently red and
  would have blocked every publish. Those errors are now fixed and
  `npm run typecheck` is clean, so the gate is restored:
  `prepublishOnly` is `typecheck && build && verify` again.


---

## 1. Blockers, each with its solution

### 1.1 Two ports, two processes, and no static serving

**Now:** API on 8787 (`tsx watch` / `tsx`), Vite dev server on 5173 proxying `/api`. `grep` for `express.static` in `server/src` returns nothing, so the API cannot serve the UI at all. `strictPort: true` on 5173 means a busy port is a hard crash.

**Solution:** the Express app serves the built UI. In `server/src/index.ts`, after the API routes, mount:

- `express.static(webDist)` — the hashed assets and `index.html`.
- A catch-all that returns `index.html` for any GET that is not `/api/*`, so client-side routes deep-link correctly. It must be registered **last**, or it swallows the API.

`webDist` resolves through a new `paths.ts` helper, not a hardcoded relative path, because after packaging the layout is a tarball, not a repo. Resolution order:

1. `JEV_WEB_DIST` if set (used by tests and by anyone running from a build dir).
2. Walk up from the module for `web/dist/index.html`.
3. Fail loudly with `web UI not built — run \`npm --prefix <pkg> run build\`` rather than serving an empty API.

Consequences:

- **Production has exactly one port.** `PORT` (default 8787) serves the API *and* the UI. Same origin, so CORS is irrelevant and there is no proxy hop in the request path.
- **Vite stays dev-only.** `npm run dev` is unchanged: concurrently, 5173, proxying to 8787. HMR is a dev concern and does not belong in the shipped product.
- Vite dev drops `strictPort: true` and reads `WEB_PORT` (default 5173) so a busy port auto-increments and the real URL is printed.

**Verified:** `/` returns the built HTML, `/opportunities` returns the SPA
fallback, `/api/config` still returns JSON, and `/api/nope` returns 404 rather
than leaking HTML into the API namespace.


### 1.2 No server build — `tsx` is a devDependency

**Now:** `server/package.json` has `"start": "tsx src/index.ts"` and `tsx` sits in `devDependencies`. `server/tsconfig.json` has `"noEmit": true`. Under `npm install --omit=dev` (or any production install that prunes dev deps) the server has no way to start.

**Solution:** add `server/tsconfig.build.json` extending the base config with:

- `noEmit: false`, `outDir: "dist"`, `rootDir: "src"`, `declaration: false`, `sourceMap: true`.
- `include: ["src/**/*.ts"]` unchanged.

Then `server/package.json` scripts become:

- `build`: `tsc -p tsconfig.build.json`
- `start`: `node dist/index.js`
- `dev`: `tsx watch src/index.ts` (unchanged)

`tsx` stays a devDependency. Nothing about the runtime path touches TypeScript.

**One thing to verify rather than assume:** the base config pairs `module: "ESNext"` with `moduleResolution: "bundler"`, which is a typecheck-only combination in some TS versions and refuses to emit in others. Every relative import in `server/src` already carries an explicit `.js` extension and the package is already `"type": "module"`, so the emit-correct pairing is `NodeNext`/`NodeNext`. If the build complains, the build tsconfig sets those two — **no source file needs editing**. Verify with a real `npm run build` plus `node dist/index.js`, not by reading the config.

### 1.3 Not publishable

**Now:** root `package.json` is `"private": true`, has no `files`, no `bin`, no `engines`, no `repository`.

**Solution** on the root manifest:

- `name: "jev-seo"`, drop `private`.
- `bin: { "jev-seo": "bin/jev-seo.js" }` — a plain CommonJS-or-ESM `.js` file with a shebang, tracked as source, that resolves and loads the built `dist/cli.js`. It must print a clear message when the build is missing rather than throwing `ERR_MODULE_NOT_FOUND`.
- `files`: an allowlist — `bin/`, `server/dist/`, `server/package.json`, `web/dist/`, plus `README.md` and the install doc. `files` is an allowlist and is strictly safer than a `.npmignore` denylist; `proxies.txt`, `.gsc/`, `.env`, `.omo/`, `server/src/`, `server/scripts/` and the Python tree all stay out by default.
- `engines: { "node": ">=20.11" }`.
- `scripts.build`: `npm --workspace server run build && npm --workspace web run build`.
- `scripts.prepare`: `npm run build` — covers `npm install` from a git URL and from a local directory.
- `scripts.prepublishOnly`: `npm run typecheck && npm run build && npm run verify` — this is the gate that guarantees the tarball carries a fresh, verified build.
- `repository`, `homepage`, `bugs`, `license` — required for a credible package, and `LICENSE` is currently missing entirely.

### 1.4 The `repoRoot()` heuristic breaks inside `node_modules`

**Now:** both `server/src/gsc.ts` and `server/src/proxyRotator.ts` walk up from `import.meta.url` looking for a directory containing `server/package.json`, with a `JEV_REPO_ROOT` escape hatch. That marker exists to distinguish the repo root from `server/`. In a packed tarball the layout is different, and inside `~/.npm/_npx/<hash>/node_modules/jev-seo` the walk either finds nothing or finds the wrong thing — so the GSC key and the proxy pool silently resolve to paths that do not exist.

**Solution:** delete the walk. Create `server/src/paths.ts` as the single source of truth for every filesystem location, and make both modules import from it:

- `dataDir()` → `JEV_DATA_DIR` if set, else `~/.jev-seo`. Never the install directory. This is the npx constraint from §0 made concrete.
- `gscKeyPath()` → `<dataDir>/.gsc/service-account.json`, `mkdirSync(..., { mode: 0o700 })`, file `mode 0o600`. Preserves the existing invariant that the filename is fixed and no request-supplied path is ever honoured.
- `proxiesPath()` → `JEV_PROXIES_FILE` if set, else `<dataDir>/proxies.txt`, else `<cwd>/proxies.txt` for the existing repo workflow. A missing file stays a non-error — the rotator already runs direct.
- `logsDir()`, `researchDir()` → under `dataDir()`. `agent.ts` currently computes `RESEARCH_OUTPUT_DIR` from `import.meta.url`, which points into the install dir and is GC'd by npx.
- `agentWorkspaceDir()` → `<dataDir>/agent/`, used for `AGENT_PROJECT_DIR`.

`JEV_REPO_ROOT` is removed. If a dev escape hatch is genuinely needed it is `JEV_DATA_DIR`, which is honest about what it does.

`agent.ts` gets one extra consequence: opencode resolves `.mcp.json` from the project directory it runs in, so the generated workspace needs its own `.mcp.json` (see §1.8).

### 1.5 The app writes into its own install directory

**Now:** `.gsc/service-account.json` (the user's private key), `.logs/server.log`, `.logs/research/`, and `jev-seo-reports/` are all created relative to the repo. Under npx all of those land in a cache directory npm will delete without warning. Under a global install they may land in a root-owned path and throw `EACCES`.

**Solution:** §1.4 moves every one of them under `dataDir()`. On top of that, add a **startup writability probe**: at boot, write and delete `<dataDir>/.probe`. On failure, exit with one clear line naming the resolved path and the `JEV_DATA_DIR` override — rather than letting the first GSC upload 500 four minutes into a session.

Rule to hold across the codebase: **the install directory is read-only.** If a future feature needs to persist something, it goes through `paths.ts` or it does not ship.

### 1.6 `.env` is loaded from `process.cwd()`

**Now:** `config.ts` tries `resolve(cwd, ".env")` then `resolve(cwd, "../.env")`. Run the binary from anywhere but the repo and no config loads, silently — every setting falls back to its default, including the model.

**Solution:** explicit order — `JEV_ENV_FILE`, then `<dataDir>/.env`, then `<cwd>/.env` (kept last purely for the existing repo dev workflow). At boot, log the **path** that was loaded and the **key names** found in it. Never the values. A silent config miss is the class of bug that costs a day, and one log line kills it.

### 1.7 Hardcoded ports

**Now:** `PORT` is read from env in `config.ts` for the API. The web side has `port: 5173, strictPort: true` hardcoded in `vite.config.ts`. In production there will be one port, so this mostly resolves itself — but the failure mode must be good.

**Solution:**

- `--port <n>` CLI flag beats `PORT` beats the 8787 default.
- In dev, a busy port auto-increments and the chosen URL is printed.
- In production, a busy port exits with `port 8787 in use — pass --port <n>, or run \`jev-seo stop\`` — naming the actual fix, which is almost always "you forgot to stop the last one".
- `stop` killing the process holding the port is the real answer, and is why the PID file is not optional (§0).

### 1.8 The Python MCP is in the runtime path it should not be in

**Now:** `server/mcp/gsc-mcp` is a vendored Python FastMCP server, launched by `server/mcp/gsc-mcp/run.sh` via `uv run` with `mcp[cli]<2` plus six Google client libraries, requiring Python 3.11+. It is registered in `.mcp.json` as server `gsc`. Its only consumer is the `opencode` child process that `agent.ts` spawns for `/api/research` — so that the agent can call GSC tools.

**The finding that makes this tractable:** the audit path needs **zero** Python. `gsc.ts` mints its own RS256 JWT with `node:crypto` and talks to the Google REST endpoints directly — that is a deliberate design choice already documented in the module header, "no Google client library, nothing to install for an onboarding check to pass". No file in `server/src` imports or shells out to Python.

**Solution, in two stages:**

- **Now (packaging):** move the MCP out of the published tarball. It is not in `files`, so npm never ships it. `doctor` reports it as an *optional capability* with its exact requirement (`uv` on PATH, Python 3.11+) instead of a hard dependency. Research degrades to a clear message, which the code already models — `RunFailure("binary-missing")` and the `degraded` flag on the research result exist for this.
- **Later (Phase 7, separate decision):** remove the dependency rather than hide it. `index.ts` already calls `gscStatus(url)` in-process before `runResearch`, so the facts the agent needs are already in the server's hands. Injecting them into the agent context removes the MCP from the runtime path permanently, and then the research feature needs no Python and no `opencode`-hosted GSC tools at all.

**Housekeeping, same phase:** `server/mcp/gsc-mcp/src/gsc_mcp/**/__pycache__/*.pyc` is sitting in the tree as untracked junk. Delete it and add `__pycache__/` to `.gitignore` — compiled Python has no business in a JS project's history.

### 1.9 The tree is not committed

**Now:** `git status` reports `.env.example`, `.gitignore`, `.mcp.json`, `.omo/`, `README.md` and more as untracked (`??`). Nothing is committed. `npm publish` from a dirty tree is a bad idea regardless, and there is no baseline to diff a packaging change against.

**Solution:** one initial commit of the current working state **before** any packaging work, so the packaging diff is reviewable on its own. `.omo/` needs a `.gitignore` entry (the opencode run-continuation JSON files under `server/.omo/` are currently untracked noise); `.gsc/`, `proxies.txt` and `.env*` are already ignored.

### 1.10 The verification scripts exist but are not wired up

**Now:** `server/scripts/verify-agent.ts`, `verify-agent-degrade.ts`, `verify-entry.ts`, `verify-rubric.ts`, `mock-jev-verify.ts` are on disk and in no `package.json` script. `prepublishOnly` cannot gate on tests that nothing can run.

**Solution:** add `server/package.json` script `verify` that runs them, hoist it to the root, and make `prepublishOnly` depend on it. If any script needs the `mock-jev-verify` server on port 8799, `verify` starts and stops it in a `pre`/`post` pair so the sequence is one command and cannot leak a listener.

### 1.11 No server lifecycle, so "run it as a server" is impossible

**Now:** `start.sh` / `stop.sh` are bash, hardcode ports 8787 and 5173, `pkill` by process-name pattern, and are macOS-shaped. They cannot work under npx (no shell, no stable paths) and they are a liability: `pkill -f vite` kills every Vite on the machine, including unrelated projects.

**Solution:** move the lifecycle into `bin/jev-seo.js`, in Node, cross-platform:

- `start` — foreground by default; `--detach` spawns with `detached: true`, `stdio: "ignore"`, `unref()`, writes `<dataDir>/jev-seo.pid`, redirects logs to `<dataDir>/logs/`.
- `stop` — reads the PID file, sends `SIGTERM`, waits, escalates to `SIGKILL`, removes the file. **Never `pkill` by pattern.** `stop` is also the documented remedy for a busy port.
- `status` — PID alive, port listening, `/api/health` reachable, prints the URL.
- `restart` — stop then start.

`start.sh` / `stop.sh` are then deleted, and their two jobs are replaced by `npx jev-seo start --detach` / `npx jev-seo stop`.

### 1.12 `doctor` — the difference between a clear error and a support ticket

**Now:** nothing checks the environment before the user hits a failure. `/api/health` reports runtime capacity well, but only after the server is already up.

**Solution:** `jev-seo doctor` runs before the server starts (and standalone), and reports pass/fail per line:

- Node version against `engines`.
- `dataDir` resolved path, and whether it is writable (the §1.5 probe).
- Whether `web/dist/index.html` exists — i.e. whether this copy is built.
- `opencode` on `PATH` — **optional**, reported as a capability, with the note that `/api/audit` works without it and `/api/research` does not.
- The Python MCP — optional capability, per §1.8.
- GSC key present at `gscKeyPath()`, and if present, the `client_email` only. Never the key.
- `proxies.txt` present and how many entries parsed.
- Which env file was loaded, and the key names in it.
- Effective port, and whether it is free.

Every dependency line is labelled **required** or **optional**. A product whose headline feature works with zero configuration must not present optional capabilities as failures, or users will read a working install as broken.

---

## 2. Target shape

One process, one port, no required external runtime:

```
npx jevseo                  # start (foreground), prints the URL
npx jevseo start --detach   # background, PID + logs in ~/.jev-seo
npx jevseo stop             # kill by PID, never by pattern
npx jevseo status           # PID / port / /api/health
npx jevseo doctor           # preflight, required vs optional

# after `npm i -g jevseo` the command is just:
jev-seo doctor
```

- **One port (8787).** Express serves the API and `web/dist`. Same origin, no CORS, no proxy.
- **One process.** `node dist/index.js`. No TypeScript at runtime, no Vite, no shell.
- **Zero required external dependencies.** Node ≥ 20.11 and an internet connection. `opencode` and the MCP are reported capabilities, not requirements.
- **Install directory read-only.** Everything mutable lives in `~/.jev-seo`.
- **Prebuilt in the tarball.** `prepublishOnly` builds; `prepare` covers git installs.

---

## 3. Phases

Each phase ends with the verification below. A green build is not a phase completion.

**P1 — Build the server.** `tsconfig.build.json`, `tsc` emit, `start: node dist/index.js`, `build` script, `paths.ts` created. *Verify:* `npm run build` succeeds, `node dist/index.js` boots, `curl localhost:8787/api/health` returns 200 **and the body is inspected**, not just the status code.

**P2 — Single port.** Static mount + SPA fallback, `webDist` resolution, `PORT` unified, vite dev reads `WEB_PORT` without `strictPort`. *Verify:* `npm --workspace web run build`, start the server, load the UI in a browser, confirm it renders and that a deep client route returns the app rather than a 404.

**P3 — Paths and data dir.** `paths.ts` adopted by `gsc.ts`, `proxyRotator.ts`, `agent.ts`, `config.ts`. `JEV_DATA_DIR` everywhere. Env-file resolution order. Boot writability probe. *Verify:* with the package installed in a temp dir, confirm nothing is written inside the install tree, and that `.gsc/`, logs and research output all land in `dataDir`.

**P4 — CLI.** `bin/jev-seo.js` with `start | stop | status | restart | doctor | version`. PID file, detached start, log redirection, `SIGTERM` → `SIGKILL`. *Verify:* `start --detach` from a different cwd, `status`, `stop`, confirm the process is gone and the port is free.

**P5 — Packaging.** `name`/`bin`/`files`/`engines`/`prepare`/`prepublishOnly`/`repository`/`license`, `verify` script wired, `LICENSE` added, `.npmignore` not needed. *Verify:* `npm pack`, then inspect the tarball listing and confirm it contains `server/dist`, `web/dist`, `bin/` and **not** `proxies.txt`, `.gsc`, `.env`, `.omo`, `server/src`, or any `.pyc`.

**P6 — Docs.** README install section (`npx jev-seo`), a `doctor` reference, a "runs without X" section stating plainly that audit needs no Python and no `opencode`, and the upgrade note: `npx jev-seo stop` before pulling a new version, or the old process keeps the port.

**P7 — Optional, and the real prize.** Inject the GSC facts `index.ts` already has into the agent context so the research path no longer needs the Python MCP at all. Biggest win, biggest code change, and it should not be bundled into the packaging work. *Verify:* with `uv` and Python removed from `PATH`, a full audit **and** a full research run both complete, and the receipt shows the GSC data was used.

---

## 4. The verification that actually counts

Everything above is a local build. The only proof is a clean-room install:

```
npm pack
npm i -g ./vakandi-jev-seo-1.0.0.tgz        # or: npx jevseo@latest
jev-seo doctor
jev-seo start --detach
curl -s localhost:8787/api/health   # read the body
open http://localhost:8787
```

Run it with **no repo on disk**, **no `.env`**, **no `proxies.txt`**, and **no Python**. The bar:

- `doctor` reports every required line green, and the optional lines honestly labelled optional.
- The install directory contains no new files after a full audit + research cycle.
- `stop` leaves no process and no listener behind.
- The UI loads and an audit actually streams NDJSON — verified by chunk count over a wire capture, not by a screenshot.

A 200 with an empty body is a failure. A screenshot is a failure for anything that has a backend. If the sentence would contain "should" or "normally", the phase is not done.

---

## 5. Decisions — now settled

- **Registry: public npm, unscoped `jevseo`.** The obvious unscoped name
  `jev-seo` was already registered to another user on 2026-09-26 and has never
  been published from, so it cannot be released by this project. The package
  therefore ships as `jevseo` — unscoped, so `npx jevseo` needs no scope
  ceremony. Public means
  §1.5's "nothing secret in the tree" is a release gate, not a convention — the
  tarball was audited and carries no `.env`, `proxies.txt`, `.gsc`, `server/src`,
  or `.pyc`.
- **Python MCP: left as an optional capability, P7 not started.** The audit path
  needs no Python at all, and `doctor` reports the MCP as optional rather than
  required. P7 would remove the dependency outright instead of hiding it, and it
  should ship as its own change.
- **`opencode`: optional, never in a `postinstall`.** Pulling a Bun-based CLI
  into an npm lifecycle script is a supply-chain decision that should not be made
  implicitly.
- **Both install paths.** The README leads with `npx jevseo`; the
  `bin` is unscoped so a global install gives a plain `jev-seo`.

---

---

## 7. The Zen proxy pool

The keyless `jev-1.13-free` tier is metered **per egress IP**. Once an address is
spent, no amount of retrying clears it — the only fix is a different address.
`server/src/zenProxy.ts` therefore owns an undici `ProxyAgent` per upstream and
quarantines an address on 429. `jevClient.ts` passes the dispatcher and steps to
the next upstream on a quota response.

**Two proxy variables, two purposes — do not merge them:**

- `JEV_PROXY_POOL` — the **Zen** provider. Read by `zenProxy.ts`. Default
  `~/.config/opencode/plugins/proxies.txt`. Format: `IP:PORT:USER:PASS`, with
  optional `|key=value` metadata after a pipe.
- `JEV_PROXIES_FILE` — the **crawl** path, read by `proxyRotator.ts`. That module
  has zero importers and is deliberately not wired in (see `server/AGENTS.md`
  anti-pattern 11). It is dead code kept for reference.

### Surfacing it in the CLI

`zenProxy.ts` read its pool from the environment only, which is invisible to
someone who just ran `npx jevseo`. The CLI now exposes it:

- `jev-seo proxy` — shows the resolved pool file, entry count and the first few
  hosts. **Credentials are never printed**, here or in `doctor`.
- `--proxy-pool <file>` (alias `-x`) — point the Zen provider at a pool file, for
  `start` and `proxy`. Validated at launch: a missing file is a clear error, not
  a silent fallback to the default.
- `--no-proxy` (alias `-n`) — bypass the pool entirely and send Zen requests
  direct. The env equivalent is `JEV_NO_PROXY=1`.
- `doctor` gained a **Zen proxy pool** line, reported separately from the crawl
  pool so the two are never confused.

### Bug found while verifying this: dead proxies were never quarantined

`rotateAfterQuota` fired **only** on a 429. A proxy that fails at the transport
layer — a provider 402, a dead host, a tunnel that never opens — throws inside
`fetch` and never reaches the `response.ok` branch, so it was never parked. Every
retry went back to the same broken address. Measured on the live pool: 2 of the
first 4 entries answered `402 Payment Required`, and a single-page audit produced
**30 identical `fetch failed` errors** instead of stepping to a working address.

`rotateAfterTransportFailure` now parks an upstream on a transport error for the
same cooldown a 429 gets. After the fix the same audit completed: a real
`page-done` judgement (`band: escalate`, `needsHuman: true`, confidences 0.46 /
0.47), nine keywords judged, `summary` and `done`. A transport failure says as
much about an address as a quota response does — it is unusable for now.

### `undici` was an undeclared dependency

`zenProxy.ts` imports `ProxyAgent` and `Dispatcher` from `undici`, but `undici`
was not in `dependencies`. It resolved only because `cheerio` happens to depend
on it and npm hoisted it — an accident that breaks the whole Zen path the moment
cheerio drops or changes that dependency. Now declared explicitly.

---

## 8. Known issues, not introduced by this work

- **`server/src/audit.ts` had two type errors, now fixed.** It declared
  `topChange` / `topChangeReason` / `reach` on the page judgement and
  `decisions` / `subjects` / `notDecided` / `presearch` on the report without
  populating them at its two construction sites. `tsc` emitted anyway —
  `noEmitOnError` is not set — so the defect was invisible unless you ran
  `npm run typecheck`. `npm run typecheck` is clean as of this commit.
- **The Zen keyless tier rate-limits per egress IP.** A spent address returns
  `FreeUsageLimitError` and the run degrades into a clean NDJSON `error` event
  rather than crashing. Retrying never clears it; a different egress address
  does, which is what §7's pool is for. `ZEN_API_KEY` with a workspace removes
  the ceiling entirely.
- **`.gsc/service-account.json` in the working tree is a 440-byte placeholder**,
  not a real service account key (a real RSA one is ~1.7 KB). It fails PEM
  parsing, so GSC correctly reports "not connected". It is gitignored and never
  ships.

