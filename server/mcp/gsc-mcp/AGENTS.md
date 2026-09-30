# GSC MCP SERVER (vendored Python)

**Parent:** `../../AGENTS.md`, `../../../AGENTS.md`

## OVERVIEW

60-tool Google MCP (GSC + GA4 + CrUX) over stdio, vendored read-only. It is optional and
feature-gated, and it is NOT the path the Node app's own GSC client uses.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Launcher, the ONLY dep declaration | `run.sh` | 39 LOC, 3-tier fallback |
| Entry point | `server.py` | Py3.11 gate, 60-tool loop, bare `mcp.run()` |
| Tool list, single source of truth | `registry.py`, `properties.py:6-78` | `TOOLS` + import-time assert vs flat `_ALL_TOOLS` (no read/write split) |
| Destructive tools | `tools/indexing.py`, `tools/sitemaps.py` | see ANTI-PATTERNS 4 |
| Credential resolution | `auth.py` | env vars + `sites.json` |
| SSRF / DNS-rebind guard | `url_safety.py` | not thread-safe by design |
| Live mutable state | `tools/drift.py:50-51` | SQLite outside the repo |
| Largest files | `drift.py` 820, `content.py` 744, `ga4.py` 639 | 23 `.py` = 6,486 LOC |

## CONVENTIONS

- **snake_case here, camelCase in `server/src`.** Both deliberate. Do not normalise.
- **Tool names are the bare Python `__name__`**, no namespace prefix. They register through a
  loop at `server.py:12-13` (`mcp.tool()(fn)`). There is not a single `@mcp.tool` decorator in the
  package; grepping for one returns 0.
- **No packaging at all.** No pyproject, setup.py, requirements.txt, tox.ini, pytest.ini, and no
  console_scripts entry point (`cli.py:274` defines `main()`; nothing registers it). src-layout,
  importable only because `run.sh:16` sets `PYTHONPATH="$here/src"`.
- **Only `mcp[cli]<2` is pinned.** The other 8 deps are unpinned, and `--no-project` means uv
  re-resolves from the network on every launch. No lockfile, no venv in the repo. The Python floor
  is enforced at runtime, not in metadata: `server.py:3-4`.
- **Config is disjoint from the Node side.** No shared `.env`, and `python-dotenv` is not a
  dependency, so `.env.example` is documentation only. `run.sh` reads `${VAR:-default}` off the
  inherited process env.

## ANTI-PATTERNS

1. **Never route Node through this MCP, and never treat it as required.** The Node app never touches
   Python: no `spawn("python")`, no `execFile`, no import bridge — the only `spawn` in `server/src` is
   `opencode`. The chain is `agent.ts:547` → `opencode run --dir PROJECT_DIR` (`agent.ts:67`) →
   opencode reads `.mcp.json` from there → `bash run.sh` → `uv run` (`run.sh:21-31`) →
   `python -m gsc_mcp.server`. `bin/jev-seo.js:293-302` makes a missing `uv` a warn, never a fail. All
   dashboard onboarding uses the app's own independent TS client (`gsc.ts`, RS256 JWT via
   `node:crypto`); only the optional agent research path reaches Python.
2. **Never assume the spawned agent has any MCP server.** `paths.ts:104` `agentWorkspaceDir()` is
   `~/.jev-seo/agent/`, whose own doc comment says it needs a `.mcp.json` for this MCP — but nothing
   writes one and the directory is empty. The repo-root `.mcp.json` also passes a *relative* `run.sh`
   path that would not resolve from there anyway. So `buildToolAllowlist` (`agent.ts:93`) can grant
   the whole `gsc` namespace, on `gate.gsc.verified` alone, against zero registered servers. Workaround:
   point `AGENT_PROJECT_DIR` at the repo root.
3. **Never surface `quota_remaining` as fact.** `quota.py:5` is a module-level in-memory counter. It
   resets on every process restart and is never persisted, so it cannot stop a restart loop from
   exceeding Google's real 200/day Indexing API limit and earning a 24h suspension.
