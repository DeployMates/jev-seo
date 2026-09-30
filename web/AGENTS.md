# WEB WORKSPACE

**Parent:** `../AGENTS.md`

## OVERVIEW

React 18 + Vite 6 dashboard, served to the browser as a prebuilt bundle. `src/` holds 25
hand-authored files (14 .tsx, 5 .ts, 6 .css; 8,318 LOC), every one git-tracked with a doc comment,
zero vendored files. `web/dist/` is a GENERATED artifact, never hand-edited.

```
web/
├── index.html      16 lines. Vite entry: mounts <div id="root">, loads /src/main.tsx as module script
├── package.json    24 lines. "name": "web", private, type module. react/react-dom ^18.3.1, react-joyride ^3.2.0
├── vite.config.ts  27 lines. DEV ONLY. No `build` key, so outDir is Vite's default dist/
├── tsconfig.json   Typecheck only (noEmit)
├── src/            The 25 authored files
└── dist/           Generated. gitignored (.gitignore:14), untracked, but SHIPPED in the tarball
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Main UI | `src/App.tsx` | 1,834 LOC, 22% of the dir. THE OUTLIER and the natural next refactor target. Form, live counters, findings wall, teardown, batch patterns, needs-a-human strip |
| Only API client / stream contract | `src/api.ts` | NDJSON reader. Exactly 5 call sites in all of `web/src` |
| Type contract with the server | `src/types.ts`, `src/researchTypes.ts` | Band, Severity, Finding, AuditEvent, AuditReport; presearch/agent proposal types |
| Client-side opportunity scoring | `src/opportunity.ts` | Pure. buildOpportunities, fromGapRow, opportunityOf |
| GSC onboarding | `src/Onboarding.tsx` | 675 LOC. POSTs /api/gsc/connect, drag/drop service-account JSON |
| Guided tour | `src/GuideTour.tsx`, `src/tourSteps.tsx` | Joyride steps in reading order. localStorage key `jev.tour.seen.v1` |
| Design tokens | `src/styles.css` | THE source of truth. `:root` = --bg #ebe9e4, --paper #faf9f6, --ink #0b0b0a, --hot #ff5a1f |
| Honest-signal badge | `src/CapacityBadge.tsx` | Re-runs GET /api/gsc/status |
| Decision prose | `src/decisionCopy.ts`, `src/DoThisNow.tsx` | Section 02 cards, and the id-to-prose mapping |
| Build/dev config | `vite.config.ts`, `tsconfig.json` | Proxy is dev-only; tsconfig never emits |

## CONVENTIONS

- **Relative imports in `web/src` are extensionless**, the opposite of `server/src` (`.js` required). Never normalise.
- `jsx: "react-jsx"`, so no `import React` anywhere.
- `verbatimModuleSyntax` means `import type` for type-only imports.
- No semicolons, 2-space indent, double quotes, trailing commas. By imitation only: no linter, no formatter.
- PascalCase components, camelCase helpers, never kebab-case in `web/src`.
- One `.css` per component, consuming `styles.css` `:root` tokens. Never a new palette.
- React 18 + `react-joyride` only. No state library, no router.

## ANTI-PATTERNS

1. **Never hand-edit `web/dist/`.** Regenerate with `npm --workspace web run build`.
2. **Never add a hardcoded colour.** Consume a `styles.css` `:root` token.
3. **Never add a `fetch` outside `web/src/api.ts`.** All frontend network I/O is centralised there.
4. **Never assert a check the run did not make.** `CapacityBadge` invariant.
5. **Never let a raw question id reach the screen.** `decisionCopy.ts` maps it to prose.
6. **Never treat typecheck as a build.** `tsc --noEmit` emits nothing, so "green" says nothing about `web/dist`.

## NOTES

- The 5 calls: `GET /api/config` (api.ts:25), `POST /api/audit` (api.ts:69), `POST /api/research`
  (api.ts:167), `GET /api/gsc/status?url=` (App.tsx:336), `POST /api/gsc/connect` (Onboarding.tsx:366).
  All 5 match a route in `server/src/index.ts`; zero orphans. `/api/gsc/properties` is server-dead.
- `api.ts:9` bakes an ABSOLUTE `http://localhost:8787` (or `VITE_API`) into the bundle. No `web/.env`.
  A remote build must set `VITE_API` at build time.
- Transport is NDJSON over `fetch` + `response.body.getReader()` + TextDecoder, split on `\n`
  (api.ts:90-115 audit, 188-213 research). Not SSE, not WebSocket: EventSource cannot POST.
- `web/dist` is gitignored and untracked **but is shipped in the npm tarball**, so build before `npm pack`.
- The bundle carries no sourcemaps, so `web/dist` is effectively undebuggable. Debug via the Vite dev server.
- `npm --workspace web run typecheck` is `tsc --noEmit` and never emits.
- Deps are hoisted to the ROOT `node_modules`. `web/node_modules` holds only the Vite dep-optimizer cache.
- `web/dist` may be stale relative to `App.tsx`; rebuild after touching `web/src`.
- `vite.config.ts` is dev-only: `server.host: true` (IPv6-only-localhost trap), `strictPort` omitted so
  a busy port rolls, `/api` proxied to `PORT` or 8787.