4. **Never call a write tool without naming the blast radius.** `indexing.py:24` `submit_url` with
   `url_type='URL_DELETED'` tells Google to DROP the URL from the index. `indexing.py:315`
   `force_reindex` and `indexing.py:246` `submit_sitemap_urls` each write a whole sitemap's worth of
   URLs from one call. `sitemaps.py:54` `sitemaps_delete` is guarded only by a string-shape check
   (`sitemaps.py:61-64`: ends in `.xml` or contains `/sitemap`) — not an ownership check, so any
   `.xml` passes. Also write-ish: `sitemaps.py:42` `submit_sitemap`, `indexing.py:107`
   `indexnow_submit`, `drift.py:541` `drift_baseline`. No confirmation, no undo.
5. **Never copy `retry.py` as a resilience model.** `retry.py:36` is pure exponential with no jitter,
   so `force_reindex` / `submit_batch` fan-out synchronises workers onto the same retry instant.
   `server/src/crawl.ts:389` does add jitter, with a comment explaining why.
6. **Never assume concurrent fetches are safe.** `url_safety.py:250-254` raises rather than degrades,
   because the global `socket.getaddrinfo` patch (`url_safety.py:287`) sits behind a non-reentrant
   lock. `url_safety.py:71-89` hard-blocks cloud metadata endpoints by name. The Node crawler is
   weaker: regex-only, no DNS resolution, no pinning, no redirect re-validation.
7. **Never trust `data/schema_templates.json`.** Committed (11 templates) and read by nothing — no
   `schema_templates`, `importlib`, `pkgutil` or `__file__`-relative data load exists anywhere.
   `technical.py` hardcodes its metadata inline instead.

## NOTES

- **The vendored code may not be what actually runs.** `run.sh` falls back 3 ways: `uv` on PATH →
  vendored code; else `gsc-mcp` on PATH → `exec gsc-mcp`; else stderr + `exit 1`. On this machine
  that tier-2 binary resolves to a completely different checkout
  (`/Users/vakandi/Documents/mcps_server/google-search-console-mcp/`), so losing `uv` silently swaps
  the entire codebase. `uv` is present, so the vendored code wins today.
- **Two different service-account keys.** Python resolves `<repo>/.gsc/service-account.json`
  (`run.sh:14,17`), which exists. Node resolves `~/.jev-seo/.gsc/service-account.json`
  (`gsc.ts:102` → `paths.ts:75`), which does not. So a dashboard onboarding writes a key this MCP
  will never read.
- **`run.sh:8-9` states an invariant the code breaks.** The comment claims a stray
  `GSC_SERVICE_ACCOUNT_PATH` cannot redirect the MCP at another key, but `run.sh:16` uses
  `${GSC_SERVICE_ACCOUNT_PATH:-...}`, which honours a pre-existing value.
- **Env vars read:** `GSC_SERVICE_ACCOUNT_PATH` (auth.py:38,104,143), `GSC_SKIP_OAUTH` (auth.py:142,
  defaulted true at run.sh:18), `GSC_CREDENTIALS_PATH` (auth.py:123), `GSC_NO_BROWSER` (auth.py:130),
  `GA4_PROPERTY_ID` (auth.py:303), `CRUX_API_KEY` (crux.py:41), `GOOGLE_API_KEY` (technical.py:509,
  needed by `pagespeed_audit`, and missing from `.env.example`).
- **`sites.json` (`auth.py:28`) is absent**, so `_load_sites()` returns `[]` and every call takes the
  legacy env-var path (`auth.py:140-153`). The whole `account=` multi-site machinery is dormant.
  Conversely, 17 of the 60 tools take **no** `account` param (all 3 crux, all 4 content, all 3
  drift, `schema_*`, `ai_visibility_audit`, `gbp_deprecation_lint`, `pagespeed_audit`,
  `parasite_risk`, `get_capabilities`) and act on a raw URL, so they work regardless.
- **There is no Python test suite.** No pytest, unittest, conftest or runner; `npm run verify` is
  TypeScript-only and covers zero Python. Closest thing: `python -m gsc_mcp.url_safety <url>
  --strict --json`. `registry.py:138-142` (`assert set(TOOLS) == set(_ALL_TOOLS)`) passes today and is
  the strongest correctness net in the package. OAuth tokens and the drift DB
  (`drift.py:50-51`) live outside the repo, together in the platform user-data dir.
- **Docstring drift:** `properties.py:70` says "59 available tool names"; the payload emits 60.
